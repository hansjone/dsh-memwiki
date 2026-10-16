import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink, type FileHandle } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { MemwikiError } from '../types.ts'
import { safeResolve } from './ids.ts'

/** Executes under a renewable case-insensitive page lock; stale after 10s, waits up to 2s (LOCKED). */
export async function withLock<T>(vaultDir: string, key: string, fn: () => Promise<T>): Promise<T> {
  const rel = '.memwiki/locks/' + createHash('sha256').update(key.toLowerCase()).digest('hex') + '.lock'
  await mkdir(safeResolve(vaultDir, '.memwiki/locks'), { recursive: true })
  const token = randomUUID()
  const started = Date.now()
  const lockPath = safeResolve(vaultDir, rel)
  let lease: FileHandle
  while (true) {
    try {
      safeResolve(vaultDir, rel)
      lease = await open(lockPath, 'wx', 0o600)
      try { await lease.writeFile(token) }
      catch (e) { await lease.close(); await unlink(lockPath); throw e }
      break
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      try {
        const before = await stat(lockPath)
        if (Date.now() - before.mtimeMs > 10_000) {
          const after = await stat(lockPath)
          if (before.ino === after.ino && before.mtimeMs === after.mtimeMs) await unlink(lockPath)
          continue
        }
      } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; continue }
      if (Date.now() - started >= 2_000) throw new MemwikiError('LOCKED', '页面被锁定，请稍后重试')
      await delay(25)
    }
  }
  let heartbeat = Promise.resolve()
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => { const now = new Date(); await lease.utimes(now, now) }).catch(() => {})
  }, 2000)
  timer.unref()
  try { return await fn() }
  finally {
    clearInterval(timer)
    await heartbeat
    await lease.close()
    try { if (await readFile(lockPath, 'utf8') === token) await unlink(lockPath) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}
