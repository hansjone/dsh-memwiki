import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initVault } from '../src/core/vault.ts'
import { Memwiki } from '../src/memwiki.ts'
import { createMemwikiServer } from '../src/mcp/server.ts'
import { temporary, config } from './helpers.ts'
import { SecretStore } from '../src/secrets/store.ts'
import { plainProtector } from '../src/secrets/protector.ts'
import path from 'node:path'

async function connect(t: Parameters<typeof temporary>[0]) {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open({ ...config(dir), agent: 'cursor', git: { autoCommit: false } })
  t.after(() => wiki.close())
  const secretsDir = await temporary(t)
  const secrets = new SecretStore({ file: path.join(secretsDir, 'secrets.json'), protector: plainProtector, vaultDir: dir })
  const server = createMemwikiServer(wiki, secrets)
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await server.connect(serverTransport)
  await client.connect(clientTransport)
  t.after(async () => { await client.close(); await server.close() })
  return { wiki, client, dir, secrets }
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
  assert.equal(moved.isError, false, moved.text)
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

test('MCP four secret tools protect metadata outputs, require purpose and redirect rejected wiki writes', async t => {
  const { client, secrets } = await connect(t)
  const tools = await client.listTools()
  for (const suffix of ['list', 'get', 'set', 'delete']) assert.ok(tools.tools.some(tool => tool.name === `memwiki_secret_${suffix}`))
  assert.ok(Buffer.byteLength(client.getInstructions() ?? '') <= 1536)
  const value = 'unique-mcp-password-987654'
  const set = await call(client, 'memwiki_secret_set', { name: 'test-admin', value, scope: '仅用于测试' })
  assert.equal(set.isError, false)
  assert.ok(!set.text.includes(value))
  const list = await call(client, 'memwiki_secret_list')
  assert.match(list.text, /test-admin/)
  assert.ok(!list.text.includes(value))
  assert.ok(!list.text.includes('"value"'))
  const missingPurpose = await call(client, 'memwiki_secret_get', { name: 'test-admin' })
  assert.equal(missingPurpose.isError, true)
  const get = await call(client, 'memwiki_secret_get', { name: 'test-admin', purpose: '本地测试登录' })
  assert.equal(get.isError, false)
  assert.match(get.text, /不要回显给用户/)
  assert.ok(get.text.includes(value))
  assert.equal((await secrets.accessLog())[0].purpose, '本地测试登录')
  assert.ok(!JSON.stringify(await secrets.accessLog()).includes(value))
  const blocked = await call(client, 'memwiki_write', { page: 'topics/password', mode: 'create', title: '测试', summary: '扫描拒绝', body: `password=${value}`, reason: '验证' })
  assert.equal(blocked.isError, true)
  assert.match(blocked.text, /memwiki_secret_set/)
  assert.ok(!blocked.text.includes(value))
  const deleted = await call(client, 'memwiki_secret_delete', { name: 'test-admin' })
  assert.equal(deleted.isError, false)
  assert.ok(!deleted.text.includes(value))
  assert.match((await call(client, 'memwiki_secret_get', { name: 'test-admin', purpose: '确认删除' })).text, /NOT_FOUND/)
})

test('maintenance MCP tools and curate prompt are registered and work through transport', async t => {
  const { client, wiki } = await connect(t)
  const names = (await client.listTools()).tools.map(tool => tool.name)
  for (const name of ['memwiki_merge', 'memwiki_verify', 'memwiki_feedback', 'memwiki_usage']) assert.ok(names.includes(name))
  assert.equal(client.getServerVersion()?.version, '0.2.0')
  const prompts = await client.listPrompts()
  assert.ok(prompts.prompts.some(prompt => prompt.name === 'memwiki-curate'))
  const prompt = await client.getPrompt({ name: 'memwiki-curate' })
  const promptText = JSON.stringify(prompt.messages)
  for (const phrase of ['纠正优先于补充', '只汇报不改代码', '删除内容前确认', '禁止改写 git 历史', 'memwiki_verify']) assert.ok(promptText.includes(phrase))
  const create = (page: string) => call(client, 'memwiki_write', { page, mode: 'create', title: '重复主题', summary: '合并测试', body: '旧内容\n', reason: '初始化' })
  assert.equal((await create('topics/a')).isError, false)
  assert.match((await create('topics/b')).text, /SIMILAR_EXISTS/)
  assert.equal((await call(client, 'memwiki_write', { page: 'topics/b', mode: 'create', title: '重复主题', summary: '合并测试', body: '独有内容\n', force: true, reason: '测试独立来源' })).isError, false)
  const rev = (await wiki.read('topics/a')).page.rev
  const merged = await call(client, 'memwiki_merge', { from: ['topics/b'], into: 'topics/a', rev, body: '当前正确且完整的说法\n', reason: '收敛' })
  assert.equal(merged.isError, false, merged.text)
  assert.equal((await wiki.read('topics/b')).page.meta.status, 'superseded')
  assert.equal((await wiki.read('topics/a')).page.body, '当前正确且完整的说法\n')
  assert.equal((await call(client, 'memwiki_verify', { page: 'topics/a', note: '核实依据' })).isError, false)
  const feedback = await call(client, 'memwiki_feedback', { kind: 'rule', title: '规则边界', scenario: '测试场景', expected: '明确说明', actual: '暂未说明' })
  assert.equal(feedback.isError, false)
  const id = /feedback-[a-f0-9]{12}/u.exec(feedback.text)![0]
  assert.match((await call(client, 'memwiki_feedback', { action: 'list' })).text, /规则边界/)
  assert.equal((await call(client, 'memwiki_feedback', { action: 'resolve', id, resolution: '补充规范' })).isError, false)
  assert.equal(wiki.feedbackList().length, 0)
  await call(client, 'memwiki_search', { query: 'zzzz-unfindable' })
  assert.match((await call(client, 'memwiki_usage', { days: 7 })).text, /SEARCH_ZERO/)
})
