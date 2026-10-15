import { appendFile, mkdir, readFile, rename, stat } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { safeResolve } from './ids.ts'
import { withLock } from './lock.ts'
import { scanSecrets } from './secrets.ts'
import { MemwikiError } from '../types.ts'

export const USAGE_MAX_BYTES = 1024 * 1024
export const USAGE_EVENTS = ['SEARCH_ZERO', 'CONFLICT', 'SECRET_DETECTED', 'EDIT_NOT_FOUND', 'AMBIGUOUS_EDIT', 'SIMILAR_EXISTS', 'FORCE_CREATE'] as const
export type UsageEvent = typeof USAGE_EVENTS[number]
export interface UsageEntry {
  at: string
  agent: string
  event: UsageEvent
  query?: string
  pageKey?: string
  rules?: string[]
}
const safeQuery = (value: string) => scanSecrets(value).length ? '[已脱敏]' : value.slice(0, 500)
const ruleNames = new Set(['private_key', 'aws', 'github', 'api_key', 'slack', 'jwt', 'credential', 'url_credentials'])

/** Constructs an allowlisted signal. Never accepts bodies, reasons, errors or credential values. */
export async function appendUsage(dir: string, input: {
  agent: string; event: UsageEvent; query?: string; page?: string; rules?: string[]
}): Promise<void> {
  if (!USAGE_EVENTS.includes(input.event)) return
  const entry: UsageEntry = { at: new Date().toISOString(), agent: safeQuery(input.agent).slice(0, 80), event: input.event }
  if (input.event === 'SEARCH_ZERO' && input.query !== undefined) entry.query = safeQuery(input.query)
  if (input.page !== undefined) entry.pageKey = createHash('sha256').update(input.page.toLowerCase()).digest('hex').slice(0, 12)
  if (input.event === 'SECRET_DETECTED') entry.rules = [...new Set(input.rules?.filter(rule => ruleNames.has(rule)) ?? [])]
  const line = JSON.stringify(entry) + '\n'
  await withLock(dir, ':usage', async () => {
    const file = safeResolve(dir, '.memwiki/usage.jsonl')
    await mkdir(path.dirname(file), { recursive: true })
    let size = 0
    try { size = (await stat(file)).size } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    if (size + Buffer.byteLength(line) > USAGE_MAX_BYTES) {
      // rename replaces the single previous generation on supported Node platforms.
      await rename(file, safeResolve(dir, '.memwiki/usage.jsonl.1'))
    }
    await appendFile(safeResolve(dir, '.memwiki/usage.jsonl'), line, { mode: 0o600 })
  })
}
/** Counts both retained generations within days; rejects nonpositive/invalid days. */
export async function usageSummary(dir: string, days = 7, now = new Date()) {
  if (!Number.isFinite(days) || days <= 0) throw new MemwikiError('INVALID_META', 'days 必须是正数')
  const counts: Partial<Record<UsageEvent, number>> = {}
  const queries = new Map<string, number>()
  const cutoff = now.getTime() - days * 86400000
  await withLock(dir, ':usage', async () => {
    for (const rel of ['.memwiki/usage.jsonl.1', '.memwiki/usage.jsonl']) {
      let raw: string
      try { raw = await readFile(safeResolve(dir, rel), 'utf8') }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') continue; throw e }
      for (const line of raw.split('\n')) {
        let entry: UsageEntry
        try { entry = JSON.parse(line) } catch { continue }
        if (!entry || !USAGE_EVENTS.includes(entry.event) || !Number.isFinite(Date.parse(entry.at))
          || Date.parse(entry.at) < cutoff || Date.parse(entry.at) > now.getTime()) continue
        counts[entry.event] = (counts[entry.event] ?? 0) + 1
        if (entry.event === 'SEARCH_ZERO' && typeof entry.query === 'string') {
          const query = safeQuery(entry.query)
          queries.set(query, (queries.get(query) ?? 0) + 1)
        }
      }
    }
  })
  const scope = '仅记录零结果搜索（SEARCH_ZERO）、版本冲突（CONFLICT）、密钥拦截（SECRET_DETECTED）、编辑找不到或不唯一（EDIT_NOT_FOUND / AMBIGUOUS_EDIT）、相似拦截（SIMILAR_EXISTS）及成功强制新建（FORCE_CREATE）；不统计正常搜索、阅读或其他成功写入。'
  return { days, scope, message: Object.keys(counts).length ? '以下为这段时间记录的事件次数。' : '这段时间没有发生这些事件。', counts, zeroQueries: [...queries].map(([query, count]) => ({ query, count }))
    .sort((a, b) => b.count - a.count || a.query.localeCompare(b.query)).slice(0, 10) }
}
