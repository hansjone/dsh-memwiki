import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import * as z from 'zod'
import type { Memwiki } from '../memwiki.ts'
import type { MetaPatch, PageType, WriteOp } from '../types.ts'
import { MemwikiError, PAGE_TYPES } from '../types.ts'

const INSTRUCTIONS = `共享记忆 wiki 规则：
1. 任务开始调用 memwiki_context；写入前先 memwiki_search。
2. 更新已有页面优于新建；一个事实一个归属。
3. 不写密钥/密码/token；读到旧内容先核实再改。
4. CONFLICT 时重新 memwiki_read，在最新 rev 上再写。
5. 拿不准归属用 memwiki_remember 进 inbox。`

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError }
}

function formatError(err: unknown): ReturnType<typeof text> {
  if (err instanceof MemwikiError) {
    const show = (v: unknown): string => Array.isArray(v) ? v.map(show).join('|')
      : v !== null && typeof v === 'object' ? Object.entries(v).map(([k, x]) => `${k}:${show(x)}`).join(' ') : String(v)
    const extra = err.details ? '，' + Object.entries(err.details).map(([k, v]) => `${k}=${show(v)}`).join('，') : ''
    return text(`${err.code}：${err.message}${extra}`, true)
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
  if (m.superseded_by) lines.push(`替代：${m.superseded_by}`)
  lines.push(`rev：${page.rev}`)
  return lines
}

/** Builds an MCP server bound to an open Memwiki instance (§8.1). */
export function createMemwikiServer(wiki: Memwiki): McpServer {
  const server = new McpServer(
    { name: 'memwiki', version: '0.1.0' },
    { instructions: INSTRUCTIONS, capabilities: { tools: {}, prompts: {} } },
  )

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
      includeSuperseded: z.boolean().optional().describe('是否包含已替代页面，默认否'),
    },
  }, async (args) => {
    const hits = wiki.search({
      query: args.query,
      type: args.type,
      tags: args.tags,
      project: args.project,
      limit: args.limit ?? 8,
      includeSuperseded: args.includeSuperseded,
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
      meta: z.record(z.string(), z.unknown()).optional().describe('页头字段，如 {"type":"howto","tags":["windows"]}；值为 null 表示删除该字段。create 时可指定 type（user/rule/project/topic/howto/decision/reference）'),
      title: z.string().optional().describe('create 必填：页面标题'),
      summary: z.string().optional().describe('create 必填：一句话摘要（≤120 字，能单独看懂，会出现在所有 AI 的开场目录里）'),
      reason: z.string().describe('为什么写/改，会记进日志和 git 提交'),
      source: z.string().optional().describe('依据，如 session:claude/<会话ID>、file:netx/README.md、url:https://...'),
    },
  }, async (args) => {
    try {
      const id = args.page
      const ctx = { agent: wiki.config.agent, reason: args.reason, source: args.source }
      let op: WriteOp
      switch (args.mode) {
        case 'create':
          if (!args.title || !args.summary) throw new MemwikiError('INVALID_META', 'create 需要 title 和 summary')
          op = { kind: 'create', id, meta: { ...(args.meta as object), title: args.title, summary: args.summary }, body: args.body ?? '' }
          break
        case 'replace':
          if (!args.rev) throw new MemwikiError('INVALID_META', 'replace 需要 rev')
          op = { kind: 'replace', id, rev: args.rev, body: args.body ?? '', meta: args.meta as MetaPatch | undefined }
          break
        case 'append':
          op = { kind: 'append', id, text: args.text ?? args.body ?? '', section: args.heading, rev: args.rev }
          break
        case 'edit':
          if (!args.rev) throw new MemwikiError('INVALID_META', 'edit 需要 rev')
          op = { kind: 'edit', id, rev: args.rev, old: args.old ?? '', new: args.new ?? '' }
          break
        case 'section':
          if (!args.rev || !args.heading) throw new MemwikiError('INVALID_META', 'section 需要 rev 和 heading')
          op = { kind: 'section', id, rev: args.rev, heading: args.heading, body: args.body ?? '' }
          break
        case 'meta':
          if (!args.rev || !args.meta) throw new MemwikiError('INVALID_META', 'meta 需要 rev 和 meta')
          op = { kind: 'meta', id, rev: args.rev, meta: args.meta as MetaPatch }
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

  server.registerTool('memwiki_move', {
    description: '改名或移动页面，所有指向它的 [[链接]] 会自动改写。',
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
    description: '把页面移到回收站（可用 memwiki_restore 恢复）。内容只是过时的话，优先用 memwiki_write 的 meta 模式把 status 改成 stale 或 superseded，而不是删除。',
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
    description: '体检记忆库：断链、孤立页、重复标题、缺摘要、页头错误、可能过时、inbox 积压、疑似密钥、未提交改动。fix=true 只自动修安全的项（标记过时、补页头默认值、提交）。',
    inputSchema: {
      fix: z.boolean().optional().describe('是否自动修复，默认否'),
    },
  }, async ({ fix }) => {
    try {
      const { issues, fixed } = await wiki.lint({ fix: !!fix, agent: wiki.config.agent })
      if (!issues.length) return text(fix ? `体检完成，修复 ${fixed} 项；当前无问题。` : '体检通过，无问题。')
      const lines = issues.map(i => `- [${i.code}]${i.page ? ` [[${i.page}]]` : ''} ${i.message}${i.fixable ? '（可修）' : ''}`)
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

  server.registerPrompt('memwiki-ingest', {
    description: '把 inbox 整理进正式页面的工作流',
  }, async () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `请按以下步骤整理记忆 inbox：
1. 调用 memwiki_context，确认 inbox 未整理条目数。
2. 用 memwiki_read 打开当前月份的 inbox/YYYY-MM 页面。
3. 对每条记录：先 memwiki_search 找相关正式页面；有则 memwiki_read 拿 rev，用 memwiki_write 更新；没有则按归属新建（user/rules/projects/topics/howto/decisions/reference）。
4. 已归入的条目从 inbox 正文中删掉（edit 或 replace）。
5. 完成后 memwiki_lint 检查。`,
      },
    }],
  }))

  server.registerPrompt('memwiki-lint', {
    description: '体检并修复记忆库的工作流',
  }, async () => ({
    messages: [{
      role: 'user' as const,
      content: {
        type: 'text' as const,
        text: `请体检记忆库：
1. 调用 memwiki_lint（不要带 fix），汇报问题列表。
2. 对可自动修的项，征得确认后（或用户已要求修复时）再 memwiki_lint fix=true。
3. 其余问题逐条处理：断链、孤立页、重复标题、过期内容等，必要时询问用户。
4. 修复后再跑一次 memwiki_lint 确认。`,
      },
    }],
  }))

  return server
}

/** Starts the MCP server over stdio. */
export async function serveMemwiki(wiki: Memwiki): Promise<void> {
  const server = createMemwikiServer(wiki)
  const transport = new StdioServerTransport()
  await server.connect(transport)
}
