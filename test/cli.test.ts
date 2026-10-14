import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { temporary } from './helpers.ts'

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
