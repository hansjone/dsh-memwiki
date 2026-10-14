import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { mkdir, readdir, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { withLock } from '../src/core/lock.ts'
import { temporary, code } from './helpers.ts'

test('lock serializes case-insensitive keys and releases after success and failure', async t => {
  const dir = await temporary(t)
  let active = 0
  await Promise.all(Array.from({ length: 6 }, (_, i) => withLock(dir, i % 2 ? 'PAGE' : 'page', async () => {
    assert.equal(active++, 0)
    await delay(10)
    assert.equal(--active, 0)
  })))
  await assert.rejects(withLock(dir, 'page', async () => { throw new Error('failure') }), /failure/)
  assert.deepEqual(await readdir(path.join(dir, '.memwiki', 'locks')), [])
})

test('stale locks can be claimed and live locks time out with LOCKED', async t => {
  const dir = await temporary(t)
  const locks = path.join(dir, '.memwiki', 'locks')
  await mkdir(locks, { recursive: true })
  const file = path.join(locks, createHash('sha256').update('page').digest('hex') + '.lock')
  await writeFile(file, 'stale')
  const old = new Date(Date.now() - 11_000)
  await utimes(file, old, old)
  assert.equal(await withLock(dir, 'page', async () => 'claimed'), 'claimed')
  await writeFile(file, 'live')
  await assert.rejects(withLock(dir, 'page', async () => 'never'), code('LOCKED'))
})
