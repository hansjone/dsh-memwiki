# dsh-memwiki 设计

多个 AI 共用的记忆 wiki：一个 Markdown 文件夹（Obsidian 库）+ 一个 MCP 服务。DeepSeek Harness（DSH）、Claude Code、Codex、Cursor 都通过同一个 MCP 服务读写；人用 Obsidian / VS Code 直接看。

本文是实现契约。接口以 [`src/types.ts`](../src/types.ts) 为准，本文解释语义。

## 1. 设计原则

1. **存的是整理过的知识，不是流水账。** 一个主题一页，一个事实只有一个归属；新信息优先更新已有页面，而不是新增一条。
2. **渐进披露。** 会话开始只给一份有预算的精简目录（每页一行摘要）；需要时再搜索、再读全文。
3. **来源和新旧可见。** 每页记录谁、何时写的、依据什么；读出时带"多久前记录"，过时内容标记而不是静默删除。
4. **多写入方安全。** 版本号乐观并发、页面级锁、原子写、git 留痕、回收站。
5. **人类优先的格式。** 标准 Markdown + YAML 页头 + `[[双链]]`，Obsidian 打开即用；生成文件（`index.md`、`log.md`）人也能读。
6. **零外部服务。** 纯本地文件 + Node；检索自带，不依赖向量库或模型。

## 2. 库（vault）结构

```
<vault>/
  memwiki.json      库标记与库级设置（schemaVersion 等），见 §7
  _guide.md         写作规范（库创建时从模板生成，用户可改）
  index.md          总目录（生成，勿手改）
  log.md            变更日志（追加写，勿手改）
  user/             用户画像与偏好
  rules/            给 AI 的工作规则（纠正、确认过的做法）
  projects/<name>/  各项目知识，<name> = 项目目录名（git 根目录名）
  topics/           跨项目通用知识、踩坑
  howto/            操作手册
  decisions/        决策记录
  reference/        外部资源指针（链接、面板、工单）
  inbox/            快速记录，按月一个文件 inbox/YYYY-MM.md，定期整理进正式页面
  .trash/           回收站（删除的页面，保留原相对路径 + 时间戳后缀）
  .memwiki/         本地缓存与锁（git 忽略）
```

- 目录是约定，不是强制：任何 `.md` 文件都是页面。`.trash/`、`.memwiki/`、`.obsidian/`、`.git/` 以及 `node_modules/` 不扫描。
- **特殊文件**：`index.md`、`log.md` 是生成文件，不作为页面参与检索和目录；`_guide.md` 可被 `read` 读取，但不进目录和检索。文件名以 `_` 开头的都按这个规则处理。

## 3. 页面

### 3.1 页面 ID

页面 ID = 相对库根目录的路径，去掉 `.md`，分隔符统一为 `/`，例如 `projects/netx/发布流程`。

- 合法字符：除 `\ : * ? " < > |` 和控制字符以外的字符；不能以 `/` 开头，不能含 `..` 段、空段，段首尾不能有空格或 `.`。
- 比较时大小写不敏感（Windows/macOS 文件系统），保存时保留原样。
- `read` 等接受"页面引用"：可以是 ID、标题或别名（大小写不敏感）。解析顺序：精确 ID → 唯一标题 → 唯一别名 → 唯一的文件名（最后一段）；多个候选时报 `AMBIGUOUS` 并列出候选。

### 3.2 页头（frontmatter）

```markdown
---
title: PowerShell 5.1 中文乱码
summary: 无 BOM 的 UTF-8 脚本在 PS 5.1 里中文会乱码，脚本要存成带 BOM 的 UTF-8
type: topic
tags: [windows, 编码]
aliases: [PS 乱码]
status: active
created: 2026-10-14
updated: 2026-10-14T20:31:00+08:00
updated_by: claude
verified: 2026-10-14
sources: [session:claude/d5ac048f, file:netx/scripts/start_netx.ps1]
project: netx
---
正文……
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 页面标题 |
| `summary` | 是 | 一行摘要（≤120 字），会进目录，必须独立可读 |
| `type` | 是 | `user` `rule` `project` `topic` `howto` `decision` `reference` `inbox` |
| `tags` | 否 | 标签数组 |
| `aliases` | 否 | 别名数组（也用于 `[[别名]]` 解析） |
| `status` | 是 | `active`（默认）`draft` `stale` `superseded` |
| `created` / `updated` | 是 | 写入方自动维护；`updated` 带时区的 ISO 时间 |
| `updated_by` | 是 | 最后写入的 agent ID（`dsh` `claude` `codex` `cursor` `human` `external`…） |
| `verified` | 否 | 最后一次确认内容仍然正确的日期 |
| `sources` | 否 | 依据：`session:<agent>/<id>`、`file:<路径>`、`url:<地址>`、`commit:<仓库>@<sha>` |
| `superseded_by` | 条件 | `status: superseded` 时必填，指向替代页面 ID |
| `project` | 否 | 归属项目名；`projects/<name>/` 下的页面缺省即为 `<name>` |
| `pinned` | 否 | `true` 时总是进精简目录 |

未知字段原样保留（用户/Obsidian 插件可能加自己的字段）。解析失败的页头不报错崩溃：页面仍可读，`lint` 报 `invalid_meta`。

### 3.3 版本号（rev）

`rev` = 文件原始字节的 SHA-256 前 12 位十六进制。`read` 返回 rev；除 `create` 和 `append` 外，所有修改都必须带读取时的 rev，不一致返回 `CONFLICT`（附当前 rev），调用方需重新读取后再改。

### 3.4 链接

- 语法：`[[目标]]`、`[[目标|显示文字]]`、`[[目标#标题]]`。代码块和行内代码里的不算。
- 目标按 §3.1 的页面引用规则解析；解析不到算断链（`lint` 报告，读页面时也提示）。
- 反向链接：任何页面都能查到"哪些页面链接到它"。
- **改名**（`move`）时，所有指向旧 ID / 旧标题的链接都改写为新 ID（保留 `|显示文字` 和 `#标题` 部分）。

## 4. 写入

### 4.1 写入操作（`WriteOp`）

| kind | 需要 rev | 语义 |
|---|---|---|
| `create` | 否 | 新建；ID 已存在返回 `EXISTS` |
| `replace` | 是 | 整页替换正文（可同时改页头） |
| `append` | 否 | 在正文末尾，或指定 `section` 标题下的末尾追加 |
| `edit` | 是 | 精确替换：`old` 必须在正文中**恰好出现一次**，否则 `AMBIGUOUS_EDIT` / `EDIT_NOT_FOUND` |
| `section` | 是 | 替换某个标题（按标题文字匹配，可写 `父标题/子标题`）下的内容，直到同级或更高级标题为止；标题不存在时追加为新的二级标题 |
| `meta` | 是 | 只改页头字段（合并，`null` 表示删除该字段） |

每次写入都带 `WriteContext { agent, reason, source? }`：`agent` 写进 `updated_by`，`reason` 进 `log.md` 和 git 提交信息，`source` 追加进 `sources`（去重）。

### 4.2 写入流程（每次写入都是这些步骤）

1. 校验 ID、路径（必须在库内，拒绝符号链接逃逸）。
2. 取页面锁：`.memwiki/locks/<id 的哈希>.lock`，以独占方式创建；超过 10 秒的锁视为残留，可以抢占。
3. 读当前文件，核对 rev。
4. 计算新内容：维护 `updated`、`updated_by`、`created`（仅新建）、`sources`；`projects/<name>/` 下自动补 `project`。
5. **敏感信息扫描**（§4.3），命中则拒绝写入，返回 `SECRET_DETECTED`（只说命中了哪类规则和行号，**不回显命中的内容**）。
6. 原子写：写临时文件后 rename。
7. 释放锁；把写入结果交给上层：更新检索索引 → 重新生成 `index.md` → 追加 `log.md` → git 提交（§4.4）。

### 4.3 敏感信息扫描

拒绝写入包含以下内容的正文或页头：私钥块（`-----BEGIN ... PRIVATE KEY-----`）、常见云厂商/平台密钥格式（AWS `AKIA...`、GitHub `ghp_`/`github_pat_`、OpenAI/Anthropic `sk-...`、Slack `xox?-`、JWT 三段式）、`password=` / `token:` / `secret=` 这类键值后跟长度 ≥8 的值、URL 里的 `user:pass@`。规则表要可单测；库设置可关闭（不推荐）。

### 4.4 git 与日志

- 库是 git 仓库且 `git.autoCommit` 为真时，每次写入提交一次：只 `add` 本次涉及的文件（页面、`index.md`、`log.md`、移动/删除的源路径），提交信息 `[<agent>] <动作> <页面ID>：<reason>`，作者名 `<agent> (memwiki)`，邮箱 `<agent>@memwiki.local`。
- 多个进程并发时 git 的 `index.lock` 冲突要退避重试（最多 5 次）。
- 库外部的改动（人在 Obsidian 里编辑、AI 直接改文件）：文件监视发现后防抖 60 秒，统一提交 `[external] 外部编辑 N 个页面`。
- `log.md` 每次写入追加一行：`- 2026-10-14 20:31 [claude] 更新 [[projects/netx/发布流程]]：补充 Ollama PATH 坑`。按月分节（`## 2026-10`），新的在最上面。

### 4.5 删除与回收站

`delete` 把文件移到 `.trash/<原路径>.<时间戳>.md`，同时扫描反向链接，在结果里返回"这些页面还链接着它"。`restore` 从回收站恢复（原 ID 被占用时报 `EXISTS`）。没有永久删除接口。

## 5. 检索

### 5.1 分词

- 统一小写，全角转半角。
- 拉丁字母/数字：按非字母数字切分成词；`camelCase`、`snake_case`、`kebab-case` 同时保留整词和拆分后的子词。
- 中日韩字符：连续的中日韩字符串切成**单字 + 相邻双字**。
- 不做词干化，不用停用词表（单字的权重由 IDF 自然压低）。

### 5.2 打分

BM25F（k1=1.2，b=0.75），字段权重：`title` 4、`aliases` 3、`tags` 2.5、`summary` 2、标题行（`#` 开头）1.5、正文 1。在此基础上：

- 查询原文（去空格后）整体出现在标题/别名里：×2；出现在正文里：×1.3。
- 页面属于当前项目（`project` 等于调用方给的项目名）：×1.3。
- `status` 为 `stale` / `superseded`：×0.4；`draft`：×0.8。默认结果里不包含 `superseded`，除非 `includeSuperseded`。
- 过滤条件：`type`、`tags`（全部包含）、`project`、`dir`（ID 前缀）。

### 5.3 结果

每条：`id`、`title`、`summary`、`type`、`status`、`updated`、`score`，以及 1~2 段最佳匹配片段（命中词最多的行及其前后各一行，单段 ≤200 字）。

索引在内存中，启动时全量建立（千页级别应在 1 秒内），之后按页面增量更新；可缓存到 `.memwiki/search.json`，缓存以文件修改时间和大小校验。

## 6. 目录、精简上下文与体检

### 6.1 `index.md`（给人看的总目录）

按顶层目录分组（固定顺序：user、rules、projects 按项目再分组、topics、howto、decisions、reference，其他目录按字母序，inbox 最后只显示条目数），每页一行：`- [[id|title]] — summary`，状态非 active 的在行尾标注。顶部显示页数统计和生成时间。内容不变时不重写文件（避免无意义的 git 改动）。

### 6.2 精简上下文（会话开始注入给 AI）

`buildContext({ project, budgetBytes })`，默认预算 4096 字节（UTF-8），按顺序填充，超出预算就停并提示剩余页数：

1. 一行说明：库位置、页数、"写入前先搜索，规范见 [[_guide]]"。
2. `pinned` 页面。
3. `type: rule` 和 `type: user` 的页面。
4. 当前项目的页面（按 `updated` 新到旧）。
5. 其他页面按 `updated` 新到旧。
6. inbox 未整理条目数（>0 时提示需要整理）。

每行格式：`- [[id]] — summary`（`stale` 加"（可能过时）"）。

### 6.3 体检（lint）

| 问题 | 说明 | 可自动修 |
|---|---|---|
| `broken_link` | `[[目标]]` 解析不到 | 否 |
| `orphan` | 没有任何页面链接到它（`user/` `rules/` `inbox/` 除外） | 否 |
| `duplicate_title` | 多个页面标题或别名相同 | 否 |
| `missing_summary` | 缺少或空 summary | 否 |
| `invalid_meta` | 页头无法解析或必填字段缺失/取值非法 | 补齐可推断的默认值 |
| `stale_candidate` | `verified`（没有则 `updated`）早于 `staleDays` 天 | 标记 `status: stale` |
| `superseded_target_missing` | `superseded_by` 指向不存在的页面 | 否 |
| `oversized` | 正文超过 20 KB，建议拆分 | 否 |
| `inbox_backlog` | inbox 条目超过 20 条或最早一条超过 14 天 | 否 |
| `secret_suspect` | 已有内容命中敏感信息规则（外部编辑带进来的） | 否 |
| `uncommitted` | 库里有未提交的改动 | 提交 |

输出结构化问题列表（页面、问题、说明、是否可修），`fix: true` 时只做"可自动修"列里的修复，并作为一次 `[<agent>] lint` 提交。

## 7. 配置

解析优先级（高到低）：命令行参数 → 环境变量 → 库内 `memwiki.json` 的 `settings` → 默认值。

| 设置 | 命令行 | 环境变量 | 默认 |
|---|---|---|---|
| 库目录 | `--dir` | `MEMWIKI_DIR` | `~/memwiki` |
| 写入方 ID | `--agent` | `MEMWIKI_AGENT` | `agent` |
| 自动提交 | `--no-git` | `MEMWIKI_GIT=0` | 库是 git 仓库时开启 |
| 精简上下文预算（字节） | `--budget` | `MEMWIKI_CONTEXT_BUDGET` | 4096 |
| 过期天数 | — | — | 90 |
| 敏感信息扫描 | — | — | 开启 |

`memwiki.json`：

```json
{ "schemaVersion": 1, "name": "我的记忆库", "created": "2026-10-14", "settings": { "staleDays": 90, "contextBudget": 4096 } }
```

没有 `memwiki.json` 的目录不是库：除 `init` 外的命令都报错并提示先运行 `dsh-memwiki init`。`schemaVersion` 高于程序支持的版本时只读打开并警告。

## 8. 对外接口

### 8.1 MCP 服务（`dsh-memwiki serve`，stdio）

工具（名字以 `memwiki_` 开头）：

| 工具 | 作用 |
|---|---|
| `memwiki_context` | 返回精简上下文（§6.2），参数 `project?` |
| `memwiki_search` | 检索（§5），参数 `query`、`type?`、`tags?`、`project?`、`limit?`(默认 8)、`includeSuperseded?` |
| `memwiki_read` | 读页面：页头、正文、rev、反向链接、断链、"记录于 N 天前"提示；参数 `page`（ID/标题/别名） |
| `memwiki_write` | 写入（§4.1），参数 `page`、`mode`、`rev?`、`body?`/`text?`/`old?`/`new?`/`heading?`/`meta?`、`reason`、`source?` |
| `memwiki_remember` | 快速记录：追加到 `inbox/YYYY-MM.md`，同时返回最相关的 3 个已有页面，提示调用方考虑直接更新它们 |
| `memwiki_move` | 改名/移动并改写链接 |
| `memwiki_delete` / `memwiki_restore` | 删除到回收站 / 从回收站恢复 |
| `memwiki_lint` | 体检，参数 `fix?` |
| `memwiki_log` | 最近的变更，参数 `limit?` |

- 服务端 `instructions`（DSH 会注入系统提示）：短规则——任务开始调用 `memwiki_context`；写入前先 `memwiki_search`；更新已有页面优于新建；一个事实一个归属；不写密钥；读到旧内容先核实。不超过 1.5 KB。
- MCP prompts：`memwiki-ingest`（把 inbox 整理进正式页面的工作流）、`memwiki-lint`（体检并修复）。
- 写入方 ID 来自配置（`MEMWIKI_AGENT`），每个客户端配置各自的值。
- 工具返回中文为主的纯文本（便于模型阅读），错误返回 `isError` 并带错误码。

### 8.2 命令行（`dsh-memwiki`）

| 命令 | 作用 |
|---|---|
| `init [dir]` | 创建库：`memwiki.json`、目录骨架、`_guide.md`、`.gitignore`，并 `git init`（`--no-git` 跳过） |
| `serve` | 启动 MCP 服务（stdio） |
| `context [--project <名>]` | 打印精简上下文；供 SessionStart hook 使用。`--project` 缺省时取当前目录所在 git 根目录名 |
| `search <query>` / `read <page>` | 调试用 |
| `lint [--fix]` | 体检 |
| `reindex` | 重建检索缓存 |
| `setup <client>` | 打印（`--write` 时写入）对应客户端的 MCP + hook 配置：`claude` `codex` `cursor` `dsh` |
| `install-skill [--target ...]` | 把 `skills/memwiki` 复制到 `~/.claude/skills`、`~/.agents/skills`（Codex/DSH）、`~/.cursor/skills` |

### 8.3 DSH 插件

npm 包同时是 DSH 插件：`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，插入一个 `@deepseek-ai/dsh-mcp-client` 条目（`serverName: memwiki`，stdio 启动本包的 `serve`，`env.MEMWIKI_AGENT: dsh`），库目录通过 `MEMWIKI_DIR` 或插件配置传入。会话开始的上下文注入通过 MCP `instructions` + `memwiki_context` 完成；可选再挂 `@deepseek-ai/dsh-hooks-claude-code` 的 `SessionStart` 调 `dsh-memwiki context`。

## 9. 模块划分

```
src/
  types.ts          共享类型（契约）
  config.ts         配置解析（§7）                         T1
  core/
    ids.ts          页面 ID 规范化、校验、路径安全（§3.1）    T1
    page.ts         页头解析/序列化、rev（§3.2 §3.3）          T1
    links.ts        链接提取/改写（§3.4）                     已有基础版，T1 补改写
    secrets.ts      敏感信息扫描（§4.3）                      T1
    lock.ts         页面锁（§4.2）                            T1
    store.ts        页面读写、移动、删除、恢复、列表（§4）    T1
    git.ts          提交与重试（§4.4）                        T1
    log.ts          log.md 追加（§4.4）                       T1
    vault.ts        init、库标记校验（§2 §7）                 T1
  search/
    tokenize.ts     分词（§5.1）                              T2
    engine.ts       检索（§5.2 §5.3）                         T2
    catalog.ts      index.md 与精简上下文（§6.1 §6.2）        T2
    lint.ts         体检（§6.3）                              T2
  memwiki.ts        门面：组装 store + 检索 + 监视 + git      T3
  watch.ts          外部改动监视（§4.4）                      T3
  mcp/server.ts     MCP 服务（§8.1）                          T3
  cli.ts            命令行（§8.2）                            T3
```

T2 不依赖 T1 的实现：只用 `types.ts` 里的 `PageRecord`（已解析好的页面）作为输入，测试里自己构造数据。

## 10. 质量要求

- TypeScript，ESM，Node ≥ 20 运行（编译产物）；开发和测试用 Node ≥ 22.18（直接运行 `.ts`，所以只用可擦除语法：不用 `enum`、`namespace`、参数属性）。
- 测试用 `node --test`，每个模块有对应的 `test/*.test.ts`；文件系统相关的测试在临时目录里跑。
- Windows、macOS、Linux 都要能用：路径一律经过规范化，不假设分隔符。
- 公共函数写 JSDoc，说明契约（输入、输出、错误码），不写实现过程。
