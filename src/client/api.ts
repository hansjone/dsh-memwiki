import { API, type ConfigView, type HealthResult, type RevealedSecret, type VaultStatus } from '../dsh/protocol.ts'
import type { SecretAccess, SecretMeta, Protector } from '../secrets/store.ts'

export class MemwikiApi {
  private async request<T>(url: string, method = 'GET', body?: unknown): Promise<T> {
    const res = await fetch(url, { method, cache: 'no-store', ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) })
    if (!res.ok) throw new Error('操作失败，请检查设置或稍后重试')
    return res.json() as Promise<T>
  }
  async config() { return (await this.request<{ config: ConfigView }>(API.config)).config }
  async save(config: { dir: string; autoPush: boolean }) { return (await this.request<{ config: ConfigView }>(API.config, 'PUT', config)).config }
  async status() { return (await this.request<{ status: VaultStatus }>(API.status)).status }
  health() { return this.request<HealthResult>(API.lint, 'POST') }
  secrets() { return this.request<{ entries: SecretMeta[]; protection: Protector['kind'] }>(API.secrets) }
  async set(name: string, scope: string, value: string) { await this.request(API.secrets, 'POST', { name, scope, value }) }
  async delete(name: string) { await this.request(API.secrets, 'DELETE', { name }) }
  reveal(name: string) { return this.request<RevealedSecret>(API.reveal, 'POST', { name }) }
  async log() { return (await this.request<{ entries: SecretAccess[] }>(API.accessLog)).entries }
}
