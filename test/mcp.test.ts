import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { initVault } from '../src/core/vault.ts'
import { Memwiki } from '../src/memwiki.ts'
import { createMemwikiServer, type ServerOptions } from '../src/mcp/server.ts'
import { temporary, config } from './helpers.ts'
import { SecretStore } from '../src/secrets/store.ts'
import { plainProtector } from '../src/secrets/protector.ts'
import path from 'node:path'

async function connect(t: Parameters<typeof temporary>[0], options: ServerOptions = {}) {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open({ ...config(dir), agent: 'cursor', git: { autoCommit: false, autoPush: false } })
  t.after(() => wiki.close())
  const secretsDir = await temporary(t)
  const secrets = new SecretStore({ file: path.join(secretsDir, 'secrets.json'), protector: plainProtector, vaultDir: dir })
  const server = createMemwikiServer(wiki, secrets, options)
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

test('MCP rejects unknown arguments on every tool and missing body without clearing content', async t => {
  const { client, wiki } = await connect(t)
  const listed = await client.listTools()
  for (const tool of listed.tools) {
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
    const props = tool.inputSchema.properties as Record<string, { type?: string; enum?: unknown[] }>
    const args: Record<string, unknown> = { unknown_typo: true }
    for (const key of tool.inputSchema.required ?? []) {
      args[key] = props[key].enum?.[0] ?? (props[key].type === 'array' ? ['topics/body'] : 'test')
    }
    const response = await call(client, tool.name, args)
    assert.equal(response.isError, true, tool.name)
    assert.match(response.text, /unknown_typo/)
  }
  const create = { page: 'topics/body', mode: 'create', title: '正文校验', summary: '防止缺正文清空', reason: '测试' }
  const missingCreate = await call(client, 'memwiki_write', create)
  assert.match(missingCreate.text, /INVALID_META.*create\/replace 需要 body/)
  assert.equal(missingCreate.isError, true)
  assert.equal((await call(client, 'memwiki_write', { ...create, body: '保留正文\n', verify: '已读测试' })).isError, false)
  const original = (await wiki.read(create.page)).page
  assert.ok(original.meta.verified)
  for (const mode of ['replace', 'section']) {
    const args = { page: create.page, mode, rev: original.rev, heading: '章节', reason: '测试' }
    const missing = await call(client, 'memwiki_write', args)
    assert.match(missing.text, /INVALID_META.*需要 body/)
    assert.equal(missing.isError, true)
    const typo = await call(client, 'memwiki_write', { ...args, content: '误传正文' })
    assert.match(typo.text, /content/)
    assert.equal(typo.isError, true)
    assert.equal((await wiki.read(create.page)).page.rev, original.rev)
  }
  const replace = await call(client, 'memwiki_write', { page: create.page, mode: 'replace', rev: original.rev, body: '替换后正文\n', reason: '正常替换', verify: '对照内容' })
  assert.equal(replace.isError, false)
  assert.equal((await wiki.read(create.page)).page.body, '替换后正文\n')
  const empty = await call(client, 'memwiki_write', { page: create.page, mode: 'replace', rev: (await wiki.read(create.page)).page.rev, body: '', reason: '明确清空' })
  assert.equal(empty.isError, false)
  assert.equal((await wiki.read(create.page)).page.body, '')
})

test('MCP missing body is rejected before remote proposal interception', async t => {
  let proposals = 0
  const { client } = await connect(t, { remote: true, runTool: async () => {
    proposals++
    return { content: [{ type: 'text', text: '已提交待审' }] }
  } })
  for (const mode of ['create', 'replace', 'section']) {
    const missing = await call(client, 'memwiki_write', { mode, page: 'topics/missing', reason: '测试' })
    assert.equal(missing.isError, true)
    assert.match(missing.text, /INVALID_META.*需要 body/)
  }
  assert.equal(proposals, 0)
  const valid = await call(client, 'memwiki_write', { mode: 'create', page: 'topics/proposal', title: '提议', summary: '待审', body: '正文', reason: '测试' })
  assert.equal(valid.isError, false)
  assert.equal(proposals, 1)
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
  assert.equal(client.getServerVersion()?.version, '0.4.0')
  const prompts = await client.listPrompts()
  assert.deepEqual(prompts.prompts.map(prompt => prompt.name), ['memwiki-curate'])
  const searchSchema = (await client.listTools()).tools.find(tool => tool.name === 'memwiki_search')!.inputSchema
  assert.ok(!('includeSuperseded' in (searchSchema.properties ?? {})))
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
  await assert.rejects(wiki.read('topics/b'), { code: 'NOT_FOUND' })
  assert.match(merged.text, /源文件已删除/)
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

test('MCP title and summary update in every mode alongside metadata and body changes', async t => {
  const { client, wiki } = await connect(t)
  const page = 'topics/all-modes'
  const created = await call(client, 'memwiki_write', { page, mode: 'create', title: '初始', summary: '初始摘要', body: 'original\n', reason: '初始化' })
  assert.equal(created.isError, false, created.text)
  const operations = [
    { mode: 'replace', body: '## 相关\n旧文字\n', expected: '## 相关\n旧文字\n' },
    { mode: 'section', heading: '相关', body: '## 相关\n替换文字\n', expected: '## 相关\n替换文字\n' },
    { mode: 'edit', old: '替换文字', new: '精确文字', expected: '## 相关\n精确文字\n' },
    { mode: 'append', text: '追加文字', expected: '## 相关\n精确文字\n追加文字\n' },
    { mode: 'meta', expected: '## 相关\n精确文字\n追加文字\n' },
  ]
  for (const { expected, ...op } of operations) {
    const before = (await wiki.read(page)).page
    const title = `${op.mode} 标题`, summary = `${op.mode} 摘要`
    const result = await call(client, 'memwiki_write', { page, ...op, rev: before.rev, title, summary, meta: { title: '被覆盖标题', summary: '被覆盖摘要', tags: ['保留'], custom: op.mode }, reason: '更新' })
    assert.equal(result.isError, false, result.text)
    const after = (await wiki.read(page)).page
    assert.equal(after.meta.title, title)
    assert.equal(after.meta.summary, summary)
    assert.deepEqual(after.meta.tags, ['保留'])
    assert.equal(after.meta.custom, op.mode)
    assert.equal(after.meta.created, before.meta.created)
    assert.equal(after.body, expected)
  }
  const before = (await wiki.read(page)).page
  const metaOnly = await call(client, 'memwiki_write', { page, mode: 'meta', rev: before.rev, title: '仅标题', summary: '仅摘要', reason: '便捷页头' })
  assert.equal(metaOnly.isError, false, metaOnly.text)
  const current = (await wiki.read(page)).page
  assert.equal(current.meta.title, '仅标题')
  assert.equal(current.meta.summary, '仅摘要')
  assert.equal(current.body, before.body)
  const noRev = await call(client, 'memwiki_write', { page, mode: 'append', text: '不应追加', summary: '不应修改', reason: '缺少版本' })
  assert.equal(noRev.isError, true)
  assert.match(noRev.text, /INVALID_META.*rev/)
  const conflict = await call(client, 'memwiki_write', { page, mode: 'append', rev: before.rev, text: '不应追加', title: '不应修改', reason: '旧版本' })
  assert.equal(conflict.isError, true)
  assert.match(conflict.text, /^CONFLICT/)
  assert.equal((await wiki.read(page)).page.rev, current.rev)
  assert.equal((await call(client, 'memwiki_write', { page, mode: 'append', text: '正常追加', reason: '无需版本的正文追加' })).isError, false)
})

test('MCP accepts metadata objects with array fields and rejects other input shapes', async t => {
  const { client, wiki } = await connect(t)
  const page = 'topics/json-meta'
  const created = await call(client, 'memwiki_write', { page, mode: 'create', title: '页头对象', summary: '使用对象和数组', body: '正文\n', meta: { tags: ['windows', 'node'], aliases: ['别名一', '别名二'], custom: { keep: true } }, reason: '初始化' })
  assert.equal(created.isError, false, created.text)
  let current = (await wiki.read(page)).page
  assert.deepEqual(current.meta.tags, ['windows', 'node'])
  assert.deepEqual(current.meta.aliases, ['别名一', '别名二'])
  assert.deepEqual(current.meta.custom, { keep: true })
  for (const meta of ['{"tags":["a"]}', [], null, 42, true]) {
    const rejected = await call(client, 'memwiki_write', { page, mode: 'meta', rev: current.rev, meta, reason: '错误输入' })
    assert.equal(rejected.isError, true)
    assert.equal((await wiki.read(page)).page.rev, current.rev)
  }
  for (const meta of [{ tags: 'a, b' }, { aliases: '别名一，别名二' }]) {
    const rejected = await call(client, 'memwiki_write', { page, mode: 'meta', rev: current.rev, meta, reason: '必须为数组' })
    assert.equal(rejected.isError, true)
    assert.match(rejected.text, /^INVALID_META.*必须是字符串数组/)
    assert.equal((await wiki.read(page)).page.rev, current.rev)
  }
  const invalidFields = await call(client, 'memwiki_write', { page, mode: 'meta', rev: current.rev, meta: { tags: [1], summary: '摘'.repeat(137) }, reason: '字段错误' })
  assert.equal(invalidFields.isError, true)
  assert.match(invalidFields.text, /summary 超过 120 字（当前 137）/)
  assert.match(invalidFields.text, /tags 必须是字符串数组/)
  assert.match(invalidFields.text, /field:summary reason:超过 120 字/)
  assert.match(invalidFields.text, /field:tags reason:必须是字符串数组/)
  assert.equal((await wiki.read(page)).page.rev, current.rev)
  const deleted = await call(client, 'memwiki_write', { page, mode: 'meta', rev: current.rev, meta: { custom: null, tags: null }, reason: '删除字段' })
  assert.equal(deleted.isError, false, deleted.text)
  current = (await wiki.read(page)).page
  assert.equal('custom' in current.meta, false)
  assert.deepEqual(current.meta.tags, [])
})

test('MCP enforces summary length and reserved IDs and documents the write contract', async t => {
  const { client, wiki } = await connect(t)
  const tool = (await client.listTools()).tools.find(tool => tool.name === 'memwiki_write')!
  assert.match(tool.description!, /任何模式都可以顺手改 title\/summary/)
  const schema = tool.inputSchema.properties as Record<string, { description?: string }>
  assert.match(schema.summary.description!, /≤120 个字符，超了会被拒/)
  const input = { mode: 'create', title: '长度验证', summary: '😀'.repeat(121), body: '正文', reason: '验证' }
  const tooLong = await call(client, 'memwiki_write', { page: 'topics/long-summary', ...input })
  assert.equal(tooLong.isError, true)
  assert.match(tooLong.text, /^INVALID_META.*summary 超过 120 字（当前 121）/)
  assert.match(tooLong.text, /field:summary reason:超过 120 字/)
  await assert.rejects(wiki.read('topics/long-summary'), { code: 'NOT_FOUND' })
  const boundary = await call(client, 'memwiki_write', { page: 'topics/boundary', ...input, summary: '😀'.repeat(120) })
  assert.equal(boundary.isError, false, boundary.text)
  assert.equal((await wiki.read('topics/boundary')).page.meta.summary, '😀'.repeat(120))
  for (const page of ['_private', 'topics/_private']) {
    const reserved = await call(client, 'memwiki_write', { page, ...input, summary: '合法摘要' })
    assert.equal(reserved.isError, true)
    assert.match(reserved.text, /^INVALID_ID.*`_` 开头保留给特殊页面/)
  }
})

test('MCP usage explains the scope and an empty window, and append requires text', async t => {
  const { client, wiki } = await connect(t)
  const summary = JSON.parse((await call(client, 'memwiki_usage')).text)
  assert.match(summary.message, /这段时间没有发生这些事件/)
  assert.match(summary.scope, /零结果搜索/)
  assert.deepEqual(summary.counts, {})
  await call(client, 'memwiki_write', { page: 'topics/append', mode: 'create', title: '追加', summary: '追加说明', body: '初始', reason: '创建' })
  const result = await call(client, 'memwiki_write', { page: 'topics/append', mode: 'append', body: '其他参数', reason: '缺少 text' })
  assert.equal(result.isError, true)
  assert.match(result.text, /append 需要 text/)
  assert.equal((await wiki.read('topics/append')).page.body, '初始')
})
