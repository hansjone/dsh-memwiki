import { appendFile, mkdir, readFile, readdir } from 'node:fs/promises'
import { MemwikiError } from '../types.ts'
import type { LogEntry } from '../types.ts'
import { safeResolve } from './ids.ts'
import { withLock } from './lock.ts'
import { shortDescription } from './limits.ts'

const clean = (s: string) => s.replace(/[\r\n]/g, ' ')
function render(entry: LogEntry): string {
  const visible = `- ${entry.at.slice(0, 10)} ${entry.at.slice(11, 16)} [${clean(entry.agent)}] ${clean(entry.action)}${entry.page ? ' [[' + clean(entry.page) + ']]' : ''}：${clean(entry.reason)}`
  // Preserve timezone, seconds and arbitrary fields without compromising the human-readable line.
  return visible + ' <!-- memwiki:' + Buffer.from(JSON.stringify(entry)).toString('base64') + ' -->'
}

/** Vault-relative monthly log path for a complete ISO timestamp. */
export function logPath(at: string): string {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])-\d{2}T/.test(at) || Number.isNaN(Date.parse(at))) throw new MemwikiError('INVALID_META', '日志时间无效')
  return `log/${at.slice(0, 7)}.md`
}

/** Reads newest months first, stopping as soon as limit structured entries are available. */
export async function readLog(vaultDir: string, limit: number): Promise<LogEntry[]> {
  if (limit <= 0) return []
  let names: string[]
  try { names = await readdir(safeResolve(vaultDir, 'log')) }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const entries: LogEntry[] = []
  for (const name of names.filter(n => /^\d{4}-(?:0[1-9]|1[0-2])\.md$/.test(n)).sort().reverse()) {
    const raw = await readFile(safeResolve(vaultDir, `log/${name}`), 'utf8')
    const monthly: LogEntry[] = []
    for (const line of raw.split(/\r?\n/).reverse()) {
      const encoded = line.match(/<!-- memwiki:([A-Za-z0-9+/=]+) -->$/)
      if (!encoded) continue
      try {
        const entry = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')) as LogEntry
        if (entry && ['at', 'agent', 'action', 'reason'].every(k => typeof entry[k as keyof LogEntry] === 'string') &&
          logPath(entry.at) === `log/${name}`) monthly.push(entry)
      } catch { /* Ignore corrupt structured entries. */ }
    }
    entries.push(...monthly.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)))
    if (entries.length >= limit) break
  }
  return entries.slice(0, limit)
}

/** Appends one line under a lock without reading or rewriting existing content. Returns the changed path. */
export async function appendLog(vaultDir: string, entry: LogEntry): Promise<string> {
  const rel = logPath(entry.at)
  await withLock(vaultDir, ':log', async () => {
    await mkdir(safeResolve(vaultDir, 'log'), { recursive: true })
    await appendFile(safeResolve(vaultDir, rel), render({ ...entry, reason: shortDescription(entry.reason) }) + '\n', 'utf8')
  })
  return rel
}
