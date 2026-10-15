import { createHash } from 'node:crypto'
import { parse, stringify } from 'yaml'
import { PAGE_TYPES, PAGE_STATUSES } from '../types.ts'
import type { PageMeta, MetaPatch, PageType } from '../types.ts'

const ORDER = ['title', 'summary', 'type', 'tags', 'aliases', 'status', 'created', 'updated', 'updated_by', 'verified', 'sources', 'superseded_by', 'project', 'pinned']
const stringArray = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const datetime = (v: unknown) => typeof v === 'string' && date(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))
const valid: Record<string, (v: unknown) => boolean> = {
  title: v => typeof v === 'string' && !!v.trim(),
  summary: v => typeof v === 'string' && !!v.trim() && [...v].length <= 120 && !/[\r\n]/.test(v),
  type: v => PAGE_TYPES.includes(v as PageType), status: v => PAGE_STATUSES.includes(v as PageMeta['status']),
  tags: stringArray, aliases: stringArray, sources: stringArray,
  created: date, updated: datetime, updated_by: v => typeof v === 'string' && !!v.trim(),
  verified: date, superseded_by: v => typeof v === 'string' && !!v.trim(),
  project: v => typeof v === 'string', pinned: v => typeof v === 'boolean',
}
const required = ['title', 'summary', 'type', 'status', 'created', 'updated', 'updated_by']

const pad = (n: number, width = 2) => String(Math.trunc(Math.abs(n))).padStart(width, '0')

/** Local wall-clock ISO datetime with offset, e.g. `2026-10-14T22:05:30+08:00` (§3.2). */
export function nowIso(at = new Date()): string {
  const offset = -at.getTimezoneOffset()
  const sign = offset >= 0 ? '+' : '-'
  return `${localDate(at)}T${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
    + `${sign}${pad(offset / 60)}:${pad(offset % 60)}`
}

/** Local calendar date `YYYY-MM-DD`; UTC dates are off by one near midnight outside UTC. */
export function localDate(at = new Date()): string {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`
}

/** Supplies inferred metadata for a new ID, then applies the supplied patch. */
export function defaultMeta(id: string, patch: MetaPatch = {}): PageMeta {
  const parts = id.split('/')
  const kind: Record<string, PageType> = { user: 'user', rules: 'rule', projects: 'project', topics: 'topic', howto: 'howto', decisions: 'decision', reference: 'reference', inbox: 'inbox', meta: 'meta' }
  const meta: PageMeta = { title: parts.at(-1) || 'Untitled', summary: '', type: kind[parts[0]] ?? 'topic', tags: [], aliases: [], status: 'active', created: localDate(), updated: nowIso(), updated_by: 'external' }
  if (parts[0] === 'projects' && parts.length > 2) meta.project = parts[1]
  return applyMetaPatch(meta, patch)
}

/** Merges metadata without mutating the input; null removes a key, unknown keys survive. */
export function applyMetaPatch(meta: PageMeta, patch: MetaPatch): PageMeta {
  const next = { ...meta }
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete next[key]
    else if (value !== undefined) next[key] = value
  }
  return next
}

/** Parses YAML frontmatter; malformed or invalid metadata yields readable defaults and metaError. */
export function parsePage(raw: string): { meta: PageMeta; body: string; metaError?: string } {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(raw)
  const hasOpening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(raw)
  const body = match && match.index === 0 ? raw.slice(match[0].length) : raw
  const fallback = defaultMeta(body.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? 'Untitled')
  if (!match || match.index !== 0) return { meta: fallback, body, metaError: hasOpening ? '页头未闭合' : '缺少页头' }
  let input: Record<string, unknown>
  try {
    const value: unknown = parse(match[1])
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    input = value as Record<string, unknown>
  } catch { return { meta: fallback, body, metaError: '页头 YAML 无法解析' } }
  const errors = required.filter(k => !(k in input))
  const meta = { ...fallback, ...input }
  for (const [key, check] of Object.entries(valid)) {
    if (key in input && !check(input[key])) {
      errors.push(key)
      if (key in fallback) meta[key] = fallback[key]
      else delete meta[key]
    }
  }
  if (meta.status === 'superseded' && !meta.superseded_by) errors.push('superseded_by')
  return { meta: meta as PageMeta, body, ...(errors.length ? { metaError: '页头字段缺失或非法：' + [...new Set(errors)].join(', ') } : {}) }
}

/** Serializes metadata in the canonical field order, then unknown keys in original order. */
export function serializePage(meta: PageMeta, body: string): string {
  const ordered = Object.create(null) as Record<string, unknown>
  for (const key of [...ORDER, ...Object.keys(meta).filter(k => !ORDER.includes(k))]) {
    if (meta[key] !== undefined) ordered[key] = meta[key]
  }
  return '---\n' + stringify(ordered, { lineWidth: 0 }) + '---\n' + body
}

/** SHA-256 of original UTF-8 text or bytes, truncated to 12 hexadecimal characters. */
export function computeRev(raw: string | Uint8Array): string { return createHash('sha256').update(raw).digest('hex').slice(0, 12) }
