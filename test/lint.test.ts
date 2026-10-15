import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fixFor, lintRecords } from '../src/search/lint.ts'
import { record } from './record.ts'
import type { LintIssue, LintOptions } from '../src/types.ts'

const opts: LintOptions = { now: new Date('2026-10-14T12:00:00+08:00'), staleDays: 90, inboxEntries: [] }

test('reports broken links and orphans using resolved IDs, with directory/pinned exceptions', () => {
  const source = record('topics/source'), target = record('topics/target'), self = record('topics/self')
  source.links = ['TOPICS/TARGET']; source.brokenLinks = ['gone', 'gone']; self.links = ['topics/self']
  const pages = [source, target, self, record('user/u'), record('rules/r'), record('inbox/i'), record('meta/feedback/2026-10'), record('META/other'), record('topics/p', { pinned: true })]
  const issues = lintRecords(pages, opts)
  assert.deepEqual(issues.filter(i => i.code === 'broken_link').map(i => i.page), ['topics/source'])
  assert.deepEqual(issues.filter(i => i.code === 'orphan').map(i => i.page), ['topics/source', 'topics/self'])
  assert.ok(issues.every(i => !i.fixable))
})

test('duplicates include title/alias collisions case-insensitively, but not repeated aliases on one page', () => {
  const issues = lintRecords([record('topics/a', { title: 'Shared', aliases: ['self', 'SELF'] }), record('topics/b', { aliases: ['shared'] })], opts)
  assert.deepEqual(issues.filter(i => i.code === 'duplicate_title').map(i => i.page), ['topics/a', 'topics/b'])
})

test('checks missing summary, parsing failures, required fields, enums, dates and optional fields', () => {
  const bad = record('topics/bad', { summary: '', type: 'bad' as never, status: 'bad' as never, created: '2026-02-30',
    updated: '2026-10-14', updated_by: '', tags: 'tag' as never, aliases: [1] as never, verified: 'yesterday', pinned: 'yes' as never })
  const parsed = record('topics/parser'); parsed.metaIssues = [{ field: 'meta', reason: 'raw private data must not be echoed' }]
  const issues = lintRecords([bad, parsed], opts)
  assert.equal(issues.filter(i => i.code === 'invalid_meta').length, 2)
  assert.equal(issues.filter(i => i.code === 'missing_summary').length, 1)
  assert.ok(issues.find(i => i.page === bad.id && i.code === 'invalid_meta')!.message.includes('created'))
  assert.ok(!JSON.stringify(issues).includes('raw private data'))
  assert.equal(issues.find(i => i.page === parsed.id && i.code === 'invalid_meta')!.fixable, false)
})

test('staleness prefers verified, uses exact day boundaries, and avoids already stale pages', () => {
  const cutoff = new Date(opts.now.getTime() - 90 * 86400000).toISOString()
  const pages = [record('topics/old', { updated: '2026-01-01T00:00:00Z' }), record('topics/verified-old', { verified: '2026-01-01' }),
    record('topics/verified-new', { updated: '2026-01-01T00:00:00Z', verified: '2026-10-14' }),
    record('topics/cutoff', { updated: cutoff }), record('topics/stale', { status: 'stale', updated: '2026-01-01T00:00:00Z' })]
  assert.deepEqual(lintRecords(pages, opts).filter(i => i.code === 'stale_candidate').map(i => i.page), ['topics/old', 'topics/verified-old'])
})

test('measures only body UTF-8 bytes for oversized', () => {
  const exact = record('topics/exact', {}, 'a'.repeat(20480)); exact.bytes = 999999
  const large = record('topics/large', {}, '中'.repeat(7000)); large.bytes = 1
  const issues = lintRecords([exact, large], opts)
  assert.deepEqual(issues.filter(i => i.code === 'oversized').map(i => i.page), ['topics/large'])
})

test('inbox backlog triggers above 20 entries or 14 days, and is vault-wide', () => {
  const entries = Array.from({ length: 20 }, () => ({ page: 'inbox/2026-10', date: '2026-10-14' }))
  assert.deepEqual(lintRecords([], { ...opts, inboxEntries: entries }), [])
  const issue = lintRecords([], { ...opts, inboxEntries: [...entries, entries[0]] })[0]
  assert.equal(issue.code, 'inbox_backlog'); assert.equal(issue.page, undefined)
  assert.equal(lintRecords([], { ...opts, inboxEntries: [{ page: 'inbox/2026-09', date: '2026-09-01' }] })[0].code, 'inbox_backlog')
})

test('secret scanner is optional, scans metadata and body, and issues never echo matched content', () => {
  const page = record('topics/secret', { token: 'meta-sensitive' }, 'body-sensitive')
  assert.ok(lintRecords([page], opts).every(i => i.code !== 'secret_suspect'))
  let called = 0
  const issues = lintRecords([page], { ...opts, scanSecrets(text) {
    called++; assert.ok(text.includes('meta-sensitive')); assert.ok(text.includes('body-sensitive'))
    return [{ rule: 'token', line: 8 }]
  } })
  assert.equal(called, 1)
  const secret = issues.find(i => i.code === 'secret_suspect')!
  assert.equal(secret.fixable, false)
  assert.ok(secret.message.includes('token') && secret.message.includes('8'))
  assert.ok(!JSON.stringify(issues).includes('sensitive'))
  assert.ok(issues.every(i => i.code !== 'uncommitted'))
})

test('fixes inferable defaults only, returns undefined for manual issues, and does not mutate input', () => {
  const page = record('projects/netx/deploy', { title: '', type: undefined as never, status: undefined as never, created: '' })
  const original = structuredClone(page)
  const issue: LintIssue = { code: 'invalid_meta', page: page.id, message: '', fixable: true }
  assert.deepEqual(fixFor(issue, page), { title: 'deploy', type: 'project', status: 'active', project: 'netx', created: '2026-10-14' })
  assert.deepEqual(fixFor({ ...issue, code: 'stale_candidate' }, page), { status: 'stale' })
  assert.deepEqual(page, original)
  assert.ok(lintRecords([page], opts).find(i => i.code === 'invalid_meta')!.fixable)
  for (const code of ['broken_link', 'orphan', 'duplicate_title', 'missing_summary', 'markdown_link', 'oversized', 'inbox_backlog', 'secret_suspect', 'uncommitted'] as const) {
    assert.equal(fixFor({ ...issue, code }, page), undefined)
  }
  assert.equal(fixFor({ ...issue, page: 'another' }, page), undefined)
  assert.equal(fixFor(issue, record(page.id, { project: 'netx' })), undefined)
  assert.equal(fixFor({ ...issue, page: 'unknown/x' }, record('unknown/x', { type: undefined as never })), undefined)
  const repaired = { ...page, meta: { ...page.meta, ...fixFor(issue, page)! } } as typeof page
  assert.ok(!lintRecords([repaired], opts).some(i => i.code === 'invalid_meta'))
})

test('Markdown link lint distinguishes automatic conversion from manual correction', () => {
  const pages = [record('topics/auto', {}, '[链接](./target.md)'), record('topics/manual', {}, '[越界](../../outside.md)'),
    record('topics/code', {}, '`[代码](target.md)` [网页](https://example.com/page.md) ![图片](image.md)')]
  assert.deepEqual(lintRecords(pages, opts).filter(i => i.code === 'markdown_link').map(i => [i.page, i.fixable]),
    [['topics/auto', true], ['topics/manual', false]])
})
