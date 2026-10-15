import type { WikiLink } from '../types.ts'
import path from 'node:path'
import { normalizeId } from './ids.ts'

const LINK_RE = /\[\[([^\[\]\n]+?)\]\]/g

/**
 * Returns `[start, end)` ranges of fenced code blocks (``` / ~~~) and inline
 * code spans; links inside them are not links (§3.4).
 */
export function codeRanges(body: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  const fence = /^( {0,3})(`{3,}|~{3,})[^\n]*$/gm
  let open: { marker: string; start: number } | undefined
  for (let m = fence.exec(body); m !== null; m = fence.exec(body)) {
    const marker = m[2]
    if (open === undefined) {
      open = { marker, start: m.index }
    } else if (marker[0] === open.marker[0] && marker.length >= open.marker.length) {
      ranges.push([open.start, m.index + m[0].length])
      open = undefined
    }
  }
  if (open !== undefined) ranges.push([open.start, body.length])

  const inside = (i: number) => ranges.some(([s, e]) => i >= s && i < e)
  const inline = /(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g
  const inlineRanges: Array<[number, number]> = []
  for (let m = inline.exec(body); m !== null; m = inline.exec(body)) {
    if (!inside(m.index)) inlineRanges.push([m.index, m.index + m[0].length])
  }
  return [...ranges, ...inlineRanges].sort((a, b) => a[0] - b[0])
}

/** Parses the inside of `[[...]]` into target / heading / label. */
export function parseLinkInner(inner: string): Pick<WikiLink, 'target' | 'heading' | 'label'> {
  let rest = inner
  let label: string | undefined
  const bar = rest.indexOf('|')
  if (bar >= 0) {
    label = rest.slice(bar + 1).trim() || undefined
    rest = rest.slice(0, bar)
  }
  let heading: string | undefined
  const hash = rest.indexOf('#')
  if (hash >= 0) {
    heading = rest.slice(hash + 1).trim() || undefined
    rest = rest.slice(0, hash)
  }
  return { target: rest.trim(), heading, label }
}

/**
 * Extracts every `[[target]]`, `[[target|label]]`, `[[target#heading]]` outside
 * code blocks and inline code, in document order. Links with an empty target
 * (pure `[[#heading]]` self-references) are skipped.
 */
export function extractLinks(body: string): WikiLink[] {
  const skip = codeRanges(body)
  const inSkip = (i: number) => skip.some(([s, e]) => i >= s && i < e)
  const out: WikiLink[] = []
  for (const m of body.matchAll(LINK_RE)) {
    const start = m.index
    if (inSkip(start)) continue
    const parsed = parseLinkInner(m[1])
    if (parsed.target === '') continue
    out.push({ ...parsed, start, end: start + m[0].length })
  }
  return out
}

/** Serializes a link back to `[[...]]` text. */
export function formatLink(target: string, heading?: string, label?: string): string {
  return '[[' + target + (heading ? '#' + heading : '') + (label ? '|' + label : '') + ']]'
}

/** A relative Markdown page link; replacement is absent when it cannot safely become a wikilink. */
export interface MarkdownPageLink { start: number; end: number; replacement?: string }

/** Finds inline relative `.md` links outside code, excluding images and external URLs. */
export function markdownPageLinks(body: string, pageId: string): MarkdownPageLink[] {
  const skip = codeRanges(body)
  const out: MarkdownPageLink[] = []
  const pattern = /(?<!!)\[([^\]\n]*)\]\(\s*(?:<([^>\n]+)>|((?:\\.|[^\s\\()]|\([^()\n]*\))+))(?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^\)\n]*\)))?\s*\)/g
  for (const m of body.matchAll(pattern)) {
    const start = m.index, end = start + m[0].length
    if (skip.some(([s, e]) => start < e && end > s) || /(?:^|[^\\])(?:\\\\)*\\$/.test(body.slice(0, start))) continue
    const href = (m[2] ?? m[3]).replace(/\\([() ])/g, '$1')
    if (/^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(href)) continue
    const hash = href.indexOf('#')
    const file = hash < 0 ? href : href.slice(0, hash)
    if (!/\.md$/i.test(file)) continue
    let replacement: string | undefined
    try {
      const target = normalizeId(path.posix.join(path.posix.dirname(pageId), decodeURIComponent(file).slice(0, -3)))
      const heading = hash < 0 ? undefined : decodeURIComponent(href.slice(hash + 1))
      const label = m[1]
      if (!/[\[\]#|\r\n]/.test(target) && !/[\[\]|\r\n]/.test((heading ?? '') + label)) {
        replacement = formatLink(target, heading, label)
      }
    } catch { /* malformed escapes, invalid IDs or paths outside the vault require manual correction */ }
    out.push({ start, end, replacement })
  }
  return out
}

/** Converts safe relative Markdown page links into vault-relative wikilinks, preserving surrounding text. */
export function convertMarkdownLinks(body: string, pageId: string): string {
  let result = body
  for (const link of markdownPageLinks(body, pageId).reverse()) {
    if (link.replacement !== undefined) result = result.slice(0, link.start) + link.replacement + result.slice(link.end)
  }
  return result
}

/** Resolves ID, title, alias, then basename, case-insensitively; reports candidates at the first matching tier. */
export function createResolver(pages: Array<{ id: string; title: string; aliases: string[] }>):
  (target: string) => { id: string } | { ambiguous: string[] } | undefined {
  const tiers = [
    (p: typeof pages[number]) => [p.id],
    (p: typeof pages[number]) => [p.title],
    (p: typeof pages[number]) => p.aliases,
    (p: typeof pages[number]) => [p.id.split('/').at(-1)!],
  ].map(keys => {
    const index = new Map<string, Set<string>>()
    for (const page of pages) for (const value of keys(page)) {
      const key = value.toLowerCase()
      if (!index.has(key)) index.set(key, new Set())
      index.get(key)!.add(page.id)
    }
    return index
  })
  return target => {
    const key = target.trim().toLowerCase()
    for (const tier of tiers) {
      const matches = tier.get(key)
      if (matches?.size) {
        const ids = [...matches].sort()
        return ids.length === 1 ? { id: ids[0] } : { ambiguous: ids }
      }
    }
    return undefined
  }
}

/** Replaces only non-code link targets, preserving heading, label and whitespace verbatim. */
export function rewriteLinks(body: string, map: (target: string) => string | undefined): string {
  let result = body
  for (const link of extractLinks(body).reverse()) {
    const replacement = map(link.target)
    if (replacement === undefined) continue
    const raw = body.slice(link.start + 2, link.end - 2)
    const boundary = raw.search(/[#|]/)
    const target = boundary < 0 ? raw : raw.slice(0, boundary)
    const left = target.length - target.trimStart().length
    const right = target.trimEnd().length
    result = result.slice(0, link.start + 2 + left) + replacement + result.slice(link.start + 2 + right)
  }
  return result
}
