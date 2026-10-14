# dsh-memwiki

多个 AI 共用的记忆 wiki：一个 Obsidian 兼容的 Markdown 文件夹 + 一个 MCP 服务。DeepSeek Harness（DSH）、Claude Code、Codex、Cursor 都通过同一个 MCP 读写；人用 Obsidian / VS Code 直接看。

设计契约见 [docs/DESIGN.md](docs/DESIGN.md)。

## 安装

```bash
npm install -g dsh-memwiki
# 或在项目里本地安装后用 npx / node node_modules/dsh-memwiki/lib/cli.js
```

初始化库：

```bash
dsh-memwiki init ~/memwiki
```

## 接入客户端

所有客户端最终都是：用 Node 启动本包的 `lib/cli.js serve`，并设置 `MEMWIKI_AGENT` / `MEMWIKI_DIR`。

推荐先打印配置（不写入）：

```bash
dsh-memwiki setup claude   # 或 codex / cursor / dsh
dsh-memwiki setup claude --write   # 合并写入，原文件备份为 .bak
```

| 客户端 | 配置位置 | agent |
|---|---|---|
| Claude Code | 用户级 MCP + `~/.claude/settings.json` SessionStart hook | `claude` |
| Codex | `~/.codex/config.toml` 的 `[mcp_servers.memwiki]` | `codex` |
| Cursor | `~/.cursor/mcp.json` 的 `mcpServers.memwiki` | `cursor` |
| DSH | `dsh plugin add` 自动挂载 `cordis.patch.yml`；自定义库目录时合并进 `$DSH_HOME/cordis.patch.yml` | `dsh` |

可选 skill（写入习惯）：

```bash
dsh-memwiki install-skill
# 或 --target claude --target cursor
```

## 配置项

优先级：命令行 > 环境变量 > 库内 `memwiki.json` 的 `settings` > 默认值。

| 设置 | 命令行 | 环境变量 | 默认 |
|---|---|---|---|
| 库目录 | `--dir` | `MEMWIKI_DIR` | `~/memwiki` |
| 写入方 ID | `--agent` | `MEMWIKI_AGENT` | `agent` |
| 自动提交 | `--no-git` | `MEMWIKI_GIT=0` | 库是 git 仓库时开启 |
| 自动推送 | `--push` / `--no-push` | `MEMWIKI_GIT_PUSH=1` | 关闭 |
| 精简上下文预算（字节） | `--budget` | `MEMWIKI_CONTEXT_BUDGET` | 4096 |
| 过期天数 | — | 库 settings | 90 |
| 敏感信息扫描 | — | 库 settings | 开启 |

`memwiki.json` 示例：

```json
{ "schemaVersion": 1, "name": "我的记忆库", "created": "2026-10-14", "settings": { "staleDays": 90, "contextBudget": 4096, "autoPush": false } }
```

## MCP 工具

| 工具 | 作用 |
|---|---|
| `memwiki_context` | 精简目录（会话开始） |
| `memwiki_search` | 全文检索 |
| `memwiki_read` | 读页面（含 rev、反向链接、断链） |
| `memwiki_write` | 写入（create/replace/append/edit/section/meta） |
| `memwiki_remember` | 快速记入 inbox，并返回相关页面 |
| `memwiki_move` | 改名/移动并改写链接 |
| `memwiki_delete` / `memwiki_restore` | 回收站删除 / 恢复 |
| `memwiki_lint` | 体检（可 `--fix`） |
| `memwiki_log` | 最近变更 |

Prompts：`memwiki-ingest`（整理 inbox）、`memwiki-lint`（体检修复）。

## 命令行

```text
dsh-memwiki init [dir]
dsh-memwiki serve
dsh-memwiki context [--project <名>]
dsh-memwiki search <query>
dsh-memwiki read <page>
dsh-memwiki lint [--fix]
dsh-memwiki reindex
dsh-memwiki sync
dsh-memwiki setup <claude|codex|cursor|dsh> [--write]
dsh-memwiki install-skill [--target ...]
```

`sync`：先 `git pull --rebase --autostash` 再 `push`；冲突时中止变基并列出文件，退出码非 0。

## 库的格式

标准 Markdown + YAML 页头 + `[[双链]]`，目录约定见 [docs/DESIGN.md](docs/DESIGN.md) §2–§3。生成文件 `index.md`、`log.md` 勿手改。

## 常见问题

**CONFLICT**：别人或另一个进程改过页面。重新 `memwiki_read` 拿最新 `rev` 再写。

**SECRET_DETECTED**：正文或页头命中密钥规则，不会写入。改成“去哪里拿”，不要贴密钥。

**多机同步**：同一 git 远程下，开 `autoPush` 或定期 `dsh-memwiki sync`。冲突需人工处理列出的文件。

**外部编辑**：在 Obsidian 里改文件会被监视；约 60 秒后统一提交 `[external] …`。

**DSH 找不到 cli.js**：用 `dsh-memwiki setup dsh` 打印带绝对路径的条目，合并进 `$DSH_HOME/cordis.patch.yml`，并确认 `MEMWIKI_DIR`。
