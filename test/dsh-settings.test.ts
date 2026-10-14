import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { parse } from 'yaml'
import { initVault } from '../src/core/vault.ts'
import { Store } from '../src/core/store.ts'
import { appendLog } from '../src/core/log.ts'
import { SecretStore } from '../src/secrets/store.ts'
import { plainProtector } from '../src/secrets/protector.ts'
import { MemwikiSettingsService } from '../src/dsh/service.ts'
import { API } from '../src/dsh/protocol.ts'
import { allowedRequest, handleSettingsRequest } from '../src/dsh/routes.ts'
import { readDshConfig, writeDshConfig, dshConfigFile } from '../src/dsh/config-store.ts'
import { temporary, config, code } from './helpers.ts'

test('settings config read/write is atomic, validated and respects environment override', async t => {
  const home = await temporary(t)
  const file = dshConfigFile(home)
  const service = new MemwikiSettingsService({ home, env: {} })
  assert.equal((await service.config()).dir, path.join(home, 'memwiki'))
  const dir = path.join(home, 'vault')
  const saved = await handleSettingsRequest(service, 'PUT', API.config, { dir, autoPush: true })
  assert.equal(saved.status, 200)
  assert.deepEqual(await readDshConfig(file), { dir, autoPush: true })
  assert.equal((await service.config()).autoPush, true)
  const overridden = new MemwikiSettingsService({ home, env: { MEMWIKI_DIR: path.join(home, 'override') } })
  const view = await overridden.config()
  assert.equal(view.dir, dir)
  assert.equal(view.effectiveDir, path.join(home, 'override'))
  assert.equal(view.overridden, true)
  const bad = await handleSettingsRequest(service, 'PUT', API.config, { dir: 42, autoPush: 'true' })
  assert.equal(bad.status, 400)
  assert.deepEqual(await readDshConfig(file), { dir, autoPush: true })
  assert.ok(!(await readdir(path.dirname(file))).some(name => name.endsWith('.tmp')))
  await writeFile(file, '{broken')
  await assert.rejects(readDshConfig(file), code('INVALID_META'))
  await assert.rejects(writeDshConfig({ dir: '' }, file), code('INVALID_META'))
})

test('settings status and health read pages/inbox/recent changes without writing indexes or locks', async t => {
  const home = await temporary(t)
  const dir = path.join(home, 'vault')
  await initVault(dir, { git: false })
  await writeDshConfig({ dir, autoPush: false }, dshConfigFile(home))
  const store = new Store(config(dir))
  await store.write({ kind: 'create', id: 'topics/test', meta: { title: '测试', summary: '状态测试' }, body: '[[missing-target]]\n' }, { agent: 'test', reason: 'setup' })
  await store.write({ kind: 'create', id: 'inbox/2026-10', meta: { title: '收件箱', summary: '两条', type: 'inbox' }, body: '- 2026-10-14 第一条\n- 2026-10-14 第二条\n' }, { agent: 'test', reason: 'setup' })
  for (let i = 0; i < 7; i++) await appendLog(dir, { at: `2026-10-14T10:0${i}:00+08:00`, action: '更新', agent: 'test', page: 'topics/test', reason: `变更 ${i}` })
  const before = await readdir(dir, { recursive: true })
  const service = new MemwikiSettingsService({ home, env: {} })
  const status = await service.status()
  assert.equal(status.valid, true)
  assert.equal(status.pages, 2)
  assert.equal(status.inbox, 2)
  assert.equal(status.git, false)
  assert.equal(status.remote, false)
  assert.equal(status.recent.length, 5)
  assert.equal(status.recent[0].reason, '变更 6')
  assert.ok((await service.health()).issues.some(i => i.code === 'broken_link'))
  assert.deepEqual(await readdir(dir, { recursive: true }), before)
  assert.ok(!before.includes('index.md'))
  const invalid = new MemwikiSettingsService({ home, env: { MEMWIKI_DIR: path.join(home, 'not-a-vault') } })
  assert.equal((await invalid.status()).valid, false)
  assert.equal((await handleSettingsRequest(invalid, 'POST', API.lint)).status, 400)
})

test('settings credential routes never return values, including injected exceptions', async t => {
  const home = await temporary(t)
  const secrets = new SecretStore({ file: path.join(home, 'private', 'secrets.json'), protector: plainProtector })
  const service = new MemwikiSettingsService({ home, env: {}, secrets })
  const value = 'settings-PASSWORD-NEVER-RETURN'
  const set = await handleSettingsRequest(service, 'POST', API.secrets, { name: 'test-admin', scope: '仅 localhost', value })
  assert.equal(set.status, 200)
  const list = await handleSettingsRequest(service, 'GET', API.secrets)
  assert.equal(list.status, 200)
  assert.match(JSON.stringify(list.body), /test-admin/)
  assert.ok(!JSON.stringify(list.body).includes('"value"'))
  assert.equal((await handleSettingsRequest(service, 'GET', API.secrets + '/get')).status, 405)
  const log = await handleSettingsRequest(service, 'GET', API.accessLog)
  assert.equal(log.status, 200)
  const bad = await handleSettingsRequest(service, 'POST', API.secrets, { name: value, scope: '仅测试', value })
  assert.equal(bad.status, 400)
  const deleted = await handleSettingsRequest(service, 'DELETE', API.secrets, { name: 'test-admin' })
  assert.equal(deleted.status, 200)
  const missing = await handleSettingsRequest(service, 'DELETE', API.secrets, { name: 'test-admin' })
  assert.equal(missing.status, 404)
  for (const response of [set, list, log, bad, deleted, missing]) assert.ok(!JSON.stringify(response).includes(value))
  assert.equal((await handleSettingsRequest(service, 'GET', API.accessLog, {}, -1)).status, 400)
  const failing = new SecretStore({ file: secrets.file, protector: { kind: 'plain', async protect() { throw new Error(value) }, async unprotect() { throw new Error(value) } } })
  const exception = await handleSettingsRequest(new MemwikiSettingsService({ home, env: {}, secrets: failing }), 'POST', API.secrets, { name: 'test-admin', scope: '仅测试', value })
  assert.equal(exception.status, 400)
  assert.ok(!JSON.stringify(exception).includes(value))
})

test('settings request guard rejects cross-origin and non-loopback requests', () => {
  assert.equal(allowedRequest('127.0.0.1', { host: 'localhost:123', origin: 'http://localhost:123' }), true)
  assert.equal(allowedRequest('::1', { host: 'dsh.example', origin: 'https://dsh.example' }), true)
  assert.equal(allowedRequest('192.168.1.1', {}), false)
  assert.equal(allowedRequest('127.0.0.1', { 'sec-fetch-site': 'cross-site' }), false)
  assert.equal(allowedRequest('127.0.0.1', { host: 'localhost', origin: 'https://evil.example' }), false)
  assert.equal(allowedRequest('127.0.0.1', { origin: 'http://localhost' }), false)
})

test('DSH patch loads the host plugin by package name and shares directory precedence with resolveConfig', async t => {
  const home = await temporary(t)
  const patch = parse(await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8'), { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: (value: string) => value }] }) as Array<{ insert: Array<{ id: string; name: string; config?: { env: { MEMWIKI_DIR: string } } }> }>
  const host = patch[0].insert.find(row => row.id === 'memwiki-host')!
  const mcp = patch[0].insert.find(row => row.id === 'memwiki')!
  const env: Record<string, string> = {}
  const fakeProcess = {
    cwd: () => path.resolve('.'), env,
    getBuiltinModule: (id: string) => id === 'node:os' ? { homedir: () => home } : process.getBuiltinModule(id),
  }
  // A computed file path as the row name broke DSH's plugin inventory; keep the package name.
  assert.equal(host.name, 'dsh-memwiki')
  const expression = mcp.config!.env.MEMWIKI_DIR
  assert.equal(runInNewContext(expression, { process: fakeProcess }), path.join(home, 'memwiki'))
  await writeDshConfig({ dir: '~/saved', autoPush: true }, dshConfigFile(home))
  assert.equal(runInNewContext(expression, { process: fakeProcess }), path.join(home, 'saved'))
  env.MEMWIKI_DIR = path.join(home, 'env')
  assert.equal(runInNewContext(expression, { process: fakeProcess }), env.MEMWIKI_DIR)
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
  assert.equal(pkg.exports['.'].default, './lib/index.js')
  assert.equal(pkg.exports['./client'].default, './lib/client.js')
  assert.deepEqual(pkg.dsh.client.inject, ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale'])
})
