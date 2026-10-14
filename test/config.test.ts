import assert from 'node:assert/strict'
import { test } from 'node:test'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { resolveConfig } from '../src/config.ts'
import { initVault } from '../src/core/vault.ts'
import { temporary, code } from './helpers.ts'

test('configuration defaults and CLI > environment > manifest precedence', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  assert.deepEqual(await resolveConfig({ dir, env: {} }), { dir, agent: 'agent', git: { autoCommit: false }, contextBudget: 4096, staleDays: 90, secretScan: true })
  const file = path.join(dir, 'memwiki.json')
  await writeFile(file, JSON.stringify({ schemaVersion: 1, name: 'test', created: '2026-10-14', settings: { contextBudget: 1024, staleDays: 15, secretScan: false } }))
  const env = { MEMWIKI_DIR: dir, MEMWIKI_AGENT: 'env', MEMWIKI_CONTEXT_BUDGET: '2048', MEMWIKI_GIT: '0' }
  assert.equal((await resolveConfig({ dir, env: {} })).contextBudget, 1024)
  assert.equal((await resolveConfig({ env })).contextBudget, 2048)
  const config = await resolveConfig({ dir, agent: 'cli', budget: 512, git: true, env: { ...env, MEMWIKI_DIR: 'missing' } })
  assert.equal(config.agent, 'cli')
  assert.equal(config.contextBudget, 512)
  assert.equal(config.git.autoCommit, true)
  assert.equal(config.staleDays, 15)
  assert.equal(config.secretScan, false)
  await assert.rejects(resolveConfig({ dir, env: { MEMWIKI_CONTEXT_BUDGET: 'bad' } }), code('INVALID_META'))
})

test('autoCommit defaults to repository presence and invalid vaults are rejected', async t => {
  const dir = await temporary(t)
  await assert.rejects(resolveConfig({ dir, env: {} }), code('NOT_A_VAULT'))
  await initVault(dir, { git: true })
  assert.equal((await resolveConfig({ dir, env: {} })).git.autoCommit, true)
  assert.equal((await resolveConfig({ dir, env: { MEMWIKI_GIT: '0' } })).git.autoCommit, false)
})
