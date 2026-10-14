import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type { TestContext } from 'node:test'
import { MemwikiError } from '../src/types.ts'
import type { ErrorCode, MemwikiConfig } from '../src/types.ts'

export async function temporary(t: TestContext): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'memwiki-t1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
export const config = (dir: string): MemwikiConfig => ({ dir, agent: 'test', git: { autoCommit: false }, contextBudget: 4096, staleDays: 90, secretScan: true })
export const code = (expected: ErrorCode) => (err: unknown): boolean => err instanceof MemwikiError && err.code === expected
