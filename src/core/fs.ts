import { mkdir, open, rename, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { safeResolve } from './ids.ts'

/** Writes a vault-relative file through a same-directory temporary file and rename. */
export async function atomicWrite(dir: string, rel: string, raw: string | Uint8Array): Promise<void> {
  const target = safeResolve(dir, rel)
  await mkdir(path.dirname(target), { recursive: true })
  safeResolve(dir, rel)
  const tempRel = rel + '.' + randomUUID() + '.tmp'
  const temp = safeResolve(dir, tempRel)
  const file = await open(temp, 'wx', 0o600)
  try {
    try {
      await file.writeFile(raw)
      await file.sync()
    } finally { await file.close() }
    safeResolve(dir, rel)
    await rename(temp, target)
  }
  finally { await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e }) }
}
