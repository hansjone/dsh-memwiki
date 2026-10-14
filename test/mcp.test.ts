import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initVault } from '../src/core/vault.ts'
import { Memwiki } from '../src/memwiki.ts'
import { createMemwikiServer } from '../src/mcp/server.ts'
import { temporary, config } from './helpers.ts'

async function connect(t: Parameters<typeof temporary>[0]) {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open({ ...config(dir), agent: 'cursor', git: { autoCommit: false } })
  t.after(() => wiki.close())
  const server = createMemwikiServer(wiki)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })
  return { wiki, client, dir }
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  const text = (result.content as Array<{ type: string; text?: string }>)
    .filter(c => c.type === 'text')
    .map(c => c.text ?? '')
    .join('\n')
  return { text, isError: !!result.isError }
}

test('MCP tools cover happy path and error codes', async t => {
  const { client } = await connect(t)

  const ctx = await call(client, 'memwiki_context', {})
  assert.equal(ctx.isError, false)
  assert.match(ctx.text, /记忆库/)

  const created = await call(client, 'memwiki_write', {
    page: 'topics/mcp',
    mode: 'create',
    title: 'MCP 测试页',
    summary: '用于工具联调',
    body: '正文含关键词 zebra-unique。\n',
    reason: '测试新建',
  })
  assert.equal(created.isError, false)
  assert.match(created.text, /rev：/)

  const search = await call(client, 'memwiki_search', { query: 'zebra-unique' })
  assert.match(search.text, /topics\/mcp/)

  const read = await call(client, 'memwiki_read', { page: 'topics/mcp' })
  assert.match(read.text, /记录于 \d+ 天前/)
  assert.match(read.text, /rev：/)
  assert.match(read.text, /zebra-unique/)

  const rev = /rev：([a-f0-9]+)/.exec(read.text)?.[1]
  assert.ok(rev)

  const conflict = await call(client, 'memwiki_write', {
    page: 'topics/mcp',
    mode: 'replace',
    rev: 'deadbeefdead',
    body: '坏\n',
    reason: '应冲突',
  })
  assert.equal(conflict.isError, true)
  assert.match(conflict.text, /^CONFLICT/)

  const remember = await call(client, 'memwiki_remember', { text: 'zebra 相关备忘' })
  assert.match(remember.text, /inbox\//)

  const moved = await call(client, 'memwiki_move', { page: 'topics/mcp', to: 'topics/mcp-renamed', reason: '改名' })
  assert.equal(moved.isError, false)
  assert.match(moved.text, /topics\/mcp-renamed/)

  const del = await call(client, 'memwiki_delete', { page: 'topics/mcp-renamed', reason: '删' })
  assert.match(del.text, /\.trash\//)
  const trashPath = /\.trash\/[^\s]+/.exec(del.text)?.[0]
  assert.ok(trashPath)

  const restored = await call(client, 'memwiki_restore', { trashPath })
  assert.match(restored.text, /topics\/mcp-renamed/)

  const lint = await call(client, 'memwiki_lint', { fix: false })
  assert.equal(lint.isError, false)

  const log = await call(client, 'memwiki_log', { limit: 5 })
  assert.match(log.text, /\[cursor\]/)

  const missing = await call(client, 'memwiki_read', { page: '不存在的页面xyz' })
  assert.equal(missing.isError, true)
  assert.match(missing.text, /^NOT_FOUND/)
})
