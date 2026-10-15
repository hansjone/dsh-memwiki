import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { temporary } from './helpers.ts'
import { config } from './helpers.ts'
import { initVault } from '../src/core/vault.ts'
import { Memwiki } from '../src/memwiki.ts'
import { writeFile } from 'node:fs/promises'

const exec = promisify(execFile)
const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/cli.ts')
const node = process.execPath

async function run(args: string[], opts: { cwd?: string } = {}) {
  const { stdout, stderr } = await exec(node, [cli, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, MEMWIKI_AGENT: 'test' },
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
  })
  return { stdout, stderr }
}

test('cli init and context print compact catalog', async t => {
  const dir = await temporary(t)
  const init = await run(['init', dir, '--no-git'])
  assert.match(init.stdout, /已创建记忆库/)
  const ctx = await run(['context', '--dir', dir, '--no-git'])
  assert.match(ctx.stdout, /记忆库/)
  assert.match(ctx.stdout, /写入前先搜索/)
})

function secretRun(args: string[], input = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const preload = new URL('./fixtures/cli-protector.ts', import.meta.url).href
    const child = spawn(node, ['--import', preload, cli, ...args], { env: { ...process.env, MEMWIKI_AGENT: 'test' }, stdio: ['pipe', 'pipe', 'pipe'] })
    let stdout = '', stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk.toString() })
    child.stderr.on('data', chunk => { stderr += chunk.toString() })
    child.on('error', reject)
    child.on('close', code => resolve({ code, stdout, stderr }))
    child.stdin.end(input)
  })
}

test('secret CLI reads first stdin line, lists no value and rejects argv passwords without echo', async t => {
  const dir = await temporary(t)
  const common = ['--secrets-file', path.join(dir, 'private', 'secrets.json'), '--dir', path.join(dir, 'vault')]
  const value = 'stdin-password-独特值'
  const set = await secretRun(['secret', 'set', 'local-admin', '--scope', '仅测试', ...common], value + '\nignored-second-line\n')
  assert.equal(set.code, 0, set.stderr)
  assert.ok(!set.stdout.includes(value))
  assert.ok(!set.stderr.includes(value))
  const list = await secretRun(['secret', 'list', ...common])
  assert.equal(list.code, 0, list.stderr)
  assert.match(list.stdout, /local-admin/)
  assert.ok(!list.stdout.includes(value))
  assert.ok(!list.stdout.includes('"value"'))
  const get = await secretRun(['secret', 'get', 'local-admin', '--purpose', '测试 stdin', ...common])
  assert.equal(get.code, 0, get.stderr)
  assert.equal(get.stdout.trimEnd(), value)
  const log = await secretRun(['secret', 'log', '--limit', '2', ...common])
  assert.ok(!log.stdout.includes(value))
  for (const args of [['secret', 'set', 'local-admin', value, '--scope', '仅测试', ...common], ['secret', 'set', 'local-admin', '--value', value, ...common]]) {
    const rejected = await secretRun(args)
    assert.equal(rejected.code, 1)
    assert.ok(!(rejected.stdout + rejected.stderr).includes(value))
  }
  const rm = await secretRun(['secret', 'rm', 'local-admin', ...common])
  assert.equal(rm.code, 0, rm.stderr)
})

test('cli setup clients print without writing', async t => {
  const dir = await temporary(t)
  for (const client of ['claude', 'codex', 'cursor', 'dsh'] as const) {
    const { stdout } = await run(['setup', client, '--dir', dir])
    assert.match(stdout, /memwiki/i)
    assert.match(stdout, /MEMWIKI_AGENT/)
    if (client === 'codex') assert.match(stdout, /\[mcp_servers\.memwiki\]/)
    if (client === 'cursor') assert.match(stdout, /mcpServers/)
    if (client === 'dsh') assert.match(stdout, /dsh-mcp-client/)
  }
})

test('cli --help runs', async () => {
  const { stdout } = await run(['--help'])
  assert.match(stdout, /dsh-memwiki/)
  assert.match(stdout, /init/)
  assert.match(stdout, /serve/)
})

test('CLI merge/verify/feedback/usage operate on an isolated vault', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open(config(dir))
  const ctx = { agent: 'test', reason: '初始化' }
  const target = (await wiki.write({ kind: 'create', id: 'topics/target', meta: { title: '目标', summary: '目标说明' }, body: '目标正文\n' }, ctx)).result.page
  await wiki.write({ kind: 'create', id: 'topics/source', meta: { title: '来源', summary: '来源说明' }, body: '来源正文\n' }, ctx)
  await wiki.feedback({ kind: 'missing', title: '测试反馈', scenario: '测试', expected: '可用', actual: '缺少', ctx })
  await wiki.feedbackResolve(wiki.feedbackList()[0].id, '测试修复', ctx)
  wiki.search({ query: 'zzzz-not-present' })
  await wiki.close()
  const bodyFile = path.join(dir, 'merged.txt'), metaFile = path.join(dir, 'patch.json')
  await writeFile(bodyFile, '整合后的正确正文\n')
  await writeFile(metaFile, JSON.stringify({ summary: '已集中维护' }))
  const common = ['--dir', dir, '--no-git']
  assert.match((await run(['merge', 'topics/source', '--into', target.id, '--rev', target.rev, '--reason', '集中维护', '--body-file', bodyFile, '--meta-file', metaFile, ...common])).stdout, /已合并到/)
  assert.match((await run(['read', target.id, ...common])).stdout, /整合后的正确正文/)
  assert.match((await run(['verify', target.id, '--note', '实测核实', ...common])).stdout, /已核实/)
  assert.equal((await run(['feedback', 'list', ...common])).stdout.trim(), '[]')
  assert.match((await run(['feedback', 'list', '--all', ...common])).stdout, /已解决/)
  const usage = JSON.parse((await run(['usage', '--days', '7', ...common])).stdout)
  assert.equal(usage.counts.SEARCH_ZERO, 1)
  assert.equal(usage.zeroQueries[0].query, 'zzzz-not-present')
})
