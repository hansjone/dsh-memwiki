import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SecretStore, type Protector } from '../src/secrets/store.ts'
import { DpapiProtector, plainProtector } from '../src/secrets/protector.ts'
import { temporary, code } from './helpers.ts'

const fakeProtector: Protector = {
  kind: 'dpapi',
  async protect(value) { return 'fake:' + Buffer.from(value).toString('base64') },
  async unprotect(value) { return Buffer.from(value.slice(5), 'base64').toString('utf8') },
}

test('secret CRUD preserves creation, lists only metadata and audits without values', async t => {
  const dir = await temporary(t)
  const file = path.join(dir, 'private', 'secrets.json')
  const store = new SecretStore({ file, protector: fakeProtector })
  assert.deepEqual(await store.list(), [])
  const value = 'test-password-独特值'
  const first = await store.set('local-admin', value, '仅用于 localhost', { agent: 'codex' })
  const next = await store.set('local-admin', value + '-updated', '仅用于测试', { agent: 'claude' })
  assert.equal(first.created, next.created)
  assert.equal(next.updated_by, 'claude')
  assert.equal(await store.get('local-admin', { agent: 'dsh', purpose: '测试登录' }), value + '-updated')
  const listed = await store.list()
  assert.equal(listed.length, 1)
  assert.equal('value' in listed[0], false)
  assert.equal(JSON.stringify(listed).includes(value), false)
  const log = await store.accessLog(2)
  assert.deepEqual(log.map(e => e.action), ['get', 'set'])
  assert.equal(log[0].purpose, '测试登录')
  await store.delete('local-admin', { agent: 'human' })
  assert.deepEqual(await store.list(), [])
  await assert.rejects(store.get('local-admin', { agent: 'dsh', purpose: '确认删除' }), code('NOT_FOUND'))
  assert.equal((await readFile(store.logFile, 'utf8')).includes(value), false)
  assert.equal((await readFile(file, 'utf8')).includes(value), false)
})

test('secret validation and arbitrary protector/file exceptions do not disclose values', async t => {
  const dir = await temporary(t)
  const value = 'NEVER-DISCLOSE-THIS-PASSWORD'
  const store = new SecretStore({ file: path.join(dir, 'secrets.json'), protector: fakeProtector })
  for (const name of ['a', 'Bad-name', '../escape', 'a'.repeat(65), value]) {
    await assert.rejects(store.set(name, value, '测试用途', { agent: 'test' }), e => code('INVALID_ID')(e) && !String(e).includes(value))
  }
  await assert.rejects(store.set('test-name', value, ' ', { agent: 'test' }), code('INVALID_META'))
  await store.set('test-name', value, '仅测试', { agent: 'test' })
  await assert.rejects(store.get('test-name', { agent: 'test', purpose: ' ' }), code('INVALID_META'))
  const bad: Protector = { kind: 'dpapi', async protect() { throw new Error(value) }, async unprotect() { throw new Error(value) } }
  const broken = new SecretStore({ file: store.file, protector: bad })
  for (const operation of [() => broken.set('test-name', value, '测试', { agent: 'test' }), () => broken.get('test-name', { agent: 'test', purpose: '登录' })]) {
    await assert.rejects(operation(), e => code('INVALID_META')(e) && !JSON.stringify(e).includes(value) && !String(e).includes(value) && !(e as Error).cause)
  }
  await writeFile(store.file, value)
  await assert.rejects(store.list(), e => code('INVALID_META')(e) && !String(e).includes(value))
  await assert.rejects(store.accessLog(0), code('INVALID_META'))
})

test('concurrent stores serialize read-modify-write and access logs', async t => {
  const dir = await temporary(t)
  const file = path.join(dir, 'secrets.json')
  await Promise.all(Array.from({ length: 10 }, (_, i) => new SecretStore({ file, protector: fakeProtector }).set(`account-${i}`, `value-${i}`, '测试账号', { agent: `agent-${i}` })))
  const store = new SecretStore({ file, protector: fakeProtector })
  assert.equal((await store.list()).length, 10)
  assert.equal((await store.accessLog()).length, 10)
})

test('secret file cannot be placed inside the wiki', async t => {
  const dir = await temporary(t)
  const store = new SecretStore({ file: path.join(dir, 'secrets.json'), vaultDir: dir, protector: fakeProtector })
  await assert.rejects(store.set('test-name', 'password', '仅测试', { agent: 'test' }), code('OUT_OF_VAULT'))
})

test('plain protection and POSIX private permissions', async t => {
  const dir = await temporary(t)
  const store = new SecretStore({ file: path.join(dir, 'private', 'secrets.json'), protector: plainProtector })
  await store.set('test-name', 'plain-value', '仅测试', { agent: 'test' })
  assert.equal(await store.get('test-name', { agent: 'test', purpose: '测试' }), 'plain-value')
  assert.match(await readFile(store.file, 'utf8'), /plain-value/)
  if (process.platform !== 'win32') {
    assert.equal((await stat(store.file)).mode & 0o777, 0o600)
    assert.equal((await stat(path.dirname(store.file))).mode & 0o777, 0o700)
    assert.equal((await stat(store.logFile)).mode & 0o777, 0o600)
  }
})

test('Windows real CurrentUser DPAPI round trip (unicode, newlines, shell metacharacters)', { skip: process.platform !== 'win32' }, async () => {
  const protector = new DpapiProtector()
  const value = '测试密码\nquotes"\' $() ` ; Ω\r\n'
  const stored = await protector.protect(value)
  assert.match(stored, /^[A-Za-z0-9+/]+=*$/)
  assert.ok(!stored.includes(value))
  assert.equal(await protector.unprotect(stored), value)
  await assert.rejects(protector.unprotect('invalid-base64'), e => !String(e).includes('invalid-base64'))
})
