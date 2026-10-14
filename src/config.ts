import { MemwikiError } from './types.ts'
import type { MemwikiConfig } from './types.ts'
import { readManifest } from './core/vault.ts'
import { isGitRepo } from './core/git.ts'
import { dshConfigFile, readDshConfig, resolveVaultDir } from './dsh/config-store.ts'

export interface ResolveConfigOpts {
  dir?: string
  agent?: string
  git?: boolean
  /** Explicit auto-push override (`--push` / `--no-push`). */
  push?: boolean
  budget?: number
  env?: Record<string, string | undefined>
  /** Injectable home/config path for isolated clients and tests. */
  home?: string
  configFile?: string
}

/** Resolves CLI > environment > vault settings > defaults; requires a supported vault manifest. */
export async function resolveConfig(opts: ResolveConfigOpts = {}): Promise<MemwikiConfig> {
  const env = opts.env ?? process.env
  const dir = await resolveVaultDir(opts)
  const dsh = await readDshConfig(opts.configFile ?? dshConfigFile(opts.home))
  const manifest = await readManifest(dir)
  const settings = manifest.settings ?? {}
  const contextBudget = opts.budget ?? (env.MEMWIKI_CONTEXT_BUDGET !== undefined ? Number(env.MEMWIKI_CONTEXT_BUDGET) : settings.contextBudget ?? 4096)
  const staleDays = settings.staleDays ?? 90
  if (!Number.isSafeInteger(contextBudget) || contextBudget <= 0 || !Number.isFinite(staleDays) || staleDays < 0 ||
    (settings.secretScan !== undefined && typeof settings.secretScan !== 'boolean') ||
    (settings.autoPush !== undefined && typeof settings.autoPush !== 'boolean')) {
    throw new MemwikiError('INVALID_META', '记忆库配置无效')
  }
  const autoCommit = opts.git ?? (env.MEMWIKI_GIT !== undefined ? env.MEMWIKI_GIT !== '0' : await isGitRepo(dir))
  const autoPush = opts.push ?? (env.MEMWIKI_GIT_PUSH !== undefined ? env.MEMWIKI_GIT_PUSH === '1' : dsh.autoPush ?? settings.autoPush ?? false)
  return {
    dir,
    agent: opts.agent ?? env.MEMWIKI_AGENT ?? 'agent',
    git: { autoCommit, autoPush },
    contextBudget,
    staleDays,
    secretScan: settings.secretScan ?? true,
  }
}
