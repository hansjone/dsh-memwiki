import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import type { Memwiki } from '../memwiki.ts'
import type { MetaPatch, PageType, WriteOp } from '../types.ts'
import { MemwikiError, PAGE_TYPES } from '../types.ts'
import { SecretStore } from '../secrets/store.ts'

const INSTRUCTIONS = `共享记忆 wiki 规则：
1. 任务开始调用 memwiki_context；写入前先 memwiki_search。
2. 一个事实一个归属；纠正优先于补充，只写当前正确说法。
3. 页面不写凭据值，只写 secret:<名字>；核实后调用 memwiki_verify。
4. CONFLICT 时重新 memwiki_read，在最新 rev 上再写。
5. 拿不准归属用 memwiki_remember 进 inbox；merge 直接删除源文件、迁移标题/别名并改写双链；先 lint fix 将相对 Markdown 页面链接转为双链；禁止改写 git 历史。
细则见 _guide；任务开始若没读过就 memwiki_read _guide；工具不好用时用 memwiki_feedback 记下。`

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError }
}

function formatError(err: unknown): ReturnType<typeof text> {
  if (err instanceof MemwikiError) {
    const show = (v: unknown): string => Array.isArray(v) ? v.map(show).join('|')
      : v !== null && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}:${show(x)}`).join(' ') : String(v)
    const extra = err.details ? '，' + Object.entries(err.details).map(([k, v]) => `${k}=${show(v)}`).join('，') : ''
    const hint = err.code === 'SECRET_DETECTED' ? '。如果确实需要保存，用 memwiki_secret_set 存进凭据库，页面里写 secret:<名字>' : ''
    return text(`${err.code}：${err.message}${extra}${hint}`, true)
  }
  return text(`ERROR：${err instanceof Error ? err.message : String(err)}`, true)
}

function pad(n: number) { return String(n).padStart(2, '0') }

function formatMeta(page: { meta: Record<string, unknown>; rev: string }): string[] {
  const m = page.meta
  const lines = [
    `标题：${m.title}`,
    `摘要：${m.summary}`,
    `类型：${m.type}`,
    `状态：${m.status}`,
    `标签：${Array.isArray(m.tags) ? m.tags.join(', ') : ''}`,
    `别名：${Array.isArray(m.aliases) ? m.aliases.join(', ') : ''}`,
    `创建：${m.created}`,
    `更新：${m.updated}`,
    `更新方：${m.updated_by}`,
  ]
  if (m.verified) lines.push(`核实：${m.verified}`)
  if (m.project) lines.push(`项目：${m.project}`)
  if (m.pinned) lines.push('置顶：是')
  if (Array.isArray(m.sources) && m.sources.length) lines.push(`来源：${m.sources.join(', ')}`)
  lines.push(`rev：${page.rev}`)
  return lines
}

/** Builds an MCP server bound to an open Memwiki instance (§8.1). */
export function createMemwikiServer(wiki: Memwiki, secrets = new SecretStore({ vaultDir: wiki.config.dir })): McpServer {
  const server = new McpServer(
    { name: 'memwiki', version: '0.3.0' },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  )

  const secretNotice = '仅保存本地开发、测试账号、内网设备等低风险凭据；银行、邮箱、主账号和生产环境密码不要存。'
  const secretCall = async (fn: () => Promise<unknown>) => {
    try { return text(JSON.stringify(await fn(), null, 2)) }
    catch (e) {
      // Never render arbitrary exceptions from a protector or store.
      return text(`${e instanceof MemwikiError ? e.code : 'ERROR'}：凭据操作失败`, true)
    }
  }
  server.registerTool('memwiki_secret_list', {
    description: `列出本机凭据名字、用途和时间，不返回值。${secretNotice}非 Windows 第一版为明文文件，以 0600 权限保护。`,
    inputSchema: {},
  }, () => secretCall(async () => ({ entries: await secrets.list(), protection: secrets.protector.kind, notice: secrets.protector.kind === 'plain' ? '当前平台为明文文件存储，以 0600 文件权限保护。' : 'Windows DPAPI（CurrentUser）' })))
  server.registerTool('memwiki_secret_get', {
    description: `按名字取凭据，purpose 必填并记访问日志。只用于 scope 说明的用途，不要回显给用户、不要写进任何文件或页面。${secretNotice}`,
    inputSchema: { name: z.string(), purpose: z.string().trim().min(1).describe('本次取凭据的具体用途，记入访问日志') },
  }, ({ name, purpose }) => secretCall(async () => {
    const { value, scope } = await secrets.getWithScope(name, { agent: wiki.config.agent, purpose })
    return { value, scope, reminder: '只用于 scope 说明的用途，不要回显给用户、不要写进任何文件或页面。' }
  }))
  server.registerTool('memwiki_secret_set', {
    description: `仅在用户在对话里明确要求“帮我记住这个密码”时存入本机凭据库，页面只写 secret:<名字>。不会返回值。${secretNotice}`,
    inputSchema: { name: z.string(), value: z.string().min(1), scope: z.string().trim().min(1).describe('允许使用这条凭据的用途') },
  }, ({ name, value, scope }) => secretCall(() => secrets.set(name, value, scope, { agent: wiki.config.agent })))
  server.registerTool('memwiki_secret_delete', {
    description: '删除本机凭据（不可恢复），仅按用户要求使用，不影响 wiki 引用。',
    inputSchema: { name: z.string() },
  }, ({ name }) => secretCall(async () => { await secrets.delete(name, { agent: wiki.config.agent }); return { deleted: true } }))

  server.registerTool('memwiki_context', {
    description: '返回共享记忆库的精简目录（每页一行摘要，置顶页、规则、用户偏好和当前项目的页面在前）。任务开始时先调用一次，了解已有哪些知识；会话开始已注入过目录就不用再调。',
    inputSchema: {
      project: z.string().optional().describe('当前项目名，等于项目 git 根目录的目录名（如 netx）；该项目的页面会排在前面'),
    },
  }, async ({ project }) => text(wiki.context(project) || '（目录为空）'))

  server.registerTool('memwiki_search', {
    description: '全文检索记忆页面（标题、别名、标签、摘要、正文，中英文都行），返回摘要和匹配片段。写入任何内容之前先用它找有没有相关页面；用户提到"之前""上次"时也先搜。',
    inputSchema: {
      query: z.string().describe('两三个关键词，空格分隔，如 "发布 流程 PATH"'),
      type: z.enum(PAGE_TYPES as unknown as [PageType, ...PageType[]]).optional().describe('按页面类型过滤'),
      tags: z.array(z.string()).optional().describe('必须全部包含的标签'),
      project: z.string().optional().describe('当前项目名（加权，不过滤）'),
      limit: z.number().int().positive().optional().describe('返回条数，默认 8'),
    },
  }, async (args) => {
    const hits = wiki.search({
      query: args.query,
      type: args.type,
      tags: args.tags,
      project: args.project,
      limit: args.limit ?? 8,
    })
    if (!hits.length) return text('没有命中。')
    const lines = hits.map((h, i) => [
      `${i + 1}. [[${h.id}|${h.title}]]（${h.type}/${h.status}，分 ${h.score.toFixed(2)}）`,
      `   ${h.summary}`,
      ...h.snippets.map(s => `   > ${s.replace(/\n/g, '\n   > ')}`),
    ].join('\n'))
    return text(lines.join('\n\n'))
  })

  server.registerTool('memwiki_read', {
    description: '读取一页的全文、页头、rev（修改时要带上）、记录于多少天前、反向链接和断链。涉及代码、配置、路径的旧内容，先核实再用。写作规范可读 _guide。',
    inputSchema: {
      page: z.string().describe('页面 ID、标题或别名'),
    },
  }, async ({ page: ref }) => {
    try {
      const { page, backlinks, brokenLinks, recordedDaysAgo } = await wiki.read(ref)
      const date = page.meta.updated.slice(0, 10)
      const lines = [
        ...formatMeta(page),
        `记录于 ${recordedDaysAgo} 天前（${date}）`,
        '',
        '## 正文',
        page.body.trimEnd() || '（空）',
        '',
        '## 反向链接',
        backlinks.length ? backlinks.map(id => `- [[${id}]]`).join('\n') : '（无）',
        '',
        '## 断链',
        brokenLinks.length ? brokenLinks.map(t => `- [[${t}]]`).join('\n') : '（无）',
      ]
      return text(lines.join('\n'))
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_write', {
    description: [
      '新建或修改记忆页面。先 memwiki_search，有相关页面就更新它，没有才新建。除 create/append 外都要带 memwiki_read 拿到的 rev；返回 CONFLICT 时重新读取再改。',
      '模式：create 新建（要 title、一句话 summary、body）；append 追加一段（可用 heading 指定追加到哪一节）；',
      'section 替换某一节的内容（heading，可写 父标题/子标题）；edit 精确替换一句（old 必须在页面里恰好出现一次）；',
      'replace 整页重写；meta 只改页头字段（如 status、tags、verified）。不要写密钥、密码、token，写"去哪里拿"。',
      '任何模式都可以顺手改 title/summary（append 改页头时必须带 rev）；顶层 title/summary 优先于 meta 中的同名字段。',
    ].join(''),
    inputSchema: {
      page: z.string().describe('页面 ID，如 projects/netx/发布流程、topics/PowerShell 中文乱码；非 create 时也可以是标题或别名'),
      mode: z.enum(['create', 'replace', 'append', 'edit', 'section', 'meta']).describe('写入模式，见工具说明'),
      rev: z.string().optional().describe('memwiki_read 返回的 rev；replace/edit/section/meta 必填'),
      body: z.string().optional().describe('Markdown 正文：create/replace 为整页正文，section 为该节新内容'),
      text: z.string().optional().describe('append 要追加的 Markdown'),
      old: z.string().optional().describe('edit：要被替换的原文，必须唯一'),
      new: z.string().optional().describe('edit：替换后的文字'),
      heading: z.string().optional().describe('section 要替换的标题；append 时表示追加到这一节末尾'),
      meta: z.record(z.string(), z.unknown()).optional().describe('页头字段对象，如 {"type":"howto","tags":["windows"]}；tags/aliases 必须是字符串数组；值为 null 表示删除该字段'),
      title: z.string().optional().describe('页面标题；create 必填，任何模式均可修改'),
      summary: z.string().optional().describe('一句话摘要（≤120 个字符，超了会被拒；能单独看懂，会出现在所有 AI 的开场目录里）；create 必填，任何模式均可修改'),
      force: z.boolean().optional().describe('create：确实是不同主题时跳过相似拦截；必须写明 reason'),
      reason: z.string().describe('为什么写/改，会记进日志和 git 提交'),
      source: z.string().optional().describe('依据，如 session:claude/<会话ID>、file:netx/README.md、url:https://...'),
    },
  }, async (args) => {
    try {
      const id = args.page
      const ctx = { agent: wiki.config.agent, reason: args.reason, source: args.source }
      let meta = args.meta as MetaPatch | undefined
      if (args.title !== undefined || args.summary !== undefined) {
        meta = { ...meta, ...(args.title !== undefined ? { title: args.title } : {}), ...(args.summary !== undefined ? { summary: args.summary } : {}) }
      }
      let op: WriteOp
      switch (args.mode) {
        case 'create':
          if (!args.title || !args.summary) {
            const errors = ['title', 'summary'].filter(field => !args[field as 'title' | 'summary']).map(field => ({ field, reason: 'create 时必填且不能为空' }))
            throw new MemwikiError('INVALID_META', errors.map(e => `${e.field} ${e.reason}`).join('；'), { errors })
          }
          op = { kind: 'create', id, meta: { ...meta, title: args.title, summary: args.summary }, body: args.body ?? '', force: args.force }
          break
        case 'replace':
          if (!args.rev) throw new MemwikiError('INVALID_META', 'replace 需要 rev')
          op = { kind: 'replace', id, rev: args.rev, body: args.body ?? '', meta }
          break
        case 'append':
          if (args.text === undefined) throw new MemwikiError('INVALID_META', 'append 需要 text')
          op = { kind: 'append', id, text: args.text, section: args.heading, rev: args.rev, meta }
          break
        case 'edit':
          if (!args.rev) throw new MemwikiError('INVALID_META', 'edit 需要 rev')
          op = { kind: 'edit', id, rev: args.rev, old: args.old ?? '', new: args.new ?? '', meta }
          break
        case 'section':
          if (!args.rev || !args.heading) throw new MemwikiError('INVALID_META', 'section 需要 rev 和 heading')
          op = { kind: 'section', id, rev: args.rev, heading: args.heading, body: args.body ?? '', meta }
          break
        case 'meta':
          if (!args.rev || !meta) throw new MemwikiError('INVALID_META', 'meta 需要 rev 和页头字段（meta 或 title/summary）')
          op = { kind: 'meta', id, rev: args.rev, meta }
          break
      }
      // Resolve non-create refs to canonical IDs.
      if (op.kind !== 'create') {
        const page = await wiki.read(op.id)
        op = { ...op, id: page.page.id }
      }
      const { result } = await wiki.write(op, ctx)
      return text(`写入成功。\n页面：[[${result.page.id}]]\nrev：${result.page.rev}`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_remember', {
    description: '拿不准该放进哪一页时，先把一条内容快速记进 inbox（不会丢），同时返回最相关的 3 个已有页面；合适的话直接用 memwiki_write 更新那一页更好。',
    inputSchema: {
      text: z.string().describe('要记住的内容'),
      source: z.string().optional().describe('来源'),
      project: z.string().optional().describe('当前项目（用于相关页加权）'),
    },
  }, async ({ text: body, source, project }) => {
    try {
      const { page, related } = await wiki.remember(body, { agent: wiki.config.agent, source, project })
      const lines = [
        `已记入 [[${page.id}]]。`,
        '最相关的已有页面（可考虑直接更新它们，而不是新建）：',
        ...(related.length ? related.map((h, i) => `${i + 1}. [[${h.id}|${h.title}]] — ${h.summary}`) : ['（暂无相关页面）']),
      ]
      return text(lines.join('\n'))
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_merge', {
    description: '把多个页面合并到一个归属页。先 lint fix 将相对 Markdown 页面链接转为双链，并确认独有内容已在归属页；body 由你整理，不传则保留目标正文。源文件直接删除，标题和别名并入目标 aliases，全库双链自动改写，一次提交。',
    inputSchema: { from: z.array(z.string()).min(1), into: z.string(), rev: z.string(), body: z.string().optional(),
      meta: z.record(z.string(), z.unknown()).optional(), reason: z.string().trim().min(1) },
  }, async ({ from, into, rev, body, meta, reason }) => {
    try {
      const { result } = await wiki.merge({ from, into, rev, body, meta: meta as MetaPatch | undefined, ctx: { agent: wiki.config.agent, reason } })
      return text(`已合并 ${result.from.join('、')} → [[${result.page.id}]]；源文件已删除。\nrev：${result.page.rev}`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_verify', {
    description: '读到并核实过页面后调用：verified 设为本地今天，stale 恢复 active；不需要 rev，不修改正文。',
    inputSchema: { page: z.string(), note: z.string().optional() },
  }, async ({ page, note }) => {
    try {
      const { result } = await wiki.verify(page, { note, ctx: { agent: wiki.config.agent, reason: '核实内容' } })
      return text(`已核实 [[${result.page.id}]]：${result.page.meta.verified}\nrev：${result.page.rev}`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_feedback', {
    description: '记录工具 bug、使用阻力、缺失能力或规则不清（action=add，默认）；list 列反馈；resolve 按 id 与 resolution 标记解决。不要包含凭据。',
    inputSchema: { action: z.enum(['add', 'list', 'resolve']).optional(), kind: z.enum(['bug', 'friction', 'missing', 'rule']).optional(),
      title: z.string().optional(), scenario: z.string().optional(), expected: z.string().optional(), actual: z.string().optional(),
      id: z.string().optional(), resolution: z.string().optional(), all: z.boolean().optional() },
  }, async (args) => {
    try {
      const ctx = { agent: wiki.config.agent, reason: '记录工具反馈' }
      if (args.action === 'list') return text(JSON.stringify(wiki.feedbackList(args.all), null, 2))
      if (args.action === 'resolve') {
        if (!args.id || !args.resolution) throw new MemwikiError('INVALID_META', 'resolve 需要 id 和 resolution')
        await wiki.feedbackResolve(args.id, args.resolution, ctx)
        return text(`已解决反馈 ${args.id}`)
      }
      if (!args.kind || !args.title || !args.scenario || !args.expected || !args.actual) throw new MemwikiError('INVALID_META', 'add 需要 kind/title/scenario/expected/actual')
      const result = await wiki.feedback({ kind: args.kind, title: args.title, scenario: args.scenario, expected: args.expected, actual: args.actual, ctx })
      return text(`已记录 ${result.id}，见 [[${result.page.id}]]`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_usage', {
    description: '仅汇总零结果搜索、版本冲突、密钥拦截、编辑找不到/不唯一、相似拦截及成功强制新建；不统计正常搜索、阅读或其他成功写入。输出事件次数、零结果查询 Top 10；无事件时明确说明。不含页面正文或凭据。',
    inputSchema: { days: z.number().positive().optional() },
  }, async ({ days }) => {
    try { return text(JSON.stringify(await wiki.usage(days), null, 2)) }
    catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_move', {
    description: '改名或移动页面，所有指向它的 [[链接]] 会自动改写；先 lint fix 将相对 Markdown 页面链接转为双链。',
    inputSchema: {
      page: z.string().describe('源页面引用'),
      to: z.string().describe('目标页面 ID'),
      reason: z.string().describe('原因'),
    },
  }, async ({ page, to, reason }) => {
    try {
      const { result } = await wiki.move(page, to, { agent: wiki.config.agent, reason })
      return text(`已移动到 [[${result.page.id}]]。\n改写链接的页面：${result.rewritten.length ? result.rewritten.map(id => `[[${id}]]`).join('、') : '无'}\nrev：${result.page.rev}`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_delete', {
    description: '把页面移到回收站（可用 memwiki_restore 恢复）。待核实内容用 status: stale；被归属页替代的内容用 memwiki_merge。',
    inputSchema: {
      page: z.string().describe('页面引用'),
      reason: z.string().describe('原因'),
    },
  }, async ({ page, reason }) => {
    try {
      const { result } = await wiki.delete(page, { agent: wiki.config.agent, reason })
      return text(`已删除 [[${result.id}]] → ${result.trashPath}\n仍链向它的页面：${result.danglingFrom.length ? result.danglingFrom.map(id => `[[${id}]]`).join('、') : '无'}`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_restore', {
    description: '从回收站恢复页面',
    inputSchema: {
      trashPath: z.string().describe('回收站相对路径，如 .trash/topics/x.123.md'),
      reason: z.string().optional().describe('原因'),
    },
  }, async ({ trashPath, reason }) => {
    try {
      const { result } = await wiki.restore(trashPath, { agent: wiki.config.agent, reason: reason ?? '恢复' })
      return text(`已恢复 [[${result.page.id}]]\nrev：${result.page.rev}`)
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_lint', {
    description: '体检记忆库：格式、双链、Markdown 页面链接、过时、overlap、fact_repeat、open 反馈与 git。fix=true 自动将相对 Markdown 页面链接转为双链并修复安全项；内容重叠、事实重复与反馈汇总不可自动修。',
    inputSchema: {
      fix: z.boolean().optional().describe('是否自动修复，默认否'),
    },
  }, async ({ fix }) => {
    try {
      const { issues, fixed } = await wiki.lint({ fix: !!fix, agent: wiki.config.agent })
      if (!issues.length) return text(fix ? `体检完成，修复 ${fixed} 项；当前无问题。` : '体检通过，无问题。')
      const lines = issues.map(i => `- [${i.code}]${i.severity ? `（${i.severity === 'info' ? '提示' : '警告'}）` : ''}${i.page ? ` [[${i.page}]]` : ''} ${i.message}${i.fixable ? '（可修）' : ''}`)
      if (fix) lines.unshift(`已自动修复 ${fixed} 项。剩余问题：`)
      return text(lines.join('\n'))
    } catch (e) { return formatError(e) }
  })

  server.registerTool('memwiki_log', {
    description: '最近的变更日志：谁、什么时候、改了哪页、为什么。',
    inputSchema: {
      limit: z.number().int().positive().optional().describe('条数，默认 20'),
    },
  }, async ({ limit }) => {
    try {
      const entries = await wiki.log(limit ?? 20)
      if (!entries.length) return text('（暂无日志）')
      return text(entries.map(e => {
        const d = new Date(e.at)
        const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
        return `- ${stamp} [${e.agent}] ${e.action}${e.page ? ` [[${e.page}]]` : ''}：${e.reason}`
      }).join('\n'))
    } catch (e) { return formatError(e) }
  })

  server.registerPrompt('memwiki-curate', {
    description: '一次完成内容收敛、核实、inbox 归档和反馈/使用信号汇总',
  }, async () => ({ messages: [{ role: 'user' as const, content: { type: 'text' as const, text: `请整理记忆库：
1. 先 memwiki_read _guide，调用 memwiki_lint；纠正优先于补充，页面只写当前正确说法。
2. 对 overlap / fact_repeat 核对来源并判断事实归属；用 memwiki_merge 或 memwiki_write edit 收敛到一页，其余改为链接。删除内容前确认已在归属页存在；不要机械删除正常的链接引用。
3. 对 stale 页核实：能核实就 memwiki_verify；不能核实就在页面标注待核实，保留 stale。
4. 搜索相关页后归档 inbox，确认信息已归入再移除原条目。
5. 用 memwiki_feedback action=list 与 memwiki_usage 汇总 open 反馈及使用信号；只汇报不改代码。工具问题、规则不清或有价值的搜索缺口用 feedback 留下可复现的场景。
6. 再跑 lint，汇报删并修改摘要和剩余不确定项。禁止改写 git 历史。` } }] }))

  return server
}

/** Starts the MCP server over stdio. */
export async function serveMemwiki(wiki: Memwiki, secrets?: SecretStore): Promise<void> {
  const server = createMemwikiServer(wiki, secrets)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
