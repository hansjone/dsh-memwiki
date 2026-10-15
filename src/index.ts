// DSH loads the package by name (cordis.patch.yml `name: dsh-memwiki`), like dsh-trilium:
// the main entry doubles as the host plugin. host.ts has only type imports from DSH.
export { apply, inject, name } from './dsh/host.ts'
export { Memwiki } from './memwiki.ts'
export type { MutationResult, RememberResult, LintResult, SyncResult } from './memwiki.ts'
export { resolveConfig } from './config.ts'
export type { ResolveConfigOpts } from './config.ts'
export { initVault, readManifest } from './core/vault.ts'
export { createMemwikiServer, serveMemwiki } from './mcp/server.ts'
export { SecretStore } from './secrets/store.ts'
export type { SecretStoreOptions, SecretMeta, SecretAccess, Protector } from './secrets/store.ts'
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
  MergeOp,
  MergeResult,
  FeedbackInput,
  FeedbackKind,
  FeedbackEntry,
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
