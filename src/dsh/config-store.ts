import os from 'node:os'
import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { atomicWrite } from '../core/fs.ts'
import { withLock } from '../core/lock.ts'
import { MemwikiError } from '../types.ts'

export interface DshConfig { dir?: string; autoPush?: boolean }
export function dshConfigFile(home = os.homedir()): string { return path.join(home, '.dsh', 'dsh-memwiki.json') }

export function validateDshConfig(raw: unknown): DshConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new MemwikiError('INVALID_META', '记忆库设置格式无效')
  const c = raw as DshConfig
  if ((c.dir !== undefined && (typeof c.dir !== 'string' || !c.dir.trim())) ||
      (c.autoPush !== undefined && typeof c.autoPush !== 'boolean')) throw new MemwikiError('INVALID_META', '库目录或自动推送设置无效')
  return { ...(c.dir !== undefined ? { dir: c.dir.trim() } : {}), ...(c.autoPush !== undefined ? { autoPush: c.autoPush } : {}) }
}

export async function readDshConfig(file = dshConfigFile()): Promise<DshConfig> {
  let raw: string
  try { raw = await readFile(file, 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw new MemwikiError('INVALID_META', '无法读取记忆库设置') }
  try { return validateDshConfig(JSON.parse(raw)) }
  catch { throw new MemwikiError('INVALID_META', '记忆库设置格式无效，请检查 ~/.dsh/dsh-memwiki.json') }
}

export async function writeDshConfig(config: unknown, file = dshConfigFile()): Promise<DshConfig> {
  const next = validateDshConfig(config)
  await withLock(path.dirname(file), ':dsh-memwiki-config', () => atomicWrite(path.dirname(file), path.basename(file), JSON.stringify(next, null, 2) + '\n'))
  return next
}

export function expandDir(dir: string, home = os.homedir()): string {
  return path.resolve(dir === '~' ? home : /^~[\\/]/.test(dir) ? path.join(home, dir.slice(2)) : dir)
}
export async function resolveVaultDir(opts: { dir?: string; env?: Record<string, string | undefined>; home?: string; configFile?: string } = {}): Promise<string> {
  const home = opts.home ?? os.homedir()
  const env = opts.env ?? process.env
  const explicit = opts.dir ?? env.MEMWIKI_DIR?.trim()
  const raw = explicit || (await readDshConfig(opts.configFile ?? dshConfigFile(home))).dir || path.join(home, 'memwiki')
  return expandDir(raw, home)
}
