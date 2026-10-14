import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SecretRevealController, copySecretTemporarily, REVEAL_MS, CLIPBOARD_MS, type Schedule } from '../src/client/secret-reveal.ts'
import { MemwikiApi } from '../src/client/api.ts'
import { API, type RevealedSecret } from '../src/dsh/protocol.ts'

function clock() {
  let now = 0
  const tasks = new Map<() => void, number>()
  const after: Schedule = (ms, callback) => { tasks.set(callback, now + ms); return () => { tasks.delete(callback) } }
  return {
    after,
    get pending() { return tasks.size },
    advance(ms: number) {
      now += ms
      for (const [callback, due] of tasks) if (due <= now) { tasks.delete(callback); callback() }
    },
  }
}
const secret = (name: string): RevealedSecret => ({ name, scope: '仅测试', value: `${name}-password` })
function deferred() {
  let resolve!: (secret: RevealedSecret) => void
  const promise = new Promise<RevealedSecret>(done => { resolve = done })
  return { promise, resolve }
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('credential reveals only after response and removes the value at exactly 10 seconds', async () => {
  const time = clock()
  const controller = new SecretRevealController(() => {}, time.after)
  const response = deferred()
  const pending = controller.reveal('admin-one', () => response.promise)
  assert.deepEqual(controller.state, { kind: 'loading', name: 'admin-one' })
  time.advance(REVEAL_MS)
  response.resolve(secret('admin-one'))
  assert.equal(await pending, true)
  assert.deepEqual(controller.state, { kind: 'revealed', secret: secret('admin-one') })
  time.advance(REVEAL_MS - 1)
  assert.equal(controller.state.kind, 'revealed')
  time.advance(1)
  assert.deepEqual(controller.state, { kind: 'hidden' })
  assert.ok(!JSON.stringify(controller.state).includes('password'))
  assert.equal(time.pending, 0)
})

test('revealing another credential immediately clears the old value and resets its timer', async () => {
  const time = clock()
  const controller = new SecretRevealController(() => {}, time.after)
  await controller.reveal('admin-one', async name => secret(name))
  time.advance(5_000)
  const response = deferred()
  const pending = controller.reveal('admin-two', () => response.promise)
  assert.deepEqual(controller.state, { kind: 'loading', name: 'admin-two' })
  assert.equal(time.pending, 0)
  response.resolve(secret('admin-two')); await pending
  time.advance(5_000)
  assert.deepEqual(controller.state, { kind: 'revealed', secret: secret('admin-two') })
  time.advance(5_000)
  assert.deepEqual(controller.state, { kind: 'hidden' })
})

test('manual hide or blur clears values and rejects late responses; section unmount disposes timers', async () => {
  for (const dispose of [false, true]) {
    const time = clock()
    const controller = new SecretRevealController(() => {}, time.after)
    await controller.reveal('admin-one', async name => secret(name))
    if (dispose) controller.dispose(); else controller.hide()
    assert.deepEqual(controller.state, { kind: 'hidden' })
    assert.equal(time.pending, 0)
    if (dispose) assert.equal(await controller.reveal('admin-one', async name => secret(name)), false)
    const active = new SecretRevealController(() => {}, time.after)
    const response = deferred()
    const pending = active.reveal('admin-one', () => response.promise)
    if (dispose) active.dispose(); else active.hide()
    response.resolve(secret('admin-one'))
    assert.equal(await pending, false)
    assert.deepEqual(active.state, { kind: 'hidden' })
    assert.equal(time.pending, 0)
  }
})

test('out-of-order reveal responses cannot replace a newer credential', async () => {
  const time = clock()
  const controller = new SecretRevealController(() => {}, time.after)
  const response = deferred()
  const old = controller.reveal('admin-one', () => response.promise)
  await controller.reveal('admin-two', async name => secret(name))
  response.resolve(secret('admin-one'))
  assert.equal(await old, false)
  assert.deepEqual(controller.state, { kind: 'revealed', secret: secret('admin-two') })
  assert.equal(time.pending, 1)
  controller.dispose()
})

test('failed or mismatched reveal responses leave no value in state', async () => {
  const time = clock()
  const controller = new SecretRevealController(() => {}, time.after)
  await controller.reveal('admin-one', async name => secret(name))
  await assert.rejects(controller.reveal('admin-two', async () => { throw new Error('failure') }))
  assert.deepEqual(controller.state, { kind: 'hidden' })
  await assert.rejects(controller.reveal('admin-two', async () => secret('admin-one')))
  assert.deepEqual(controller.state, { kind: 'hidden' })
  assert.equal(time.pending, 0)
})

test('copied credential is cleared at 30 seconds only if clipboard still contains it', async () => {
  for (const changed of [false, true]) {
    const time = clock()
    let content = ''
    const clipboard = { async writeText(value: string) { content = value }, async readText() { return content } }
    await copySecretTemporarily('copied-password', clipboard, time.after)
    assert.equal(content, 'copied-password')
    time.advance(CLIPBOARD_MS - 1); await flush()
    assert.equal(content, 'copied-password')
    if (changed) content = 'new clipboard content'
    time.advance(1); await flush()
    assert.equal(content, changed ? 'new clipboard content' : '')
  }
})

test('clipboard cleanup skips denied reads and tolerates denied clearing; failed copy schedules nothing', async () => {
  for (const deniedRead of [true, false]) {
    const time = clock()
    let content = ''
    let writes = 0
    const clipboard = {
      async writeText(value: string) { if (++writes > 1) throw new Error('denied'); content = value },
      async readText() { if (deniedRead) throw new Error('denied'); return content },
    }
    await copySecretTemporarily('copied-password', clipboard, time.after)
    time.advance(CLIPBOARD_MS); await flush()
    assert.equal(content, 'copied-password')
    assert.equal(writes, deniedRead ? 1 : 2)
  }
  const time = clock()
  await assert.rejects(copySecretTemporarily('copied-password', { async writeText() { throw new Error('denied') }, async readText() { return '' } }, time.after))
  assert.equal(time.pending, 0)
})

test('client reveal explicitly POSTs only the name with no-store', async t => {
  const calls: Array<{ url: unknown; init?: RequestInit }> = []
  t.mock.method(globalThis, 'fetch', async (url: unknown, init?: RequestInit) => {
    calls.push({ url, init })
    return { ok: true, async json() { return secret('admin-one') } }
  })
  assert.deepEqual(await new MemwikiApi().reveal('admin-one'), secret('admin-one'))
  assert.deepEqual(calls, [{ url: API.reveal, init: { method: 'POST', cache: 'no-store', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'admin-one' }) } }])
})
