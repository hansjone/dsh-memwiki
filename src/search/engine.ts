import type { PageRecord, SearchEngine, SearchHit, SearchQuery } from '../types.ts'
import { tokenize } from './tokenize.ts'
import { isSpecialId } from '../core/ids.ts'

const WEIGHTS = [4, 3, 2.5, 2, 1.5, 1]
const compact = (text: string) => text.normalize('NFKC').toLowerCase().replace(/\s+/gu, '')
const key = (id: string) => id.toLowerCase()
const visible = (id: string) => !isSpecialId(id)
interface Field { counts: Map<string, number>; length: number }
interface Indexed {
  record: PageRecord
  fields: Field[]
  terms: Set<string>
  phrases: string[]
  lines: string[]
  lineTerms: Set<string>[]
}

function field(tokens: string[]): Field {
  const counts = new Map<string, number>()
  for (const term of tokens) counts.set(term, (counts.get(term) ?? 0) + 1)
  return { counts, length: tokens.length }
}

function index(record: PageRecord): Indexed {
  const lines = record.body.split(/\r?\n/u)
  const lineTokens = lines.map(tokenize)
  const headings: string[] = [], body: string[] = []
  lines.forEach((line, i) => (/^\s{0,3}#/u.test(line) ? headings : body).push(...lineTokens[i]))
  const fields = [field(tokenize(record.meta.title ?? '')), field(tokenize((record.meta.aliases ?? []).join(' '))),
    field(tokenize((record.meta.tags ?? []).join(' '))), field(tokenize(record.meta.summary ?? '')),
    field(headings), field(body)]
  return {
    record: { ...record, meta: { ...record.meta, tags: [...(record.meta.tags ?? [])], aliases: [...(record.meta.aliases ?? [])] } },
    fields, terms: new Set(fields.flatMap(f => [...f.counts.keys()])),
    phrases: [compact(record.meta.title ?? ''), ...(record.meta.aliases ?? []).map(compact), compact(record.body)],
    lines, lineTerms: lineTokens.map(tokens => new Set(tokens)),
  }
}

function excerpts(doc: Indexed, terms: string[]): string[] {
  const ranked = doc.lines.map((_, i) => ({ i, hits: terms.reduce((n, term) => n + Number(doc.lineTerms[i].has(term)), 0) }))
    .filter(row => row.hits > 0).sort((a, b) => b.hits - a.hits || a.i - b.i)
  const selected: number[] = []
  const snippets: string[] = []
  for (const { i } of ranked) {
    if (selected.some(other => Math.abs(i - other) <= 2)) continue
    const surrounding = doc.lines.slice(Math.max(0, i - 1), i + 2).join('\n')
    if ([...surrounding].length <= 200) {
      snippets.push(surrounding)
      selected.push(i)
      if (snippets.length === 2) break
      continue
    }
    const line = [...doc.lines[i]]
    let core = line.join('')
    if (line.length > 200) {
      const normalizedChars = line.map(char => char.normalize('NFKC').toLowerCase())
      const normalized = normalizedChars.join('')
      const first = Math.min(...terms.map(term => normalized.indexOf(term)).filter(pos => pos >= 0))
      let offset = 0, match = 0
      if (Number.isFinite(first)) {
        while (match < line.length && offset + normalizedChars[match].length <= first) offset += normalizedChars[match++].length
      }
      const start = Math.max(0, Math.min(match - 50, line.length - 200))
      core = line.slice(start, start + 200).join('')
    }
    const spare = 200 - [...core].length
    const beforeSize = Math.floor((spare - 1) / 2)
    const before = i > 0 && beforeSize > 0 ? [...doc.lines[i - 1]].slice(-beforeSize).join('') : ''
    const prefix = before ? before + '\n' : ''
    const remaining = 200 - [...prefix + core].length
    const after = i + 1 < doc.lines.length && remaining > 1 ? [...doc.lines[i + 1]].slice(0, remaining - 1).join('') : ''
    snippets.push(prefix + core + (after ? '\n' + after : ''))
    selected.push(i)
    if (snippets.length === 2) break
  }
  return snippets.length ? snippets : [[...(doc.record.body || doc.record.meta.summary || doc.record.meta.title)].slice(0, 200).join('')]
}

/** Creates an in-memory BM25F index. Project boosts results; type/tags/dir filter them. */
export function createSearchEngine(): SearchEngine {
  const docs = new Map<string, Indexed>()
  const postings = new Map<string, Set<string>>()
  const lengths = WEIGHTS.map(() => 0)
  const remove = (id: string) => {
    const idKey = key(id), previous = docs.get(idKey)
    if (!previous) return
    previous.fields.forEach((f, i) => { lengths[i] -= f.length })
    for (const term of previous.terms) {
      const ids = postings.get(term)!
      ids.delete(idKey)
      if (ids.size === 0) postings.delete(term)
    }
    docs.delete(idKey)
  }
  const upsert = (record: PageRecord) => {
    remove(record.id)
    if (!visible(record.id)) return
    const doc = index(record), idKey = key(record.id)
    docs.set(idKey, doc)
    doc.fields.forEach((f, i) => { lengths[i] += f.length })
    for (const term of doc.terms) {
      if (!postings.has(term)) postings.set(term, new Set())
      postings.get(term)!.add(idKey)
    }
  }
  return {
    load(records) {
      docs.clear(); postings.clear(); lengths.fill(0)
      records.forEach(upsert)
    },
    upsert, remove,
    search(q: SearchQuery): SearchHit[] {
      const terms = [...new Set(tokenize(q.query))]
      const limit = q.limit === undefined ? 8 : Math.max(0, Math.floor(q.limit))
      if (!terms.length || !limit || !docs.size) return []
      const scores = new Map<string, number>()
      for (const term of terms) {
        const ids = postings.get(term)
        if (!ids) continue
        const idf = Math.log(1 + (docs.size - ids.size + 0.5) / (ids.size + 0.5))
        for (const id of ids) {
          const doc = docs.get(id)!
          let tf = 0
          doc.fields.forEach((f, i) => {
            const count = f.counts.get(term) ?? 0
            if (count) tf += WEIGHTS[i] * count / (0.25 + 0.75 * f.length / (lengths[i] / docs.size || 1))
          })
          scores.set(id, (scores.get(id) ?? 0) + idf * (2.2 * tf) / (1.2 + tf))
        }
      }
      const phrase = compact(q.query)
      const ranked: { doc: Indexed; score: number }[] = []
      for (const [id, initial] of scores) {
        const doc = docs.get(id)!, { meta } = doc.record
        if ((q.type && q.type !== meta.type)
          || (q.tags && !q.tags.every(tag => meta.tags.includes(tag))) || (q.dir && !id.startsWith(key(q.dir)))) continue
        let score = initial
        if (doc.phrases.slice(0, -1).some(text => text.includes(phrase))) score *= 2
        if (doc.phrases.at(-1)!.includes(phrase)) score *= 1.3
        const project = meta.project ?? (id.startsWith('projects/') ? doc.record.id.split('/')[1] : undefined)
        if (q.project && project === q.project) score *= 1.3
        if (meta.status === 'stale') score *= 0.4
        ranked.push({ doc, score })
      }
      ranked.sort((a, b) => b.score - a.score
        || (Date.parse(b.doc.record.meta.updated) || 0) - (Date.parse(a.doc.record.meta.updated) || 0)
        || (a.doc.record.id < b.doc.record.id ? -1 : a.doc.record.id > b.doc.record.id ? 1 : 0))
      return ranked.slice(0, limit).map(({ doc, score }) => {
        const { id, meta } = doc.record
        return { id, title: meta.title, summary: meta.summary, type: meta.type, status: meta.status,
          updated: meta.updated, score, snippets: excerpts(doc, terms) }
      })
    },
  }
}
