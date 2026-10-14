/**
 * Shared contracts for dsh-memwiki. Semantics live in docs/DESIGN.md; section
 * numbers below (§) point there. Every module programs against these types.
 */

/** Page kinds (§3.2). */
export type PageType = 'user' | 'rule' | 'project' | 'topic' | 'howto' | 'decision' | 'reference' | 'inbox'

/** Page lifecycle status (§3.2). */
export type PageStatus = 'active' | 'draft' | 'stale' | 'superseded'

export const PAGE_TYPES: readonly PageType[] = ['user', 'rule', 'project', 'topic', 'howto', 'decision', 'reference', 'inbox']
export const PAGE_STATUSES: readonly PageStatus[] = ['active', 'draft', 'stale', 'superseded']

/** Parsed frontmatter (§3.2). Unknown keys are preserved verbatim. */
export interface PageMeta {
  title: string
  summary: string
  type: PageType
  tags: string[]
  aliases: string[]
  status: PageStatus
  /** ISO date `YYYY-MM-DD`. */
  created: string
  /** ISO datetime with offset. */
  updated: string
  updated_by: string
  verified?: string
  sources?: string[]
  superseded_by?: string
  project?: string
  pinned?: boolean
  [extra: string]: unknown
}

/** A page as loaded from disk. */
export interface Page {
  /** Page ID: vault-relative path without `.md`, `/`-separated (§3.1). */
  id: string
  /** Absolute filesystem path. */
  path: string
  meta: PageMeta
  /** Markdown body after the frontmatter. */
  body: string
  /** SHA-256 of the raw file bytes, first 12 hex chars (§3.3). */
  rev: string
  /** File mtime in ms. */
  mtimeMs: number
  /** Raw file size in bytes. */
  bytes: number
  /** Present when the frontmatter failed to parse or failed validation; `meta` then holds best-effort defaults. */
  metaError?: string
}

/** A parsed `[[link]]` occurrence (§3.4). */
export interface WikiLink {
  /** Raw target text before `|` / `#`, trimmed. */
  target: string
  /** Heading part after `#`, if any. */
  heading?: string
  /** Display text after `|`, if any. */
  label?: string
  /** 0-based offset of `[[` in the body. */
  start: number
  /** Offset just past `]]`. */
  end: number
}

/**
 * Input record for search, catalog and lint (T2). Built from a `Page` by the
 * facade: `links` are already resolved to page IDs (unresolvable ones go to `brokenLinks`).
 */
export interface PageRecord {
  id: string
  meta: PageMeta
  body: string
  bytes: number
  mtimeMs: number
  metaError?: string
  /** Resolved outgoing link targets (page IDs, deduplicated). */
  links: string[]
  /** Raw targets that did not resolve. */
  brokenLinks: string[]
}

/** Who is writing and why (§4.1). */
export interface WriteContext {
  agent: string
  reason: string
  /** Appended to `sources` (deduplicated). */
  source?: string
}

/** Frontmatter patch: `null` deletes a key. */
export type MetaPatch = { [K in keyof PageMeta]?: PageMeta[K] | null }

/** Write operations (§4.1). */
export type WriteOp =
  | { kind: 'create'; id: string; meta: MetaPatch & { title: string; summary: string }; body: string }
  | { kind: 'replace'; id: string; rev: string; body: string; meta?: MetaPatch }
  | { kind: 'append'; id: string; text: string; section?: string; rev?: string }
  | { kind: 'edit'; id: string; rev: string; old: string; new: string }
  | { kind: 'section'; id: string; rev: string; heading: string; body: string }
  | { kind: 'meta'; id: string; rev: string; meta: MetaPatch }

export interface WriteResult {
  page: Page
  created: boolean
  /** Vault-relative paths touched on disk (for git add). */
  changedPaths: string[]
}

export interface MoveResult {
  page: Page
  /** IDs of pages whose links were rewritten. */
  rewritten: string[]
  changedPaths: string[]
}

export interface DeleteResult {
  id: string
  /** Vault-relative path inside `.trash/`. */
  trashPath: string
  /** Pages that still link to the deleted page. */
  danglingFrom: string[]
  changedPaths: string[]
}

/** Error codes thrown as `MemwikiError` (§3, §4). */
export type ErrorCode =
  | 'NOT_FOUND'
  | 'EXISTS'
  | 'CONFLICT'
  | 'AMBIGUOUS'
  | 'AMBIGUOUS_EDIT'
  | 'EDIT_NOT_FOUND'
  | 'INVALID_ID'
  | 'OUT_OF_VAULT'
  | 'INVALID_META'
  | 'SECRET_DETECTED'
  | 'LOCKED'
  | 'NOT_A_VAULT'
  | 'UNSUPPORTED_SCHEMA'

export class MemwikiError extends Error {
  readonly code: ErrorCode
  readonly details?: Record<string, unknown>
  constructor(code: ErrorCode, message: string, details?: Record<string, unknown>) {
    super(message)
    this.name = 'MemwikiError'
    this.code = code
    this.details = details
  }
}

/** A secret-scan hit (§4.3). Never carries the matched text. */
export interface SecretFinding {
  rule: string
  /** 1-based line number in the scanned text. */
  line: number
}

/** Resolved runtime configuration (§7). */
export interface MemwikiConfig {
  /** Absolute vault root. */
  dir: string
  agent: string
  git: { autoCommit: boolean }
  contextBudget: number
  staleDays: number
  secretScan: boolean
}

/** `memwiki.json` at the vault root (§7). */
export interface VaultManifest {
  schemaVersion: number
  name: string
  created: string
  settings?: { staleDays?: number; contextBudget?: number; secretScan?: boolean }
}

/** Search query (§5). */
export interface SearchQuery {
  query: string
  type?: PageType
  /** Every listed tag must be present. */
  tags?: string[]
  /** Current project; boosts (not filters) matching pages. */
  project?: string
  /** Filters to pages whose ID starts with this prefix. */
  dir?: string
  limit?: number
  includeSuperseded?: boolean
}

export interface SearchHit {
  id: string
  title: string
  summary: string
  type: PageType
  status: PageStatus
  updated: string
  score: number
  /** 1–2 best-matching excerpts, each ≤ 200 chars. */
  snippets: string[]
}

/** Incremental full-text index (§5). */
export interface SearchEngine {
  /** Replaces the whole index. */
  load(records: PageRecord[]): void
  upsert(record: PageRecord): void
  remove(id: string): void
  search(q: SearchQuery): SearchHit[]
}

export interface ContextOptions {
  project?: string
  /** UTF-8 byte budget (§6.2). */
  budgetBytes: number
  /** Shown in the header line. */
  vaultDir: string
  /** Number of entries in inbox files (§6.2 step 6). */
  inboxCount: number
}

export type LintCode =
  | 'broken_link'
  | 'orphan'
  | 'duplicate_title'
  | 'missing_summary'
  | 'invalid_meta'
  | 'stale_candidate'
  | 'superseded_target_missing'
  | 'oversized'
  | 'inbox_backlog'
  | 'secret_suspect'
  | 'uncommitted'

export interface LintIssue {
  code: LintCode
  /** Affected page ID (absent for vault-wide issues). */
  page?: string
  message: string
  fixable: boolean
}

export interface LintOptions {
  staleDays: number
  /** "Now" for staleness math; injectable for tests. */
  now: Date
  /** Inbox entries: page ID + entry date, for `inbox_backlog`. */
  inboxEntries: { page: string; date: string }[]
}

/** One `log.md` entry (§4.4). */
export interface LogEntry {
  /** ISO datetime with offset. */
  at: string
  agent: string
  /** e.g. 新建 / 更新 / 移动 / 删除 / 恢复 / lint */
  action: string
  page?: string
  reason: string
}
