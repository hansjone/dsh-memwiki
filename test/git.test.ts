import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { commit, gitInit, isGitRepo, listUncommitted } from '../src/core/git.ts'
import { temporary } from './helpers.ts'

const exec = promisify(execFile)
test('git commits touched paths only, uses local identity, and handles no changes and deletion', async t => {
  const dir = await temporary(t)
  assert.equal(await isGitRepo(dir), false)
  await gitInit(dir)
  const git = (args: string[]) => exec('git', args, { cwd: dir })
  await git(['config', 'user.name', 'Local Test'])
  await git(['config', 'user.email', 'local@example.test'])
  await writeFile(path.join(dir, '.gitignore'), '.memwiki/\n')
  await writeFile(path.join(dir, '中文 file.md'), 'one')
  await writeFile(path.join(dir, 'unrelated.md'), 'other')
  const opts = { agent: 'codex', message: '[codex] 新建：测试' }
  const sha = await commit(dir, ['中文 file.md', '.gitignore'], opts)
  assert.match(sha!, /^[a-f0-9]{40}$/)
  assert.deepEqual(await listUncommitted(dir), ['unrelated.md'])
  assert.equal((await git(['log', '-1', '--format=%an <%ae>'])).stdout.trim(), 'codex (memwiki) <codex@memwiki.local>')
  await git(['add', 'unrelated.md'])
  await writeFile(path.join(dir, '中文 file.md'), 'two')
  await commit(dir, ['中文 file.md'], opts)
  assert.equal((await git(['diff', '--cached', '--name-only'])).stdout.trim(), 'unrelated.md')
  assert.equal(await commit(dir, ['中文 file.md'], opts), undefined)
  assert.equal(await commit(dir, [], opts), undefined)
  await writeFile(path.join(dir, '中文 file.md'), 'staged alternative')
  await git(['add', '中文 file.md'])
  await writeFile(path.join(dir, '中文 file.md'), 'two')
  assert.equal(await commit(dir, ['中文 file.md'], opts), undefined)
  await unlink(path.join(dir, '中文 file.md'))
  assert.ok(await commit(dir, ['中文 file.md'], opts))
  assert.deepEqual(await listUncommitted(dir), ['unrelated.md'])
  await mkdir(path.join(dir, 'nested'))
  assert.equal(await isGitRepo(path.join(dir, 'nested')), false)
})

test('git retries transient index.lock and lists staged rename paths', async t => {
  const dir = await temporary(t)
  await gitInit(dir)
  const git = (args: string[]) => exec('git', args, { cwd: dir })
  await git(['config', 'user.name', 'Test'])
  await git(['config', 'user.email', 'test@example.test'])
  await writeFile(path.join(dir, '.gitignore'), '.memwiki/\n')
  await writeFile(path.join(dir, 'old.md'), 'body')
  await commit(dir, ['old.md', '.gitignore'], { agent: 'test', message: 'initial' })
  await rename(path.join(dir, 'old.md'), path.join(dir, 'new.md'))
  await git(['add', '-A'])
  assert.deepEqual(await listUncommitted(dir), ['new.md', 'old.md'])
  const lock = path.join(dir, '.git', 'index.lock')
  await writeFile(lock, 'busy')
  const release = delay(120).then(() => unlink(lock))
  assert.ok(await commit(dir, ['old.md', 'new.md'], { agent: 'test', message: 'rename' }))
  await release
  assert.equal(await readFile(path.join(dir, 'new.md'), 'utf8'), 'body')
})
