import type { WikiLink } from '../types.ts'

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
