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

## 团队远程模式

团队库由独立的 memwiki 进程托管，Hub 负责登录与身份签发。个人用户继续使用 `serve` 的 stdio 接入，原有 Claude Code、Codex、Cursor 和 DSH 配置无需调整。

先初始化团队库（启用 git 以保留提交作者），再启动：

```bash
dsh-memwiki init /data/team-kb
dsh-memwiki serve-remote --dir /data/team-kb --port 8081 \
  --hub-pubkey /keys/hub-public.pem --audit-file /audit/kb.jsonl
# 容器内也可直接执行：
node /app/lib/cli.js serve-remote --dir /data/team-kb --port 8081 \
  --hub-pubkey /keys/hub-public.pem --audit-file /audit/kb.jsonl
```

服务监听 `0.0.0.0`，MCP 地址是 `/mcp`，使用 SDK 的无状态 Streamable HTTP 传输：POST 返回 JSON，不分配会话 ID，GET/DELETE 返回 405。Hub 配置 `DSH_TEAM_KB_UPSTREAM=http://memwiki:8081/mcp`，向用户提供 `/_hub/kb/mcp`。memwiki 只放在 Hub 可达的内部网络；Hub 每次转发时丢弃客户端自带的身份头，并按当前会话签发新头。

每个 HTTP 请求都必须携带 `X-Dsh-Team-Identity: v1.<payload_base64url>.<signature_base64url>`。签名算法为 Ed25519，输入为 `v1.<payload_base64url>`，公钥文件为 SPKI PEM；payload 必须包含 `v=1`、`sub`、`name`、`src`、`kind`、`roles`、`inst="kb"`、`iat`、`exp`、`jti`。`kind` 为 `member` / `external` / `system`，`src` 为 `uac` / `local` / `system`；有效期最长 60 秒，允许 5 秒时钟偏差。缺失、重复、多值、编码非法、验签失败、过期及实例不符均返回 401；错误和审计不包含身份头原文。`jti` 只用于关联，不做重放去重，遵循 Hub 契约。

- 页头 `visibility: company` 是默认值（老页面未声明时同样按 company）；显式 `visibility: all` 才对外部成员开放。维护人可以通过 `memwiki_write` 的 `meta` 设置该字段。
- 公司成员与系统账号可读全部页面；外部成员只能读 all 页面。直接读取、搜索、context、反向链接都会过滤权限；生成的全库 index/log 与内部诊断工具不向外部成员开放。公开页面中指向内部页面的双链会隐藏，公开正文自身的业务内容仍由维护人审核后发布。
- `kb-maintainer`、`admin`、`super_admin` 可直接写入；其他角色的所有修改（包括 write、merge、move、delete、restore、verify、remember、lint fix、feedback 修改）均生成独立的 `inbox/proposals/<UTC日期>/<随机ID>` 待审页，返回“已提交待审”。提议保留完整工具参数与 rev。维护人用现有 read/write/merge/delete 工具审核、应用并归档；应用时仍须检查最新 rev。提议默认 company。
- 远程模式不注册任何 `memwiki_secret_*` 工具。写入作者、来源、git 作者均来自签名身份，忽略工具参数伪造的作者；`updated_by` 为 `sub`，`updated_by_name` 为 `name`，sources 包含 `hub:<sub> (<name>)`。维护人的审核提交记审核人，提议页保留原提议人。
- 同一服务的请求串行完成修改、索引、日志和 git 提交，并保留跨进程文件锁与 rev 冲突检查；长操作会续租文件锁。远程进程在每次工具调用时刷新磁盘内容，不启动个人模式的后台文件监听提交。
- 审计写到库外 JSONL：`kb.write` / `kb.propose`，包含时间、作者、目标页和工具。写入前记 attempt，完成后记 success/error；只有 attempt 表示中断或未完成，需检查库与 git。日志不可写时拒绝开始修改，不记录正文和身份头。默认路径为 `<库绝对路径>.audit.jsonl`，容器部署建议显式挂载 `/audit` 并设置 `--audit-file`。审计路径不能通过符号链接落回库内。

memwiki 端的库目录、端口、公钥与审计路径都通过上述命令行参数设置，**无需新增环境变量**。现有 `MEMWIKI_GIT=0` 可关闭自动提交（团队部署应保留默认开启），`MEMWIKI_GIT_PUSH=1` 可选开启推送；Hub 的 `DSH_TEAM_KB_UPSTREAM` 设置在 Hub 容器。挂载 `/data` 与 `/audit` 为持久可写卷，`/keys/hub-public.pem` 为只读文件；memwiki 不需要 Hub 私钥或实例令牌。

## 配置项

库目录优先级：`--dir` > `MEMWIKI_DIR` > `~/.dsh/dsh-memwiki.json` 的 `dir` > `~/memwiki`。自动推送：命令行 > 环境变量 > DSH 设置文件的 `autoPush` > 库设置 > 默认关闭；其他设置仍是命令行 > 环境变量 > 库设置 > 默认值。

| 设置 | 命令行 | 环境变量 | 默认 |
|---|---|---|---|
| 库目录 | `--dir` | `MEMWIKI_DIR` | `~/memwiki` |
| 写入方 ID | `--agent` | `MEMWIKI_AGENT` | `agent` |
| 自动提交 | `--no-git` | `MEMWIKI_GIT=0` | 库是 git 仓库时开启 |
| 自动推送 | `--push` / `--no-push` | `MEMWIKI_GIT_PUSH=1` | 关闭 |
| 精简上下文预算（字节） | `--budget` | `MEMWIKI_CONTEXT_BUDGET` | 4096 |
| 过期天数 | — | 库 settings | 90 |
| 敏感信息扫描 | — | 库 settings | 开启 |
| 新建相似阈值 | — | 库 `settings.similarCreateThreshold` | 0.72 |
| 正文重叠阈值 | — | 库 `settings.overlapThreshold` | 0.70 |

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
| `memwiki_write` | 写入（create/replace/append/edit/section/meta）；create 拦截相似页，可注明 reason 后 force |
| `memwiki_remember` | 快速记入 inbox，并返回相关页面 |
| `memwiki_move` | 改名/移动并改写链接 |
| `memwiki_merge` | 合并到归属页，改写双链并直接删除源文件、迁移标题和别名；body/meta 可选，带目标 rev |
| `memwiki_verify` | 只核实旧页时刷新 verified，stale 恢复 active，无需 rev；写入时用 verify 参数顺带核实 |
| `memwiki_feedback` | add/list/resolve：记录与处理按月反馈 |
| `memwiki_usage` | 本地使用信号统计与零结果查询 Top 10 |
| `memwiki_delete` / `memwiki_restore` | 回收站删除 / 恢复 |
| `memwiki_lint` | 体检（可 `fix`）；含 markdown_link（可自动转双链）及 overlap、fact_repeat、feedback_open（仅提示） |
| `memwiki_log` | 最近变更 |

Prompt：`memwiki-curate`（内容收敛、核实、归档及反馈/使用信号汇总，只汇报不改代码）。规则正文唯一来源是库内 `_guide`；skill 与服务说明只保留摘要。

## 命令行

```text
dsh-memwiki init [dir]
dsh-memwiki serve
dsh-memwiki context [--project <名>]
dsh-memwiki search <query>
dsh-memwiki read <page>
dsh-memwiki lint [--fix]
dsh-memwiki merge <from>... --into <page> --rev <rev> --reason <说明> [--body-file <md>] [--meta-file <json>]
dsh-memwiki verify <page> [--note <说明>]
dsh-memwiki usage [--days 7]
dsh-memwiki feedback list [--all]
dsh-memwiki reindex
dsh-memwiki sync
dsh-memwiki setup <claude|codex|cursor|dsh> [--write]
dsh-memwiki install-skill [--target ...]
```

`sync`：先 `git pull --rebase --autostash` 再 `push`；冲突时中止变基并列出文件，退出码非 0。

## 库的格式

标准 Markdown + YAML 页头 + `[[双链]]`，状态只有 `active` / `stale`。页间引用使用双链；`[文字](相对路径.md)` 会被 lint 报 `markdown_link`，`fix: true` 按当前页目录将其转成双链，随后才参与反链、断链与 move/merge 改写。请先修复再移动或合并。MCP 的 meta 只接受对象，tags/aliases 使用字符串数组，append 正文用 text。目录约定见 [docs/DESIGN.md](docs/DESIGN.md) §2–§3。生成文件 `index.md`、`log/YYYY-MM.md` 勿手改。

`create` / `replace` / `section` 必须显式传字符串 `body`，缺失报 `INVALID_META`；所有 MCP 工具拒绝未知参数并指出字段名。写入时可传 `verify: "核实依据"`，同次写入设置今天的 verified，stale 恢复 active，只记一条日志和一个 git 提交；刚写完的页面不要再单独调用 `memwiki_verify`。

正文超过 20 KB（UTF-8 字节）报 `PAGE_TOO_LARGE` 并要求拆页；让正文变小的写入与 `meta/` 页面除外，meta 模式仍可修改超大页页头。sources 去重保留最新 10 条，新的在后。日志按月存放，只向文件末尾追加；`memwiki_log` 从最新月份往前读，够 limit 即停。日志 reason 与 git 提交说明超过 120 字保留前 120 字并加“…”（按 Unicode 字符计数）。

旧库的日志需停止写入并备份后，手动运行一次 `node scripts/split-log.mjs <vaultDir>`：按月拆分并删除旧 `log.md`；运行时代码只读月度日志。

## 常见问题

**CONFLICT**：别人或另一个进程改过页面。重新 `memwiki_read` 拿最新 `rev` 再写。

**SIMILAR_EXISTS**：先读最多 3 个相似候选，优先更新已有页；确实不同主题才 `force: true`，reason 必须说明理由并原样记日志。inbox 不拦截。

**内容维护**：一个事实一个归属，纠正优先于补充。merge 的正文由调用方整理；删除源内容前确认已在目标页，源文件直接删除，源标题和别名并入目标 aliases，原文在 git 历史中。fact_repeat 仅为低级别提示，链接引用 IP 不必删。

**反馈与统计**：反馈在 `meta/feedback/YYYY-MM.md`（type=meta）；context 只提示 open 条数。使用信号在 git 忽略的 `.memwiki/usage.jsonl`，超过 1 MB 轮转一份旧文件；仅记录零结果搜索、版本冲突、密钥拦截、编辑找不到/不唯一、相似拦截和成功强制新建；不统计正常搜索、阅读或其他成功写入。计数为空会提示“这段时间没有发生这些事件”。事件中只保留脱敏查询及哈希页面标识，不记录正文、写入理由或凭据值。

**SECRET_DETECTED**：正文或页头命中密钥规则，不会写入。确需保存低风险凭据时用 `memwiki_secret_set`，页面写 `secret:<名字>` 引用。

**多机同步**：同一 git 远程下，开 `autoPush` 或定期 `dsh-memwiki sync`。冲突需人工处理列出的文件。

**外部编辑**：在 Obsidian 里改文件会被监视；约 60 秒后统一提交 `[external] …`。

**DSH 找不到 cli.js**：用 `dsh-memwiki setup dsh` 打印带绝对路径的条目，合并进 `$DSH_HOME/cordis.patch.yml`，并确认 `MEMWIKI_DIR`。

## 本机凭据库

密码和 token 不能写进 wiki 页面（会进入 git 历史、目录和检索）。仅本地开发、测试账号、内网设备等低风险凭据可存入独立凭据库；银行、邮箱、主账号、生产环境密码不要存。页面只写 `secret:netx-local-admin`。

默认文件 `~/.memwiki/secrets.json`，可用 `MEMWIKI_SECRETS_FILE` 或 `--secrets-file` 覆盖；文件必须在 wiki 目录之外，不进 git、不同步。默认访问日志为同目录的 `secrets-access.log`，只记录时间、agent、动作、名字和用途，不含值。

Windows 用 DPAPI CurrentUser 加密，绑定当前 Windows 用户；换用户或机器不能解密，DPAPI 不可用时直接失败，不退回明文。其他平台第一版**明文存储**，靠文件 0600 / 父目录 0700 权限保护。列表不会返回值。

```text
dsh-memwiki secret set netx-local-admin --scope "仅用于 localhost 的 netx 开发实例"
dsh-memwiki secret list
dsh-memwiki secret get netx-local-admin --purpose "登录 localhost 开发实例"
dsh-memwiki secret rm netx-local-admin
dsh-memwiki secret log --limit 20
```

`set` 交互输入不回显；管道输入只读 stdin 第一行，密码不能放在命令行参数中。`get` 是明确请求取值的命令，会向 stdout 输出值，请留意接收端。MCP 的 `memwiki_secret_list/get/set/delete` 共用同一凭据库；`get` 必须给 `purpose`，只按 `scope` 使用，不回显给用户、不写进任何文件或页面。`set` 只在用户明确要求记住密码时使用。

## DSH 设置页

安装插件后打开“设置 → 记忆库”，可保存库目录和自动推送开关，查看库状态、最近 5 条变更和只读体检；凭据区支持新增、更新、删除和访问日志。凭据默认不显示，点击“显示”后显示 10 秒，查看会记入访问日志；同一时间只显示一条，切换设置页或窗口失焦时立即隐藏。显示期间可复制，30 秒后若剪贴板仍为该值且可读取则尝试清空。配置落盘到 `~/.dsh/dsh-memwiki.json`，保存后重启 DSH 生效；环境变量优先时卡片会提示实际目录。

`cordis.patch.yml` 同时挂载 MCP 客户端与独立的 `lib/dsh-host.js` 插件；公共 API 仍为 `lib/index.js`。浏览器端 `dsh.client` / `./client` 加载 `lib/client.js`，遵循 Desktop 0.2 的 `settings.section`、`slots` + `locale` 模式。构建保留 tsc，并通过 Bun 打包这两个插件入口（`npm run build` 需要 Bun）。
