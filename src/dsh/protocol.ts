import type { LintIssue, LogEntry } from '../types.ts'
export const API = {
  config: '/api/dsh-memwiki/config',
  status: '/api/dsh-memwiki/status',
  lint: '/api/dsh-memwiki/lint',
  secrets: '/api/dsh-memwiki/secrets',
  accessLog: '/api/dsh-memwiki/secrets/log',
  reveal: '/api/dsh-memwiki/secrets/reveal',
} as const
export interface RevealedSecret { name: string; scope: string; value: string }
export interface ConfigView { dir: string; autoPush: boolean; effectiveDir: string; overridden: boolean }
export interface VaultStatus { dir: string; valid: boolean; pages: number; inbox: number; git: boolean; remote: boolean; recent: LogEntry[]; error?: string }
export interface HealthResult { issues: LintIssue[] }
