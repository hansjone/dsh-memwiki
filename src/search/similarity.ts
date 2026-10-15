import type { PageMeta } from '../types.ts'
import { extractLinks } from '../core/links.ts'
import { isSpecialId } from '../core/ids.ts'

export const SIMILAR_CREATE_THRESHOLD = 0.72
export const OVERLAP_THRESHOLD = 0.7
type Document = { id: string; meta: Pick<PageMeta, 'title' | 'summary' | 'status' | 'type'>; body: string }
const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Character shingles, independent of vocabulary and corpus size. */
export function shingles(text: string, size = 2): Set<string> {
  const chars = [...normalize(text)]
  return new Set(Array.from({ length: Math.max(0, chars.length - size + 1) }, (_, i) => chars.slice(i, i + size).join('')))
}
/** Set intersection / union in [0,1]; two empty sets score zero. */
export function jaccard(a: Set<string>, b: Set<string>): number {
  const intersection = [...a].filter(x => b.has(x)).length
  return a.size + b.size > 0 ? intersection / (a.size + b.size - intersection) : 0
}
/** Reference-only pages should never be treated as duplicated prose. */
export function prose(body: string): string {
  let result = body
  for (const link of extractLinks(body).reverse()) result = result.slice(0, link.start) + result.slice(link.end)
  return result.replace(/!?\[[^\]\n]*\]\([^\n)]*\)/gu, '').replace(/^\s*#{1,6}[^\n]*$/gmu, '')
}
/** Formal knowledge pages eligible for duplicate detection (excluding inbox/meta/special files). */
export function contentEligible(page: Document): boolean {
  return !isSpecialId(page.id) && page.meta.type !== 'inbox'
    && page.meta.type !== 'meta' && !/^(?:inbox|meta)\//iu.test(page.id)
}
/** Five-character prose overlap; short or reference-only content scores zero. */
export function contentSimilarity(a: string, b: string): number {
  return jaccard(contentFingerprint(a), contentFingerprint(b))
}
/** Reusable prose shingles; requires at least 40 normalized characters. */
export function contentFingerprint(body: string): Set<string> {
  const text = prose(body)
  return [...normalize(text)].length < 40 ? new Set() : shingles(text, 5)
}
/** Explainable [0,1] score: bigram title/summary identity plus five-character prose overlap. */
export function createSimilarity(a: Pick<Document, 'meta' | 'body'>, b: Pick<Document, 'meta' | 'body'>): number {
  const title = jaccard(shingles(a.meta.title), shingles(b.meta.title))
  const summary = jaccard(shingles(a.meta.summary), shingles(b.meta.summary))
  const body = contentSimilarity(a.body.slice(0, 2000), b.body.slice(0, 2000))
  return Math.max(0.8 * title + 0.2 * summary, 0.9 * body, 0.45 * (0.8 * title + 0.2 * summary) + 0.55 * body)
}
/** At most three eligible candidates at/above threshold, highest similarity first. */
export function similarPages(candidate: Pick<Document, 'meta' | 'body'>, pages: Document[], threshold = SIMILAR_CREATE_THRESHOLD) {
  return pages.filter(contentEligible).map(page => ({ id: page.id, title: page.meta.title, summary: page.meta.summary,
    similarity: createSimilarity(candidate, page) }))
    .filter(hit => hit.similarity >= threshold && hit.similarity > 0)
    .sort((a, b) => b.similarity - a.similarity || a.id.localeCompare(b.id)).slice(0, 3)
}
