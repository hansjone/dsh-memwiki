import path from 'node:path'
import os from 'node:os'
import type { MemwikiConfig, PageRecord } from '../types.ts'
import { MemwikiError } from '../types.ts'
import { resolveConfig } from '../config.ts'
import { Store } from '../core/store.ts'
import { hasRemote, isGitRepo, listUncommitted } from '../core/git.ts'
import { readLog } from '../core/log.ts'
import { createResolver, extractLinks } from '../core/links.ts'
import { scanSecrets } from '../core/secrets.ts'
import { lintRecords } from '../search/lint.ts'
import { SecretStore } from '../secrets/store.ts'
import { dshConfigFile, expandDir, readDshConfig, resolveVaultDir, writeDshConfig } from './config-store.ts'
import type { ConfigView, HealthResult, RevealedSecret, VaultStatus } from './protocol.ts'

export interface ServiceOptions {
  configFile?: string
  home?: string
  env?: Record<string, string | undefined>
  secrets?: SecretStore
}
/** HTTP-independent operations; injected paths/environment keep tests off real user data. */
export class MemwikiSettingsService {
  private opts: ServiceOptions
  constructor(opts: ServiceOptions = {}) { this.opts = opts }
  private file() { return this.opts.configFile ?? dshConfigFile(this.opts.home) }
  private env() { return this.opts.env ?? process.env }
  private dir() { return resolveVaultDir({ ...this.opts, env: this.env(), configFile: this.file() }) }
  async config(): Promise<ConfigView> {
    const saved = await readDshConfig(this.file())
    const dir = expandDir(saved.dir ?? path.join(this.opts.home ?? os.homedir(), 'memwiki'), this.opts.home)
    const effectiveDir = await this.dir()
    let autoPush = saved.autoPush
    if (autoPush === undefined) {
      try { autoPush = (await resolveConfig({ ...this.opts, env: {}, configFile: this.file(), dir })).git.autoPush }
      catch { autoPush = false }
    }
    return { dir, effectiveDir, autoPush: autoPush ?? false, overridden: !!this.env().MEMWIKI_DIR?.trim() }
  }
  async saveConfig(body: unknown): Promise<ConfigView> { await writeDshConfig(body, this.file()); return this.config() }
  private async snapshot(): Promise<{ config: MemwikiConfig; records: PageRecord[]; inboxEntries: { page: string; date: string }[] }> {
    const config = await resolveConfig({ ...this.opts, env: this.env(), configFile: this.file(), git: false })
    const pages = await new Store(config).list()
    const resolver = createResolver(pages.map(p => ({ id: p.id, title: p.meta.title, aliases: p.meta.aliases })))
    const records: PageRecord[] = pages.map(page => {
      const links: string[] = [], brokenLinks: string[] = []
      for (const link of extractLinks(page.body)) {
        const target = resolver(link.target)
        if (!target || 'ambiguous' in target) brokenLinks.push(link.target)
        else links.push(target.id)
      }
      return { ...page, links: [...new Set(links)], brokenLinks: [...new Set(brokenLinks)] }
    })
    const inboxEntries = records.filter(r => r.meta.type === 'inbox' || r.id.toLowerCase().startsWith('inbox/')).flatMap(r =>
      [...r.body.matchAll(/^- (\d{4}-\d{2}-\d{2})/gm)].map(m => ({ page: r.id, date: m[1] })))
    return { config, records, inboxEntries }
  }
  async status(): Promise<VaultStatus> {
    const dir = await this.dir()
    const git = await isGitRepo(dir)
    const remote = git && await hasRemote(dir)
    try {
      const { records, inboxEntries } = await this.snapshot()
      return { dir, valid: true, pages: records.length, inbox: inboxEntries.length, git, remote, recent: await readLog(dir, 5) }
    } catch (e) {
      return { dir, valid: false, pages: 0, inbox: 0, git, remote, recent: [], error: e instanceof MemwikiError ? e.message : '无法读取记忆库' }
    }
  }
  async health(): Promise<HealthResult> {
    const { config, records, inboxEntries } = await this.snapshot()
    const issues = lintRecords(records, { staleDays: config.staleDays, overlapThreshold: config.overlapThreshold, now: new Date(), inboxEntries, scanSecrets: config.secretScan ? scanSecrets : undefined })
    if (await isGitRepo(config.dir)) {
      const dirty = await listUncommitted(config.dir)
      if (dirty.length) issues.push({ code: 'uncommitted', message: `有 ${dirty.length} 个未提交文件`, fixable: true })
    }
    return { issues }
  }
  private async secretStore(): Promise<SecretStore> {
    return this.opts.secrets ?? new SecretStore({
      file: this.env().MEMWIKI_SECRETS_FILE ?? (this.opts.home ? path.join(this.opts.home, '.memwiki', 'secrets.json') : undefined),
      vaultDir: await this.dir(),
    })
  }
  async listSecrets() {
    const store = await this.secretStore()
    return { entries: await store.list(), protection: store.protector.kind }
  }
  async setSecret(body: Record<string, unknown>) {
    if (typeof body.name !== 'string' || typeof body.value !== 'string' || typeof body.scope !== 'string') throw new MemwikiError('INVALID_META', '凭据需要名字、用途和密码')
    return { entry: await (await this.secretStore()).set(body.name, body.value, body.scope, { agent: 'human' }) }
  }
  async deleteSecret(body: Record<string, unknown>) {
    if (typeof body.name !== 'string') throw new MemwikiError('INVALID_ID', '需要凭据名字')
    await (await this.secretStore()).delete(body.name, { agent: 'human' })
    return { deleted: true }
  }
  async revealSecret(body: Record<string, unknown>): Promise<RevealedSecret> {
    if (typeof body.name !== 'string') throw new MemwikiError('INVALID_ID', '需要凭据名字')
    const secret = await (await this.secretStore()).getWithScope(body.name, { agent: 'human', purpose: 'DSH 设置页查看' })
    return { name: body.name, scope: secret.scope, value: secret.value }
  }
  async accessLog(limit = 20) { return { entries: await (await this.secretStore()).accessLog(limit) } }
}
