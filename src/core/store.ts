import { mkdir, readdir, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { MemwikiError } from '../types.ts'
import type { MemwikiConfig, Page, PageMeta, WriteOp, WriteContext, WriteResult, MoveResult, DeleteResult, MergeOp, MergeResult } from '../types.ts'
import { normalizeId, idToRelPath, relPathToId, isSpecialId, safeResolve } from './ids.ts'
import { applyMetaPatch, computeRev, defaultMeta, localDate, nowIso, parsePage, serializePage } from './page.ts'
import { codeRanges, createResolver, extractLinks, rewriteLinks } from './links.ts'
import { scanSecrets } from './secrets.ts'
import { withLock } from './lock.ts'
import { atomicWrite } from './fs.ts'
import { contentEligible, similarPages } from '../search/similarity.ts'

const ignored = new Set(['.trash', '.memwiki', '.obsidian', '.git', 'node_modules'])
const STRUCTURE_LOCK = ':store-structure'
const fold = (text: string) => text.toLowerCase()
const joinText = (before: string, text: string) => before + (before && !before.endsWith('\n') ? '\n' : '') + text + (text && !text.endsWith('\n') ? '\n' : '')

interface Heading { text: string; parents: string[]; level: number; start: number; content: number; end: number }
function findSection(body: string, query: string): Heading | undefined {
  const ranges = codeRanges(body)
  const headings: Heading[] = []
  const stack: Heading[] = []
  for (const m of body.matchAll(/^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*\r?$/gm)) {
    if (ranges.some(([start, end]) => m.index >= start && m.index < end)) continue
    const level = m[1].length
    while (stack.length && stack.at(-1)!.level >= level) stack.pop()
    const content = m.index + m[0].length + (body[m.index + m[0].length] === '\n' ? 1 : 0)
    const heading = { text: m[2].replace(/[ \t]+#+[ \t]*$/, '').trim(), parents: stack.map(h => h.text), level, start: m.index, content, end: body.length }
    stack.push(heading)
    headings.push(heading)
  }
  for (let i = 0; i < headings.length; i++) headings[i].end = headings.slice(i + 1).find(h => h.level <= headings[i].level)?.start ?? body.length
  const parts = query.split('/').map(s => s.trim())
  const matches = headings.filter(h => {
    if (h.text !== parts.at(-1)) return false
    if (parts.length === 1) return true
    const ancestry = [...h.parents, h.text]
    return ancestry.length >= parts.length && ancestry.slice(-parts.length).every((s, i) => s === parts[i])
  })
  if (matches.length > 1) throw new MemwikiError('AMBIGUOUS', '标题重复，请指定父标题路径')
  return matches[0]
}
function sectionWrite(body: string, heading: string, text: string, append: boolean): string {
  if (!heading.trim()) throw new MemwikiError('INVALID_META', '标题不能为空')
  if (!append) {
    const leading = /^(?:[ \t]*\r?\n)* {0,3}#{1,6}[ \t]+(.+?)[ \t]*(?:\r?\n|$)/.exec(text)
    const name = leading?.[1].replace(/[ \t]+#+[ \t]*$/, '').trim()
    if (leading && name === heading.split('/').at(-1)!.trim()) text = text.slice(leading[0].length)
  }
  const section = findSection(body, heading)
  if (!section) return joinText(body, '\n## ' + heading.split('/').at(-1)!.trim() + '\n\n' + text)
  const content = append ? joinText(body.slice(section.content, section.end), text) : joinText('', text)
  const prefix = body.slice(0, section.content)
  return prefix + (prefix.endsWith('\n') ? '' : '\n') + content + body.slice(section.end)
}

/** Vault-local page storage. Writes return touched paths; catalog, log and git are handled by the facade. */
export class Store {
  private config: MemwikiConfig
  private cache = new Map<string, Page>()
  constructor(config: MemwikiConfig) { this.config = { ...config, dir: path.resolve(config.dir) } }

  private ensurePageId(id: string): string {
    normalizeId(id)
    if (id.split('/').some(part => ignored.has(fold(part)))) throw new MemwikiError('INVALID_ID', '不能写入内部目录')
    if (id.split('/').at(-1)!.startsWith('_')) throw new MemwikiError('INVALID_ID', '`_` 开头保留给特殊页面')
    if (isSpecialId(id)) throw new MemwikiError('INVALID_ID', '特殊文件不能作为普通页面写入')
    safeResolve(this.config.dir, idToRelPath(id))
    return id
  }

  private async existingId(id: string): Promise<string | undefined> {
    const rel = idToRelPath(id)
    safeResolve(this.config.dir, rel)
    let actual = ''
    for (const part of rel.split('/')) {
      let names: string[]
      try { names = await readdir(safeResolve(this.config.dir, actual || '.')) }
      catch (e) { if (['ENOENT', 'ENOTDIR'].includes((e as NodeJS.ErrnoException).code ?? '')) return undefined; throw e }
      const candidates = names.filter(name => fold(name) === fold(part))
      if (candidates.length > 1) throw new MemwikiError('AMBIGUOUS', '大小写重复的页面路径', { candidates })
      if (!candidates.length) return undefined
      actual += (actual ? '/' : '') + candidates[0]
      safeResolve(this.config.dir, actual)
    }
    return relPathToId(actual)
  }

  private async newId(id: string): Promise<string> {
    // Reuse the spelling of existing parent directories even on case-sensitive systems.
    const parts = id.split('/')
    let parent = ''
    for (const segment of parts.slice(0, -1)) {
      let names: string[]
      try { names = await readdir(safeResolve(this.config.dir, parent || '.')) }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; names = [] }
      const candidates = names.filter(name => fold(name) === fold(segment))
      if (candidates.length > 1) throw new MemwikiError('AMBIGUOUS', '大小写重复的目录路径', { candidates })
      parent += (parent ? '/' : '') + (candidates[0] ?? segment)
      safeResolve(this.config.dir, parent)
    }
    return (parent ? parent + '/' : '') + parts.at(-1)!
  }

  private async load(id: string, fresh = false): Promise<Page> {
    const rel = idToRelPath(id)
    const filePath = safeResolve(this.config.dir, rel)
    let info
    try { info = await stat(filePath) }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MemwikiError('NOT_FOUND', '页面不存在', { id }); throw e }
    if (!info.isFile()) throw new MemwikiError('NOT_FOUND', '页面不存在', { id })
    const cached = this.cache.get(id)
    if (!fresh && cached && cached.mtimeMs === info.mtimeMs && cached.bytes === info.size) return structuredClone(cached)
    const raw = await readFile(safeResolve(this.config.dir, rel))
    const parsed = parsePage(raw.toString('utf8'))
    const page: Page = { id, path: filePath, ...parsed, rev: computeRev(raw), mtimeMs: info.mtimeMs, bytes: info.size }
    this.cache.set(id, page)
    return structuredClone(page)
  }

  /** Lists Markdown pages recursively, excluding generated files, internal directories and symlinks. */
  async list(): Promise<Page[]> {
    const ids: string[] = []
    const walk = async (rel: string): Promise<void> => {
      for (const entry of await readdir(safeResolve(this.config.dir, rel || '.'), { withFileTypes: true })) {
        const child = (rel ? rel + '/' : '') + entry.name
        if (entry.isDirectory() && !ignored.has(fold(entry.name))) await walk(child)
        else if (entry.isFile() && /\.md$/i.test(entry.name)) {
          const id = relPathToId(child)
          if (!isSpecialId(id)) ids.push(id)
        }
      }
    }
    await walk('')
    const pages: Page[] = []
    for (const id of ids.sort()) {
      try { pages.push(await this.load(id)) }
      catch (e) { if (!(e instanceof MemwikiError && e.code === 'NOT_FOUND')) throw e }
    }
    const present = new Set(ids)
    for (const id of this.cache.keys()) if (!present.has(id)) this.cache.delete(id)
    return pages
  }

  /** Reads an ID case-insensitively; throws NOT_FOUND for missing pages. */
  async get(id: string): Promise<Page> {
    const actual = await this.existingId(normalizeId(id))
    if (!actual) throw new MemwikiError('NOT_FOUND', '页面不存在', { id })
    return this.load(actual)
  }

  /** Resolves ID, title, alias, then filename; throws NOT_FOUND or AMBIGUOUS with candidate IDs. */
  async resolve(ref: string): Promise<Page> {
    const pages = await this.list()
    const resolved = createResolver(pages.map(p => ({ id: p.id, title: p.meta.title, aliases: p.meta.aliases })))(ref)
    if (!resolved) throw new MemwikiError('NOT_FOUND', '页面不存在', { ref })
    if ('ambiguous' in resolved) throw new MemwikiError('AMBIGUOUS', '页面引用不唯一', { candidates: resolved.ambiguous })
    return this.get(resolved.id)
  }

  /** Reads a special Markdown page such as _guide, index or log. */
  async readSpecial(name: string): Promise<Page> {
    const id = normalizeId(name.replace(/\.md$/i, ''))
    if (!isSpecialId(id)) throw new MemwikiError('INVALID_ID', '不是特殊文件')
    return this.get(id)
  }

  private updated(meta: PageMeta, id: string, ctx: WriteContext): PageMeta {
    const next = { ...meta, updated: nowIso(), updated_by: ctx.agent }
    if (ctx.source) {
      if (next.sources !== undefined && (!Array.isArray(next.sources) || !next.sources.every(s => typeof s === 'string'))) throw new MemwikiError('INVALID_META', 'sources 必须是字符串数组', { errors: [{ field: 'sources', reason: '必须是字符串数组' }] })
      next.sources = [...new Set([...(next.sources ?? []), ctx.source])]
    }
    if (id.startsWith('projects/') && id.split('/').length > 2 && !next.project) next.project = id.split('/')[1]
    return next
  }

  private prepare(meta: PageMeta, body: string): string {
    const raw = serializePage(meta, body)
    if (this.config.secretScan) {
      const findings = scanSecrets(raw)
      if (findings.length) throw new MemwikiError('SECRET_DETECTED', '内容包含敏感信息，拒绝写入', { findings })
    }
    const parsed = parsePage(raw)
    if (parsed.metaError) throw new MemwikiError('INVALID_META', parsed.metaError, { errors: parsed.metaIssues ?? [{ field: 'meta', reason: parsed.metaError }] })
    return raw
  }

  private async locks<T>(ids: string[], fn: () => Promise<T>): Promise<T> {
    const sorted = [...new Set(ids.map(fold))].sort()
    const next = (i: number): Promise<T> => i === sorted.length ? fn() : withLock(this.config.dir, sorted[i], () => next(i + 1))
    return next(0)
  }

  /** Applies a write under a page lock and atomic rename; rev conflicts include the current rev. */
  async write(op: WriteOp, ctx: WriteContext): Promise<WriteResult> {
    const requested = this.ensurePageId(op.id)
    if (op.kind === 'append' && op.meta !== undefined && op.rev === undefined) {
      throw new MemwikiError('INVALID_META', 'append 修改页头需要 rev', { errors: [{ field: 'rev', reason: 'append 修改页头时必填' }] })
    }
    const run = () => withLock(this.config.dir, requested, async () => {
      const actual = await this.existingId(requested)
      if (op.kind === 'create' && actual) throw new MemwikiError('EXISTS', '页面已经存在', { id: actual })
      if (op.kind === 'create' && op.force && (typeof ctx.reason !== 'string' || !ctx.reason.trim())) throw new MemwikiError('INVALID_META', 'force 新建必须写明 reason')
      if (op.kind !== 'create' && !actual) throw new MemwikiError('NOT_FOUND', '页面不存在', { id: requested })
      const id = actual ?? await this.newId(requested)
      const page = op.kind === 'create' ? undefined : await this.load(id, true)
      if (page && (op.kind !== 'append' || op.rev !== undefined) && op.kind !== 'create' && op.rev !== page.rev) {
        throw new MemwikiError('CONFLICT', '页面已更新，请重新读取', { rev: page.rev })
      }
      let meta: PageMeta
      let body: string
      if (op.kind === 'create') { meta = defaultMeta(id, op.meta); meta.created = localDate(); body = op.body }
      else {
        meta = applyMetaPatch(page!.meta, op.meta ?? {})
        body = page!.body
        switch (op.kind) {
          case 'replace': body = op.body; break
          case 'append': body = op.section ? sectionWrite(body, op.section, op.text, true) : joinText(body, op.text); break
          case 'edit': {
            if (!op.old) throw new MemwikiError('AMBIGUOUS_EDIT', 'old 不能为空')
            const first = body.indexOf(op.old)
            if (first < 0) throw new MemwikiError('EDIT_NOT_FOUND', '待替换内容不存在')
            if (body.indexOf(op.old, first + 1) >= 0) throw new MemwikiError('AMBIGUOUS_EDIT', '待替换内容不唯一')
            body = body.slice(0, first) + op.new + body.slice(first + op.old.length)
            break
          }
          case 'section': body = sectionWrite(body, op.heading, op.body, false); break
          case 'meta': break
        }
        // Creation date belongs to the original page, not to callers' patches.
        meta.created = page!.meta.created
      }
      meta = this.updated(meta, id, ctx)
      const rel = idToRelPath(id)
      const raw = this.prepare(meta, body)
      if (op.kind === 'create' && !op.force && contentEligible({ id, meta, body })) {
        const candidates = similarPages({ meta, body }, await this.list(), this.config.similarCreateThreshold)
        if (candidates.length) throw new MemwikiError('SIMILAR_EXISTS', '请更新已有页面；确实是不同主题时带 force 并写明理由', { candidates })
      }
      await atomicWrite(this.config.dir, rel, raw)
      return { page: await this.load(id, true), created: op.kind === 'create', changedPaths: [rel] }
    })
    return op.kind === 'create' ? withLock(this.config.dir, STRUCTURE_LOCK, run) : run()
  }

  /** Validates every input and prepares every output before the first write. Sources stay as redirects. */
  async merge(op: MergeOp): Promise<MergeResult> {
    return withLock(this.config.dir, STRUCTURE_LOCK, async () => {
      if (!op.from.length) throw new MemwikiError('INVALID_META', 'from 不能为空')
      const destination = await this.resolve(op.into)
      const sources = await Promise.all(op.from.map(ref => this.resolve(ref)))
      const sourceIds = new Set(sources.map(p => fold(p.id)))
      if (sourceIds.has(fold(destination.id))) throw new MemwikiError('INVALID_META', 'from 不能包含 into')
      if (sourceIds.size !== sources.length) throw new MemwikiError('INVALID_META', 'from 不能包含重复页面')
      const snapshot = await this.list()
      return this.locks(snapshot.map(p => p.id), async () => {
        const current = await this.load(destination.id, true)
        if (current.rev !== op.rev) throw new MemwikiError('CONFLICT', '目标页面已更新，请重新读取', { rev: current.rev })
        const freshSources = await Promise.all(sources.map(p => this.load(p.id, true)))
        for (const page of [current, ...freshSources]) this.ensurePageId(page.id)
        if (current.meta.status === 'superseded') throw new MemwikiError('INVALID_META', '不能合并到 superseded 页面')
        const targets = new Set(freshSources.flatMap(p => [p.id, p.meta.title, ...p.meta.aliases]).map(fold))
        const rewrite = (body: string) => rewriteLinks(body, target => targets.has(fold(target)) ? current.id : undefined)
        const nextMeta = applyMetaPatch(current.meta, op.meta ?? {})
        if (nextMeta.aliases !== undefined && (!Array.isArray(nextMeta.aliases) || !nextMeta.aliases.every(alias => typeof alias === 'string'))) {
          throw new MemwikiError('INVALID_META', 'aliases 必须是字符串数组')
        }
        const aliases = [...(nextMeta.aliases ?? []), ...freshSources.flatMap(p => [p.meta.title, ...p.meta.aliases])]
        nextMeta.aliases = [...new Map(aliases.map(alias => [fold(alias), alias])).values()]
        nextMeta.created = current.meta.created
        if (nextMeta.status === 'superseded') throw new MemwikiError('INVALID_META', '合并目标必须保留为有效页面')
        // Superseded stubs relinquish title/alias ownership; exact old IDs still land on a redirect.
        const pending: Array<{ id: string; raw: string }> = []
        const rewritten: string[] = []
        for (const old of snapshot) {
          const page = await this.load(old.id, true)
          let body = rewrite(page.body)
          let meta = page.meta
          if (fold(page.id) === fold(current.id)) { body = rewrite(op.body ?? current.body); meta = nextMeta }
          else if (sourceIds.has(fold(page.id))) {
            meta = { ...page.meta, title: `已合并：${page.id}`, summary: `已合并到 ${current.id}`, aliases: [], status: 'superseded', superseded_by: current.id }
            body = `已合并到 [[${current.id}]]\n`
          } else if (body === page.body) continue
          if (body !== page.body) rewritten.push(page.id)
          pending.push({ id: page.id, raw: this.prepare(this.updated(meta, page.id, op.ctx), body) })
        }
        for (const change of pending) await atomicWrite(this.config.dir, idToRelPath(change.id), change.raw)
        const pages = await Promise.all(pending.map(p => this.load(p.id, true)))
        return { page: pages.find(p => fold(p.id) === fold(current.id))!, from: freshSources.map(p => p.id), pages,
          rewritten, changedPaths: pending.map(p => idToRelPath(p.id)) }
      })
    })
  }

  /** Verification deliberately changes only verified/status; provenance and body stay intact. */
  async verify(ref: string): Promise<WriteResult> {
    const source = await this.resolve(ref)
    this.ensurePageId(source.id)
    return withLock(this.config.dir, source.id, async () => {
      const page = await this.load(source.id, true)
      const meta = { ...page.meta, verified: localDate() }
      if (meta.status === 'stale') meta.status = 'active'
      const rel = idToRelPath(page.id)
      await atomicWrite(this.config.dir, rel, this.prepare(meta, page.body))
      return { page: await this.load(page.id, true), created: false, changedPaths: [rel] }
    })
  }

  /** Moves a page and rewrites references to its ID/title/aliases, preserving link suffixes. */
  async move(ref: string, toId: string, ctx: WriteContext): Promise<MoveResult> {
    return withLock(this.config.dir, STRUCTURE_LOCK, async () => {
      const source = await this.resolve(ref)
      this.ensurePageId(source.id)
      this.ensurePageId(toId)
      toId = await this.newId(toId)
      const snapshot = await this.list()
      return this.locks([...snapshot.map(p => p.id), source.id, toId], async () => {
        const current = await this.load(source.id, true)
        const destination = await this.existingId(toId)
        if (destination && fold(destination) !== fold(source.id)) throw new MemwikiError('EXISTS', '目标页面已经存在')
        const targets = new Set([current.id, current.meta.title, ...current.meta.aliases].map(fold))
        const rewrite = (body: string) => rewriteLinks(body, target => targets.has(fold(target)) ? toId : undefined)
        const changedPaths = new Set<string>([idToRelPath(current.id), idToRelPath(toId)])
        const rewritten: string[] = []
        const pending: Array<{ id: string; raw: string }> = []
        for (const old of snapshot) {
          if (fold(old.id) === fold(current.id)) continue
          let page: Page
          try { page = await this.load(old.id, true) } catch (e) { if (e instanceof MemwikiError && e.code === 'NOT_FOUND') continue; throw e }
          const body = rewrite(page.body)
          if (body !== page.body) {
            pending.push({ id: page.id, raw: this.prepare(this.updated(page.meta, page.id, ctx), body) })
            rewritten.push(page.id)
            changedPaths.add(idToRelPath(page.id))
          }
        }
        const movedBody = rewrite(current.body)
        if (movedBody !== current.body) rewritten.push(toId)
        const movedRaw = this.prepare(this.updated(current.meta, toId, ctx), movedBody)
        // Rename first also supports spelling-only moves on case-insensitive filesystems.
        const srcPath = safeResolve(this.config.dir, idToRelPath(current.id))
        const dstPath = safeResolve(this.config.dir, idToRelPath(toId))
        await mkdir(path.dirname(dstPath), { recursive: true })
        safeResolve(this.config.dir, idToRelPath(toId))
        if (current.id !== toId) await rename(srcPath, dstPath)
        await atomicWrite(this.config.dir, idToRelPath(toId), movedRaw)
        this.cache.delete(current.id)
        for (const change of pending) await atomicWrite(this.config.dir, idToRelPath(change.id), change.raw)
        return { page: await this.load(toId, true), rewritten, changedPaths: [...changedPaths] }
      })
    })
  }

  /** Moves a page into .trash and returns IDs of remaining pages linking to it. */
  async delete(ref: string, _ctx: WriteContext): Promise<DeleteResult> {
    return withLock(this.config.dir, STRUCTURE_LOCK, async () => {
      const source = await this.resolve(ref)
      this.ensurePageId(source.id)
      return withLock(this.config.dir, source.id, async () => {
        const page = await this.load(source.id, true)
        const pages = await this.list()
        const resolver = createResolver(pages.map(p => ({ id: p.id, title: p.meta.title, aliases: p.meta.aliases })))
        const danglingFrom = pages.filter(p => p.id !== page.id && extractLinks(p.body).some(l => {
          const match = resolver(l.target)
          return match && 'id' in match && match.id === page.id
        })).map(p => p.id)
        let stamp = Date.now()
        let trashPath: string
        while (true) {
          trashPath = '.trash/' + page.id + '.' + stamp + '.md'
          try { await stat(safeResolve(this.config.dir, trashPath)); stamp++ }
          catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') break; throw e }
        }
        const target = safeResolve(this.config.dir, trashPath)
        await mkdir(path.dirname(target), { recursive: true })
        safeResolve(this.config.dir, trashPath)
        await rename(safeResolve(this.config.dir, idToRelPath(page.id)), target)
        this.cache.delete(page.id)
        return { id: page.id, trashPath, danglingFrom, changedPaths: [idToRelPath(page.id), trashPath] }
      })
    })
  }

  /** Restores a timestamped trash path to its original ID; rejects occupied IDs (EXISTS). */
  async restore(trashPath: string, ctx: WriteContext): Promise<WriteResult> {
    const rel = trashPath.replaceAll('\\', '/')
    safeResolve(this.config.dir, rel)
    const match = /^\.trash\/(.+)\.(\d+)(?:-[a-f0-9-]+)?\.md$/i.exec(rel)
    if (!match) throw new MemwikiError('INVALID_ID', '无效的回收站路径')
    return withLock(this.config.dir, STRUCTURE_LOCK, async () => {
      const id = await this.newId(this.ensurePageId(match[1]))
      return this.locks([id, rel], async () => {
        if (await this.existingId(id)) throw new MemwikiError('EXISTS', '原页面 ID 已被占用')
        let raw: string
        try { raw = await readFile(safeResolve(this.config.dir, rel), 'utf8') }
        catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new MemwikiError('NOT_FOUND', '回收站页面不存在'); throw e }
        const parsed = parsePage(raw)
        const meta = this.updated(parsed.meta, id, ctx)
        await atomicWrite(this.config.dir, idToRelPath(id), this.prepare(meta, parsed.body))
        await unlink(safeResolve(this.config.dir, rel))
        return { page: await this.load(id, true), created: true, changedPaths: [idToRelPath(id), rel] }
      })
    })
  }
}
