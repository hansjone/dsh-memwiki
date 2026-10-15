import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { test } from 'node:test'
import { applyMetaPatch, computeRev, defaultMeta, parsePage, serializePage } from '../src/core/page.ts'
import { PAGE_STATUSES } from '../src/types.ts'
import type { MetaPatch } from '../src/types.ts'

test('frontmatter round-trips metadata, body, unknown values and canonical order', () => {
  const meta = defaultMeta('projects/netx/发布', { title: '发布', summary: '说明', customZ: { x: [1, true] }, customA: 'plugin', pinned: true, aliases: ['别名'] })
  const body = '# 正文\r\n[[目标]]\r\n'
  const raw = serializePage(meta, body)
  const page = parsePage(raw)
  assert.deepEqual(page, { meta, body })
  assert.equal(meta.project, 'netx')
  const keys = [...raw.matchAll(/^([a-zA-Z_]+):/gm)].map(m => m[1])
  assert.deepEqual(keys, ['title', 'summary', 'type', 'tags', 'aliases', 'status', 'created', 'updated', 'updated_by', 'project', 'pinned', 'customZ', 'customA'])
  const patch = applyMetaPatch(meta, { pinned: null, customZ: null, title: 'new' })
  assert.equal(patch.title, 'new')
  assert.equal('pinned' in patch, false)
  assert.equal(patch.customA, 'plugin')
  assert.equal(meta.title, '发布')
})

test('bad YAML, missing frontmatter and invalid fields remain readable with defaults', () => {
  for (const raw of ['---\ntitle: [\n---\nreadable', '---\n- list\n---\nreadable', '---\nnull\n---\nreadable']) {
    const parsed = parsePage(raw)
    assert.ok(parsed.metaIssues)
    assert.equal(parsed.body, 'readable')
    assert.ok(Array.isArray(parsed.meta.aliases))
  }
  assert.equal(parsePage('body').body, 'body')
  assert.ok(parsePage('body').metaIssues)
  assert.equal(parsePage('---\nunclosed').body, '---\nunclosed')
  const parsed = parsePage('---\ntitle: Title\nsummary: Summary\ntype: invalid\nstatus: invalid-status\ntags: bad\nplugin: keep\n---\nbody')
  assert.ok(parsed.metaIssues?.some(e => e.field === 'status'))
  assert.equal(parsed.meta.type, 'topic')
  assert.deepEqual(parsed.meta.tags, [])
  assert.equal(parsed.meta.plugin, 'keep')
  assert.equal(parsePage('text\n---\ntitle: later\n---\nbody').body, 'text\n---\ntitle: later\n---\nbody')
})

test('rev hashes raw bytes, including line endings and non-ASCII', () => {
  const raw = Buffer.from('中文\r\n')
  assert.equal(computeRev(raw), createHash('sha256').update(raw).digest('hex').slice(0, 12))
  assert.equal(computeRev(raw), computeRev(raw.toString()))
  assert.notEqual(computeRev('a\n'), computeRev('a\r\n'))
})

test('frontmatter validation gives field-level reasons without echoing rejected values', () => {
  const invalid = {
    title: ' ', summary: '摘'.repeat(137), type: 'invalid-kind', tags: 'invalid-tags', aliases: [1],
    status: 'invalid-status', created: '2026-02-30', updated: 'yesterday', updated_by: '',
    verified: 'today', sources: false, project: 7, pinned: 'true',
  }
  const parsed = parsePage(serializePage(defaultMeta('topics/bad', invalid as unknown as MetaPatch), 'readable'))
  for (const field of Object.keys(invalid)) assert.ok(parsed.metaIssues?.some(e => e.field === field), field)
  assert.deepEqual(parsed.metaIssues?.find(e => e.field === 'summary'), { field: 'summary', reason: '超过 120 字（当前 137）' })
  assert.deepEqual(parsed.metaIssues?.find(e => e.field === 'tags'), { field: 'tags', reason: '必须是字符串数组' })
  assert.ok(!JSON.stringify(parsed.metaIssues).includes('invalid-tags'))
  assert.equal(parsed.body, 'readable')
  const missing = parsePage('---\ntitle: Title\n---\nbody')
  assert.ok(missing.metaIssues?.some(e => e.field === 'summary' && e.reason === '缺少必填字段'))
})

test('page statuses are active and stale; other values fail structured validation', () => {
  assert.deepEqual(PAGE_STATUSES, ['active', 'stale'])
  for (const status of ['draft', 'superseded']) {
    const parsed = parsePage(serializePage(defaultMeta('topics/page', { summary: '摘要', status: status as never }), '正文'))
    assert.deepEqual(parsed.metaIssues, [{ field: 'status', reason: '必须是以下状态之一：active、stale' }])
    assert.equal(parsed.meta.status, 'active')
  }
})
