import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { initVault, readManifest } from '../src/core/vault.ts'
import { isGitRepo } from '../src/core/git.ts'
import { temporary, code } from './helpers.ts'

test('vault init copies templates and creates the complete skeleton', async t => {
  const dir = await temporary(t)
  await initVault(dir, { name: '中文记忆库', git: false })
  const manifest = await readManifest(dir)
  assert.equal(manifest.name, '中文记忆库')
  assert.equal(manifest.schemaVersion, 1)
  for (const sub of ['user', 'rules', 'projects', 'topics', 'howto', 'decisions', 'reference', 'inbox', '.trash', '.memwiki/locks']) assert.ok((await stat(path.join(dir, sub))).isDirectory())
  assert.equal(await readFile(path.join(dir, '_guide.md'), 'utf8'), await readFile(new URL('../templates/vault/_guide.md', import.meta.url), 'utf8'))
  assert.equal(await readFile(path.join(dir, '.gitignore'), 'utf8'), await readFile(new URL('../templates/vault/gitignore', import.meta.url), 'utf8'))
  assert.equal(await isGitRepo(dir), false)
  await assert.rejects(initVault(dir, { git: false }), code('EXISTS'))
})

test('manifest rejects missing, corrupt and unsupported schemas; optional init initializes git', async t => {
  const dir = await temporary(t)
  await assert.rejects(readManifest(dir), code('NOT_A_VAULT'))
  await writeFile(path.join(dir, 'memwiki.json'), '{bad')
  await assert.rejects(readManifest(dir), code('NOT_A_VAULT'))
  await writeFile(path.join(dir, 'memwiki.json'), JSON.stringify({ schemaVersion: 2 }))
  await assert.rejects(readManifest(dir), code('UNSUPPORTED_SCHEMA'))
  const other = await temporary(t)
  await initVault(other, { git: true })
  assert.equal(await isGitRepo(other), true)
})
