import { createHash } from 'node:crypto'
import { parse, stringify } from 'yaml'
import { PAGE_TYPES, PAGE_STATUSES } from '../types.ts'
import type { PageMeta, MetaPatch, PageType, MetaIssue } from '../types.ts'

const ORDER = ['title', 'summary', 'type', 'tags', 'aliases', 'status', 'visibility', 'created', 'updated', 'updated_by', 'verified', 'sources', 'project', 'pinned']
const stringArray = (v: unknown) => Array.isArray(v) && v.every(x => typeof x === 'string')
const date = (v: unknown) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v
const datetime = (v: unknown) => typeof v === 'string' && date(v.slice(0, 10)) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v))
const valid: Record<string, (v: unknown) => boolean> = {
  title: v => typeof v === 'string' && !!v.trim(),
  summary: v => typeof v === 'string' && !!v.trim() && [...v].length <= 120 && !/[\r\n]/.test(v),
  type: v => PAGE_TYPES.includes(v as PageType), status: v => PAGE_STATUSES.includes(v as PageMeta['status']),
  tags: stringArray, aliases: stringArray, sources: stringArray,
  created: date, updated: datetime, updated_by: v => typeof v === 'string' && !!v.trim(),
  verified: date,
  visibility: v => v === 'company' || v === 'all',
  project: v => typeof v === 'string', pinned: v => typeof v === 'boolean',
}
const required = ['title', 'summary', 'type', 'status', 'created', 'updated', 'updated_by']

function invalidReason(field: string, value: unknown): string {
  if (['tags', 'aliases', 'sources'].includes(field)) return '必须是字符串数组'
  if (field === 'type') return '必须是以下类型之一：' + PAGE_TYPES.join('、')
  if (field === 'status') return '必须是以下状态之一：' + PAGE_STATUSES.join('、')
  if (field === 'visibility') return '必须是 company 或 all'
  if (['created', 'verified'].includes(field)) return '必须是有效日期（YYYY-MM-DD）'
  if (field === 'updated') return '必须是带时区的有效 ISO 日期时间'
  if (field === 'pinned') return '必须是布尔值'
  if (field === 'project') return '必须是字符串'
  if (typeof value !== 'string' || !value.trim()) return '必须是非空字符串'
  if (field === 'summary') {
    if ([...value].length > 120) return `超过 120 字（当前 ${[...value].length}）`
    return '必须是单行文本'
  }
  return '取值非法'
}

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

/** Parses YAML frontmatter; malformed or invalid metadata yields readable defaults and structured issues. */
export function parsePage(raw: string): { meta: PageMeta; body: string; metaIssues?: MetaIssue[] } {
  const match = /^(?:\uFEFF)?---[ \t]*\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(raw)
  const hasOpening = /^(?:\uFEFF)?---[ \t]*(?:\r?\n|$)/.test(raw)
  const body = match && match.index === 0 ? raw.slice(match[0].length) : raw
  const fallback = defaultMeta(body.match(/^#{1,6}\s+(.+)$/m)?.[1] ?? 'Untitled')
  if (!match || match.index !== 0) return { meta: fallback, body, metaIssues: [{ field: 'meta', reason: hasOpening ? '页头未闭合' : '缺少页头' }] }
  let input: Record<string, unknown>
  try {
    const value: unknown = parse(match[1])
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error()
    input = value as Record<string, unknown>
  } catch { return { meta: fallback, body, metaIssues: [{ field: 'meta', reason: '页头 YAML 无法解析' }] } }
  const errors: MetaIssue[] = required.filter(k => !(k in input)).map(field => ({ field, reason: '缺少必填字段' }))
  const meta = { ...fallback, ...input }
  for (const [key, check] of Object.entries(valid)) {
    if (key in input && !check(input[key])) {
      errors.push({ field: key, reason: invalidReason(key, input[key]) })
      if (key in fallback) meta[key] = fallback[key]
      else delete meta[key]
    }
  }
  return { meta: meta as PageMeta, body, ...(errors.length ? { metaIssues: errors } : {}) }
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
