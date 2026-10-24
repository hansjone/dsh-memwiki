import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Store } from '../src/core/store.ts'
import { initVault } from '../src/core/vault.ts'
import { localDate, serializePage } from '../src/core/page.ts'
import { remoteActor } from '../src/core/actor.ts'
import { MAX_BODY_BYTES } from '../src/core/limits.ts'
import { lintRecords } from '../src/search/lint.ts'
import { buildContext, buildIndexMd } from '../src/search/catalog.ts'
import { createSearchEngine } from '../src/search/engine.ts'
import type { WriteOp } from '../src/types.ts'
import { config, temporary, code } from './helpers.ts'
import { record } from './record.ts'

const exec = promisify(execFile)
const ctx = { agent: 'codex', reason: '测试' }
const meta = { title: '大小约束', summary: '验证正文大小限制' }
const lintOptions = { now: new Date(), staleDays: 90, inboxEntries: [] }

test('all body modes enforce UTF-8 limit atomically, but allow reducing oversized old pages', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const store = new Store(config(dir))
  const huge = '中'.repeat(7000)
  await assert.rejects(store.write({ kind: 'create', id: 'topics/large', meta, body: huge }, ctx), code('PAGE_TOO_LARGE'))
  await assert.rejects(store.get('topics/large'), code('NOT_FOUND'))
  const id = 'topics/body'
  let page = (await store.write({ kind: 'create', id, meta, body: 'a'.repeat(MAX_BODY_BYTES) }, ctx)).page
  assert.equal(Buffer.byteLength(page.body), MAX_BODY_BYTES)
  const failures: WriteOp[] = [
    { kind: 'replace', id, rev: page.rev, body: huge },
    { kind: 'append', id, text: '中' },
    { kind: 'edit', id, rev: page.rev, old: page.body, new: huge },
    { kind: 'section', id, rev: page.rev, heading: '新节', body: huge },
  ]
  for (const op of failures) {
    await assert.rejects(store.write(op, ctx), code('PAGE_TOO_LARGE'))
    assert.equal((await store.get(id)).rev, page.rev)
  }
  for (const op of [
    { kind: 'create', id: 'topics/missing', meta },
    { kind: 'replace', id, rev: page.rev },
    { kind: 'section', id, rev: page.rev, heading: '章节' },
  ]) await assert.rejects(store.write(op as WriteOp, ctx), code('INVALID_META'))
  // Simulate an existing large page edited externally, without weakening the new write guard.
  const seed = async (body: string) => {
    await writeFile(page.path, serializePage(page.meta, body))
    return (await new Store(config(dir)).get(id))
  }
  const shrinking: Array<(rev: string) => WriteOp> = [
    rev => ({ kind: 'replace', id, rev, body: 'a'.repeat(MAX_BODY_BYTES + 100) }),
    rev => ({ kind: 'edit', id, rev, old: '删掉这一句', new: '' }),
    rev => ({ kind: 'section', id, rev, heading: '章节', body: 'a'.repeat(MAX_BODY_BYTES + 100) }),
  ]
  for (const make of shrinking) {
    page = await seed('## 章节\n' + 'a'.repeat(MAX_BODY_BYTES + 200) + '删掉这一句\n')
    const reduced = await store.write(make(page.rev), ctx)
    assert.ok(Buffer.byteLength(reduced.page.body) > MAX_BODY_BYTES)
    assert.ok(Buffer.byteLength(reduced.page.body) < Buffer.byteLength(page.body))
  }
  page = await seed(huge)
  await assert.rejects(store.write({ kind: 'replace', id, rev: page.rev, body: huge }, ctx), code('PAGE_TOO_LARGE'))
  assert.equal((await store.write({ kind: 'meta', id, rev: page.rev, meta: { summary: '先修摘要' } }, ctx)).page.body, huge)
  const exempt = await store.write({ kind: 'create', id: 'meta/large', meta, body: huge }, ctx)
  const appended = await store.write({ kind: 'append', id: exempt.page.id, text: huge }, ctx)
  assert.ok(Buffer.byteLength(appended.page.body) > MAX_BODY_BYTES)
  assert.equal(lintRecords([record('meta/large', {}, huge)], lintOptions).some(i => i.code === 'oversized'), false)
  assert.equal(lintRecords([record(id, {}, huge)], lintOptions).some(i => i.code === 'oversized'), true)
})

test('all storage write paths cap deduplicated sources to the latest ten, including remote attribution', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const store = new Store(config(dir))
  const sources = Array.from({ length: 15 }, (_, i) => `file:${i}`)
  let page = (await store.write({ kind: 'create', id: 'topics/sources', body: 'body\n', meta: { ...meta, sources: [...sources, sources[4]] } }, ctx)).page
  assert.deepEqual(page.meta.sources, [...sources.slice(6), sources[4]])
  for (const op of ['replace', 'append', 'edit', 'section', 'meta'] as const) {
    const before = [...sources, sources[0]]
    const common = { id: page.id, rev: page.rev, meta: { sources: before } }
    const write: WriteOp = op === 'replace' ? { ...common, kind: op, body: 'body\n' }
      : op === 'append' ? { ...common, kind: op, text: 'append\n' }
        : op === 'edit' ? { ...common, kind: op, old: 'body', new: 'edited' }
          : op === 'section' ? { ...common, kind: op, heading: '节', body: '正文' }
            : { ...common, kind: op }
    page = (await remoteActor.run({ sub: 'u_test', name: '测试者' }, () => store.write(write, { ...ctx, source: 'file:new' }))).page
    assert.deepEqual(page.meta.sources, [...sources.slice(8), sources[0], 'hub:u_test (测试者)', 'file:new'])
    assert.equal(page.meta.updated_by, 'u_test')
  }
  page = (await store.move(page.id, 'topics/moved', { ...ctx, source: 'file:move' })).page
  assert.equal(page.meta.sources?.length, 10)
  assert.equal(page.meta.sources?.at(-1), 'file:move')
  const deleted = await store.delete(page.id, ctx)
  page = (await store.restore(deleted.trashPath, { ...ctx, source: 'file:restore' })).page
  assert.equal(page.meta.sources?.length, 10)
  assert.equal(page.meta.sources?.at(-1), 'file:restore')
  await store.write({ kind: 'create', id: 'topics/from', meta: { title: '不同来源', summary: '用于合并' }, body: '别的内容\n', force: true }, ctx)
  page = (await store.merge({ into: page.id, from: ['topics/from'], rev: page.rev, ctx: { ...ctx, source: 'file:merge' } })).page
  assert.equal(page.meta.sources?.length, 10)
  assert.equal(page.meta.sources?.at(-1), 'file:merge')
  await writeFile(page.path, serializePage({ ...page.meta, sources }, page.body))
  const verified = await new Store(config(dir)).verify(page.id)
  assert.deepEqual(verified.page.meta.sources, sources.slice(-10))
  assert.equal(verified.page.meta.verified, localDate())
})

test('monthly logs are reserved special paths and excluded from store, search, catalog and lint', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  await mkdir(path.join(dir, 'log'))
  await writeFile(path.join(dir, 'log/2026-10.md'), '日志正文')
  const store = new Store(config(dir))
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.write({ kind: 'create', id: 'log/2026-11', meta, body: 'bad' }, ctx), code('INVALID_ID'))
  const logs = [record('log/2026-10', {}, 'zebra-log ' + 'a'.repeat(MAX_BODY_BYTES + 1))]
  const engine = createSearchEngine()
  engine.load(logs)
  assert.deepEqual(engine.search({ query: 'zebra-log' }), [])
  assert.ok(!buildIndexMd(logs, { generatedAt: new Date() }).includes('[[log/'))
  assert.ok(!buildContext(logs, { vaultDir: dir, budgetBytes: 4096, inboxCount: 0 }).includes('[[log/'))
  assert.deepEqual(lintRecords(logs, lintOptions), [])
})

test('split-log migrates temporary legacy log only, preserves rows and refuses overwriting', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const old = path.join(dir, 'log.md')
  const line = (at: string, reason: string) => {
    const entry = { at, agent: 'test', action: '更新', reason }
    return `- ${at.slice(0, 10)} ${at.slice(11, 16)} [test] 更新：${reason} <!-- memwiki:${Buffer.from(JSON.stringify(entry)).toString('base64')} -->`
  }
  const october = line('2026-10-25T12:00:00Z', '新')
  const september = line('2026-09-30T12:00:00Z', '旧')
  const visible = '- 2026-09-29 10:00 [human] 更新：只有可见文字'
  const raw = `# 变更日志\n\n## 2026-10\n\n${october}\n\n## 2026-09\n\n${september}\n${visible}\n`
  await writeFile(old, raw)
  const script = path.resolve('scripts/split-log.mjs')
  await exec(process.execPath, [script, dir])
  await assert.rejects(readFile(old), { code: 'ENOENT' })
  assert.equal(await readFile(path.join(dir, 'log/2026-10.md'), 'utf8'), october + '\n')
  assert.equal(await readFile(path.join(dir, 'log/2026-09.md'), 'utf8'), visible + '\n' + september + '\n')
  await writeFile(old, raw)
  await assert.rejects(exec(process.execPath, [script, dir]))
  assert.equal(await readFile(old, 'utf8'), raw)
  assert.equal(await readFile(path.join(dir, 'log/2026-10.md'), 'utf8'), october + '\n')
  const invalid = '不认识的旧日志行\n'
  await writeFile(old, invalid)
  await assert.rejects(exec(process.execPath, [script, dir]))
  assert.equal(await readFile(old, 'utf8'), invalid)
  const ignore = await readFile(path.join(dir, '.gitignore'), 'utf8')
  assert.match(ignore, /\.obsidian\/graph\.json/)
})
