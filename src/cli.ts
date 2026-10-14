#!/usr/bin/env node
import { parseArgs } from 'node:util'
import { copyFile, cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveConfig } from './config.ts'
import { initVault } from './core/vault.ts'
import { Memwiki } from './memwiki.ts'
import { serveMemwiki } from './mcp/server.ts'
import { MemwikiError } from './types.ts'

const exec = promisify(execFile)
const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')
const cliJs = path.join(here, 'cli.js')

const HELP = `dsh-memwiki — 多个 AI 共用的记忆 wiki

用法：
  dsh-memwiki init [dir] [--name <名>] [--no-git]
  dsh-memwiki serve [--dir <库>] [--agent <id>] [--no-git] [--push|--no-push]
  dsh-memwiki context [--project <名>] [--dir ...]
  dsh-memwiki search <query> [--dir ...]
  dsh-memwiki read <page> [--dir ...]
  dsh-memwiki lint [--fix] [--dir ...]
  dsh-memwiki reindex [--dir ...]
  dsh-memwiki sync [--dir ...]
  dsh-memwiki setup <claude|codex|cursor|dsh> [--write] [--dir ...]
  dsh-memwiki install-skill [--target claude|codex|cursor|dsh]...

全局选项：--dir、--agent、--no-git、--push / --no-push、--budget
`

function fail(err: unknown): never {
  if (err instanceof MemwikiError) {
    console.error(`${err.code}：${err.message}`)
    process.exit(1)
  }
  console.error(err instanceof Error ? err.message : String(err))
  process.exit(1)
}

async function gitProjectName(cwd = process.cwd()): Promise<string | undefined> {
  try {
    const { stdout } = await exec('git', ['rev-parse', '--show-toplevel'], { cwd })
    return path.basename(stdout.trim())
  } catch { return undefined }
}

async function openWiki(flags: { dir?: string; agent?: string; git?: boolean; push?: boolean; budget?: number }) {
  const config = await resolveConfig({
    dir: flags.dir,
    agent: flags.agent,
    git: flags.git,
    push: flags.push,
    budget: flags.budget,
  })
  return Memwiki.open(config)
}

function mcpCommandBlock(agent: string, vaultDir?: string) {
  const env: Record<string, string> = { MEMWIKI_AGENT: agent }
  if (vaultDir) env.MEMWIKI_DIR = vaultDir
  return {
    command: process.execPath,
    args: [cliJs, 'serve'],
    env,
  }
}

async function backup(file: string): Promise<void> {
  if (existsSync(file)) await copyFile(file, file + '.bak')
}

/**
 * Reads a JSON config to merge into. A missing file starts empty; an unreadable or
 * unparsable one aborts, so `setup --write` never replaces a user's config with `{}`.
 */
async function readJsonForMerge(file: string): Promise<Record<string, unknown>> {
  let raw: string
  try { raw = await readFile(file, 'utf8') }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw e }
  try { return JSON.parse(raw) as Record<string, unknown> }
  catch { throw new Error(`${file} 不是合法的 JSON（可能含注释），为避免覆盖已停止；请手动合并上面打印的片段`) }
}

async function setupClient(client: string, opts: { write: boolean; dir?: string }) {
  const vault = opts.dir ?? process.env.MEMWIKI_DIR ?? path.join(os.homedir(), 'memwiki')
  const agents = { claude: 'claude', codex: 'codex', cursor: 'cursor', dsh: 'dsh' } as const
  if (!(client in agents)) throw new Error(`未知客户端：${client}（claude|codex|cursor|dsh）`)
  const agent = agents[client as keyof typeof agents]
  const mcp = mcpCommandBlock(agent, vault)

  if (client === 'claude') {
    const mcpSnippet = {
      mcpServers: {
        memwiki: { command: mcp.command, args: mcp.args, env: mcp.env },
      },
    }
    const hookSnippet = {
      hooks: {
        SessionStart: [{
          // Shell command line, not JSON: quote paths with plain double quotes (Windows paths keep single backslashes).
          hooks: [{ type: 'command', command: `"${process.execPath}" "${cliJs}" context --dir "${vault}" --agent claude` }],
        }],
      },
    }
    const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
    console.log(`# Claude Code\n# MCP：等同 claude mcp add memwiki --scope user\n# 建议写入用户 MCP 配置；SessionStart hook → ${settingsPath}\n`)
    console.log('# MCP 配置片段：')
    console.log(JSON.stringify(mcpSnippet, null, 2))
    console.log('\n# settings.json SessionStart hook 片段：')
    console.log(JSON.stringify(hookSnippet, null, 2))
    if (opts.write) {
      await mkdir(path.dirname(settingsPath), { recursive: true })
      await backup(settingsPath)
      let settings: Record<string, unknown> = {}
      settings = await readJsonForMerge(settingsPath)
      const hooks = (settings.hooks ?? {}) as Record<string, unknown>
      // Re-running setup replaces our earlier hook instead of stacking duplicates.
      const ours = (entry: unknown) => JSON.stringify(entry).includes('dsh-memwiki') && JSON.stringify(entry).includes(' context ')
      const existing = (Array.isArray(hooks.SessionStart) ? hooks.SessionStart as unknown[] : []).filter(e => !ours(e))
      hooks.SessionStart = [...existing, ...(hookSnippet.hooks.SessionStart as unknown[])]
      settings.hooks = hooks
      await writeFile(settingsPath, JSON.stringify(settings, null, 2) + '\n')
      // User-level MCP via ~/.claude.json (Claude Code convention)
      const claudeJson = path.join(os.homedir(), '.claude.json')
      await backup(claudeJson)
      let root: Record<string, unknown> = {}
      root = await readJsonForMerge(claudeJson)
      const servers = (root.mcpServers ?? {}) as Record<string, unknown>
      servers.memwiki = mcpSnippet.mcpServers.memwiki
      root.mcpServers = servers
      await writeFile(claudeJson, JSON.stringify(root, null, 2) + '\n')
      console.log(`\n已写入 ${settingsPath} 与 ${claudeJson}（原文件备份为 .bak）`)
    }
    return
  }

  if (client === 'codex') {
    const block = [
      '[mcp_servers.memwiki]',
      `command = ${JSON.stringify(mcp.command)}`,
      `args = [${mcp.args.map(a => JSON.stringify(a)).join(', ')}]`,
      // Codex asks before every MCP tool call by default, and non-interactive runs
      // (approval policy "never") then reject the call. memwiki only touches its vault.
      'default_tools_approval_mode = "approve"',
      '[mcp_servers.memwiki.env]',
      ...Object.entries(mcp.env).map(([k, v]) => `${k} = ${JSON.stringify(v)}`),
      '',
    ].join('\n')
    const configPath = path.join(os.homedir(), '.codex', 'config.toml')
    console.log(`# Codex → ${configPath}\n`)
    console.log(block)
    if (opts.write) {
      await mkdir(path.dirname(configPath), { recursive: true })
      await backup(configPath)
      let raw = ''
      try { raw = await readFile(configPath, 'utf8') } catch { /* new */ }
      const stripped = raw.replace(/\n?\[mcp_servers\.memwiki(?:\.env)?\][\s\S]*?(?=\n\[(?!mcp_servers\.memwiki)|\s*$)/g, '').trimEnd()
      await writeFile(configPath, (stripped ? stripped + '\n\n' : '') + block)
      console.log(`\n已写入 ${configPath}（原文件备份为 .bak）`)
    }
    return
  }

  if (client === 'cursor') {
    const snippet = { mcpServers: { memwiki: { command: mcp.command, args: mcp.args, env: mcp.env } } }
    const configPath = path.join(os.homedir(), '.cursor', 'mcp.json')
    console.log(`# Cursor → ${configPath}\n`)
    console.log(JSON.stringify(snippet, null, 2))
    if (opts.write) {
      await mkdir(path.dirname(configPath), { recursive: true })
      await backup(configPath)
      let root: Record<string, unknown> = {}
      root = await readJsonForMerge(configPath)
      const servers = (root.mcpServers ?? {}) as Record<string, unknown>
      servers.memwiki = snippet.mcpServers.memwiki
      root.mcpServers = servers
      await writeFile(configPath, JSON.stringify(root, null, 2) + '\n')
      console.log(`\n已写入 ${configPath}（原文件备份为 .bak）`)
    }
    return
  }

  // dsh
  const yaml = `- insert:
    - id: memwiki
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: memwiki
        transport: stdio
        command: ${JSON.stringify(mcp.command)}
        args: ${JSON.stringify(mcp.args)}
        env:
          MEMWIKI_AGENT: dsh
          MEMWIKI_DIR: ${JSON.stringify(vault)}
`
  console.log(`# DSH：dsh plugin add 安装本包后会自动挂载 cordis.patch.yml。\n# 仅在需要自定义库目录时，把下面条目合并进 $DSH_HOME/cordis.patch.yml：\n`)
  console.log(yaml)
}

async function installSkill(targets: string[]) {
  const src = path.join(pkgRoot, 'skills', 'memwiki')
  const map: Record<string, string> = {
    claude: path.join(os.homedir(), '.claude', 'skills', 'memwiki'),
    codex: path.join(os.homedir(), '.agents', 'skills', 'memwiki'),
    dsh: path.join(os.homedir(), '.agents', 'skills', 'memwiki'),
    cursor: path.join(os.homedir(), '.cursor', 'skills', 'memwiki'),
  }
  const chosen = targets.length ? targets : ['claude', 'codex', 'cursor']
  // dsh shares codex path; dedupe destinations
  const dests = new Map<string, string>()
  for (const t of chosen) {
    if (!map[t]) throw new Error(`未知 target：${t}`)
    dests.set(map[t], t)
  }
  for (const [dest, label] of dests) {
    if (existsSync(dest)) {
      await cp(dest, dest + '.bak', { recursive: true, force: true })
    }
    await mkdir(path.dirname(dest), { recursive: true })
    await cp(src, dest, { recursive: true, force: true })
    console.log(`已安装 skill → ${dest}（${label}）`)
  }
}

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    allowPositionals: true,
    strict: false,
    options: {
      dir: { type: 'string' },
      agent: { type: 'string' },
      project: { type: 'string' },
      name: { type: 'string' },
      budget: { type: 'string' },
      fix: { type: 'boolean', default: false },
      write: { type: 'boolean', default: false },
      git: { type: 'boolean', default: true },
      push: { type: 'boolean' },
      'no-git': { type: 'boolean', default: false },
      'no-push': { type: 'boolean', default: false },
      target: { type: 'string', multiple: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
  })

  if (values.help || positionals.length === 0) {
    console.log(HELP)
    process.exit(0)
  }

  const git = values['no-git'] ? false : (values.git as boolean)
  const pushFlag = values['no-push'] ? false : (values.push === true ? true : values.push === false ? false : undefined)
  const flags = {
    dir: values.dir as string | undefined,
    agent: values.agent as string | undefined,
    git,
    push: pushFlag,
    budget: values.budget !== undefined ? Number(values.budget) : undefined,
  }

  const cmd = positionals[0]

  try {
    if (cmd === 'init') {
      const dir = path.resolve(positionals[1] ?? flags.dir ?? path.join(os.homedir(), 'memwiki'))
      await initVault(dir, { name: values.name as string | undefined, git })
      console.log(`已创建记忆库：${dir}`)
      return
    }

    if (cmd === 'setup') {
      const client = positionals[1]
      if (!client) throw new Error('用法：dsh-memwiki setup <claude|codex|cursor|dsh> [--write]')
      await setupClient(client, { write: !!values.write, dir: flags.dir })
      return
    }

    if (cmd === 'install-skill') {
      await installSkill((values.target as string[] | undefined) ?? [])
      return
    }

    if (cmd === 'serve') {
      const wiki = await openWiki(flags)
      process.on('SIGINT', () => { void wiki.close().then(() => process.exit(0)) })
      await serveMemwiki(wiki)
      return
    }

    const wiki = await openWiki(flags)
    try {
      if (cmd === 'context') {
        const project = (values.project as string | undefined) ?? await gitProjectName()
        console.log(wiki.context(project))
      } else if (cmd === 'search') {
        const query = positionals.slice(1).join(' ')
        if (!query) throw new Error('用法：dsh-memwiki search <query>')
        const hits = wiki.search({ query })
        for (const h of hits) console.log(`[[${h.id}|${h.title}]] ${h.score.toFixed(2)} — ${h.summary}`)
        if (!hits.length) console.log('没有命中。')
      } else if (cmd === 'read') {
        const ref = positionals[1]
        if (!ref) throw new Error('用法：dsh-memwiki read <page>')
        const { page, backlinks, brokenLinks, recordedDaysAgo } = await wiki.read(ref)
        console.log(`# ${page.meta.title}\nrev: ${page.rev}\n记录于 ${recordedDaysAgo} 天前\n\n${page.body}`)
        if (backlinks.length) console.log('\n反向链接：' + backlinks.join(', '))
        if (brokenLinks.length) console.log('断链：' + brokenLinks.join(', '))
      } else if (cmd === 'lint') {
        const { issues, fixed } = await wiki.lint({ fix: !!values.fix, agent: wiki.config.agent })
        if (values.fix) console.log(`已修复 ${fixed} 项`)
        for (const i of issues) console.log(`[${i.code}]${i.page ? ' ' + i.page : ''} ${i.message}`)
        if (!issues.length) console.log('体检通过')
      } else if (cmd === 'reindex') {
        await wiki.reindex()
        console.log('检索索引已重建')
      } else if (cmd === 'sync') {
        const result = await wiki.sync()
        if (result.conflicts?.length) {
          console.error('同步冲突，已中止变基。冲突文件：')
          for (const f of result.conflicts) console.error('  ' + f)
          process.exitCode = 1
        } else {
          console.log(`同步完成：pull=${result.pulled} push=${result.pushed}`)
        }
      } else {
        throw new Error(`未知命令：${cmd}\n\n${HELP}`)
      }
    } finally {
      await wiki.close()
    }
  } catch (e) {
    fail(e)
  }
}

void main()
