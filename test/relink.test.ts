import assert from 'node:assert/strict'
import { test } from 'node:test'
import { initVault } from '../src/core/vault.ts'
import { localDate, nowIso } from '../src/core/page.ts'
import { Memwiki } from '../src/memwiki.ts'
import { config, temporary } from './helpers.ts'

const ctx = { agent: 'claude', reason: 'test' }

test('links written before their target exists stop being broken once it is created', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open({ ...config(dir), git: { autoCommit: false, autoPush: false }, agent: 'claude' })
  t.after(() => wiki.close())

  await wiki.write({ kind: 'create', id: 'rules/a', meta: { title: 'A', summary: '链接到 B' }, body: '见 [[howto/b]]\n' }, ctx)
  assert.deepEqual((await wiki.read('rules/a')).brokenLinks, ['howto/b'])

  await wiki.write({ kind: 'create', id: 'howto/b', meta: { title: 'B', summary: '后建的页面' }, body: '正文\n' }, ctx)
  assert.deepEqual((await wiki.read('rules/a')).brokenLinks, [])
  assert.deepEqual((await wiki.read('howto/b')).backlinks, ['rules/a'])
  const { issues } = await wiki.lint({ fix: false, agent: 'claude' })
  assert.ok(!issues.some(i => i.code === 'broken_link'), JSON.stringify(issues))
  assert.ok(!issues.some(i => i.code === 'orphan' && i.page === 'howto/b'))

  await wiki.delete('howto/b', ctx)
  assert.deepEqual((await wiki.read('rules/a')).brokenLinks, ['howto/b'])
})

test('a link by title resolves after the title is introduced on an existing page', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open({ ...config(dir), git: { autoCommit: false, autoPush: false }, agent: 'claude' })
  t.after(() => wiki.close())

  await wiki.write({ kind: 'create', id: 'topics/x', meta: { title: 'X', summary: '链接到别名' }, body: '[[发布手册]]\n' }, ctx)
  const created = await wiki.write({ kind: 'create', id: 'howto/release', meta: { title: 'Release', summary: '发布' }, body: '…\n' }, ctx)
  assert.deepEqual((await wiki.read('topics/x')).brokenLinks, ['发布手册'])
  await wiki.write({ kind: 'meta', id: 'howto/release', rev: created.result.page.rev, meta: { aliases: ['发布手册'] } }, ctx)
  assert.deepEqual((await wiki.read('topics/x')).brokenLinks, [])
})

test('timestamps are local wall-clock time with an offset', () => {
  const at = new Date(2026, 9, 14, 22, 5, 30)
  const iso = nowIso(at)
  assert.match(iso, /^2026-10-14T22:05:30[+-]\d{2}:\d{2}$/)
  assert.equal(Date.parse(iso), at.getTime())
  assert.equal(localDate(at), '2026-10-14')
})
