import { randomUUID } from 'node:crypto'
import type { FeedbackEntry, FeedbackInput } from '../types.ts'
import { MemwikiError } from '../types.ts'
import { localDate } from './page.ts'

export const FEEDBACK_HEADER = /^## (feedback-[a-f0-9]{12})\r?\n日期：([^\r\n]+)\r?\nAgent：([^\r\n]+)\r?\n类型：(bug|friction|missing|rule)\r?\n标题：([^\r\n]+)\r?\n状态：([^\r\n]+)/gmu
const inline = (text: string) => text.replace(/[\r\n]+/gu, ' ').trim()
/** Lists structured monthly entries, open only unless all=true. */
export function feedbackEntries(records: { id: string; body: string }[], all = false): FeedbackEntry[] {
  return records.filter(r => /^meta\/feedback\//iu.test(r.id)).flatMap(page =>
    [...page.body.matchAll(FEEDBACK_HEADER)].map(m => ({ id: m[1], page: page.id, date: m[2], agent: m[3],
      kind: m[4] as FeedbackEntry['kind'], title: m[5], status: m[6] })))
    .filter(entry => all || entry.status === 'open').sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id))
}
/** Validates feedback fields and creates a Markdown entry with a unique short ID. */
export function feedbackBlock(input: FeedbackInput): { id: string; text: string } {
  if (!['bug', 'friction', 'missing', 'rule'].includes(input.kind)) throw new MemwikiError('INVALID_META', '反馈类型无效')
  for (const text of [input.title, input.scenario, input.expected, input.actual, input.ctx.agent]) {
    if (!text.trim() || /^## feedback-/mu.test(text)) throw new MemwikiError('INVALID_META', '反馈字段不能为空或包含保留条目标记')
  }
  const id = `feedback-${randomUUID().replaceAll('-', '').slice(0, 12)}`
  return { id, text: `\n## ${id}\n日期：${localDate()}\nAgent：${inline(input.ctx.agent)}\n类型：${input.kind}\n标题：${inline(input.title)}\n状态：open\n\n### 场景\n${input.scenario}\n\n### 期望\n${input.expected}\n\n### 实际\n${input.actual}\n` }
}
/** Changes one entry's status; invalid resolution or missing ID throws without modifying input. */
export function resolveFeedbackBody(body: string, id: string, resolution: string): string {
  if (!resolution.trim() || /[\r\n]/u.test(resolution)) throw new MemwikiError('INVALID_META', 'resolution 必须是非空单行说明')
  let found = false
  const result = body.replace(FEEDBACK_HEADER, (header: string, entryId: string) => {
    if (entryId !== id) return header
    found = true
    return header.replace(/状态：[^\r\n]+$/u, () => `状态：已解决：${resolution}`)
  })
  if (!found) throw new MemwikiError('NOT_FOUND', '反馈不存在')
  return result
}
