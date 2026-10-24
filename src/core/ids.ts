import path from 'node:path'
import { lstatSync, realpathSync } from 'node:fs'
import { MemwikiError } from '../types.ts'

/** Validates a vault-relative page ID, preserving spelling; throws INVALID_ID. */
export function normalizeId(input: string): string {
  if (typeof input !== 'string' || !input || /[\\:*?"<>|\x00-\x1f\x7f]/u.test(input) ||
    input.split('/').some(s => !s || /^[\s.]|[\s.]$/u.test(s))) {
    throw new MemwikiError('INVALID_ID', '非法页面 ID')
  }
  return input
}

/** Converts a valid ID to its slash-separated Markdown path. */
export function idToRelPath(id: string): string { return normalizeId(id) + '.md' }

/** Converts a relative Markdown path (either platform separator) to an ID. */
export function relPathToId(rel: string): string {
  const normalized = rel.replaceAll('\\', '/')
  if (!/\.md$/i.test(normalized)) throw new MemwikiError('INVALID_ID', '页面路径须以 .md 结尾')
  return normalizeId(normalized.slice(0, -3))
}

/** Generated index/log paths and underscore-prefixed files are special pages. */
export function isSpecialId(id: string): boolean {
  const name = normalizeId(id).split('/').at(-1)!.toLowerCase()
  return name === 'index' || id.split('/')[0].toLowerCase() === 'log' || name.startsWith('_')
}

const contains = (root: string, target: string) => {
  const rel = path.relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel))
}

/** Resolves a relative path; rejects traversal and existing symlinks escaping the vault (OUT_OF_VAULT). */
export function safeResolve(vaultDir: string, rel: string): string {
  const root = path.resolve(vaultDir)
  const normalized = rel.replaceAll('\\', '/')
  const fail = () => { throw new MemwikiError('OUT_OF_VAULT', '路径超出记忆库') }
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(rel) || /[\x00-\x1f]/.test(rel)) fail()
  const target = path.resolve(root, normalized)
  if (!contains(root, target)) fail()
  let physicalRoot: string
  try { physicalRoot = realpathSync(root) } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    physicalRoot = root
  }
  let current = root
  for (const segment of path.relative(root, target).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment)
    try {
      lstatSync(current)
      if (!contains(physicalRoot, realpathSync(current))) fail()
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
      // A dangling symlink must not be treated as a nonexistent safe directory.
      try { if (lstatSync(current).isSymbolicLink()) fail() } catch (inner) {
        if ((inner as NodeJS.ErrnoException).code !== 'ENOENT') throw inner
      }
    }
  }
  return target
}
