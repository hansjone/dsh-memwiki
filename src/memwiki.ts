import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type {
  DeleteResult, LintIssue, LogEntry, MemwikiConfig, MoveResult, Page, PageRecord,
  SearchHit, SearchQuery, WriteContext, WriteOp, WriteResult,
  MergeOp, MergeResult, FeedbackInput,
} from './types.ts'
import { MemwikiError } from './types.ts'
import { Store } from './core/store.ts'
import { createResolver, extractLinks, convertMarkdownLinks } from './core/links.ts'
import { appendLog, readLog, logPath } from './core/log.ts'
import { commit, hasRemote, listUncommitted, pullRebase, push } from './core/git.ts'
import { scanSecrets } from './core/secrets.ts'
import { idToRelPath, safeResolve } from './core/ids.ts'
import { atomicWrite } from './core/fs.ts'
import { nowIso } from './core/page.ts'
import { createSearchEngine } from './search/engine.ts'
import { buildContext, buildIndexMd } from './search/catalog.ts'
import { fixFor, lintRecords } from './search/lint.ts'
import { watchVault } from './watch.ts'
import { appendUsage, usageSummary, USAGE_EVENTS } from './core/usage.ts'
import type { UsageEvent } from './core/usage.ts'
import { feedbackBlock, feedbackEntries, resolveFeedbackBody } from './core/feedback.ts'
import { withLock } from './core/lock.ts'
import { localDate } from './core/page.ts'

const INBOX_LINE = /^- (\d{4}-\d{2}-\d{2})/u

export interface MutationResult<T> {
  result: T
  commitSha?: string
}

export interface RememberResult {
  page: Page
  related: SearchHit[]
  commitSha?: string
}

export interface LintResult {
  issues: LintIssue[]
  fixed: number
  commitSha?: string
}

export interface SyncResult {
  pulled: boolean
  pushed: boolean
  conflicts?: string[]
}

/** Facade assembling store, search, catalog, lint, git and external watch (§4 §6). */
export class Memwiki {
  readonly config: MemwikiConfig
  private store: Store
  private engine = createSearchEngine()
  private records = new Map<string, PageRecord>()
  private watcher?: ReturnType<typeof watchVault>
  private pushTimer?: ReturnType<typeof setTimeout>
  private closed = false
  private usagePending: Promise<void> = Promise.resolve()

  private signal(event: UsageEvent, agent: string, extra: { query?: string; page?: string; rules?: string[] } = {}): Promise<void> {
    this.usagePending = this.usagePending.then(() => appendUsage(this.config.dir, { event, agent, ...extra }))
      .catch(() => { console.warn('[memwiki] 使用信号写入失败') })
    return this.usagePending
  }

  private async observed<T>(agent: string, page: string | undefined, fn: () => Promise<T>): Promise<T> {
    try { return await fn() }
    catch (e) {
      if (e instanceof MemwikiError && USAGE_EVENTS.includes(e.code as UsageEvent)) {
        const findings = e.details?.findings as { rule: string }[] | undefined
        await this.signal(e.code as UsageEvent, agent, { page, rules: findings?.map(f => f.rule) })
      }
      throw e
    }
  }

  private constructor(config: MemwikiConfig) {
    this.config = { ...config, dir: path.resolve(config.dir), git: { ...config.git } }
    this.store = new Store(this.config)
  }

  /** Opens a vault: loads pages into the search index and starts the file watcher. */
  static async open(config: MemwikiConfig, options: { watch?: boolean } = {}): Promise<Memwiki> {
    const wiki = new Memwiki(config)
    await wiki.rebuildIndex()
    if (options.watch === false) return wiki
    wiki.watcher = watchVault(wiki.config.dir, {
      onExternalChange: async () => { await wiki.refreshFromDisk() },
      onExternalCommit: async (changed) => {
        if (!wiki.config.git.autoCommit) return
        const pages = changed.filter(p => /\.md$/i.test(p) && !p.startsWith('.trash/') && !p.startsWith('.memwiki/'))
        if (!pages.length) return
        const sha = await wiki.tryCommit(pages, { agent: 'external', message: `[external] 外部编辑 ${pages.length} 个页面` })
        if (sha) wiki.schedulePush()
      },
    })
    return wiki
  }

  private key(id: string) { return id.toLowerCase() }

  private toRecord(page: Page, resolver: ReturnType<typeof createResolver>): PageRecord {
    const links: string[] = []
    const brokenLinks: string[] = []
    for (const link of extractLinks(page.body)) {
      const match = resolver(link.target)
      if (!match) brokenLinks.push(link.target)
      else if ('ambiguous' in match) brokenLinks.push(link.target)
      else links.push(match.id)
    }
    return {
      id: page.id,
      meta: page.meta,
      body: page.body,
      bytes: page.bytes,
      mtimeMs: page.mtimeMs,
      metaIssues: page.metaIssues,
      links: [...new Set(links)],
      brokenLinks: [...new Set(brokenLinks)],
    }
  }

  private async allPages(): Promise<Page[]> {
    return this.store.list()
  }

  private async rebuildIndex(): Promise<void> {
    const pages = await this.allPages()
    const resolver = createResolver(pages.map(p => ({ id: p.id, title: p.meta.title, aliases: p.meta.aliases })))
    this.records.clear()
    const list: PageRecord[] = []
    for (const page of pages) {
      const record = this.toRecord(page, resolver)
      this.records.set(this.key(page.id), record)
      list.push(record)
    }
    this.engine.load(list)
    await this.rewriteIndexMd(list)
  }

  private async refreshFromDisk(): Promise<void> {
    await this.rebuildIndex()
  }

  private recordList(): PageRecord[] {
    return [...this.records.values()]
  }

  private resolverFromRecords(): ReturnType<typeof createResolver> {
    return createResolver(this.recordList().map(r => ({ id: r.id, title: r.meta.title, aliases: r.meta.aliases })))
  }

  /**
   * Re-resolves every record's links. Needed whenever the set of link targets changes
   * (page created, deleted, or retitled): links written before their target existed must
   * stop counting as broken, and links to a deleted page must start counting.
   */
  private relinkAll(): void {
    const resolver = this.resolverFromRecords()
    for (const record of this.records.values()) {
      const { links, brokenLinks } = this.toRecord({ ...record, path: '', rev: '' } as Page, resolver)
      record.links = links
      record.brokenLinks = brokenLinks
    }
  }

  private upsertRecord(page: Page): void {
    const previous = this.records.get(this.key(page.id))
    const sameTargets = previous !== undefined && previous.meta.title === page.meta.title
      && JSON.stringify(previous.meta.aliases) === JSON.stringify(page.meta.aliases)
    // Store a placeholder first so the page can resolve links to itself.
    this.records.set(this.key(page.id), this.toRecord(page, createResolver([])))
    if (!sameTargets) this.relinkAll()
    const record = this.toRecord(page, this.resolverFromRecords())
    this.records.set(this.key(page.id), record)
    this.engine.upsert(record)
  }

  private removeRecord(id: string): void {
    this.records.delete(this.key(id))
    this.engine.remove(id)
    this.relinkAll()
  }

  private noteOwnWrite(paths: string[], pages: Page[] = []): void {
    for (const rel of paths) this.watcher?.noteWrite(rel)
    for (const page of pages) this.watcher?.noteWrite(idToRelPath(page.id), page.rev)
  }

  private async rewriteIndexMd(records = this.recordList()): Promise<boolean> {
    const next = buildIndexMd(records, { generatedAt: new Date() })
    const rel = 'index.md'
    let prev = ''
    try { prev = await readFile(safeResolve(this.config.dir, rel), 'utf8') }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e }
    // Compare without the generated timestamp line so identical catalogs stay quiet.
    const strip = (text: string) => text.replace(/^生成时间：.*$/mu, '生成时间：')
    if (strip(prev) === strip(next) && prev) return false
    this.watcher?.noteWrite(rel)
    await atomicWrite(this.config.dir, rel, next)
    return true
  }

  private async afterMutation(opts: {
    changedPaths: string[]
    pages?: Page[]
    removedIds?: string[]
    action: string
    page?: string
    reason: string
    agent: string
  }): Promise<string | undefined> {
    for (const id of opts.removedIds ?? []) this.removeRecord(id)
    for (const page of opts.pages ?? []) this.upsertRecord(page)
    // Re-resolve links across all pages when IDs/titles may have changed (move).
    if (opts.removedIds?.length || (opts.pages?.length ?? 0) > 1) {
      const pages = await this.allPages()
      const resolver = createResolver(pages.map(p => ({ id: p.id, title: p.meta.title, aliases: p.meta.aliases })))
      this.records.clear()
      for (const page of pages) {
        const record = this.toRecord(page, resolver)
        this.records.set(this.key(page.id), record)
        this.engine.upsert(record)
      }
    }
    const indexChanged = await this.rewriteIndexMd()
    const entry: LogEntry = {
      at: nowIso(),
      agent: opts.agent,
      action: opts.action,
      page: opts.page,
      reason: opts.reason,
    }
    const logRel = logPath(entry.at)
    this.watcher?.noteWrite(logRel)
    await appendLog(this.config.dir, entry)
    const paths = [...new Set([...opts.changedPaths, ...(indexChanged ? ['index.md'] : []), logRel])]
    this.noteOwnWrite(paths, opts.pages)
    const sha = await this.tryCommit(paths, {
      agent: opts.agent,
      message: `[${opts.agent}] ${opts.action}${opts.page ? ' ' + opts.page : ''}：${opts.reason}`,
    })
    if (sha) this.schedulePush()
    return sha
  }

  private async tryCommit(paths: string[], opts: { agent: string; message: string }): Promise<string | undefined> {
    if (!this.config.git.autoCommit) return undefined
    try { return await commit(this.config.dir, paths, opts) }
    catch (e) {
      console.warn('[memwiki] git commit 失败：', e instanceof Error ? e.message : e)
      return undefined
    }
  }

  private schedulePush(): void {
    if (!this.config.git.autoPush) return
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.pushTimer = setTimeout(() => { void this.doPush() }, 30_000)
  }

  private async doPush(): Promise<void> {
    try {
      if (!(await hasRemote(this.config.dir))) return
      await push(this.config.dir)
    } catch (e) {
      console.warn('[memwiki] git push 失败：', e instanceof Error ? e.message : e)
    }
  }

  private inboxEntries(): { page: string; date: string }[] {
    const entries: { page: string; date: string }[] = []
    for (const record of this.records.values()) {
      if (record.meta.type !== 'inbox' && !record.id.toLowerCase().startsWith('inbox/')) continue
      for (const line of record.body.split(/\r?\n/)) {
        const m = INBOX_LINE.exec(line)
        if (m) entries.push({ page: record.id, date: m[1] })
      }
    }
    return entries
  }

  private countInbox(): number {
    return this.inboxEntries().length
  }

  /** Budget-aware compact directory for session start (§6.2). */
  context(project?: string): string {
    return buildContext(this.recordList(), {
      project,
      budgetBytes: this.config.contextBudget,
      vaultDir: this.config.dir,
      inboxCount: this.countInbox(),
      feedbackOpen: this.feedbackList().length,
    })
  }

  /** Full-text search over indexed pages (§5). */
  search(q: SearchQuery): SearchHit[] {
    const hits = this.engine.search(q)
    if (!hits.length) void this.signal('SEARCH_ZERO', this.config.agent, { query: q.query })
    return hits
  }

  /** Reads a page by ID / title / alias, including backlinks and broken links. */
  async read(ref: string): Promise<{
    page: Page
    backlinks: string[]
    brokenLinks: string[]
    recordedDaysAgo: number
  }> {
    const page = ref.startsWith('_') || ref.toLowerCase() === 'index' || /^log\//i.test(ref)
      ? await this.store.readSpecial(ref).catch(async () => this.store.resolve(ref))
      : await this.store.resolve(ref)
    const record = this.records.get(this.key(page.id)) ?? this.toRecord(page, createResolver(
      this.recordList().map(r => ({ id: r.id, title: r.meta.title, aliases: r.meta.aliases })),
    ))
    const backlinks = this.recordList()
      .filter(r => r.links.some(l => l.toLowerCase() === page.id.toLowerCase()))
      .map(r => r.id)
    const updated = Date.parse(page.meta.updated)
    const recordedDaysAgo = Number.isFinite(updated) ? Math.max(0, Math.floor((Date.now() - updated) / 86_400_000)) : 0
    return { page, backlinks, brokenLinks: record.brokenLinks, recordedDaysAgo }
  }

  /** Applies a write op, then refreshes search / index / log / git. */
  async write(op: WriteOp, ctx: WriteContext): Promise<MutationResult<WriteResult>> {
    const result = await this.observed(ctx.agent, op.id, () => this.store.write(op, ctx))
    if (op.kind === 'create' && op.force) await this.signal('FORCE_CREATE', ctx.agent, { page: op.id })
    const action = (op.kind === 'create' ? '新建' : '更新') + (op.verify !== undefined ? '并核实' : '')
    const commitSha = await this.afterMutation({
      changedPaths: result.changedPaths,
      pages: [result.page],
      action,
      page: result.page.id,
      reason: op.verify !== undefined ? `${ctx.reason}；核实依据：${op.verify}` : ctx.reason,
      agent: ctx.agent,
    })
    return { result, commitSha }
  }

  /** Consolidates source pages into an owner with one catalog/log/git mutation. */
  async merge(op: MergeOp): Promise<MutationResult<MergeResult>> {
    const result = await this.observed(op.ctx.agent, op.into, () => this.store.merge(op))
    const commitSha = await this.afterMutation({ changedPaths: result.changedPaths, pages: result.pages, removedIds: result.from,
      action: 'merge', page: `${result.from.join(', ')} -> ${result.page.id}`, reason: op.ctx.reason, agent: op.ctx.agent })
    return { result, commitSha }
  }

  /** Records successful verification without requiring a revision or changing body/provenance. */
  async verify(ref: string, opts: { note?: string; ctx: WriteContext }): Promise<MutationResult<WriteResult>> {
    const result = await this.observed(opts.ctx.agent, ref, () => this.store.verify(ref))
    const commitSha = await this.afterMutation({ changedPaths: result.changedPaths, pages: [result.page],
      action: 'verify', page: result.page.id, reason: opts.note ?? opts.ctx.reason, agent: opts.ctx.agent })
    return { result, commitSha }
  }

  /** Lists indexed feedback entries; default includes only open items. */
  feedbackList(all = false) { return feedbackEntries(this.recordList(), all) }

  /** Appends a monthly feedback entry; sensitive content is rejected by the normal scanner. */
  async feedback(input: FeedbackInput) {
    const block = feedbackBlock(input)
    const id = `meta/feedback/${localDate().slice(0, 7)}`
    return this.observed(input.ctx.agent, id, () => withLock(this.config.dir, ':feedback', async () => {
      let exists = true
      try { await this.store.get(id) }
      catch (e) { if (!(e instanceof MemwikiError && e.code === 'NOT_FOUND')) throw e; exists = false }
      const result = await this.store.write(exists ? { kind: 'append', id, text: block.text } : {
        kind: 'create', id, meta: { title: `工具反馈 ${localDate().slice(0, 7)}`, summary: '工具与规则反馈，按条目跟踪处理状态', type: 'meta' }, body: block.text,
      }, input.ctx)
      const commitSha = await this.afterMutation({ changedPaths: result.changedPaths, pages: [result.page], action: 'feedback',
        page: id, reason: input.ctx.reason, agent: input.ctx.agent })
      return { id: block.id, page: result.page, commitSha }
    }))
  }

  /** Resolves exactly one feedback ID under a cross-process feedback lock. */
  async feedbackResolve(id: string, resolution: string, ctx: WriteContext) {
    return this.observed(ctx.agent, undefined, () => withLock(this.config.dir, ':feedback', async () => {
      const entries = feedbackEntries(await this.store.list(), true).filter(entry => entry.id === id)
      if (!entries.length) throw new MemwikiError('NOT_FOUND', '反馈不存在')
      if (entries.length !== 1) throw new MemwikiError('AMBIGUOUS', '反馈 ID 不唯一')
      const page = await this.store.get(entries[0].page)
      const result = await this.store.write({ kind: 'replace', id: page.id, rev: page.rev, body: resolveFeedbackBody(page.body, id, resolution) }, ctx)
      const commitSha = await this.afterMutation({ changedPaths: result.changedPaths, pages: [result.page], action: 'feedback_resolve',
        page: page.id, reason: resolution, agent: ctx.agent })
      return { result, commitSha }
    }))
  }

  /** Waits for pending signals and returns bounded event/query statistics. */
  async usage(days = 7) {
    await this.usagePending
    return usageSummary(this.config.dir, days)
  }

  /** Quick capture into monthly inbox; returns the three most related pages. */
  async remember(text: string, opts: { agent: string; source?: string; project?: string }): Promise<RememberResult> {
    return this.observed(opts.agent, undefined, () => this.rememberImpl(text, opts))
  }

  private async rememberImpl(text: string, opts: { agent: string; source?: string; project?: string }): Promise<RememberResult> {
    const now = new Date()
    const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`
    const id = `inbox/${ym}`
    const stamp = `${ym}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
    const line = `- ${stamp} [${opts.agent}] ${text.replace(/[\r\n]+/g, ' ')}${opts.source ? `（来源：${opts.source}）` : ''}`
    const ctx: WriteContext = { agent: opts.agent, reason: '快速记录', source: opts.source }
    let result: WriteResult
    try {
      await this.store.get(id)
      result = await this.store.write({ kind: 'append', id, text: line + '\n' }, ctx)
    } catch (e) {
      if (!(e instanceof MemwikiError && e.code === 'NOT_FOUND')) throw e
      result = await this.store.write({
        kind: 'create',
        id,
        meta: { title: `收件箱 ${ym}`, summary: `${ym} 快速记录`, type: 'inbox' },
        body: line + '\n',
      }, ctx)
    }
    const commitSha = await this.afterMutation({
      changedPaths: result.changedPaths,
      pages: [result.page],
      action: '记录',
      page: result.page.id,
      reason: ctx.reason,
      agent: opts.agent,
    })
    const related = this.engine.search({ query: text, project: opts.project, limit: 3 })
    return { page: result.page, related, commitSha }
  }

  async move(ref: string, toId: string, ctx: WriteContext): Promise<MutationResult<MoveResult>> {
    const result = await this.observed(ctx.agent, toId, () => this.store.move(ref, toId, ctx))
    const pages = [result.page]
    for (const id of result.rewritten) {
      if (id.toLowerCase() === result.page.id.toLowerCase()) continue
      try { pages.push(await this.store.get(id)) } catch { /* deleted mid-flight */ }
    }
    const fromId = result.changedPaths.find(p => p.endsWith('.md') && !p.startsWith('.trash/'))
    const oldId = fromId ? fromId.replace(/\.md$/i, '') : ref
    if (oldId.toLowerCase() !== result.page.id.toLowerCase()) this.removeRecord(oldId)
    const commitSha = await this.afterMutation({
      changedPaths: result.changedPaths,
      pages,
      removedIds: oldId.toLowerCase() !== result.page.id.toLowerCase() ? [oldId] : [],
      action: '移动',
      page: result.page.id,
      reason: ctx.reason,
      agent: ctx.agent,
    })
    return { result, commitSha }
  }

  async delete(ref: string, ctx: WriteContext): Promise<MutationResult<DeleteResult>> {
    const result = await this.store.delete(ref, ctx)
    const commitSha = await this.afterMutation({
      changedPaths: result.changedPaths,
      removedIds: [result.id],
      action: '删除',
      page: result.id,
      reason: ctx.reason,
      agent: ctx.agent,
    })
    return { result, commitSha }
  }

  async restore(trashPath: string, ctx: WriteContext): Promise<MutationResult<WriteResult>> {
    const result = await this.observed(ctx.agent, undefined, () => this.store.restore(trashPath, ctx))
    const commitSha = await this.afterMutation({
      changedPaths: result.changedPaths,
      pages: [result.page],
      action: '恢复',
      page: result.page.id,
      reason: ctx.reason,
      agent: ctx.agent,
    })
    return { result, commitSha }
  }

  /** Runs lint; with `fix: true` applies auto-fixes and commits once. */
  async lint(opts: { fix?: boolean; agent?: string } = {}): Promise<LintResult> {
    const agent = opts.agent ?? this.config.agent
    const issues = lintRecords(this.recordList(), {
      staleDays: this.config.staleDays,
      overlapThreshold: this.config.overlapThreshold,
      now: new Date(),
      inboxEntries: this.inboxEntries(),
      scanSecrets: this.config.secretScan ? scanSecrets : undefined,
    })
    if (this.config.git.autoCommit) {
      try {
        const dirty = await listUncommitted(this.config.dir)
        if (dirty.length) {
          issues.push({
            code: 'uncommitted',
            message: `有 ${dirty.length} 个未提交文件：${dirty.slice(0, 5).join('、')}${dirty.length > 5 ? '…' : ''}`,
            fixable: true,
          })
        }
      } catch { /* not a git repo */ }
    }
    if (!opts.fix) return { issues, fixed: 0 }

    let fixed = 0
    const changedPaths = new Set<string>()
    const pages: Page[] = []
    for (const issue of issues) {
      if (!issue.fixable || !issue.page) continue
      const record = this.records.get(this.key(issue.page))
      if (!record) continue
      const patch = fixFor(issue, record)
      if (!patch && issue.code !== 'markdown_link') continue
      try {
        const page = await this.store.get(issue.page)
        const op: WriteOp = issue.code === 'markdown_link'
          ? { kind: 'replace', id: page.id, rev: page.rev, body: convertMarkdownLinks(page.body, page.id) }
          : { kind: 'meta', id: page.id, rev: page.rev, meta: patch! }
        const written = await this.observed(agent, page.id, () => this.store.write(op, { agent, reason: 'lint 自动修复' }))
        pages.push(written.page)
        for (const p of written.changedPaths) changedPaths.add(p)
        fixed++
      } catch { /* skip pages that conflicted */ }
    }

    let commitSha: string | undefined
    if (fixed || issues.some(i => i.code === 'uncommitted')) {
      for (const page of pages) this.upsertRecord(page)
      const indexChanged = await this.rewriteIndexMd()
      const entry: LogEntry = {
        at: nowIso(),
        agent,
        action: 'lint',
        reason: opts.fix ? `自动修复 ${fixed} 项` : '体检',
      }
      const logRel = logPath(entry.at)
      this.watcher?.noteWrite(logRel)
      await appendLog(this.config.dir, entry)
      if (indexChanged) changedPaths.add('index.md')
      changedPaths.add(logRel)
      try {
        const dirty = await listUncommitted(this.config.dir)
        for (const p of dirty) changedPaths.add(p)
      } catch { /* ignore */ }
      this.noteOwnWrite([...changedPaths], pages)
      commitSha = await this.tryCommit([...changedPaths], { agent, message: `[${agent}] lint` })
      if (commitSha) this.schedulePush()
    }
    const refreshed = lintRecords(this.recordList(), {
      staleDays: this.config.staleDays,
      overlapThreshold: this.config.overlapThreshold,
      now: new Date(),
      inboxEntries: this.inboxEntries(),
      scanSecrets: this.config.secretScan ? scanSecrets : undefined,
    })
    return { issues: refreshed, fixed, commitSha }
  }

  /** Recent log entries, newest first. */
  async log(limit = 20): Promise<LogEntry[]> {
    return readLog(this.config.dir, limit)
  }

  /** Manual multi-machine sync: pull --rebase then push (§4.4). */
  async sync(): Promise<SyncResult> {
    const pull = await pullRebase(this.config.dir)
    if (!pull.ok) return { pulled: false, pushed: false, conflicts: pull.conflicts }
    await this.refreshFromDisk()
    let pushed = false
    if (await hasRemote(this.config.dir)) {
      try {
        await push(this.config.dir)
        pushed = true
      } catch (e) {
        console.warn('[memwiki] sync push 失败：', e instanceof Error ? e.message : e)
      }
    }
    return { pulled: true, pushed }
  }

  /** Rebuilds the in-memory search index from disk. */
  async reindex(): Promise<void> {
    await this.rebuildIndex()
  }

  /** Stops the watcher and cancels pending push. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await this.usagePending
    if (this.pushTimer) clearTimeout(this.pushTimer)
    this.watcher?.close()
  }
}
