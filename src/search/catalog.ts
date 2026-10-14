import type { ContextOptions, PageRecord } from '../types.ts'
import { nowIso } from '../core/page.ts'

const ORDER = ['user', 'rules', 'projects', 'topics', 'howto', 'decisions', 'reference']
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0
const oneLine = (text: string) => text.replace(/[\r\n]+/gu, ' ').trim()
const visible = (r: PageRecord) => !['index', 'log'].includes(r.id.toLowerCase()) && !r.id.split('/').at(-1)!.startsWith('_')
const top = (r: PageRecord) => r.id.includes('/') ? r.id.split('/')[0] : '(root)'
const newest = (a: PageRecord, b: PageRecord) => (Date.parse(b.meta.updated) || 0) - (Date.parse(a.meta.updated) || 0) || compare(a.id, b.id)

/** Builds a deterministic human directory; only the supplied generation timestamp varies. */
export function buildIndexMd(records: PageRecord[], opts: { generatedAt: Date }): string {
  const pages = records.filter(visible)
  const groups = new Map<string, PageRecord[]>()
  for (const r of pages) {
    const group = top(r)
    if (!groups.has(group)) groups.set(group, [])
    groups.get(group)!.push(r)
  }
  const extras = [...groups.keys()].filter(group => !ORDER.includes(group) && group !== 'inbox').sort(compare)
  const lines = ['# 记忆目录', '', `共 ${pages.length} 页`, `生成时间：${nowIso(opts.generatedAt)}`]
  const append = (r: PageRecord) => lines.push(`- [[${r.id}|${oneLine(r.meta.title)}]] — ${oneLine(r.meta.summary)}${r.meta.status === 'active' ? '' : ` （${r.meta.status}）`}`)
  for (const group of [...ORDER, ...extras, 'inbox']) {
    const rows = groups.get(group)
    if (!rows) continue
    lines.push('', `## ${group}`, '')
    if (group === 'inbox') {
      lines.push(`共 ${rows.length} 页待整理`)
    } else if (group === 'projects') {
      const names = [...new Set(rows.map(r => r.id.split('/')[1]))].sort(compare)
      for (const name of names) {
        lines.push(`### ${name}`, '')
        rows.filter(r => r.id.split('/')[1] === name).sort((a, b) => compare(a.id, b.id)).forEach(append)
        lines.push('')
      }
      if (lines.at(-1) === '') lines.pop()
    } else rows.sort((a, b) => compare(a.id, b.id)).forEach(append)
  }
  return lines.join('\n') + '\n'
}

/** Builds priority-ordered context within a strict UTF-8 budget (4096 by default).
 * If even the omission notice cannot fit, returns an empty string.
 */
export function buildContext(records: PageRecord[], opts: ContextOptions): string {
  const requested = opts.budgetBytes ?? 4096
  const budget = Number.isFinite(requested) ? Math.max(0, Math.floor(requested)) : 4096
  // Inbox pages are raw captures; they are summarized by the inbox count footer instead of listed.
  const pages = records.filter(r => visible(r) && r.meta.type !== 'inbox')
  const priority = (r: PageRecord) => r.meta.pinned ? 0 : ['rule', 'user'].includes(r.meta.type) ? 1
    : opts.project && (r.meta.project ?? (top(r) === 'projects' ? r.id.split('/')[1] : undefined)) === opts.project ? 2 : 3
  const ordered = [...pages].sort((a, b) => priority(a) - priority(b) || newest(a, b))
  const header = `记忆库：${oneLine(opts.vaultDir)}，共 ${pages.length} 页。写入前先搜索，规范见 [[_guide]]`
  const rows = ordered.map(r => `- [[${r.id}]] — ${oneLine(r.meta.summary)}${r.meta.status === 'stale' ? '（可能过时）' : ''}`)
  const footer = `inbox 未整理条目：${opts.inboxCount}${opts.inboxCount > 0 ? '，需要整理' : ''}`
  const bytes = (text: string) => Buffer.byteLength(text, 'utf8')
  const all = [header, ...rows, footer].join('\n')
  if (bytes(all) <= budget) return all
  const notice = (n: number) => `……还有 ${n} 页未列出，用 memwiki_search 查找`
  const lines: string[] = []
  let used = 0, listed = 0
  const fits = (line: string, remaining: number) => used + (lines.length ? 1 : 0) + bytes(line) + 1 + bytes(notice(remaining)) <= budget
  if (fits(header, pages.length)) {
    lines.push(header); used = bytes(header)
    for (const row of rows) {
      if (!fits(row, pages.length - listed - 1)) break
      used += 1 + bytes(row); lines.push(row); listed++
    }
    if (listed === pages.length && fits(footer, 0)) lines.push(footer)
  }
  const omitted = notice(pages.length - listed)
  if (bytes(omitted) > budget) return ''
  lines.push(omitted)
  return lines.join('\n')
}
