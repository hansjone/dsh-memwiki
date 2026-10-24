import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { randomUUID, type KeyObject } from 'node:crypto'
import { Readable } from 'node:stream'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Memwiki } from '../memwiki.ts'
import { Store } from '../core/store.ts'
import { actorSource, remoteActor } from '../core/actor.ts'
import { withLock } from '../core/lock.ts'
import { createResolver } from '../core/links.ts'
import { buildContext } from '../search/catalog.ts'
import { createSearchEngine } from '../search/engine.ts'
import { MemwikiError, type PageRecord } from '../types.ts'
import { createMemwikiServer } from './server.ts'
import { hubPublicKey, requestIdentity, type TeamIdentity } from './identity.ts'

const reply = (text: string, isError = false): CallToolResult => ({ content: [{ type: 'text', text }], isError })
const queues = new WeakMap<Memwiki, Promise<unknown>>()
function serial<T>(wiki: Memwiki, fn: () => Promise<T>): Promise<T> {
  const next = (queues.get(wiki) ?? Promise.resolve()).then(fn, fn)
  queues.set(wiki, next.catch(() => {}))
  return next
}

function physical(file: string): string {
  if (existsSync(file)) return realpathSync(file)
  const parent = path.dirname(file)
  return parent === file ? file : path.join(physical(parent), path.basename(file))
}

/** Both lexical and physical paths must be outside the vault, including symlink aliases. */
export function auditPath(vault: string, file?: string): string {
  const target = path.resolve(file ?? `${path.resolve(vault)}.audit.jsonl`)
  for (const [root, log] of [[path.resolve(vault), target], [physical(path.resolve(vault)), physical(target)]]) {
    const rel = path.relative(root, log)
    if (!rel || (!path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep))) {
      throw new Error('审计文件必须放在库目录之外')
    }
  }
  return target
}

/** A per-request view. Resolve and rank only readable pages, before formatting any output. */
function readableWiki(wiki: Memwiki, identity: TeamIdentity) {
  let records: PageRecord[] = []
  let versions = new Map<string, string>()
  let hidden: string[] = []
  let hiddenRefs = new Set<string>()
  let resolve = createResolver([])
  const engine = createSearchEngine()
  const allowed = (meta: { visibility?: string }) => identity.kind !== 'external' || meta.visibility === 'all'
  const redact = (text: string) => hidden.reduce((s, term) => s.split(term).join('[无权读取]'),
    text.replace(/\[\[([^\]]+)\]\]/g, (link, inner: string) => hiddenRefs.has(inner.split(/[|#]/)[0].trim().toLowerCase()) ? '[无权读取]' : link))
  const view = new Proxy(wiki, {
    get(target, key) {
      if (key === 'config') return { ...target.config, agent: identity.sub }
      if (key === 'search') return engine.search.bind(engine)
      if (key === 'context') return (project?: string) => {
        const context = buildContext(records, {
          project, budgetBytes: wiki.config.contextBudget, vaultDir: '团队知识库',
          inboxCount: records.filter(r => r.meta.type === 'inbox').reduce((n, r) => n + (r.id.startsWith('inbox/proposals/') ? 1 : r.body.match(/^- \d{4}-\d{2}-\d{2}/gm)?.length ?? 0), 0),
        })
        return identity.kind === 'external' ? context.replace('，规范见 [[_guide]]', '') : context
      }
      if (key === 'read') return async (ref: string) => {
        if (identity.kind !== 'external') return wiki.read(ref)
        const id = ref.toLowerCase().replace(/\.md$/i, '')
        if (id === 'index' || /^log(?:\/|$)/.test(id)) throw new MemwikiError('NOT_FOUND', '页面不存在或无权读取')
        const match = resolve(ref)
        if (match && 'ambiguous' in match) throw new MemwikiError('AMBIGUOUS', '可读页面引用不唯一')
        const result = await wiki.read(match && 'id' in match ? match.id : ref)
        if (!allowed(result.page.meta)) throw new MemwikiError('NOT_FOUND', '页面不存在或无权读取')
        const ids = new Set(records.map(r => r.id.toLowerCase()))
        return { ...result, backlinks: result.backlinks.filter(id => ids.has(id.toLowerCase())), brokenLinks: [] }
      }
      const value = Reflect.get(target, key)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return {
    wiki: view,
    redact,
    versions: () => versions,
    async refresh() {
      const pages = await new Store(wiki.config).list()
      versions = new Map(pages.map(p => [p.id, p.rev]))
      const readable = pages.filter(p => allowed(p.meta))
      resolve = createResolver(readable.map(p => ({ id: p.id, title: p.meta.title, aliases: p.meta.aliases })))
      hidden = identity.kind === 'external' ? [...new Set(pages.filter(p => !allowed(p.meta))
        .flatMap(p => [p.id, p.meta.title, p.meta.summary, ...p.meta.aliases]).filter(Boolean))].sort((a, b) => b.length - a.length) : []
      hiddenRefs = new Set(pages.filter(p => !allowed(p.meta)).flatMap(p => [p.id, p.meta.title, ...p.meta.aliases]).map(s => s.toLowerCase()))
      records = readable.map(p => ({ ...p, links: [], brokenLinks: [] }))
      engine.load(records.map(r => ({ ...r, body: redact(r.body), meta: { ...r.meta, summary: redact(r.meta.summary) } })))
    },
  }
}

function mutation(name: string, args: Record<string, unknown>): boolean {
  return !['memwiki_context', 'memwiki_search', 'memwiki_read', 'memwiki_log', 'memwiki_usage'].includes(name)
    && !(name === 'memwiki_lint' && !args.fix) && !(name === 'memwiki_feedback' && args.action === 'list')
}

export interface RemoteOptions {
  publicKey: KeyObject
  auditFile?: string
}

/** Returns a handler without listening. Tests and embedders control the HTTP lifecycle. */
export function createRemoteHandler(wiki: Memwiki, options: RemoteOptions) {
  if (options.publicKey.type !== 'public' || options.publicKey.asymmetricKeyType !== 'ed25519') throw new Error('Hub 公钥必须是 Ed25519')
  const logFile = auditPath(wiki.config.dir, options.auditFile)
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    let identity: TeamIdentity
    try { identity = requestIdentity(req, options.publicKey) }
    catch { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end('{"error":"unauthorized"}'); return }
    if (req.url !== '/mcp') { res.writeHead(404); res.end(); return }
    // Stateless transport has no resumable GET stream or session DELETE endpoint.
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); res.end(); return }
    const scoped = readableWiki(wiki, identity)
    const maintainer = identity.roles.some(r => ['kb-maintainer', 'admin', 'super_admin'].includes(r))
    const server = createMemwikiServer(scoped.wiki, undefined, {
      remote: true,
      runTool: (name, args, run) => serial(wiki, () => remoteActor.run(identity, async () => {
        try {
          const writing = mutation(name, args)
          if (identity.kind === 'external' && !writing && ['memwiki_log', 'memwiki_usage', 'memwiki_lint', 'memwiki_feedback'].includes(name)) {
            return reply('FORBIDDEN：此工具需要读取公司内部诊断信息', true)
          }
          const perform = async () => {
            await scoped.refresh()
            const before = scoped.versions()
            await wiki.reindex()
            const target = typeof args.page === 'string' ? args.page : typeof args.into === 'string' ? args.into : name
            const audit = async (outcome: string, proposal?: string, targets?: string[]) => {
              await mkdir(path.dirname(logFile), { recursive: true })
              auditPath(wiki.config.dir, logFile)
              await appendFile(logFile, JSON.stringify({ at: new Date().toISOString(), event: maintainer ? 'kb.write' : 'kb.propose',
                actor_uid: identity.sub, name: identity.name, target: targets?.[0] ?? target, targets, tool: name, proposal, outcome }) + '\n', { mode: 0o600 })
            }
            // Write-ahead audit: no mutation is accepted when the audit sink is unavailable.
            if (writing) await audit('attempt')
            let result: CallToolResult
            let proposal: string | undefined
            if (writing && !maintainer) {
              // Separate inbox page per proposal preserves multiline payloads, revision and visibility.
              proposal = `inbox/proposals/${new Date().toISOString().slice(0, 10)}/${randomUUID()}`
              await wiki.write({ kind: 'create', id: proposal, meta: {
                title: `待审提议 ${name}`, summary: `${[...identity.name].slice(0, 50).join('')} 提交的 ${name} 待审提议`, type: 'inbox', visibility: 'company',
              }, body: `# 待审提议\n\n作者：${identity.sub}（${identity.name}）\n工具：${name}\n\n\`\`\`json\n${JSON.stringify({ tool: name, arguments: args }, null, 2)}\n\`\`\`\n` },
              { agent: identity.sub, reason: '团队知识库提议待审', source: actorSource(identity) })
              result = reply(`已提交待审。提议：[[${proposal}]]；维护人可用现有 read/write/merge/delete 工具审核处理。`)
            } else {
              if (identity.kind === 'external' && writing) {
                // Reading privilege is independent of the maintainer role.
                for (const ref of [args.page, args.into, ...(Array.isArray(args.from) ? args.from : [])]) {
                  if (typeof ref === 'string' && !(name === 'memwiki_write' && args.mode === 'create')) await scoped.wiki.read(ref)
                }
                if (['memwiki_restore', 'memwiki_lint', 'memwiki_feedback'].includes(name)) return reply('FORBIDDEN：此操作需要访问公司内部页面', true)
              }
              result = await run()
            }
            if (writing) {
              await scoped.refresh()
              const after = scoped.versions()
              const targets = [...new Set([...before.keys(), ...after.keys()])].filter(id => before.get(id) !== after.get(id))
              await audit(result.isError ? 'error' : 'success', proposal, targets)
            }
            if (identity.kind === 'external') {
              if (result.isError) return reply('ERROR：操作失败或无权读取；请检查参数和页面版本', true)
              const redacted = result.content.map(c => c.type === 'text' ? { ...c, text: scoped.redact(c.text) } : c)
              // The submitter always learns the id of their own proposal; it is not a secret. Added after
              // redaction because the proposal page itself stays company-visible and would be masked.
              if (proposal) redacted.push({ type: 'text', text: `提议 id：${proposal}` })
              return { ...result, content: redacted }
            }
            return result
          }
          return writing ? withLock(wiki.config.dir, ':remote-mutation', perform) : perform()
        } catch (e) {
          return reply(e instanceof MemwikiError ? `${e.code}：操作失败，请检查权限、参数和页面版本` : 'ERROR：远程操作失败', true)
        }
      })),
    })
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true, maxRequestBodySize: 1024 * 1024 })
    res.on('close', () => { void server.close().catch(() => {}) })
    try {
      await server.connect(transport)
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2) headers.append(req.rawHeaders[i], req.rawHeaders[i + 1])
      const init: RequestInit & { duplex: 'half' } = { method: 'POST', headers, body: Readable.toWeb(req) as ReadableStream<Uint8Array>, duplex: 'half' }
      const response = await transport.handleRequest(new Request('http://memwiki/mcp', init))
      // SDK parser diagnostics can include rejected request fragments. Keep HTTP errors opaque.
      const body = response.status >= 400
        ? Buffer.from(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32600, message: '请求无效' } }))
        : Buffer.from(await response.arrayBuffer())
      const responseHeaders: Record<string, string> = {}
      response.headers.forEach((value, key) => { if (key !== 'content-length') responseHeaders[key] = value })
      // Explicit framing also works through proxies that treat MCP's SSE Accept header specially.
      res.writeHead(response.status, { ...responseHeaders, 'Transfer-Encoding': 'chunked' })
      res.write(body)
      res.end()
    }
    catch { if (!res.headersSent) res.writeHead(500); if (!res.writableEnded) res.end() }
  }
}

export async function serveRemote(wiki: Memwiki, options: { port: number; hubPubkey: string; auditFile?: string }) {
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('port 必须是 0–65535 的整数')
  const handler = createRemoteHandler(wiki, { publicKey: hubPublicKey(await readFile(options.hubPubkey)), auditFile: options.auditFile })
  const server = createServer((req, res) => { void handler(req, res) })
  server.requestTimeout = 30_000
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.port, '0.0.0.0', () => { server.off('error', reject); resolve() }) })
  return server
}
