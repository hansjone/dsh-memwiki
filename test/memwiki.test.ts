import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { logPath } from '../src/core/log.ts'
import { nowIso, localDate } from '../src/core/page.ts'
import { initVault } from '../src/core/vault.ts'
import { Memwiki } from '../src/memwiki.ts'
import { temporary, config } from './helpers.ts'

const exec = promisify(execFile)

async function openVault(t: Parameters<typeof temporary>[0], withGit = true) {
  const dir = await temporary(t)
  await initVault(dir, { git: withGit })
  if (withGit) {
    await exec('git', ['config', 'user.name', 'Test'], { cwd: dir })
    await exec('git', ['config', 'user.email', 'test@example.test'], { cwd: dir })
  }
  const wiki = await Memwiki.open({ ...config(dir), git: { autoCommit: withGit, autoPush: false }, agent: 'codex' })
  t.after(() => wiki.close())
  return { dir, wiki }
}

test('full write flow: create, search, index, log, git commit', async t => {
  const { dir, wiki } = await openVault(t)
  const { result, commitSha } = await wiki.write({
    kind: 'create',
    id: 'topics/编码',
    meta: { title: 'UTF-8 BOM', summary: 'PowerShell 5.1 需要带 BOM 的 UTF-8', type: 'topic', tags: ['windows'] },
    body: '脚本要存成带 BOM 的 UTF-8。\n',
  }, { agent: 'codex', reason: '记录踩坑' })
  assert.ok(commitSha)
  assert.equal(result.page.meta.title, 'UTF-8 BOM')
  const hits = wiki.search({ query: 'BOM PowerShell' })
  assert.ok(hits.some(h => h.id === 'topics/编码'))
  const index = await readFile(path.join(dir, 'index.md'), 'utf8')
  assert.match(index, /topics\/编码/)
  const log = await readFile(path.join(dir, logPath(nowIso())), 'utf8')
  assert.match(log, /新建.*topics\/编码/)
  const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: dir })
  assert.match(stdout, /\[codex\] 新建/)
})

test('write with verification updates the date with one log and one commit; descriptions truncate', async t => {
  const { dir, wiki } = await openVault(t)
  const count = async () => Number((await exec('git', ['rev-list', '--count', 'HEAD'], { cwd: dir })).stdout.trim())
  const before = await count()
  const created = await wiki.write({ kind: 'create', id: 'topics/verified', meta: { title: '核实页', summary: '记录核实结果', status: 'stale' }, body: '原文\n', verify: '对照代码' }, { agent: 'codex', reason: '新建内容' })
  assert.equal(created.result.page.meta.verified, localDate())
  assert.equal(created.result.page.meta.status, 'active')
  assert.equal(await count(), before + 1)
  assert.equal((await wiki.log()).length, 1)
  assert.equal((await wiki.log())[0].action, '新建并核实')
  assert.match((await wiki.log())[0].reason, /对照代码/)
  const written = await wiki.write({ kind: 'replace', id: created.result.page.id, rev: created.result.page.rev, body: '核实后的正文\n', verify: '' }, { agent: 'codex', reason: '😀'.repeat(130) })
  assert.equal(written.result.page.meta.verified, localDate())
  assert.equal(await count(), before + 2)
  const logs = await wiki.log()
  assert.equal(logs.length, 2)
  assert.equal(logs[0].action, '更新并核实')
  assert.equal(logs[0].reason, '😀'.repeat(120) + '…')
  const message = (await exec('git', ['log', '-1', '--format=%s'], { cwd: dir })).stdout.trim()
  assert.equal([...message].length, 121)
  assert.ok(message.endsWith('…'))
  const changed = (await exec('git', ['diff-tree', '--no-commit-id', '--name-only', '-r', 'HEAD'], { cwd: dir })).stdout
  assert.match(changed, /log\/\d{4}-\d{2}\.md/)
  assert.equal((await exec('git', ['status', '--porcelain'], { cwd: dir })).stdout, '')
})

test('move rewrites links and updates search', async t => {
  const { wiki } = await openVault(t)
  await wiki.write({
    kind: 'create', id: 'topics/old', meta: { title: '旧名', summary: '将被改名的页面' }, body: '内容\n',
  }, { agent: 'codex', reason: '建' })
  await wiki.write({
    kind: 'create', id: 'howto/引用', meta: { title: '引用页', summary: '链向旧名' }, body: '见 [[topics/old|旧名]] 与 [[旧名]]。\n',
  }, { agent: 'codex', reason: '建' })
  const { result } = await wiki.move('topics/old', 'topics/new-id', { agent: 'codex', reason: '改名' })
  assert.equal(result.page.id, 'topics/new-id')
  assert.ok(result.rewritten.includes('howto/引用'))
  const linked = await wiki.read('howto/引用')
  assert.match(linked.page.body, /\[\[topics\/new-id/)
  assert.ok(wiki.search({ query: '将被改名' }).some(h => h.id === 'topics/new-id'))
  assert.equal(wiki.search({ query: '将被改名' }).some(h => h.id === 'topics/old'), false)
})

test('delete and restore', async t => {
  const { wiki } = await openVault(t)
  await wiki.write({
    kind: 'create', id: 'topics/temp', meta: { title: '临时', summary: '将被删除' }, body: 'x\n',
  }, { agent: 'codex', reason: '建' })
  const { result: del } = await wiki.delete('topics/temp', { agent: 'codex', reason: '删' })
  assert.match(del.trashPath, /^\.trash\/topics\/temp\.\d+\.md$/)
  await assert.rejects(() => wiki.read('topics/temp'))
  const { result: rest } = await wiki.restore(del.trashPath, { agent: 'codex', reason: '恢复' })
  assert.equal(rest.page.id, 'topics/temp')
  assert.equal((await wiki.read('topics/temp')).page.meta.title, '临时')
})

test('remember appends inbox and returns related pages', async t => {
  const { wiki } = await openVault(t)
  await wiki.write({
    kind: 'create',
    id: 'topics/powershell',
    meta: { title: 'PowerShell', summary: 'Windows 脚本环境与编码' },
    body: 'PowerShell 编码问题。\n',
  }, { agent: 'codex', reason: '建' })
  const { page, related } = await wiki.remember('PowerShell 中文乱码要记得加 BOM', { agent: 'codex', source: 'session:test' })
  assert.match(page.id, /^inbox\/\d{4}-\d{2}$/)
  assert.match(page.body, /^- \d{4}-\d{2}-\d{2} \d{2}:\d{2} \[codex\] PowerShell/)
  assert.match(page.body, /来源：session:test/)
  assert.equal(page.meta.type, 'inbox')
  assert.ok(related.some(h => h.id === 'topics/powershell'))
  const ctx = wiki.context()
  assert.match(ctx, /inbox 未整理条目：1/)
})

test('lint reports and fix applies meta patches', async t => {
  const { dir, wiki } = await openVault(t)
  await wiki.write({
    kind: 'create',
    id: 'topics/stale-page',
    meta: { title: '过期页', summary: '很久没核实', verified: '2020-01-01' },
    body: '旧内容\n',
  }, { agent: 'codex', reason: '建' })
  const before = await wiki.lint({ fix: false })
  assert.ok(before.issues.some(i => i.code === 'stale_candidate' && i.page === 'topics/stale-page'))
  const after = await wiki.lint({ fix: true, agent: 'codex' })
  assert.ok(after.fixed >= 1)
  assert.equal((await wiki.read('topics/stale-page')).page.meta.status, 'stale')
  const { stdout } = await exec('git', ['log', '-1', '--format=%s'], { cwd: dir })
  assert.match(stdout, /\[codex\] lint/)
})

test('two vaults sync via bare remote', async t => {
  const bare = await temporary(t)
  await exec('git', ['init', '--bare'], { cwd: bare })
  const aDir = await temporary(t)
  const bDir = await temporary(t)
  await initVault(aDir, { git: true })
  await exec('git', ['config', 'user.name', 'A'], { cwd: aDir })
  await exec('git', ['config', 'user.email', 'a@test'], { cwd: aDir })
  await exec('git', ['remote', 'add', 'origin', bare], { cwd: aDir })
  // initVault already committed the skeleton, so clones are valid vaults.

  const wikiA = await Memwiki.open({ ...config(aDir), agent: 'a', git: { autoCommit: true, autoPush: false } })
  t.after(() => wikiA.close())
  await wikiA.write({
    kind: 'create', id: 'topics/shared', meta: { title: '共享知识', summary: '两边都能搜到' }, body: '同步内容 alpha\n',
  }, { agent: 'a', reason: 'A 写入' })
  await exec('git', ['push', '-u', 'origin', 'HEAD'], { cwd: aDir })

  await exec('git', ['clone', bare, bDir])
  await exec('git', ['config', 'user.name', 'B'], { cwd: bDir })
  await exec('git', ['config', 'user.email', 'b@test'], { cwd: bDir })
  const wikiB = await Memwiki.open({ ...config(bDir), agent: 'b', git: { autoCommit: true, autoPush: false } })
  t.after(() => wikiB.close())
  assert.ok(wikiB.search({ query: '同步内容 alpha' }).some(h => h.id === 'topics/shared'))

  await wikiA.write({
    kind: 'append', id: 'topics/shared', text: '同步内容 beta\n',
  }, { agent: 'a', reason: '追加' })
  await exec('git', ['push'], { cwd: aDir })
  const sync = await wikiB.sync()
  assert.equal(sync.pulled, true)
  assert.ok(wikiB.search({ query: '同步内容 beta' }).some(h => h.id === 'topics/shared'))
})
