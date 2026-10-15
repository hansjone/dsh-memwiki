import { readFile } from 'node:fs/promises'
import { MemwikiError } from '../types.ts'
import type { LogEntry } from '../types.ts'
import { safeResolve } from './ids.ts'
import { withLock } from './lock.ts'
import { atomicWrite } from './fs.ts'

const clean = (s: string) => s.replace(/[\r\n]/g, ' ')
function render(entry: LogEntry): string {
  const visible = `- ${entry.at.slice(0, 10)} ${entry.at.slice(11, 16)} [${clean(entry.agent)}] ${clean(entry.action)}${entry.page ? ' [[' + clean(entry.page) + ']]' : ''}：${clean(entry.reason)}`
  // Preserve timezone, seconds and arbitrary fields without compromising the human-readable line.
  return visible + ' <!-- memwiki:' + Buffer.from(JSON.stringify(entry)).toString('base64') + ' -->'
}

/** Reads the structured entries emitted by appendLog, preserving complete ISO timestamps. */
export async function readLog(vaultDir: string, limit: number): Promise<LogEntry[]> {
  if (limit <= 0) return []
  let raw: string
  try { raw = await readFile(safeResolve(vaultDir, 'log.md'), 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  const entries: LogEntry[] = []
  for (const line of raw.split(/\r?\n/)) {
    const encoded = line.match(/<!-- memwiki:([A-Za-z0-9+/=]+) -->$/)
    if (encoded) {
      try {
        const entry = JSON.parse(Buffer.from(encoded[1], 'base64').toString('utf8')) as LogEntry
        if (['at', 'agent', 'action', 'reason'].every(k => typeof entry[k as keyof LogEntry] === 'string')) { entries.push(entry); continue }
      } catch { /* Ignore corrupt structured entries. */ }
    }
  }
  return entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, limit)
}

/** Inserts an entry into its month section, newest month and entry first, under a log lock. */
export async function appendLog(vaultDir: string, entry: LogEntry): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}T/.test(entry.at) || Number.isNaN(Date.parse(entry.at))) throw new MemwikiError('INVALID_META', '日志时间无效')
  await withLock(vaultDir, ':log', async () => {
    const entries = [entry, ...await readLog(vaultDir, Number.MAX_SAFE_INTEGER)].sort((a, b) => b.at.slice(0, 7).localeCompare(a.at.slice(0, 7)) || Date.parse(b.at) - Date.parse(a.at))
    let raw = '# 变更日志\n'
    let month = ''
    for (const item of entries) {
      if (month !== item.at.slice(0, 7)) { month = item.at.slice(0, 7); raw += '\n## ' + month + '\n\n' }
      raw += render(item) + '\n'
    }
    await atomicWrite(vaultDir, 'log.md', raw)
  })
}
