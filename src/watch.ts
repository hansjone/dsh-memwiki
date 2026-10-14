import { watch as fsWatch, type FSWatcher } from 'node:fs'
import path from 'node:path'

const IGNORED = new Set(['.git', '.memwiki', '.trash', '.obsidian', 'node_modules'])

export interface WatchHandlers {
  /** Called after 500ms debounce when external page files change. */
  onExternalChange: (changedRelPaths: string[]) => void | Promise<void>
  /** Called after 60s debounce to commit external edits. */
  onExternalCommit: (changedRelPaths: string[]) => void | Promise<void>
}

/**
 * Watches the vault for external edits. Own writes are skipped when their
 * vault-relative path (and optional rev) was recently marked via `noteWrite`.
 * Falls back to a 30s scan when recursive `fs.watch` is unavailable.
 */
export function watchVault(dir: string, handlers: WatchHandlers): { noteWrite: (rel: string, rev?: string) => void; close: () => void } {
  const root = path.resolve(dir)
  const own = new Map<string, { until: number; rev?: string }>()
  const pending = new Set<string>()
  const commitPending = new Set<string>()
  let refreshTimer: ReturnType<typeof setTimeout> | undefined
  let commitTimer: ReturnType<typeof setTimeout> | undefined
  let pollTimer: ReturnType<typeof setInterval> | undefined
  let watcher: FSWatcher | undefined
  let closed = false

  const noteWrite = (rel: string, rev?: string) => {
    const key = rel.replaceAll('\\', '/')
    own.set(key, { until: Date.now() + 2000, rev })
  }

  const isIgnored = (rel: string) => {
    const parts = rel.replaceAll('\\', '/').split('/')
    return parts.some(p => IGNORED.has(p.toLowerCase()))
  }

  const shouldSkip = (rel: string) => {
    const key = rel.replaceAll('\\', '/')
    const marked = own.get(key)
    if (!marked) return false
    if (Date.now() > marked.until) {
      own.delete(key)
      return false
    }
    return true
  }

  const schedule = (rel: string) => {
    if (closed || isIgnored(rel) || shouldSkip(rel)) return
    if (!/\.md$/i.test(rel) && rel !== 'memwiki.json') return
    pending.add(rel.replaceAll('\\', '/'))
    commitPending.add(rel.replaceAll('\\', '/'))
    if (refreshTimer) clearTimeout(refreshTimer)
    refreshTimer = setTimeout(() => {
      const batch = [...pending]
      pending.clear()
      void Promise.resolve(handlers.onExternalChange(batch)).catch(() => {})
    }, 500)
    if (commitTimer) clearTimeout(commitTimer)
    commitTimer = setTimeout(() => {
      const batch = [...commitPending]
      commitPending.clear()
      void Promise.resolve(handlers.onExternalCommit(batch)).catch(() => {})
    }, 60_000)
  }

  const onEvent = (eventType: string, filename: string | Buffer | null | undefined) => {
    if (!filename) return
    const name = typeof filename === 'string' ? filename : filename.toString()
    schedule(name.replaceAll('\\', '/'))
  }

  try {
    watcher = fsWatch(root, { recursive: true }, onEvent)
    watcher.on('error', () => {
      // Recursive watch unsupported or failed — fall back to polling.
      try { watcher?.close() } catch { /* ignore */ }
      watcher = undefined
      startPoll()
    })
  } catch {
    startPoll()
  }

  function startPoll() {
    if (pollTimer || closed) return
    let last = new Map<string, number>()
    const scan = async () => {
      if (closed) return
      const { readdir, stat } = await import('node:fs/promises')
      const next = new Map<string, number>()
      const walk = async (rel: string): Promise<void> => {
        let entries
        try { entries = await readdir(path.join(root, rel || '.'), { withFileTypes: true }) }
        catch { return }
        for (const entry of entries) {
          const child = (rel ? rel + '/' : '') + entry.name
          if (entry.isDirectory()) {
            if (!IGNORED.has(entry.name.toLowerCase())) await walk(child)
          } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
            try {
              const info = await stat(path.join(root, child))
              next.set(child.replaceAll('\\', '/'), info.mtimeMs)
            } catch { /* ignore */ }
          }
        }
      }
      await walk('')
      if (last.size) {
        for (const [rel, mtime] of next) {
          if (last.get(rel) !== mtime) schedule(rel)
        }
        for (const rel of last.keys()) if (!next.has(rel)) schedule(rel)
      }
      last = next
    }
    void scan()
    pollTimer = setInterval(() => { void scan() }, 30_000)
  }

  return {
    noteWrite,
    close() {
      closed = true
      if (refreshTimer) clearTimeout(refreshTimer)
      if (commitTimer) clearTimeout(commitTimer)
      if (pollTimer) clearInterval(pollTimer)
      try { watcher?.close() } catch { /* ignore */ }
    },
  }
}
