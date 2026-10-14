import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeId, idToRelPath, relPathToId, isSpecialId, safeResolve } from '../src/core/ids.ts'
import { temporary, code } from './helpers.ts'

test('IDs preserve spelling and reject forbidden characters and segments', () => {
  assert.equal(normalizeId('projects/NetX/发布流程'), 'projects/NetX/发布流程')
  for (const id of ['', '/a', 'a//b', 'a/../b', './a', 'a.', ' a', 'a/ b', 'a/b ', 'a\\b', 'C:/a', 'a*', 'a?', 'a"', 'a<', 'a>', 'a|', 'a\u0000', 'a\u007f']) assert.throws(() => normalizeId(id), code('INVALID_ID'), id)
  assert.equal(idToRelPath('topics/A'), 'topics/A.md')
  assert.equal(relPathToId('topics\\A.MD'), 'topics/A')
  assert.throws(() => relPathToId('a.txt'), code('INVALID_ID'))
  assert.equal(isSpecialId('topics/_internal'), true)
  assert.equal(isSpecialId('INDEX'), true)
  assert.equal(isSpecialId('log'), true)
  assert.equal(isSpecialId('topics/normal'), false)
})

test('safeResolve rejects lexical traversal, absolute paths and junction escapes', async t => {
  const dir = await temporary(t)
  const outside = await temporary(t)
  assert.equal(safeResolve(dir, 'topics\\new.md'), path.join(dir, 'topics', 'new.md'))
  for (const rel of ['../bad.md', '..\\bad.md', path.join(outside, 'bad.md'), 'C:\\outside\\bad.md', '/tmp/bad', '\\\\server\\share']) assert.throws(() => safeResolve(dir, rel), code('OUT_OF_VAULT'))
  await writeFile(path.join(outside, 'page.md'), 'outside')
  await symlink(outside, path.join(dir, 'escape'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => safeResolve(dir, 'escape/page.md'), code('OUT_OF_VAULT'))
  assert.throws(() => safeResolve(dir, 'escape/not-yet-created/new.md'), code('OUT_OF_VAULT'))
  await mkdir(path.join(dir, 'inside'))
  await symlink(path.join(dir, 'inside'), path.join(dir, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.equal(safeResolve(dir, 'alias/new.md'), path.join(dir, 'alias', 'new.md'))
})
