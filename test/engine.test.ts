import assert from 'node:assert/strict'
import { test } from 'node:test'
import { performance } from 'node:perf_hooks'
import { createSearchEngine } from '../src/search/engine.ts'
import { record } from './record.ts'
import type { SearchQuery } from '../src/types.ts'

test('finds Chinese bigrams, English subwords and fullwidth queries', () => {
  const engine = createSearchEngine()
  engine.load([record('topics/encoding', { title: 'PowerShell 中文乱码' }), record('projects/netx/start', {}, 'Run startNetx now')])
  assert.equal(engine.search({ query: '乱码' })[0].id, 'topics/encoding')
  assert.equal(engine.search({ query: 'ＮＥＴＸ' })[0].id, 'projects/netx/start')
  assert.deepEqual(engine.search({ query: 'unknown' }), [])
  assert.deepEqual(engine.search({ query: '' }), [])
})

test('BM25F ranks title, aliases, tags, summary, headings and body by field weight', () => {
  const engine = createSearchEngine()
  const pages = Array.from({ length: 6 }, (_, i) => record(`topics/${i}`, {
    title: i === 0 ? 'needle' : 'plain', aliases: [i === 1 ? 'needle' : 'plain'], tags: [i === 2 ? 'needle' : 'plain'], summary: i === 3 ? 'needle' : 'plain',
  }, `# ${i === 4 ? 'needle' : 'plain'}\n${i === 5 ? 'needle' : 'plain'}`))
  engine.load(pages)
  const hits = engine.search({ query: 'needle absent' })
  assert.deepEqual(hits.map(h => h.id), pages.map(p => p.id))
  const idf = Math.log(1 + 0.5 / 6.5)
  hits.forEach((hit, i) => {
    const tf = [4, 3, 2.5, 2, 1.5, 1][i]
    assert.ok(Math.abs(hit.score - idf * 2.2 * tf / (1.2 + tf)) < 1e-12)
  })
})

test('applies exact-phrase boosts in title, alias and body', () => {
  const engine = createSearchEngine()
  engine.load([record('topics/title', { title: 'alpha beta' }, 'alpha beta'), record('topics/alias', { aliases: ['alpha beta'] }, 'alpha beta')])
  for (const id of ['topics/title', 'topics/alias']) {
    const exact = engine.search({ query: 'alpha beta' }).find(h => h.id === id)!
    const reversed = engine.search({ query: 'beta alpha' }).find(h => h.id === id)!
    assert.ok(Math.abs(exact.score / reversed.score - 2.6) < 1e-12)
  }
})

test('project boosts without filtering; status multipliers, defaults and timestamps are respected', () => {
  const engine = createSearchEngine()
  const pages = ['active', 'stale'].map((status, i) => record(`topics/${i}`, {
    title: 'needle', status: status as 'active' | 'stale', project: 'netx',
  }))
  pages.push(record('projects/netx/inferred', { title: 'needle' }), record('topics/other', { title: 'needle', project: 'other' }))
  engine.load(pages)
  const all = engine.search({ query: 'needle', project: 'netx' })
  const base = all.find(h => h.id === 'topics/0')!.score
  for (const [i, factor] of [1, 0.4].entries()) assert.ok(Math.abs(all.find(h => h.id === `topics/${i}`)!.score / base - factor) < 1e-12)
  assert.ok(all.some(h => h.id === 'topics/other'))
  assert.equal(all.find(h => h.id === 'projects/netx/inferred')!.score, base)
  assert.ok(Math.abs(base / all.find(h => h.id === 'topics/other')!.score - 1.3) < 1e-12)
  engine.load([record('topics/old', { title: 'needle', updated: '2026-10-01T00:00:00Z' }), record('topics/new', { title: 'needle', updated: '2026-10-02T00:00:00+08:00' })])
  assert.equal(engine.search({ query: 'needle' })[0].id, 'topics/new')
})

test('filters by type, every tag and ID prefix, and defaults to eight hits', () => {
  const engine = createSearchEngine()
  engine.load(Array.from({ length: 12 }, (_, i) => record(`topics/${i}`, { title: 'needle', type: i % 2 ? 'howto' : 'topic', tags: i % 3 ? ['a'] : ['a', 'b'] })))
  assert.equal(engine.search({ query: 'needle' }).length, 8)
  assert.equal(engine.search({ query: 'needle', limit: 2 }).length, 2)
  assert.deepEqual(engine.search({ query: 'needle', limit: 0 }), [])
  assert.deepEqual(engine.search({ query: 'needle', type: 'howto', tags: ['a', 'b'] }).map(h => h.id), ['topics/3', 'topics/9'])
  assert.deepEqual(engine.search({ query: 'needle', dir: 'TOPICS/11' }).map(h => h.id), ['topics/11'])
})

test('snippets use the richest matching lines, neighboring lines and at most 200 characters', () => {
  const engine = createSearchEngine()
  engine.load([record('topics/snippet', {}, 'before\nalpha beta\nafter\nblank\nsecond before\nalpha\nsecond after')])
  const [hit] = engine.search({ query: 'alpha beta' })
  assert.deepEqual(hit.snippets, ['before\nalpha beta\nafter', 'second before\nalpha\nsecond after'])
  engine.load([record('topics/long', {}, 'p'.repeat(300) + '\n' + 'x'.repeat(500) + ' needle ' + 'y'.repeat(500) + '\nend')])
  const snippets = engine.search({ query: 'needle' })[0].snippets
  assert.ok(snippets.every(s => [...s].length <= 200))
  assert.ok(snippets.some(s => s.includes('needle')))
  engine.upsert(record('topics/long', {}, ' '.repeat(500) + 'ｎｅｅｄｌｅ' + ' '.repeat(500)))
  assert.ok(engine.search({ query: 'needle' })[0].snippets[0].includes('ｎｅｅｄｌｅ'))
  engine.upsert(record('topics/long', {}, 'p'.repeat(100) + '\nneedle\nend'))
  assert.equal(engine.search({ query: 'needle' })[0].snippets[0], 'p'.repeat(100) + '\nneedle\nend')
  engine.load([record('topics/title-only', { title: 'needle', summary: '长'.repeat(300) }, '')])
  assert.equal([...engine.search({ query: 'needle' })[0].snippets[0]].length, 200)
})

test('incremental mutations equal full reload, including field averages and ID case', () => {
  const incremental = createSearchEngine(), full = createSearchEngine()
  let pages = [record('topics/a', { title: 'alpha beta' }), record('topics/b', {}, 'alpha alpha'), record('topics/c', {}, 'beta')]
  incremental.load(pages)
  const compare = () => {
    full.load(pages)
    for (const query of [{ query: 'alpha beta' }, { query: '乱码' }, { query: 'alpha', project: 'netx' }] satisfies SearchQuery[]) {
      assert.deepEqual(incremental.search(query), full.search(query))
    }
  }
  compare()
  const updated = record('topics/A', { title: '中文乱码 alpha', project: 'netx', aliases: ['beta'], status: 'stale' }, 'beta '.repeat(200))
  pages = [updated, ...pages.slice(1)]; incremental.upsert(updated); compare()
  pages = pages.filter(p => p.id !== 'topics/b'); incremental.remove('TOPICS/B'); compare()
  incremental.remove('absent'); compare()
  const extra = record('topics/d', {}, 'alpha beta'); pages.push(extra); incremental.upsert(extra); compare()
  incremental.load([]); assert.deepEqual(incremental.search({ query: 'alpha beta' }), [])
})

test('generated pages and underscore files do not enter search', () => {
  const engine = createSearchEngine()
  engine.load(['index', 'log', '_guide', 'topics/_hidden', 'topics/visible'].map(id => record(id, { title: 'needle' })))
  assert.deepEqual(engine.search({ query: 'needle' }).map(h => h.id), ['topics/visible'])
})

test('loads 1000 bilingual ~2 KB pages and runs 20 queries within 1.5 seconds', () => {
  const body = ('中文乱码 排查指南 startNetx network configuration deployment 编码 UTF8\n').repeat(24)
  const pages = Array.from({ length: 1000 }, (_, i) => record(`projects/netx/page-${i}`, { title: `中文乱码 network ${i}`, project: 'netx', tags: ['windows', '编码'] }, body))
  assert.ok(Buffer.byteLength(body) >= 1800 && Buffer.byteLength(body) <= 2600)
  const engine = createSearchEngine(), start = performance.now()
  engine.load(pages)
  const loaded = performance.now()
  for (let i = 0; i < 20; i++) assert.ok(engine.search({ query: ['乱码', 'netx', 'configuration', '编码 network'][i % 4] }).length)
  const elapsed = performance.now() - start
  console.log(`search performance: load=${(loaded - start).toFixed(1)} ms, load + 20 queries=${elapsed.toFixed(1)} ms`)
  assert.ok(elapsed < 1500, `elapsed ${elapsed.toFixed(1)} ms`)
})
