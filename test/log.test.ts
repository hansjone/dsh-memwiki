import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { appendLog, readLog } from '../src/core/log.ts'
import { temporary } from './helpers.ts'

test('log groups months and entries newest first and round-trips full entries', async t => {
  const dir = await temporary(t)
  assert.deepEqual(await readLog(dir, 10), [])
  const first = { at: '2026-09-30T20:31:17+08:00', agent: 'claude', action: '新建', page: 'topics/中文', reason: '保留来源' }
  const second = { ...first, at: '2026-10-14T20:31:00+08:00', agent: 'codex', action: '更新' }
  const third = { ...second, at: '2026-10-14T21:31:00+08:00', reason: '最新' }
  await appendLog(dir, second)
  await appendLog(dir, first)
  await appendLog(dir, third)
  const raw = await readFile(path.join(dir, 'log.md'), 'utf8')
  assert.ok(raw.indexOf('## 2026-10') < raw.indexOf('## 2026-09'))
  assert.equal(raw.match(/## 2026-10/g)?.length, 1)
  assert.ok(raw.includes('- 2026-10-14 21:31 [codex] 更新 [[topics/中文]]：最新'))
  assert.deepEqual(await readLog(dir, 10), [third, second, first])
  assert.deepEqual(await readLog(dir, 1), [third])
  assert.deepEqual(await readLog(dir, 0), [])
  const sameTime = { ...third, reason: '同一时间的新日志' }
  await appendLog(dir, sameTime)
  assert.deepEqual(await readLog(dir, 1), [sameTime])
})

test('concurrent append loses no entries; lines without valid structured data are ignored', async t => {
  const dir = await temporary(t)
  await writeFile(path.join(dir, 'log.md'), '# 变更日志\n\n## 2026-09\n\n- 2026-09-01 10:00 [human] lint：检查\n- 2026-09-01 10:00 [human] lint：损坏 <!-- memwiki:eA== -->\n')
  await Promise.all(Array.from({ length: 5 }, (_, i) => appendLog(dir, { at: `2026-10-14T20:3${i}:00Z`, agent: 'test', action: '更新', reason: String(i) })))
  const log = await readLog(dir, 10)
  assert.equal(log.length, 5)
  assert.deepEqual(log.map(entry => entry.reason), ['4', '3', '2', '1', '0'])
})
