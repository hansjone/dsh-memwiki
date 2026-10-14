import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { MemwikiError } from '../types.ts'
import { safeResolve } from './ids.ts'

/** Executes under a case-insensitive page lock; stale after 10s, waiting times out after 2s (LOCKED). */
export async function withLock<T>(vaultDir: string, key: string, fn: () => Promise<T>): Promise<T> {
  const rel = '.memwiki/locks/' + createHash('sha256').update(key.toLowerCase()).digest('hex') + '.lock'
  await mkdir(safeResolve(vaultDir, '.memwiki/locks'), { recursive: true })
  const token = randomUUID()
  const started = Date.now()
  const lockPath = safeResolve(vaultDir, rel)
  while (true) {
    try {
      safeResolve(vaultDir, rel)
      const handle = await open(lockPath, 'wx', 0o600)
      try { await handle.writeFile(token) } finally { await handle.close() }
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
  try { return await fn() }
  finally {
    try { if (await readFile(lockPath, 'utf8') === token) await unlink(lockPath) }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
  }
}
