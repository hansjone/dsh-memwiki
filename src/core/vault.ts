import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import path from 'node:path'
import { MemwikiError } from '../types.ts'
import type { VaultManifest } from '../types.ts'
import { safeResolve } from './ids.ts'
import { gitInit } from './git.ts'

/** Reads the v1 manifest; throws NOT_A_VAULT for missing/invalid markers and UNSUPPORTED_SCHEMA for newer versions. */
export async function readManifest(dir: string): Promise<VaultManifest> {
  let value: unknown
  try { value = JSON.parse(await readFile(safeResolve(dir, 'memwiki.json'), 'utf8')) }
  catch (e) {
    if (e instanceof MemwikiError) throw e
    throw new MemwikiError('NOT_A_VAULT', '不是记忆库，请先运行 dsh-memwiki init')
  }
  if (!value || typeof value !== 'object' || !Number.isInteger((value as VaultManifest).schemaVersion)) {
    throw new MemwikiError('NOT_A_VAULT', '记忆库标记无效，请先运行 dsh-memwiki init')
  }
  const manifest = value as VaultManifest
  if (manifest.schemaVersion > 1) throw new MemwikiError('UNSUPPORTED_SCHEMA', '记忆库版本高于程序支持的版本', { schemaVersion: manifest.schemaVersion })
  if (manifest.schemaVersion !== 1 || typeof manifest.name !== 'string' || typeof manifest.created !== 'string' ||
    (manifest.settings !== undefined && (!manifest.settings || typeof manifest.settings !== 'object' || Array.isArray(manifest.settings)))) {
    throw new MemwikiError('NOT_A_VAULT', '记忆库标记无效')
  }
  return manifest
}

/** Creates the vault skeleton and templates, optionally git init; refuses an existing marker (EXISTS). */
export async function initVault(dir: string, opts: { name?: string; git: boolean }): Promise<void> {
  const root = path.resolve(dir)
  await mkdir(root, { recursive: true })
  const manifest: VaultManifest = { schemaVersion: 1, name: opts.name ?? path.basename(root), created: new Date().toISOString().slice(0, 10) }
  try { await writeFile(safeResolve(root, 'memwiki.json'), JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' }) }
  catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') throw new MemwikiError('EXISTS', '记忆库已经存在')
    throw e
  }
  for (const rel of ['user', 'rules', 'projects', 'topics', 'howto', 'decisions', 'reference', 'inbox', '.trash', '.memwiki/locks']) {
    await mkdir(safeResolve(root, rel), { recursive: true })
  }
  const templates = new URL('../../templates/vault/', import.meta.url)
  await copyFile(new URL('_guide.md', templates), safeResolve(root, '_guide.md'), constants.COPYFILE_EXCL)
  await copyFile(new URL('gitignore', templates), safeResolve(root, '.gitignore'), constants.COPYFILE_EXCL)
  if (opts.git) await gitInit(root)
}
