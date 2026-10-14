import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runInNewContext } from 'node:vm'

const require = createRequire(import.meta.url)
const source = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
let client
runInNewContext(source, { window: { __ModuleLoader__: { load(row) { assert.equal(row.id, 'dsh-memwiki'); client = row.factory(require) } } } })
assert.deepEqual(Array.from(client.inject), ['slots', 'locale'])
let registration
const effects = []
client.apply({
  effect(fn) { effects.push(fn()) },
  locale: { register() { return () => {} }, bind() { return () => '记忆库' } },
  slots: { inject(slot, fn) { assert.equal(slot, 'settings.section'); effects.push(fn()) }, register(options, Card) { registration = options; assert.equal(typeof Card, 'function'); return () => {} } },
})
assert.equal(registration.id, 'memwiki')
assert.equal(registration.locale, 'dsh-memwiki')
assert.equal(registration.label(), '记忆库')
assert.equal(typeof registration.inject().api.set, 'function')
// Slot failures do not propagate into GUI boot.
client.apply({ effect() {}, locale: { bind() { return () => '' } }, slots: { inject() { throw new Error('unavailable') } }, logger: { warn() {} } })
client.apply({ effect(fn) { fn() }, locale: { register() { throw new Error('unavailable') } }, logger: { warn() {} } })
for (const dispose of effects) dispose()

const host = await import('../lib/dsh-host.js')
assert.deepEqual(host.inject, ['webServer'])
const routes = [], disposed = []
let stop
host.apply({ effect(fn) { stop = fn() }, webServer: { register(route) { routes.push(route); return () => disposed.push(route.path) } } })
assert.equal(routes.length, 6)
assert.ok(routes.every(route => route.path.startsWith('/api/dsh-memwiki/')))
stop()
assert.equal(disposed.length, 6)
const api = await import('../lib/index.js')
assert.equal(typeof api.Memwiki.open, 'function')
assert.equal(typeof api.SecretStore, 'function')
// The main entry doubles as the DSH host plugin (patch row name: dsh-memwiki).
assert.equal(typeof api.apply, 'function')
assert.deepEqual(api.inject, ['webServer'])
console.log('bundle smoke: client registration, failure containment, host route lifecycle and main-entry host plugin passed')
