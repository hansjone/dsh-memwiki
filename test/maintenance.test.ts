import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir, writeFile, stat } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { Store } from '../src/core/store.ts'
import { initVault } from '../src/core/vault.ts'
import { localDate } from '../src/core/page.ts'
import { Memwiki } from '../src/memwiki.ts'
import { MemwikiError } from '../src/types.ts'
import { resolveConfig } from '../src/config.ts'
import { contentSimilarity, createSimilarity, similarPages, shingles, jaccard } from '../src/search/similarity.ts'
import { factTokens } from '../src/search/facts.ts'
import { lintRecords, fixFor } from '../src/search/lint.ts'
import { appendUsage, usageSummary, USAGE_MAX_BYTES } from '../src/core/usage.ts'
import { record } from './record.ts'
import { config, temporary, code } from './helpers.ts'

const exec = promisify(execFile)
const ctx = { agent: 'codex', reason: '验证自维护' }
const prose = '家庭网络主网关 MikroTik 使用 RouterOS 7.12.1，管理地址是 10.0.0.1。EasyMesh 的二层环路导致掉速，需要先断开重复上联，再核对 VLAN 配置与备份位置。'
async function fixture(t: Parameters<typeof temporary>[0], git = false) {
  const dir = await temporary(t)
  await initVault(dir, { git })
  const wiki = await Memwiki.open({ ...config(dir), git: { autoCommit: git, autoPush: false } })
  t.after(() => wiki.close())
  const create = (id: string, title: string, body = prose, extra = {}) => wiki.write({ kind: 'create', id,
    meta: { title, summary: `${title}说明`, ...extra }, body, force: true }, ctx)
  return { dir, wiki, create }
}

test('similarity is bounded, explainable and ignores reference-only/short prose', () => {
  assert.equal(jaccard(shingles('ＡＢＣ'), shingles('abc')), 1)
  assert.equal(jaccard(new Set(), new Set()), 0)
  const a = record('topics/a', { title: '家庭网络', summary: '主网关' }, prose)
  const b = record('topics/b', { title: '家庭网络', summary: '主网关' }, prose)
  assert.equal(createSimilarity(a, b), 1)
  assert.equal(contentSimilarity('见 [[10.0.0.1|网关]]', '见 [[10.0.0.1|网关]]'), 0)
  assert.equal(contentSimilarity('[说明](https://host/10.0.0.1)', '[说明](https://host/10.0.0.1)'), 0)
  assert.equal(contentSimilarity('很短的内容', '很短的内容'), 0)
  assert.deepEqual(similarPages(a, [b, { ...b, id: 'inbox/x' }, { ...b, id: '_guide' }, { ...b, id: 'meta/feedback/2026-10' }]).map(h => h.id), ['topics/b'])
})

test('create blocks similar content, returns three candidates, permits different topics and justified force', async t => {
  const { wiki, create } = await fixture(t)
  for (let i = 0; i < 4; i++) await create(`topics/old-${i}`, `家庭网络 ${i}`)
  const op = { kind: 'create' as const, id: 'topics/new', meta: { title: '家庭网络', summary: '主网关说明' }, body: prose }
  await assert.rejects(wiki.write(op, ctx), err => {
    assert.ok(err instanceof MemwikiError)
    assert.equal(err.code, 'SIMILAR_EXISTS')
    const candidates = err.details?.candidates as { id: string; title: string; summary: string; similarity: number }[]
    assert.equal(candidates.length, 3)
    assert.ok(candidates.every(hit => hit.id && hit.title && hit.summary && hit.similarity >= 0.72))
    return true
  })
  await assert.rejects(wiki.read(op.id), code('NOT_FOUND'))
  await assert.rejects(wiki.write({ ...op, force: true }, { ...ctx, reason: ' ' }), code('INVALID_META'))
  await assert.rejects(wiki.write({ ...op, force: true }, { agent: ctx.agent } as typeof ctx), code('INVALID_META'))
  const reason = '  独立主题，保留理由原文  '
  await wiki.write({ ...op, force: true }, { ...ctx, reason })
  assert.equal((await wiki.log())[0].reason, reason)
  await wiki.write({ kind: 'create', id: 'topics/cooking', meta: { title: '烘焙温度', summary: '面包与酵母发酵' }, body: '面团先发酵，再预热烤箱。' }, ctx)
  await wiki.remember(prose, { agent: 'codex' })
  await wiki.remember(prose, { agent: 'codex' })
  await assert.rejects(wiki.write({ ...op, id: 'topics/unsafe-force', force: true, body: 'token=NEVER-STORE-987654321' }, ctx), code('SECRET_DETECTED'))
})

test('concurrent similar creates have one winner across distinct IDs', async t => {
  const { wiki } = await fixture(t)
  const create = (id: string) => wiki.write({ kind: 'create', id, meta: { title: '同一主题', summary: '唯一归属' }, body: prose }, ctx)
  const results = await Promise.allSettled([create('topics/a'), create('topics/b')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const rejected = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.ok(code('SIMILAR_EXISTS')(rejected.reason))
})

test('vault thresholds are loaded, validated and actually change create/lint behavior', async t => {
  const { dir, wiki, create } = await fixture(t)
  await create('topics/a', '甲')
  await wiki.close()
  const manifest = JSON.parse(await readFile(path.join(dir, 'memwiki.json'), 'utf8'))
  manifest.settings = { similarCreateThreshold: 0.99, overlapThreshold: 1 }
  await writeFile(path.join(dir, 'memwiki.json'), JSON.stringify(manifest))
  const resolved = await resolveConfig({ dir, env: {} })
  assert.equal(resolved.similarCreateThreshold, 0.99)
  const store = new Store(resolved)
  await store.write({ kind: 'create', id: 'topics/b', meta: { title: '乙', summary: '乙' }, body: prose }, ctx)
  for (const value of [-1, 1.1, '0.7', null]) {
    manifest.settings.overlapThreshold = value
    await writeFile(path.join(dir, 'memwiki.json'), JSON.stringify(manifest))
    await assert.rejects(resolveConfig({ dir, env: {} }), code('INVALID_META'))
  }
  const a = record('topics/a', {}, prose), b = record('topics/b', {}, prose + '另有一个独立检查步骤。')
  assert.ok(lintRecords([a, b], { staleDays: 90, now: new Date(), inboxEntries: [], overlapThreshold: 0.1 }).some(i => i.code === 'overlap'))
  assert.ok(!lintRecords([a, b], { staleDays: 90, now: new Date(), inboxEntries: [], overlapThreshold: 1 }).some(i => i.code === 'overlap'))
})

test('merge rewrites links/suffixes, transfers names, deletes sources and makes one commit/log', async t => {
  const { dir, wiki, create } = await fixture(t, true)
  const { result: target } = await create('topics/owner', '归属页', '保留正文\n', { aliases: ['已有别名'], custom: true })
  await create('topics/a', '旧标题', '旧内容\n', { aliases: ['OldAlias'] })
  await create('topics/b', '另一旧标题', '另一个内容\n', { aliases: ['B'] })
  await create('howto/links', '链接页', '[[TOPICS/A#章节|显示]] [[旧标题]] [[oldalias|A]] [[B]] `[[B]]`\n```\n[[topics/a]]\n```\n')
  const beforeCount = Number((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout)
  const beforeLog = (await wiki.log(100)).length
  const { result, commitSha } = await wiki.merge({ from: ['OldAlias', 'topics/b'], into: 'topics/owner', rev: target.page.rev,
    meta: { summary: '集中维护' }, ctx })
  assert.ok(commitSha)
  assert.equal(Number((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout), beforeCount + 1)
  assert.equal((await wiki.log(100)).length, beforeLog + 1)
  assert.equal((await exec('git', ['log', '-1', '--format=%s'], { cwd: dir })).stdout.trim(), '[codex] merge topics/a, topics/b -> topics/owner：验证自维护')
  assert.equal(result.page.body, target.page.body)
  assert.equal(result.page.meta.custom, true)
  for (const name of ['已有别名', '旧标题', 'OldAlias', '另一旧标题', 'B']) {
    assert.ok(result.page.meta.aliases.includes(name))
    assert.equal((await wiki.read(name)).page.id, 'topics/owner')
  }
  for (const id of ['topics/a', 'topics/b']) {
    await assert.rejects(wiki.read(id), code('NOT_FOUND'))
    await assert.rejects(stat(path.join(dir, id + '.md')), { code: 'ENOENT' })
    assert.ok(result.changedPaths.includes(id + '.md'))
    assert.ok(!result.pages.some(p => p.id === id))
    assert.ok(!wiki.search({ query: '旧内容' }).some(hit => hit.id === id))
    assert.ok(!wiki.context().includes('[[' + id + ']]'))
  }
  assert.ok(!(await readFile(path.join(dir, 'index.md'), 'utf8')).includes('[[topics/a|'))
  assert.ok(!(await readdir(path.join(dir, '.trash'))).length)
  assert.deepEqual((await wiki.read('topics/owner')).backlinks, ['howto/links'])
  assert.equal((await wiki.read('howto/links')).page.body, '[[topics/owner#章节|显示]] [[topics/owner]] [[topics/owner|A]] [[topics/owner]] `[[B]]`\n```\n[[topics/a]]\n```\n')
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: dir })).stdout, '')
  const tracked = (await exec('git', ['ls-files', '.memwiki'], { cwd: dir })).stdout
  assert.equal(tracked, '')
})

test('merge validation failures change no pages, catalog, log or git history', async t => {
  const { dir, wiki, create } = await fixture(t, true)
  const target = (await create('topics/c', '目标', 'safe\n')).result.page
  await create('topics/a', '来源', 'safe source\n')
  const snapshot = async () => Promise.all(['topics/a.md', 'topics/c.md', 'index.md', `log/${localDate().slice(0, 7)}.md`].map(rel => readFile(path.join(dir, rel), 'utf8')))
  const before = await snapshot()
  const head = (await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout
  for (const from of [['topics/c'], ['topics/a', 'missing'], [], ['topics/a', '来源']]) {
    await assert.rejects(wiki.merge({ from, into: target.id, rev: target.rev, ctx }))
    assert.deepEqual(await snapshot(), before)
  }
  await assert.rejects(wiki.merge({ from: ['topics/a'], into: target.id, rev: 'bad', ctx }), code('CONFLICT'))
  await assert.rejects(wiki.merge({ from: ['topics/a'], into: 'missing', rev: target.rev, ctx }), code('NOT_FOUND'))
  await assert.rejects(wiki.merge({ from: ['topics/a'], into: target.id, rev: target.rev, body: 'password=DO-NOT-STORE-987654', ctx }), code('SECRET_DETECTED'))
  assert.deepEqual(await snapshot(), before)
  assert.equal((await exec('git', ['rev-parse', 'HEAD'], { cwd: dir })).stdout, head)
})

test('verify restores stale without rev and only changes verified/status; note is logged', async t => {
  const { wiki, create } = await fixture(t)
  const page = (await create('topics/old', '待核实', '正文原样\r\n', { status: 'stale', verified: '2000-01-01', sources: ['file:proof'] })).result.page
  const { result } = await wiki.verify(page.id, { note: '已对照设备核实', ctx })
  assert.deepEqual(result.page.meta, { ...page.meta, verified: localDate(), status: 'active' })
  assert.equal(result.page.body, page.body)
  assert.equal((await wiki.log())[0].reason, '已对照设备核实')
  assert.ok(!(await wiki.lint()).issues.some(i => i.code === 'stale_candidate'))
})

test('fact token rules handle addresses, dotted versions, paths and ports with negative cases', () => {
  const tokens = factTokens('RouterOS 7.12.1 IP 10.0.0.1:8890 Windows C:\\Users\\me\\app Unix /usr/local/bin and :8080 12:30 999.1.2.3 :99999 https://example.com/path')
  for (const token of ['7.12.1', '10.0.0.1', ':8890', 'c:/users/me/app', '/usr/local/bin', ':8080']) assert.ok(tokens.has(token), token)
  for (const token of [':30', '999.1.2.3', ':99999', '/example.com/path', '/path']) assert.ok(!tokens.has(token), token)
  assert.deepEqual([...factTokens('普通文字 1234 12:30 https://example.com/a')], [])
  assert.deepEqual([...factTokens('127.0.0.1 0.0.0.0 10.0.0.0 10.0.0.255 /ip /etc fe80::2 2408:8207::4 a:22')], [])
  assert.deepEqual([...factTokens('localhost:5173 git.avelo.top:2222')].sort(), [':2222', ':5173'])
})

test('content lint excludes special/inbox/meta pages, aggregates facts and never auto-fixes', () => {
  const records = ['topics/a', 'topics/b', 'topics/c'].map(id => record(id, {}, prose))
  const ignored = [record('_guide', {}, prose), record('inbox/a', { type: 'inbox' }, prose), record('meta/feedback/2026-10', { type: 'meta' }, prose)]
  const opts = { staleDays: 90, now: new Date(), inboxEntries: [] }
  const issues = lintRecords([...records, ...ignored], opts)
  const overlaps = issues.filter(i => i.code === 'overlap')
  assert.equal(overlaps.length, 3)
  assert.ok(overlaps.every(i => i.similarity === 1 && i.pages?.length === 2 && i.severity === 'warning'))
  const ip = issues.find(i => i.code === 'fact_repeat' && i.token === '10.0.0.1')!
  assert.deepEqual(ip.pages, records.map(r => r.id))
  assert.equal(ip.severity, 'info')
  for (const issue of [...overlaps, ip]) { assert.equal(issue.fixable, false); assert.equal(fixFor(issue, records[0]), undefined) }
  assert.ok(!lintRecords(records.slice(0, 2), opts).some(i => i.code === 'fact_repeat'))
  const links = ['topics/x', 'topics/y', 'topics/z'].map(id => record(id, {}, '请见 [[topics/a|10.0.0.1]]'))
  assert.ok(!lintRecords(links, opts).some(i => i.code === 'overlap'))
})

test('content lint bounds overlap pairs and grouped fact warnings to avoid flooding', () => {
  const body = prose + '\n' + Array.from({ length: 15 }, (_, i) => `10.0.1.${i}`).join(' ')
  const pages = Array.from({ length: 8 }, (_, i) => record(`topics/${i}`, {}, body))
  const issues = lintRecords(pages, { staleDays: 90, now: new Date(), inboxEntries: [] })
  assert.equal(issues.filter(i => i.code === 'overlap').length, 20)
  assert.equal(issues.filter(i => i.code === 'fact_repeat').length, 10)
})

test('five-page household fixture reports repeated facts, then merge converges to one owner', async t => {
  const { wiki, create } = await fixture(t)
  const pages = []
  for (const title of ['拓扑', '设备', '掉速', 'VLAN', '决定']) pages.push((await create(`projects/家庭网络/${title}`, title, `${prose}\n${title}检查说明。`)).result.page)
  const before = await wiki.lint()
  assert.ok(before.issues.some(i => i.code === 'overlap'))
  assert.ok(before.issues.some(i => i.code === 'fact_repeat' && i.token === '7.12.1' && i.pages?.length === 5))
  await wiki.merge({ from: pages.slice(1).map(p => p.id), into: pages[0].id, rev: pages[0].rev, body: prose, ctx })
  assert.ok(!(await wiki.lint()).issues.some(i => ['overlap', 'fact_repeat'].includes(i.code)))
})

test('feedback appends unique monthly entries concurrently, summarizes context/lint and resolves one entry', async t => {
  const { wiki, dir } = await fixture(t)
  const input = { kind: 'friction' as const, title: '工具错误缺少定位', scenario: '修改摘要时失败', expected: '返回字段名', actual: '只显示非法页头', ctx }
  const entries = await Promise.all(Array.from({ length: 3 }, () => wiki.feedback(input)))
  assert.equal(new Set(entries.map(e => e.id)).size, 3)
  assert.equal(wiki.feedbackList().length, 3)
  assert.equal(wiki.feedbackList()[0].page, `meta/feedback/${localDate().slice(0, 7)}`)
  assert.match(wiki.context(), /有 3 条反馈待处理/)
  assert.ok(!wiki.context().includes('[[meta/feedback/'))
  assert.ok(!(await wiki.lint()).issues.some(i => i.code === 'orphan' && i.page?.startsWith('meta/')))
  const issue = (await wiki.lint()).issues.find(i => i.code === 'feedback_open')!
  assert.match(issue.message, /3 条/)
  assert.equal(issue.fixable, false)
  await wiki.feedbackResolve(entries[0].id, 'v0.2.0 修复', ctx)
  assert.equal(wiki.feedbackList().length, 2)
  assert.equal(wiki.feedbackList(true).length, 3)
  assert.equal(wiki.feedbackList(true).find(e => e.id === entries[0].id)?.status, '已解决：v0.2.0 修复')
  assert.match(await readFile(path.join(dir, 'index.md'), 'utf8'), /## meta/)
  await assert.rejects(wiki.feedbackResolve('feedback-notfound', '处理', ctx), code('NOT_FOUND'))
  await assert.rejects(wiki.feedback({ ...input, actual: 'token=DO-NOT-STORE-987654' }), code('SECRET_DETECTED'))
})

test('usage signals record only allowlisted context, redact query secrets and relate subsequent force', async t => {
  const { wiki, dir, create } = await fixture(t)
  const page = (await create('topics/a', '网络', 'alpha alpha\n')).result.page
  wiki.search({ query: '找不到的关键词' })
  wiki.search({ query: 'token=PRIVATE-CREDENTIAL-987654' })
  for (const [old, error] of [['missing', 'EDIT_NOT_FOUND'], ['alpha', 'AMBIGUOUS_EDIT']] as const) {
    await assert.rejects(wiki.write({ kind: 'edit', id: page.id, rev: page.rev, old, new: 'BODY-PRIVATE-CONTENT' }, ctx), code(error))
  }
  await assert.rejects(wiki.write({ kind: 'replace', id: page.id, rev: 'bad', body: 'BODY-PRIVATE-CONTENT' }, ctx), code('CONFLICT'))
  await assert.rejects(wiki.remember('password=PRIVATE-CREDENTIAL-987654', { agent: 'claude' }), code('SECRET_DETECTED'))
  const op = { kind: 'create' as const, id: 'topics/duplicate', meta: { title: '网络', summary: '网络说明' }, body: 'BODY-PRIVATE-CONTENT' }
  await assert.rejects(wiki.write(op, ctx), code('SIMILAR_EXISTS'))
  await wiki.write({ ...op, force: true }, { ...ctx, reason: '确实不同' })
  const summary = await wiki.usage()
  for (const event of ['SEARCH_ZERO', 'CONFLICT', 'SECRET_DETECTED', 'EDIT_NOT_FOUND', 'AMBIGUOUS_EDIT', 'SIMILAR_EXISTS', 'FORCE_CREATE'] as const) assert.ok(summary.counts[event])
  const raw = await readFile(path.join(dir, '.memwiki/usage.jsonl'), 'utf8')
  assert.ok(!raw.includes('BODY-PRIVATE-CONTENT'))
  assert.ok(!raw.includes('PRIVATE-CREDENTIAL-987654'))
  assert.ok(!raw.includes(ctx.reason))
  const entries = raw.trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(entries.filter(e => e.event === 'SECRET_DETECTED')[0].rules, ['credential'])
  assert.equal(entries.find(e => e.event === 'SIMILAR_EXISTS').pageKey, entries.at(-1).pageKey)
})

test('usage rotates at 1 MB, retains one generation, applies date filter and limits Top 10', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const file = path.join(dir, '.memwiki/usage.jsonl')
  await writeFile(file, 'x'.repeat(USAGE_MAX_BYTES))
  await appendUsage(dir, { agent: 'codex', event: 'CONFLICT' })
  assert.equal((await stat(file + '.1')).size, USAGE_MAX_BYTES)
  await writeFile(file, 'y'.repeat(USAGE_MAX_BYTES))
  await appendUsage(dir, { agent: 'codex', event: 'EDIT_NOT_FOUND' })
  assert.ok((await readFile(file + '.1', 'utf8')).startsWith('y'))
  for (let i = 0; i < 12; i++) await appendUsage(dir, { agent: 'test', event: 'SEARCH_ZERO', query: `query ${i}` })
  const summary = await usageSummary(dir, 7)
  assert.equal(summary.zeroQueries.length, 10)
  assert.equal(summary.counts.EDIT_NOT_FOUND, 1)
  await writeFile(file + '.1', JSON.stringify({ at: '2000-01-01T00:00:00Z', agent: 'test', event: 'CONFLICT' }) + '\n')
  assert.equal((await usageSummary(dir)).counts.CONFLICT, undefined)
  assert.deepEqual((await readdir(path.join(dir, '.memwiki'))).filter(n => n.startsWith('usage')).sort(), ['usage.jsonl', 'usage.jsonl.1'])
})

test('usage describes its limited event scope and explicitly reports an empty time window', async t => {
  const { wiki, create, dir } = await fixture(t)
  const empty = await wiki.usage()
  assert.deepEqual(empty.counts, {})
  assert.deepEqual(empty.zeroQueries, [])
  assert.match(empty.message, /这段时间没有发生这些事件/)
  for (const event of ['SEARCH_ZERO', 'CONFLICT', 'SECRET_DETECTED', 'EDIT_NOT_FOUND', 'AMBIGUOUS_EDIT', 'SIMILAR_EXISTS', 'FORCE_CREATE']) assert.ok(empty.scope.includes(event))
  assert.match(empty.scope, /不统计正常搜索、阅读或其他成功写入/)
  await wiki.write({ kind: 'create', id: 'topics/normal', meta: { title: '正常', summary: '正常操作' }, body: 'keyword' }, ctx)
  wiki.search({ query: 'keyword' })
  await wiki.read('topics/normal')
  assert.deepEqual((await wiki.usage()).counts, {})
  await create('topics/forced', '强制')
  assert.equal((await wiki.usage()).counts.FORCE_CREATE, 1)
  assert.ok(!(await wiki.usage()).message.includes('没有发生'))
  assert.match((await usageSummary(dir, 7, new Date('2100-01-01'))).message, /这段时间没有发生这些事件/)
})

test('lint converts Markdown page links, then backlinks, broken links, move and merge use wikilinks', async t => {
  const { dir, wiki, create } = await fixture(t, true)
  await create('topics/source', '源页', '来源正文')
  await create('topics/owner', '归属', '归属正文')
  const body = '[显示](../topics/source.md#章节) [断链](../topics/missing.md) `[示例](../topics/source.md)`\n'
  await create('howto/links', '操作页', body)
  assert.deepEqual((await wiki.read('topics/source')).backlinks, [])
  const issues = (await wiki.lint()).issues.filter(i => i.code === 'markdown_link')
  assert.equal(issues.length, 1)
  assert.equal(issues[0].page, 'howto/links')
  assert.equal(issues[0].fixable, true)
  assert.equal((await wiki.read('howto/links')).page.body, body)
  const beforeLog = (await wiki.log(100)).length
  const result = await wiki.lint({ fix: true })
  assert.equal(result.fixed, 1)
  assert.ok(result.commitSha)
  assert.equal((await wiki.log(100)).length, beforeLog + 1)
  assert.ok(!result.issues.some(i => i.code === 'markdown_link'))
  assert.ok(result.issues.some(i => i.code === 'broken_link' && i.page === 'howto/links'))
  assert.equal((await wiki.read('howto/links')).page.body, '[[topics/source#章节|显示]] [[topics/missing|断链]] `[示例](../topics/source.md)`\n')
  assert.deepEqual((await wiki.read('topics/source')).backlinks, ['howto/links'])
  assert.deepEqual((await wiki.read('howto/links')).brokenLinks, ['topics/missing'])
  assert.ok(wiki.search({ query: '显示' }).some(hit => hit.id === 'howto/links'))
  await wiki.move('topics/source', 'topics/moved', ctx)
  assert.match((await wiki.read('howto/links')).page.body, /\[\[topics\/moved#章节\|显示\]\]/)
  const owner = (await wiki.read('topics/owner')).page
  await wiki.merge({ from: ['topics/moved'], into: owner.id, rev: owner.rev, ctx })
  assert.deepEqual((await wiki.read(owner.id)).backlinks, ['howto/links'])
  assert.match((await wiki.read('howto/links')).page.body, /\[\[topics\/owner#章节\|显示\]\]/)
  assert.equal((await wiki.lint({ fix: true })).fixed, 0)
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: dir })).stdout, '')
})
