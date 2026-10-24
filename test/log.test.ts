import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendLog, readLog } from '../src/core/log.ts'
import { temporary } from './helpers.ts'

test('log appends by month and reads newest entries first with full timestamps', async t => {
  const dir = await temporary(t)
  assert.deepEqual(await readLog(dir, 10), [])
  const first = { at: '2026-09-30T20:31:17+08:00', agent: 'claude', action: '新建', page: 'topics/中文', reason: '保留来源' }
  const second = { ...first, at: '2026-10-14T20:31:00+08:00', agent: 'codex', action: '更新' }
  const third = { ...second, at: '2026-10-14T21:31:00+08:00', reason: '最新' }
  await appendLog(dir, second)
  await appendLog(dir, first)
  await appendLog(dir, third)
  const raw = await readFile(path.join(dir, 'log/2026-10.md'), 'utf8')
  assert.ok(raw.indexOf('20:31') < raw.indexOf('21:31'))
  assert.ok(!raw.includes('2026-09'))
  assert.match(await readFile(path.join(dir, 'log/2026-09.md'), 'utf8'), /保留来源/)
  assert.ok(raw.includes('- 2026-10-14 21:31 [codex] 更新 [[topics/中文]]：最新'))
  assert.deepEqual(await readLog(dir, 10), [third, second, first])
  assert.deepEqual(await readLog(dir, 1), [third])
  assert.deepEqual(await readLog(dir, 0), [])
  const sameTime = { ...third, reason: '同一时间的新日志' }
  await appendLog(dir, sameTime)
  assert.ok((await readFile(path.join(dir, 'log/2026-10.md'), 'utf8')).startsWith(raw))
  assert.deepEqual(await readLog(dir, 1), [sameTime])
})

test('concurrent append loses no entries; lines without valid structured data are ignored', async t => {
  const dir = await temporary(t)
  await mkdir(path.join(dir, 'log'))
  await writeFile(path.join(dir, 'log/2026-09.md'), '- 2026-09-01 10:00 [human] lint：检查\n- 2026-09-01 10:00 [human] lint：损坏 <!-- memwiki:eA== -->\n')
  await Promise.all(Array.from({ length: 5 }, (_, i) => appendLog(dir, { at: `2026-10-14T20:3${i}:00Z`, agent: 'test', action: '更新', reason: String(i) })))
  const log = await readLog(dir, 10)
  assert.equal(log.length, 5)
  assert.deepEqual(log.map(entry => entry.reason), ['4', '3', '2', '1', '0'])
})

test('readLog stops before older months and ignores old root log; reasons truncate by Unicode characters', async t => {
  const dir = await temporary(t)
  const entry = { at: '2026-10-25T12:00:00+08:00', agent: 'test', action: '更新', reason: '😀'.repeat(121) }
  await writeFile(path.join(dir, 'log.md'), '旧日志不可读取')
  assert.deepEqual(await readLog(dir, 10), [])
  const rel = await appendLog(dir, entry)
  assert.equal(rel, 'log/2026-10.md')
  assert.equal((await readLog(dir, 1))[0].reason, '😀'.repeat(120) + '…')
  // Opening this older month would fail; enough entries from October must stop the reader.
  await mkdir(path.join(dir, 'log/2026-09.md'))
  assert.equal((await readLog(dir, 1)).length, 1)
  await assert.rejects(readLog(dir, 2))
})
