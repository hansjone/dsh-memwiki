export { Memwiki } from './memwiki.ts'
export type { MutationResult, RememberResult, LintResult, SyncResult } from './memwiki.ts'
export { resolveConfig } from './config.ts'
export type { ResolveConfigOpts } from './config.ts'
export { initVault, readManifest } from './core/vault.ts'
export { createMemwikiServer, serveMemwiki } from './mcp/server.ts'
export {
  MemwikiError,
  PAGE_TYPES,
  PAGE_STATUSES,
} from './types.ts'
export type {
  PageType,
  PageStatus,
  PageMeta,
  Page,
  PageRecord,
  WikiLink,
  WriteContext,
  WriteOp,
  WriteResult,
  MoveResult,
  DeleteResult,
  MetaPatch,
  ErrorCode,
  SecretFinding,
  MemwikiConfig,
  VaultManifest,
  SearchQuery,
  SearchHit,
  SearchEngine,
  ContextOptions,
  LintCode,
  LintIssue,
  LintOptions,
  LogEntry,
} from './types.ts'
