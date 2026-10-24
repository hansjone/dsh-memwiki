import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { lstat } from 'node:fs/promises'
import path from 'node:path'
import { safeResolve } from './ids.ts'
import { withLock } from './lock.ts'
import { remoteActor } from './actor.ts'
import { shortDescription } from './limits.ts'

const exec = promisify(execFile)
async function git(dir: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: path.resolve(dir), encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  return stdout
}

/** True only for a git working-tree root (not a vault merely inside another repo). */
export async function isGitRepo(dir: string): Promise<boolean> {
  try { return path.resolve((await git(dir, ['rev-parse', '--show-toplevel'])).trim()).toLowerCase() === path.resolve(dir).toLowerCase() }
  catch { return false }
}

/** Initializes a repository at dir without changing global git configuration. */
export async function gitInit(dir: string): Promise<void> { await git(dir, ['init']) }

/** Lists staged, unstaged and untracked vault-relative paths, including both sides of renames. */
export async function listUncommitted(dir: string): Promise<string[]> {
  const records = (await git(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0')
  const paths: string[] = []
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    paths.push(record.slice(3).replaceAll('\\', '/'))
    if (/[RC]/.test(record.slice(0, 2)) && records[i + 1]) paths.push(records[++i].replaceAll('\\', '/'))
  }
  return [...new Set(paths)].sort()
}

/** Commits only requested paths with memwiki identity; retries index.lock failures five times, returns undefined for no changes. */
export async function commit(dir: string, paths: string[], opts: { agent: string; message: string }): Promise<string | undefined> {
  const selected = [...new Set(paths.map(rel => {
    safeResolve(dir, rel)
    return path.relative(path.resolve(dir), safeResolve(dir, rel)).replaceAll('\\', '/')
  }))]
  if (!selected.length) return undefined
  return withLock(dir, ':git-commit', async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const dirty = new Set(await listUncommitted(dir))
        const touched = selected.filter(p => dirty.has(p))
        if (!touched.length) return undefined
        const literal = touched.map(p => ':(literal)' + p)
        // Already-staged deletions are absent from the index and cannot be passed to git add.
        const indexed = new Set((await git(dir, ['ls-files', '-z', '--', ...literal])).split('\0'))
        const stage: string[] = []
        for (const rel of touched) {
          let exists = false
          try { await lstat(safeResolve(dir, rel)); exists = true }
          catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
          if (exists || indexed.has(rel)) stage.push(':(literal)' + rel)
        }
        if (stage.length) await git(dir, ['add', '-A', '--', ...stage])
        if (!(await git(dir, ['diff', '--cached', '--name-only', '-z', '--', ...literal]))) return undefined
        const actor = remoteActor.getStore()
        const author = actor ? `${actor.name} (${actor.sub})`.replace(/[<>\r\n]/g, '') : `${opts.agent} (memwiki)`
        const email = actor ? `${encodeURIComponent(actor.sub)}@memwiki.local` : `${opts.agent}@memwiki.local`
        const identity = ['-c', `user.name=${author}`, '-c', `user.email=${email}`]
        await git(dir, [...identity, 'commit', ...(actor ? [`--author=${author} <${email}>`] : []), '--only', '-m', shortDescription(opts.message), '--', ...literal])
        return (await git(dir, ['rev-parse', 'HEAD'])).trim()
      } catch (e) {
        const err = e as Error & { stderr?: string }
        if (!/index\.lock/.test(err.stderr ?? err.message) || attempt >= 5) throw e
        await delay(50 * 2 ** attempt)
      }
    }
  })
}

/** True when the vault has at least one configured remote. */
export async function hasRemote(dir: string): Promise<boolean> {
  try { return (await git(dir, ['remote'])).trim().length > 0 }
  catch { return false }
}

/** Pushes the current branch to its upstream (or `origin` HEAD). */
export async function push(dir: string): Promise<void> {
  await git(dir, ['push'])
}

export interface PullRebaseResult {
  ok: boolean
  /** Set when rebase aborted due to conflicts. */
  conflicts?: string[]
}

/** Pulls with rebase + autostash; on conflict aborts rebase and returns conflict paths. */
export async function pullRebase(dir: string): Promise<PullRebaseResult> {
  try {
    await git(dir, ['pull', '--rebase', '--autostash'])
    return { ok: true }
  } catch (e) {
    const err = e as Error & { stderr?: string; stdout?: string }
    const text = `${err.stderr ?? ''}\n${err.stdout ?? ''}\n${err.message}`
    if (/conflict|CONFLICT|could not apply|needs merge/i.test(text)) {
      try { await git(dir, ['rebase', '--abort']) } catch { /* already clean or not rebasing */ }
      let conflicts: string[] = []
      try {
        const names = (await git(dir, ['diff', '--name-only', '--diff-filter=U'])).trim()
        if (names) conflicts = names.split(/\r?\n/).map(s => s.replaceAll('\\', '/'))
      } catch { /* ignore */ }
      if (!conflicts.length) {
        const match = text.match(/(?:CONFLICT(?:\s+\([^)]+\))?\s*:?\s*(?:Merge conflict in|content conflict in)\s+)(.+)/gi)
        if (match) conflicts = [...new Set(match.map(line => line.replace(/^.*?in\s+/i, '').trim().replaceAll('\\', '/')))]
      }
      return { ok: false, conflicts }
    }
    throw e
  }
}
