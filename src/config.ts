import os from 'node:os'
import path from 'node:path'
import { MemwikiError } from './types.ts'
import type { MemwikiConfig } from './types.ts'
import { readManifest } from './core/vault.ts'
import { isGitRepo } from './core/git.ts'

/** Resolves CLI > environment > vault settings > defaults; requires a supported vault manifest. */
export async function resolveConfig(opts: { dir?: string; agent?: string; git?: boolean; budget?: number; env?: Record<string, string | undefined> } = {}): Promise<MemwikiConfig> {
  const env = opts.env ?? process.env
  const raw = opts.dir ?? env.MEMWIKI_DIR ?? path.join(os.homedir(), 'memwiki')
  const dir = path.resolve(raw === '~' ? os.homedir() : /^~[\\/]/.test(raw) ? path.join(os.homedir(), raw.slice(2)) : raw)
  const manifest = await readManifest(dir)
  const settings = manifest.settings ?? {}
  const contextBudget = opts.budget ?? (env.MEMWIKI_CONTEXT_BUDGET !== undefined ? Number(env.MEMWIKI_CONTEXT_BUDGET) : settings.contextBudget ?? 4096)
  const staleDays = settings.staleDays ?? 90
  if (!Number.isSafeInteger(contextBudget) || contextBudget <= 0 || !Number.isFinite(staleDays) || staleDays < 0 ||
    (settings.secretScan !== undefined && typeof settings.secretScan !== 'boolean')) {
    throw new MemwikiError('INVALID_META', '记忆库配置无效')
  }
  return { dir, agent: opts.agent ?? env.MEMWIKI_AGENT ?? 'agent', git: { autoCommit: opts.git ?? (env.MEMWIKI_GIT !== undefined ? env.MEMWIKI_GIT !== '0' : await isGitRepo(dir)) }, contextBudget, staleDays, secretScan: settings.secretScan ?? true }
}
