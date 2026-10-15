import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Store } from '../src/core/store.ts'
import { initVault } from '../src/core/vault.ts'
import { computeRev, defaultMeta, localDate, serializePage } from '../src/core/page.ts'
import { MemwikiError } from '../src/types.ts'
import type { MetaPatch, WriteOp } from '../src/types.ts'
import { temporary, config, code } from './helpers.ts'

const ctx = { agent: 'codex', reason: '测试', source: 'session:codex/test' }
async function fixture(t: Parameters<typeof temporary>[0]) {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const store = new Store(config(dir))
  const create = (id: string, body = 'body\n', meta: MetaPatch = {}, force = false) => store.write({ kind: 'create', id, meta: { ...meta, title: meta.title ?? id.split('/').at(-1)!, summary: meta.summary ?? '摘要' }, body, force }, ctx)
  return { dir, store, create }
}

test('create, replace, append, edit and meta maintain provenance and accurate touched paths', async t => {
  const { store, create, dir } = await fixture(t)
  const first = await create('projects/netx/中文', 'alpha\n', { aliases: ['别名'], plugin: { keep: true }, created: '2000-01-01' })
  assert.equal(first.created, true)
  assert.deepEqual(first.changedPaths, ['projects/netx/中文.md'])
  assert.equal(first.page.meta.project, 'netx')
  assert.equal(first.page.meta.type, 'project')
  assert.equal(first.page.meta.updated_by, 'codex')
  assert.equal(first.page.meta.created, localDate())
  assert.deepEqual(first.page.meta.sources, [ctx.source])
  assert.equal(first.page.rev, computeRev(await readFile(first.page.path)))
  await assert.rejects(create('PROJECTS/NETX/中文'), code('EXISTS'))
  assert.equal((await store.get('PROJECTS/NETX/中文')).id, first.page.id)
  const replaced = await store.write({ kind: 'replace', id: first.page.id, rev: first.page.rev, body: 'beta\n', meta: { summary: '新摘要', created: '2000-01-01' } }, ctx)
  assert.equal(replaced.created, false)
  assert.equal(replaced.page.body, 'beta\n')
  assert.deepEqual(replaced.page.meta.plugin, { keep: true })
  assert.equal(replaced.page.meta.created, first.page.meta.created)
  await assert.rejects(store.write({ kind: 'replace', id: first.page.id, rev: first.page.rev, body: 'bad' }, ctx), e => {
    assert.ok(e instanceof MemwikiError)
    assert.equal(e.code, 'CONFLICT')
    assert.equal(e.details?.rev, replaced.page.rev)
    return true
  })
  const appended = await store.write({ kind: 'append', id: first.page.id, text: 'gamma' }, ctx)
  assert.equal(appended.page.body, 'beta\ngamma\n')
  assert.deepEqual(appended.page.meta.sources, [ctx.source])
  await assert.rejects(store.write({ kind: 'append', id: first.page.id, rev: first.page.rev, text: 'x' }, ctx), code('CONFLICT'))
  const edited = await store.write({ kind: 'edit', id: first.page.id, rev: appended.page.rev, old: 'gamma', new: 'delta' }, ctx)
  assert.equal(edited.page.body, 'beta\ndelta\n')
  const patched = await store.write({ kind: 'meta', id: first.page.id, rev: edited.page.rev, meta: { aliases: null, plugin: null, pinned: true } }, ctx)
  assert.equal(patched.page.body, edited.page.body)
  assert.equal(patched.page.meta.pinned, true)
  assert.equal('plugin' in patched.page.meta, false)
  assert.deepEqual(patched.page.meta.aliases, [])
  await assert.rejects(store.write({ kind: 'meta', id: first.page.id, rev: patched.page.rev, meta: { title: null } }, ctx), code('INVALID_META'))
  assert.equal((await store.get(first.page.id)).rev, patched.page.rev)
  assert.deepEqual((await readdir(dir)).filter(n => ['log.md', 'index.md', '.git'].includes(n)), [])
})

test('edit requires exactly one occurrence, including overlapping matches', async t => {
  const { store, create } = await fixture(t)
  const { page } = await create('topics/edit', 'aaaa repeated repeated\n')
  for (const [old, error] of [['missing', 'EDIT_NOT_FOUND'], ['repeated', 'AMBIGUOUS_EDIT'], ['aaa', 'AMBIGUOUS_EDIT'], ['', 'AMBIGUOUS_EDIT']] as const) {
    await assert.rejects(store.write({ kind: 'edit', id: page.id, rev: page.rev, old, new: 'new' }, ctx), code(error))
    assert.equal((await store.get(page.id)).rev, page.rev)
  }
})

test('section replacement respects nesting, parent paths, absent headings and fenced code', async t => {
  const { store, create } = await fixture(t)
  const body = ['# Root', 'intro', '## Parent', 'before', '### Child', 'old', '#### Nested', 'nested body', '## Other', '### Child', 'other body', '```md', '## Fake', '```', '## Tail', 'tail'].join('\n') + '\n'
  let { page } = await create('topics/sections', body)
  await assert.rejects(store.write({ kind: 'section', id: page.id, rev: page.rev, heading: 'Child', body: 'bad' }, ctx), code('AMBIGUOUS'))
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: 'Parent/Child', body: 'replacement' }, ctx)).page
  assert.ok(page.body.includes('### Child\nreplacement\n## Other'))
  assert.ok(!page.body.includes('nested body'))
  assert.ok(page.body.includes('### Child\nother body'))
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: 'Missing', body: 'created' }, ctx)).page
  assert.ok(page.body.endsWith('## Missing\n\ncreated\n'))
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: 'Fake', body: 'real' }, ctx)).page
  assert.ok(page.body.includes('```md\n## Fake\n```'))
  assert.ok(page.body.endsWith('## Fake\n\nreal\n'))
  const parent = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: 'Parent', body: 'whole section' }, ctx)).page
  assert.ok(parent.body.includes('## Parent\nwhole section\n## Other'))
  assert.ok(!parent.body.includes('replacement'))
})

test('section strips a leading duplicate heading for existing and new sections', async t => {
  const { store, create } = await fixture(t)
  let { page } = await create('topics/duplicate-heading', '## 相关\n旧内容\n## 尾节\n保留\n')
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: '相关', body: '## 相关\n新内容\n' }, ctx)).page
  assert.equal(page.body, '## 相关\n新内容\n## 尾节\n保留\n')
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: '新增', body: '## 新增\n新增内容\n' }, ctx)).page
  assert.ok(page.body.endsWith('## 新增\n\n新增内容\n'))
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: '相关', body: '### 子节\n保留标题\n' }, ctx)).page
  assert.ok(page.body.includes('## 相关\n### 子节\n保留标题\n## 尾节'))
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: '相关/子节', body: '\r\n  ### 子节 ###\r\n更新子节\r\n' }, ctx)).page
  assert.ok(page.body.includes('### 子节\n更新子节\r\n## 尾节'))
  page = (await store.write({ kind: 'section', id: page.id, rev: page.rev, heading: '相关', body: '```md\n## 相关\n```\n' }, ctx)).page
  assert.ok(page.body.includes('## 相关\n```md\n## 相关\n```\n'))
})

test('invalid metadata reports reasons in message and details and does not change the page', async t => {
  const { store, create } = await fixture(t)
  const { page } = await create('topics/validation', 'safe\n')
  await assert.rejects(store.write({ kind: 'meta', id: page.id, rev: page.rev, meta: { summary: '摘'.repeat(137), tags: 42 as unknown as string[] } }, ctx), err => {
    assert.ok(err instanceof MemwikiError)
    assert.equal(err.code, 'INVALID_META')
    assert.match(err.message, /summary 超过 120 字（当前 137）/)
    assert.match(err.message, /tags 必须是字符串数组/)
    assert.deepEqual(err.details?.errors, [{ field: 'summary', reason: '超过 120 字（当前 137）' }, { field: 'tags', reason: '必须是字符串数组' }])
    return true
  })
  assert.equal((await store.get(page.id)).rev, page.rev)
  for (const summary of ['摘'.repeat(121), '😀'.repeat(121)]) {
    await assert.rejects(create('topics/too-long', '', { summary }), err => {
      assert.ok(err instanceof MemwikiError)
      assert.equal(err.code, 'INVALID_META')
      assert.match(err.message, /summary 超过 120 字（当前 121）/)
      return true
    })
    await assert.rejects(store.get('topics/too-long'), code('NOT_FOUND'))
  }
  const boundary = '😀'.repeat(120)
  assert.equal((await create('topics/boundary', '', { summary: boundary })).page.meta.summary, boundary)
})

test('append metadata requires a revision and checks conflicts before applying patches', async t => {
  const { store, create } = await fixture(t)
  const { page } = await create('topics/append-meta', 'original\n')
  await assert.rejects(store.write({ kind: 'append', id: page.id, text: 'bad', meta: { title: 'bad' } }, ctx), code('INVALID_META'))
  await assert.rejects(store.write({ kind: 'append', id: page.id, rev: 'stale', text: 'bad', meta: { title: 'bad' } }, ctx), code('CONFLICT'))
  assert.equal((await store.get(page.id)).rev, page.rev)
  const result = await store.write({ kind: 'append', id: page.id, rev: page.rev, text: 'added', meta: { title: 'new', summary: '新摘要' } }, ctx)
  assert.equal(result.page.meta.title, 'new')
  assert.equal(result.page.meta.summary, '新摘要')
  assert.equal(result.page.body, 'original\nadded\n')
})

test('create clearly rejects underscore filenames reserved for special pages', async t => {
  const { store, create } = await fixture(t)
  for (const id of ['_private', 'topics/_private']) {
    await assert.rejects(create(id), err => {
      assert.ok(err instanceof MemwikiError)
      assert.equal(err.code, 'INVALID_ID')
      assert.match(err.message, /`_` 开头保留给特殊页面/)
      return true
    })
    await assert.rejects(store.get(id), code('NOT_FOUND'))
  }
})

test('append into a section stays before its next sibling and preserves nested children', async t => {
  const { store, create } = await fixture(t)
  let { page } = await create('topics/append', '## A\na\n### Child\nc\n## B\nb\n')
  page = (await store.write({ kind: 'append', id: page.id, section: 'A', text: 'added' }, ctx)).page
  assert.equal(page.body, '## A\na\n### Child\nc\nadded\n## B\nb\n')
  page = (await store.write({ kind: 'append', id: page.id, section: 'A/Child', text: 'child added' }, ctx)).page
  assert.ok(page.body.includes('added\nchild added\n## B'))
  page = (await store.write({ kind: 'append', id: page.id, section: 'New', text: 'new content' }, ctx)).page
  assert.ok(page.body.endsWith('## New\n\nnew content\n'))
  const duplicate = await create('topics/duplicate', '## A\nfirst\n## A\nsecond\n')
  await assert.rejects(store.write({ kind: 'append', id: duplicate.page.id, section: 'A', text: 'bad' }, ctx), code('AMBIGUOUS'))
  const noNewline = await create('topics/no-newline', '## A')
  assert.equal((await store.write({ kind: 'append', id: noNewline.page.id, section: 'A', text: 'content' }, ctx)).page.body, '## A\ncontent\n')
})

test('move rewrites all ID/title/alias links, handles self links, and retains suffixes and code', async t => {
  const { store, create, dir } = await fixture(t)
  await create('topics/old', '[[topics/old]]\n', { title: 'Old Title', aliases: ['Alias'] })
  await create('topics/linker', '[[TOPICS/OLD#H|label]] [[Old Title]] [[alias|A]] `[[Alias]]`\n```\n[[Old Title]]\n```\n')
  await create('topics/untouched', 'no links\n')
  const moved = await store.move('Alias', 'projects/netx/new', ctx)
  assert.equal(moved.page.id, 'projects/netx/new')
  assert.equal(moved.page.meta.project, 'netx')
  assert.equal(moved.page.body, '[[projects/netx/new]]\n')
  assert.deepEqual(new Set(moved.rewritten), new Set(['projects/netx/new', 'topics/linker']))
  assert.deepEqual(new Set(moved.changedPaths), new Set(['topics/old.md', 'projects/netx/new.md', 'topics/linker.md']))
  assert.equal((await store.get('topics/linker')).body, '[[projects/netx/new#H|label]] [[projects/netx/new]] [[projects/netx/new|A]] `[[Alias]]`\n```\n[[Old Title]]\n```\n')
  await assert.rejects(store.get('topics/old'), code('NOT_FOUND'))
  assert.equal((await store.resolve('Old Title')).id, moved.page.id)
  await assert.rejects(store.move(moved.page.id, 'topics/untouched', ctx), code('EXISTS'))
  assert.deepEqual(await readdir(path.join(dir, '.memwiki', 'locks')), [])
})

test('delete/restore round-trip, report backlinks and reject occupied IDs and forged trash paths', async t => {
  const { store, create, dir } = await fixture(t)
  const original = await create('topics/trash', 'keep me\n', { aliases: ['TrashAlias'], extra: 'keep' })
  await create('topics/ref', '[[TrashAlias]]\n')
  const deleted = await store.delete('TrashAlias', ctx)
  assert.deepEqual(deleted.danglingFrom, ['topics/ref'])
  assert.match(deleted.trashPath, /^\.trash\/topics\/trash\.\d+\.md$/)
  assert.deepEqual(deleted.changedPaths, ['topics/trash.md', deleted.trashPath])
  assert.equal(await readFile(path.join(dir, deleted.trashPath), 'utf8'), serializePage(original.page.meta, original.page.body))
  assert.deepEqual((await store.list()).map(p => p.id), ['topics/ref'])
  await create('topics/trash', 'occupied')
  await assert.rejects(store.restore(deleted.trashPath, ctx), code('EXISTS'))
  await store.delete('topics/trash', ctx)
  const restored = await store.restore(deleted.trashPath, { ...ctx, source: 'session:new' })
  assert.equal(restored.created, true)
  assert.equal(restored.page.body, original.page.body)
  assert.equal(restored.page.meta.extra, 'keep')
  assert.deepEqual(restored.page.meta.sources, [ctx.source, 'session:new'])
  assert.deepEqual(restored.changedPaths, ['topics/trash.md', deleted.trashPath])
  await assert.rejects(readFile(path.join(dir, deleted.trashPath)), { code: 'ENOENT' })
  await assert.rejects(store.restore('../outside.123.md', ctx), code('OUT_OF_VAULT'))
  await assert.rejects(store.restore('topics/ref.md', ctx), code('INVALID_ID'))
  await assert.rejects(store.restore('.trash/topics/ref.123-deadbeef.md', ctx), code('INVALID_ID'))
  await assert.rejects(store.restore('.trash/topics/missing.123.md', ctx), code('NOT_FOUND'))
})

test('list excludes special/internal files, resolve honors tiers, cache refreshes external changes', async t => {
  const { store, create, dir } = await fixture(t)
  await create('topics/A', 'body', { title: 'Same', aliases: ['Alias'] })
  await create('rules/A', 'body', { title: 'Other', aliases: ['Same'] })
  // Deliberately duplicate a title to exercise resolver ambiguity despite the create guard.
  await create('topics/B', 'body', { title: 'Other', aliases: ['shared'] }, true)
  await create('topics/C', 'body', { aliases: ['shared'] })
  for (const rel of ['index.md', 'log.md', 'topics/_private.md', '.trash/x.md', '.memwiki/x.md', '.obsidian/x.md', '.git/x.md', 'node_modules/x.md']) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true })
    await writeFile(path.join(dir, rel), 'special')
  }
  assert.equal((await store.list()).length, 4)
  assert.equal((await store.resolve('same')).id, 'topics/A')
  assert.equal((await store.resolve('alias')).id, 'topics/A')
  assert.equal((await store.resolve('b')).id, 'topics/B')
  for (const ref of ['A', 'Other', 'shared']) await assert.rejects(store.resolve(ref), code('AMBIGUOUS'))
  await assert.rejects(store.resolve('missing'), code('NOT_FOUND'))
  assert.equal((await store.readSpecial('_guide')).id, '_guide')
  await assert.rejects(store.readSpecial('topics/A'), code('INVALID_ID'))
  const page = await store.get('topics/A')
  page.meta.aliases.push('mutated')
  assert.deepEqual((await store.get('topics/A')).meta.aliases, ['Alias'])
  await writeFile(page.path, serializePage(defaultMeta('topics/A', { summary: '外部摘要', title: 'External' }), 'external body\n'))
  assert.equal((await store.get('topics/A')).body, 'external body\n')
  assert.equal((await store.resolve('External')).id, 'topics/A')
  await writeFile(page.path, '---\ntitle: [\n---\nstill readable')
  const broken = await store.get('topics/A')
  assert.ok(broken.metaIssues)
  assert.equal(broken.body, 'still readable')
})

test('final content of every write kind is scanned without echoing secrets in errors', async t => {
  const { store, create } = await fixture(t)
  const secret = 'sk-proj-' + 'a'.repeat(40)
  const { page } = await create('topics/secrets', 'safe\n')
  const ops: WriteOp[] = [
    { kind: 'create', id: 'topics/new-secret', meta: { title: 'Title', summary: '摘要' }, body: secret },
    { kind: 'replace', id: page.id, rev: page.rev, body: secret },
    { kind: 'append', id: page.id, text: secret },
    { kind: 'edit', id: page.id, rev: page.rev, old: 'safe', new: secret },
    { kind: 'section', id: page.id, rev: page.rev, heading: 'Secret', body: secret },
    { kind: 'meta', id: page.id, rev: page.rev, meta: { hidden: secret } },
  ]
  for (const op of ops) {
    await assert.rejects(store.write(op, ctx), e => {
      assert.ok(e instanceof MemwikiError)
      assert.equal(e.code, 'SECRET_DETECTED')
      assert.ok(!e.message.includes(secret))
      assert.ok(!JSON.stringify(e.details).includes(secret))
      assert.ok(Array.isArray(e.details?.findings))
      return true
    })
    assert.equal((await store.get(page.id)).rev, page.rev)
  }
  // Scan old body as well as the incoming metadata patch.
  await writeFile(page.path, serializePage(page.meta, secret))
  const external = await store.get(page.id)
  await assert.rejects(store.write({ kind: 'meta', id: page.id, rev: external.rev, meta: { pinned: true } }, ctx), code('SECRET_DETECTED'))
  const permissive = new Store({ ...config(path.dirname(path.dirname(page.path))), secretScan: false })
  assert.equal((await permissive.write({ kind: 'append', id: page.id, text: 'allowed' }, ctx)).page.body, secret + '\nallowed\n')
})

test('concurrent appends lose no updates and parallel same-ID creates have one winner', async t => {
  const { store, create } = await fixture(t)
  await create('topics/concurrent', '')
  await Promise.all(Array.from({ length: 8 }, (_, i) => store.write({ kind: 'append', id: 'topics/concurrent', text: String(i) }, ctx)))
  assert.deepEqual((await store.get('topics/concurrent')).body.trim().split('\n').sort(), ['0', '1', '2', '3', '4', '5', '6', '7'])
  const results = await Promise.allSettled([create('topics/once'), create('TOPICS/ONCE')])
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1)
  const failed = results.find(r => r.status === 'rejected') as PromiseRejectedResult
  assert.ok(code('EXISTS')(failed.reason))
})

test('store refuses invalid, reserved and symlink-escaping write/move paths', async t => {
  const { store, create, dir } = await fixture(t)
  const outside = await temporary(t)
  await symlink(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  for (const id of ['../escape', 'index', '_guide', '.trash/x', 'node_modules/x']) await assert.rejects(create(id), code('INVALID_ID'))
  await assert.rejects(create('escape/page'), code('OUT_OF_VAULT'))
  await create('topics/safe')
  await assert.rejects(store.move('topics/safe', 'escape/page', ctx), code('OUT_OF_VAULT'))
  assert.equal((await readdir(outside)).length, 0)
  assert.deepEqual((await store.list()).map(p => p.id), ['topics/safe'])
})

test('new pages reuse directory spelling and case-only moves retain new filename spelling', async t => {
  const { store, create } = await fixture(t)
  const page = (await create('TOPICS/Capital')).page
  assert.equal(page.id, 'topics/Capital')
  const moved = await store.move(page.id, 'TOPICS/capital', ctx)
  assert.equal(moved.page.id, 'topics/capital')
  assert.deepEqual(new Set(moved.changedPaths), new Set(['topics/Capital.md', 'topics/capital.md']))
  assert.equal((await store.get('TOPICS/CAPITAL')).id, 'topics/capital')
  await create('Topics/second')
  await Promise.all([create('NewDir/A'), create('newdir/B')])
  const ids = (await store.list()).map(p => p.id)
  assert.deepEqual(ids.map(id => id.toLowerCase()).sort(), ['newdir/a', 'newdir/b', 'topics/capital', 'topics/second'])
  assert.equal(new Set(ids.filter(id => id.toLowerCase().startsWith('newdir/')).map(id => id.split('/')[0])).size, 1)
})
