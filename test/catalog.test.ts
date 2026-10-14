import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildContext, buildIndexMd } from '../src/search/catalog.ts'
import { record } from './record.ts'
import type { ContextOptions } from '../src/types.ts'

const opts: ContextOptions = { vaultDir: 'D:/记忆库', budgetBytes: 4096, inboxCount: 3, project: 'netx' }

test('index groups fixed directories, projects, extra directories and inbox deterministically', () => {
  const pages = ['inbox/2026-10', 'zeta/z', 'alpha/a', 'reference/r', 'decisions/d', 'howto/h', 'topics/z', 'topics/a',
    'projects/z/p', 'projects/a/z', 'projects/a/a', 'rules/r', 'user/u', 'index', 'log', '_guide', 'topics/_internal'].map(id => record(id))
  pages.find(p => p.id === 'topics/z')!.meta.status = 'stale'
  const generatedAt = new Date('2026-10-14T00:00:00Z')
  const output = buildIndexMd(pages, { generatedAt })
  assert.deepEqual(output.match(/^## .+$/gmu), ['## user', '## rules', '## projects', '## topics', '## howto', '## decisions', '## reference', '## alpha', '## zeta', '## inbox'])
  assert.ok(output.indexOf('### a') < output.indexOf('### z'))
  assert.ok(output.indexOf('[[projects/a/a|') < output.indexOf('[[projects/a/z|'))
  assert.ok(output.indexOf('[[topics/a|') < output.indexOf('[[topics/z|'))
  assert.ok(output.includes('共 13 页'))
  assert.ok(output.includes('- [[topics/z|z]] — 页面摘要 （stale）'))
  assert.ok(output.endsWith('## inbox\n\n共 1 页待整理\n'))
  assert.ok(!output.includes('[[inbox/'))
  assert.equal(output, buildIndexMd([...pages].reverse(), { generatedAt }))
  const later = buildIndexMd(pages, { generatedAt: new Date('2026-10-15T00:00:00Z') })
  assert.equal(output.replace(/^生成时间：.*$/mu, ''), later.replace(/^生成时间：.*$/mu, ''))
})

test('context orders pinned, rule/user, project, others, then inbox count without duplicating pages', () => {
  const pages = [record('topics/other', { updated: '2026-10-14T12:00:00Z' }),
    record('projects/netx/old', { updated: '2026-10-01T00:00:00Z', status: 'stale' }),
    record('topics/pinned', { pinned: true }), record('rules/rule', { type: 'rule' }), record('user/user', { type: 'user' }),
    record('projects/netx/new', { project: 'netx', updated: '2026-10-13T00:00:00Z' }), record('_guide')]
  const output = buildContext(pages, opts)
  assert.ok(output.startsWith('记忆库：D:/记忆库，共 6 页。写入前先搜索，规范见 [[_guide]]'))
  assert.deepEqual(output.split('\n').filter(l => l.startsWith('- ')).map(l => l.match(/\[\[(.*?)\]\]/u)![1]),
    ['topics/pinned', 'rules/rule', 'user/user', 'projects/netx/new', 'projects/netx/old', 'topics/other'])
  assert.ok(output.includes('（可能过时）'))
  assert.ok(output.endsWith('inbox 未整理条目：3，需要整理'))
})

test('context leaves inbox pages to the inbox count footer', () => {
  const output = buildContext([record('topics/a'), record('inbox/2026-10', { type: 'inbox' })], opts)
  assert.ok(!output.includes('[[inbox/'))
  assert.ok(output.includes('共 1 页'))
})

test('context counts the omission notice in every UTF-8 budget, including tiny budgets', () => {
  const pages = Array.from({ length: 12 }, (_, i) => record(`topics/页面-${i}`, { summary: '中文摘要😀'.repeat(10) }))
  const full = buildContext(pages, { ...opts, budgetBytes: 10000 })
  assert.equal(buildContext(pages, { ...opts, budgetBytes: Buffer.byteLength(full) }), full)
  for (let budgetBytes = 0; budgetBytes <= Buffer.byteLength(full) + 1; budgetBytes++) {
    const output = buildContext(pages, { ...opts, budgetBytes })
    assert.ok(Buffer.byteLength(output) <= budgetBytes, `budget ${budgetBytes}`)
    assert.ok(!output.includes('\uFFFD'))
    if (output !== full && output !== '') {
      const count = output.split('\n').filter(l => l.startsWith('- ')).length
      assert.ok(output.endsWith(`……还有 ${pages.length - count} 页未列出，用 memwiki_search 查找`))
    }
  }
})

test('context stops at the first page that does not fit and flattens embedded newlines', () => {
  const pages = [record('topics/a', { pinned: true, summary: '长'.repeat(1000) }), record('topics/b', { summary: '短' })]
  const output = buildContext(pages, { ...opts, budgetBytes: 250 })
  assert.ok(!output.includes('[[topics/b]]'))
  assert.ok(output.endsWith('……还有 2 页未列出，用 memwiki_search 查找'))
  const clean = buildContext([record('topics/x', { summary: '一行\n第二行' })], opts)
  assert.ok(clean.includes('— 一行 第二行'))
  assert.equal(buildContext([], { ...opts, budgetBytes: 0 }), '')
})
