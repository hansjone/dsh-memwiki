import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
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
