import { chmod, mkdir, readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { atomicWrite } from '../core/fs.ts'
import { withLock } from '../core/lock.ts'
import { MemwikiError } from '../types.ts'
import { defaultProtector, type Protector } from './protector.ts'

export type { Protector } from './protector.ts'
export interface SecretMeta { name: string; scope: string; created: string; updated: string; updated_by: string }
interface Entry extends SecretMeta { value: string }
interface StoreFile { version: 1; protection: Protector['kind']; entries: Entry[] }
export interface SecretAccess { at: string; agent: string; action: 'get' | 'set' | 'delete'; name: string; purpose: string }
export interface SecretStoreOptions { file?: string; logFile?: string; protector?: Protector; vaultDir?: string }

export function secretsFile(file?: string): string {
  const raw = file ?? process.env.MEMWIKI_SECRETS_FILE ?? path.join(os.homedir(), '.memwiki', 'secrets.json')
  return path.resolve(/^~[\\/]/.test(raw) ? path.join(os.homedir(), raw.slice(2)) : raw)
}

/** Resolves existing ancestors too, so an override cannot alias the wiki through a symlink. */
function physical(file: string): string {
  if (existsSync(file)) return realpathSync(file)
  const parent = path.dirname(file)
  return parent === file ? file : path.join(physical(parent), path.basename(file))
}
function within(root: string, target: string) {
  const rel = path.relative(root, target)
  return !rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))
}
function meta(entry: Entry): SecretMeta {
  return { name: entry.name, scope: entry.scope, created: entry.created, updated: entry.updated, updated_by: entry.updated_by }
}
function nameCheck(name: string) {
  if (typeof name !== 'string' || !/^[a-z0-9][a-z0-9._-]{1,63}$/.test(name)) throw new MemwikiError('INVALID_ID', '凭据名字须为 2–64 位小写字母、数字、点、下划线或连字符')
}
function required(value: string) {
  if (typeof value !== 'string' || !value.trim()) throw new MemwikiError('INVALID_META', '用途和写入方不能为空')
}

/** Separate local store. Never returns stored entries or underlying exception messages. */
export class SecretStore {
  readonly file: string
  readonly logFile: string
  readonly protector: Protector
  private vaultDir?: string
  constructor(opts: SecretStoreOptions = {}) {
    this.file = secretsFile(opts.file)
    this.logFile = path.resolve(opts.logFile ?? path.join(path.dirname(this.file), 'secrets-access.log'))
    this.protector = opts.protector ?? defaultProtector()
    this.vaultDir = opts.vaultDir
  }
  private async locked<T>(fn: () => Promise<T>): Promise<T> {
    try {
      if (this.vaultDir && [this.file, this.logFile].some(file => within(physical(path.resolve(this.vaultDir!)), physical(file)))) {
        throw new MemwikiError('OUT_OF_VAULT', '凭据文件和访问日志必须放在记忆库之外')
      }
      for (const file of [this.file, this.logFile]) {
        const dir = path.dirname(file)
        await mkdir(dir, { recursive: true, mode: 0o700 })
        if (process.platform !== 'win32') await chmod(dir, 0o700)
      }
      // Shared directory lock also serializes access logs for multiple stores.
      return await withLock(path.dirname(this.file), ':secrets', fn)
    } catch (e) {
      // Only our fixed messages may cross the security boundary; never attach a cause.
      if (e instanceof MemwikiError && ['INVALID_ID', 'NOT_FOUND', 'OUT_OF_VAULT', 'LOCKED'].includes(e.code)) {
        const messages = { INVALID_ID: '凭据名字非法', NOT_FOUND: '凭据不存在', OUT_OF_VAULT: '凭据文件和访问日志必须放在记忆库之外', LOCKED: '凭据库被锁定，请稍后重试' }
        throw new MemwikiError(e.code, messages[e.code as keyof typeof messages])
      }
      throw new MemwikiError('INVALID_META', '凭据操作失败，请检查配置、文件或加密方式')
    }
  }
  private async read(): Promise<StoreFile> {
    let raw: string
    try { raw = await readFile(this.file, 'utf8') }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, protection: this.protector.kind, entries: [] }; throw e }
    const file = JSON.parse(raw) as StoreFile
    if (file.version !== 1 || file.protection !== this.protector.kind || !Array.isArray(file.entries)) throw new Error()
    const names = new Set<string>()
    for (const e of file.entries) {
      nameCheck(e.name)
      if (names.has(e.name) || ['scope', 'value', 'created', 'updated', 'updated_by'].some(key => typeof e[key as keyof Entry] !== 'string')) throw new Error()
      names.add(e.name)
    }
    if (process.platform !== 'win32') await chmod(this.file, 0o600)
    return file
  }
  private async write(file: StoreFile) {
    await atomicWrite(path.dirname(this.file), path.basename(this.file), JSON.stringify(file, null, 2) + '\n')
  }
  private async logs(): Promise<SecretAccess[]> {
    try {
      return (await readFile(this.logFile, 'utf8')).split('\n').filter(Boolean).map(line => {
        const e = JSON.parse(line) as SecretAccess
        return { at: e.at, agent: e.agent, action: e.action, name: e.name, purpose: e.purpose }
      })
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return []; throw e }
  }
  private async audit(agent: string, action: SecretAccess['action'], name: string, purpose: string) {
    const logs = await this.logs()
    logs.push({ at: new Date().toISOString(), agent, action, name, purpose })
    await atomicWrite(path.dirname(this.logFile), path.basename(this.logFile), logs.map(e => JSON.stringify(e)).join('\n') + '\n')
  }
  async list(): Promise<SecretMeta[]> { return this.locked(async () => (await this.read()).entries.map(meta)) }
  async get(name: string, ctx: { agent: string; purpose: string }): Promise<string> {
    return (await this.getWithScope(name, ctx)).value
  }
  /** Returns value and scope from one locked snapshot, for the MCP use reminder. */
  async getWithScope(name: string, ctx: { agent: string; purpose: string }): Promise<{ value: string; scope: string }> {
    return this.locked(async () => {
      nameCheck(name); required(ctx.agent); required(ctx.purpose)
      const file = await this.read()
      await this.audit(ctx.agent, 'get', name, ctx.purpose)
      const entry = file.entries.find(e => e.name === name)
      if (!entry) throw new MemwikiError('NOT_FOUND', '凭据不存在')
      return { value: await this.protector.unprotect(entry.value), scope: entry.scope }
    })
  }
  async set(name: string, value: string, scope: string, ctx: { agent: string }): Promise<SecretMeta> {
    return this.locked(async () => {
      nameCheck(name); required(scope); required(ctx.agent)
      if (typeof value !== 'string' || !value) throw new Error()
      const file = await this.read()
      const before = file.entries.find(e => e.name === name)
      const now = new Date().toISOString()
      const entry: Entry = { name, scope, value: await this.protector.protect(value), created: before?.created ?? now, updated: now, updated_by: ctx.agent }
      await this.audit(ctx.agent, 'set', name, scope)
      file.entries = [...file.entries.filter(e => e.name !== name), entry]
      await this.write(file)
      return meta(entry)
    })
  }
  async delete(name: string, ctx: { agent: string }): Promise<void> {
    return this.locked(async () => {
      nameCheck(name); required(ctx.agent)
      const file = await this.read()
      await this.audit(ctx.agent, 'delete', name, '删除凭据')
      if (!file.entries.some(e => e.name === name)) throw new MemwikiError('NOT_FOUND', '凭据不存在')
      file.entries = file.entries.filter(e => e.name !== name)
      await this.write(file)
    })
  }
  async accessLog(limit = 20): Promise<SecretAccess[]> {
    return this.locked(async () => {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new Error()
      return (await this.logs()).slice(-limit).reverse()
    })
  }
}
