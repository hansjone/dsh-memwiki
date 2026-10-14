import { PAGE_STATUSES, PAGE_TYPES } from '../types.ts'
import type { LintIssue, LintOptions, MetaPatch, PageRecord, PageType } from '../types.ts'

const DAY = 86_400_000
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0
const strings = (value: unknown) => Array.isArray(value) && value.every(v => typeof v === 'string')
const date = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value
const timestamp = (value: unknown) => typeof value === 'string'
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
  && date(value.slice(0, 10)) && Number.isFinite(Date.parse(value))
const TYPES: Record<string, PageType> = { user: 'user', rules: 'rule', projects: 'project', topics: 'topic', howto: 'howto', decisions: 'decision', reference: 'reference', inbox: 'inbox' }

function invalidFields(record: PageRecord): string[] {
  const m = record.meta
  const fields: string[] = []
  for (const name of ['title', 'summary', 'updated_by'] as const) if (!text(m[name])) fields.push(name)
  if (typeof m.summary === 'string' && ([...m.summary].length > 120 || /[\r\n]/u.test(m.summary))) fields.push('summary')
  if (!PAGE_TYPES.includes(m.type)) fields.push('type')
  if (!PAGE_STATUSES.includes(m.status)) fields.push('status')
  if (!date(m.created)) fields.push('created')
  if (!timestamp(m.updated)) fields.push('updated')
  for (const name of ['tags', 'aliases', 'sources'] as const) if (m[name] !== undefined && !strings(m[name])) fields.push(name)
  if (m.verified !== undefined && !date(m.verified)) fields.push('verified')
  if (m.project !== undefined && !text(m.project)) fields.push('project')
  if (m.pinned !== undefined && typeof m.pinned !== 'boolean') fields.push('pinned')
  if ((m.status === 'superseded' || m.superseded_by !== undefined) && !text(m.superseded_by)) fields.push('superseded_by')
  return fields
}

/** Returns only safely inferable metadata patches, and never edits records. */
export function fixFor(issue: LintIssue, record: PageRecord): MetaPatch | undefined {
  if (issue.page !== record.id) return undefined
  if (issue.code === 'stale_candidate') return { status: 'stale' }
  if (issue.code !== 'invalid_meta') return undefined
  const patch: MetaPatch = {}, m = record.meta
  const parts = record.id.split('/')
  if (!text(m.title)) patch.title = parts.at(-1)!
  if (!text(m.type) && TYPES[parts[0]]) patch.type = TYPES[parts[0]]
  if (!text(m.status)) patch.status = 'active'
  if (!text(m.project) && parts[0] === 'projects' && parts.length > 2) patch.project = parts[1]
  if (!text(m.created) && timestamp(m.updated)) patch.created = m.updated.slice(0, 10)
  return Object.keys(patch).length ? patch : undefined
}

/** Checks parsed records without I/O; secrets are scanned only through the injected scanner. */
export function lintRecords(records: PageRecord[], opts: LintOptions): LintIssue[] {
  const issues: LintIssue[] = []
  const ids = new Set(records.map(r => r.id.toLowerCase()))
  const incoming = new Set<string>()
  const names = new Map<string, Set<string>>()
  for (const r of records) {
    for (const target of r.links) if (target.toLowerCase() !== r.id.toLowerCase()) incoming.add(target.toLowerCase())
    for (const name of [r.meta.title, ...(Array.isArray(r.meta.aliases) ? r.meta.aliases : [])]) {
      if (!text(name)) continue
      const normalized = name.trim().toLowerCase()
      if (!names.has(normalized)) names.set(normalized, new Set())
      names.get(normalized)!.add(r.id)
    }
  }
  const add = (code: LintIssue['code'], page: string | undefined, message: string, fixable = false) => issues.push({ code, page, message, fixable })
  for (const r of records) {
    const m = r.meta
    for (const target of new Set(r.brokenLinks)) add('broken_link', r.id, `无法解析链接：${target}`)
    if (!incoming.has(r.id.toLowerCase()) && !/^(?:user|rules|inbox)\//iu.test(r.id) && !m.pinned) add('orphan', r.id, '没有其他页面链接到此页')
    if (!text(m.summary)) add('missing_summary', r.id, '缺少独立可读的摘要')
    const fields = invalidFields(r)
    if (r.metaError !== undefined || fields.length) {
      // Do not echo parser errors: they may contain raw frontmatter secrets.
      const issue: LintIssue = { code: 'invalid_meta', page: r.id, message: fields.length ? `页头字段缺失或非法：${fields.join('、')}` : '页头解析失败', fixable: false }
      issue.fixable = fixFor(issue, r) !== undefined
      issues.push(issue)
    }
    const checked = m.verified ?? m.updated
    if (!['stale', 'superseded'].includes(m.status) && opts.now.getTime() - Date.parse(checked) > opts.staleDays * DAY) {
      add('stale_candidate', r.id, `超过 ${opts.staleDays} 天未确认`, true)
    }
    if (text(m.superseded_by) && !ids.has(m.superseded_by.toLowerCase())) add('superseded_target_missing', r.id, `替代页面不存在：${m.superseded_by}`)
    if (Buffer.byteLength(r.body, 'utf8') > 20 * 1024) add('oversized', r.id, '正文超过 20 KB，建议拆分')
    if (opts.scanSecrets) {
      const scanText = Object.entries(m).map(([name, value]) => `${name}: ${typeof value === 'string' ? value : JSON.stringify(value)}`).join('\n') + '\n---\n' + r.body
      for (const finding of opts.scanSecrets(scanText)) add('secret_suspect', r.id, `敏感信息规则 ${finding.rule}，第 ${finding.line} 行`)
    }
  }
  for (const [name, pages] of names) if (pages.size > 1) {
    for (const page of pages) add('duplicate_title', page, `标题或别名重复：${name}（${[...pages].join('、')}）`)
  }
  if (opts.inboxEntries.length > 20 || opts.inboxEntries.some(entry => opts.now.getTime() - Date.parse(entry.date) > 14 * DAY)) {
    add('inbox_backlog', undefined, `inbox 有 ${opts.inboxEntries.length} 条未整理记录，数量超过 20 条或已有记录超过 14 天`)
  }
  return issues
}
