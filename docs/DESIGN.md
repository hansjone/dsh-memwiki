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
  meta/feedback/    工具与规则反馈，按月一个 YYYY-MM.md（type: meta）
  inbox/            快速记录，按月一个文件 inbox/YYYY-MM.md，定期整理进正式页面
  .trash/           回收站（删除的页面，保留原相对路径 + 时间戳后缀）
  .memwiki/         本地缓存、锁与 usage.jsonl 使用信号（git 忽略）
```

- 目录是约定，不是强制：任何 `.md` 文件都是页面。`.trash/`、`.memwiki/`、`.obsidian/`、`.git/` 以及 `node_modules/` 不扫描。
- **特殊文件**：`index.md`、`log.md` 是生成文件，不作为页面参与检索和目录；`_guide.md` 可被 `read` 读取，但不进目录和检索。文件名以 `_` 开头的都按这个规则处理。

## 3. 页面

### 3.1 页面 ID

页面 ID = 相对库根目录的路径，去掉 `.md`，分隔符统一为 `/`，例如 `projects/myapp/发布流程`。

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
sources: [session:claude/7f3a91c2, file:myapp/scripts/start.ps1]
project: myapp
---
正文……
```

| 字段 | 必填 | 说明 |
|---|---|---|
| `title` | 是 | 页面标题 |
| `summary` | 是 | 一行摘要（≤120 字），会进目录，必须独立可读 |
| `type` | 是 | `user` `rule` `project` `topic` `howto` `decision` `reference` `inbox` `meta` |
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

`rev` = 文件原始字节的 SHA-256 前 12 位十六进制。`read` 返回 rev；普通写入除 `create` 和 `append` 外必须带 rev，不一致返回 `CONFLICT`（附当前 rev），调用方重新读取后再改。merge 校验目标 rev；verify 只改核实字段、内部加锁而无需 rev；feedback 的追加/解决在内部取锁并读取当前版本。

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

#### 新建相似页拦截（0.2.0）

create 在结构锁和页面锁内读取最新页面集合，准备并校验新内容后、落盘前检查相似页。inbox、meta、特殊页和 superseded 不参与；remember 保持直接写 inbox，不拦截。force 仍执行 ID/元数据/敏感扫描等全部校验。

比较使用标题、摘要和正文前 2000 个字符，不依赖模型或词库。NFKC、转小写、只保留字母数字后：标题二元组 Jaccard 为 T，摘要二元组 Jaccard 为 S；正文去双链、Markdown 链接及标题行后，双方各至少 40 字，按五字符 shingle Jaccard 得 B，否则 B=0。相似度是 `max(0.8T+0.2S, 0.9B, 0.45(0.8T+0.2S)+0.55B)`，范围 [0,1]。这是可解释的字符重叠机制，并不判断语义真伪。

分数达到 `similarCreateThreshold` 且大于 0 时返回 `SIMILAR_EXISTS`，details.candidates 最多 3 条，按分数排序，每条含 id/title/summary/similarity。提示“更新已有页面；确实是不同主题时带 force 并写明理由”。`force: true` 只跳过相似检查，必须有非空 reason，原文进日志；拦截和后续强制创建分别记使用信号。

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
- **多机同步**：`git.autoPush` 开启且库配置了远程时，提交后防抖 30 秒执行一次 `git push`；推送失败（离线、被拒）只记录警告，不影响写入，下次再推。`dsh-memwiki sync` 手动同步：`git pull --rebase --autostash` 后 `push`；变基冲突时中止变基、保持本地不变，并列出冲突文件让用户或 AI 处理。git 同步凭据走 git 自己的凭据机制（凭据管理器、SSH key），本工具不托管这类凭据；低风险开发/测试凭据另见 §11。
- `log.md` 每次写入追加一行：`- 2026-10-14 20:31 [claude] 更新 [[projects/myapp/发布流程]]：补充打包时的 PATH 坑`。按月分节（`## 2026-10`），新的在最上面。

### 4.5 删除与回收站

`delete` 把文件移到 `.trash/<原路径>.<时间戳>.md`，同时扫描反向链接，在结果里返回"这些页面还链接着它"。`restore` 从回收站恢复（原 ID 被占用时报 `EXISTS`）。没有永久删除接口。

### 4.6 合并与核实

- `merge({ from: string[], into, body?, meta?, rev, ctx })`：调用方先核对归属，把整合后的正文放 body；省略则保留目标正文。必须先确认被删除的独有信息已在归属页存在。
- 合并持有结构锁和按 ID 排序的页面锁，先解析所有引用、校验非空/不重复的 from、不包含 into、页面存在、目标 rev 一致且目标不为 superseded；准备所有输出并完成元数据/敏感扫描后才开始写。校验失败时页面、目录、日志和 git 均不变。与已有 move 相同，跨文件 I/O 故障不是文件系统事务，不承诺断电回滚。
- 源文件保留，不进回收站：status=superseded、superseded_by=目标 ID，正文仅“已合并到 [[目标ID]]”。为让旧标题/别名可唯一定位归属页，源页标题变为“已合并：源ID”、摘要改为跳转说明、aliases 清空；源页旧标题及别名并入目标 aliases（大小写不敏感去重）。旧 ID 仍可直接读跳转页，原内容由 git 历史保留。
- 全库正文中指向源 ID、标题、别名的双链复用 move 的 rewriteLinks 改写为目标 ID，保留显示文字、标题和空白，不碰代码内示例。目标的新正文也改写。一次 afterMutation 生成目录、一条日志、一次 git 提交：`[<agent>] merge A, B -> C：<reason>`。
- `verify(ref, { note?, ctx })`：解析页面后取页面锁并重新读取，仅把 verified 设为本地今天，status=stale 时恢复 active；不改正文、updated、updated_by、sources 等字段，无需 rev。独立日志/提交的 reason 用 note（没有则 ctx.reason）。**AI 读到并核实过就调用 verify**；不能核实则保持 stale 并标待核实。过时判断继续使用 verified ?? updated。

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
- 过滤条件：`type`、`tags`（全部包含）、`dir`（ID 前缀）。`project` 只加权不过滤；要只看某个项目用 `dir: 'projects/<name>/'`。

### 5.3 结果

每条：`id`、`title`、`summary`、`type`、`status`、`updated`、`score`，以及 1~2 段最佳匹配片段（命中词最多的行及其前后各一行，单段 ≤200 字）。

索引在内存中，启动时全量建立（千页级别应在 1 秒内），之后按页面增量更新；可缓存到 `.memwiki/search.json`，缓存以文件修改时间和大小校验。

## 6. 目录、精简上下文与体检

### 6.1 `index.md`（给人看的总目录）

按顶层目录分组（固定顺序：user、rules、projects 按项目再分组、topics、howto、decisions、reference、meta，其他目录按字母序，inbox 最后只显示条目数），每页一行：`- [[id|title]] — summary`，状态非 active 的在行尾标注。顶部显示页数统计和生成时间。内容不变时不重写文件（避免无意义的 git 改动）。

### 6.2 精简上下文（会话开始注入给 AI）

`buildContext({ project, budgetBytes })`，默认预算 4096 字节（UTF-8），按顺序填充，超出预算就停并提示剩余页数：

1. 一行说明：库位置、页数、"写入前先搜索，规范见 [[_guide]]"；有 open 反馈时加“有 N 条反馈待处理”（优先于目录条目保留）。
2. `pinned` 页面。
3. `type: rule` 和 `type: user` 的页面。
4. 当前项目的页面（按 `updated` 新到旧）。
5. 其他页面按 `updated` 新到旧（inbox 和 meta/feedback 页面不逐条列出；superseded 不进精简上下文）。
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
| `overlap` | 非特殊正式页正文五字符 shingle Jaccard 达 overlapThreshold，双方至少 40 字；忽略双链/Markdown 链接与标题行 | 否 |
| `fact_repeat` | 同一关键事实 token 出现于 ≥3 页，提醒确认唯一归属、其他页改链接 | 否 |
| `feedback_open` | open 反馈 >0 时只报一条汇总 | 否 |

输出结构化问题列表（页面、问题、说明、是否可修），`fix: true` 时只做"可自动修"列里的修复，并作为一次 `[<agent>] lint` 提交。

内容检查不包含 inbox、meta、superseded、`_guide` 等特殊页。原 LintIssue 字段保持不变，新增可选 severity/pages/similarity/token：overlap 为 warning，最多 20 对；fact_repeat 为 info，按 token 聚合、按涉及页数降序最多 10 条，消息最多展示 10 页（结构化 pages 保留全部）。关键事实规则表在 `search/facts.ts`：合法 IPv4、两至三段数字版本（v 前缀可带四段）、Windows 绝对路径（斜线统一且大小写归一）、Unix 绝对路径、1–65535 的冒号端口；忽略普通 URL 和时钟时间。每页每 token 只计一次；疑似凭据页不输出 token。仅链接里引用 IP 不会触发 overlap；fact_repeat 可以提示，调用方须判断是否合理引用。

## 7. 配置

库目录：命令行 `--dir` → 环境变量 `MEMWIKI_DIR` → `~/.dsh/dsh-memwiki.json` 的 `dir` → `~/memwiki`。自动推送：命令行 → 环境变量 → DSH 设置文件的 `autoPush` → 库设置 → 默认关闭。其余配置仍为命令行 → 环境变量 → 库内 `memwiki.json` 的 `settings` → 默认值。

| 设置 | 命令行 | 环境变量 | 默认 |
|---|---|---|---|
| 库目录 | `--dir` | `MEMWIKI_DIR` | `~/memwiki` |
| 写入方 ID | `--agent` | `MEMWIKI_AGENT` | `agent` |
| 自动提交 | `--no-git` | `MEMWIKI_GIT=0` | 库是 git 仓库时开启 |
| 自动推送 | `--push` / `--no-push` | `MEMWIKI_GIT_PUSH=1` | 关闭；库里 `settings.autoPush` 可开 |
| 精简上下文预算（字节） | `--budget` | `MEMWIKI_CONTEXT_BUDGET` | 4096 |
| 过期天数 | — | — | 90 |
| 敏感信息扫描 | — | — | 开启 |
| 新建相似阈值 `similarCreateThreshold` | — | — | 0.72 |
| 正文重叠阈值 `overlapThreshold` | — | — | 0.70 |

`memwiki.json`：

两个相似阈值均为库 `settings` 中的 [0,1] 有限数值；省略时机制使用表内默认值。提高阈值可减少拦截，阈值 1 只匹配满分，不把零分视为命中。

```json
{ "schemaVersion": 1, "name": "我的记忆库", "created": "2026-10-14", "settings": { "staleDays": 90, "contextBudget": 4096, "autoPush": false } }
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
| `memwiki_merge` | 参数 from[]、into、rev、body?、meta?、reason；合并并保留源页跳转，见 §4.6 |
| `memwiki_verify` | 参数 page、note?；核实日期，stale 恢复 active，无需 rev |
| `memwiki_feedback` | action=add（默认，kind/title/scenario/expected/actual）、list（all?）、resolve（id/resolution），见 §13 |
| `memwiki_usage` | days? 默认 7，返回各事件次数与零结果查询 Top 10 |
| `memwiki_delete` / `memwiki_restore` | 删除到回收站 / 从回收站恢复 |
| `memwiki_lint` | 体检，参数 `fix?` |
| `memwiki_log` | 最近的变更，参数 `limit?` |

- 服务端 `instructions`（DSH 会注入系统提示）仅保留核心摘要，不超过 1.5 KB；细则见 `_guide`，工具不好用时用 memwiki_feedback 记下。memwiki_write 新增可选 force（仅 create 使用），reason 必填。
- MCP prompts：`memwiki-ingest`、兼容保留 `memwiki-lint`，新增 `memwiki-curate`：lint → 判断 overlap/fact_repeat 归属并 merge/edit → stale 核实后 verify、否则标待核实 → inbox 归档 → open 反馈和 usage 汇总（只汇报不改代码）→ 再次 lint。纠正优先于补充，只写当前正确说法，删除前确认已在归属页存在，不改写 git 历史。
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
| `merge <from>... --into <page> --rev <rev> --reason <说明> [--body-file <md>] [--meta-file <json>]` | 一次合并，正文/元数据可从文件读入 |
| `verify <page> [--note <说明>]` | 核实后刷新日期 |
| `usage [--days 7]` | 汇总本地事件次数及零结果查询 Top 10 |
| `feedback list [--all]` | 默认只列 open 反馈，all 包含已解决 |
| `reindex` | 重建检索缓存 |
| `sync` | 与远程仓库同步（§4.4 多机同步） |
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

## 11. 凭据库

凭据与 Markdown 库严格分开：页面只写 `secret:<名字>`，密码/token 不进入页面、git、检索、目录或页面日志。只允许本地开发、测试账号、内网设备等低风险用途；银行、邮箱、主账号和生产环境密码不要存。

- 默认 `~/.memwiki/secrets.json`；`MEMWIKI_SECRETS_FILE` / `--secrets-file` 可覆盖，禁止放进 wiki（包括符号链接指向库内）。覆盖路径的访问日志也放在其旁边，默认即 `~/.memwiki/secrets-access.log`。
- 文件格式 `{ version: 1, protection: 'dpapi' | 'plain', entries: [...] }`；每条 `{ name, scope, value, created, updated, updated_by }`，名字规则 `^[a-z0-9][a-z0-9._-]{1,63}$`，用途必填。
- Windows 的 `value` 是 DPAPI CurrentUser 密文 base64。固定 PowerShell 脚本通过子进程 stdin/stdout 传递数据，密码不出现在命令行；stderr 不转发，加密失败不退回明文。其他平台第一版为明文，以文件 0600、父目录 0700 保护。保护方式写入文件以防误解码。
- `Protector` 提供 `kind`、异步 `protect(plain)` / `unprotect(stored)`，可注入测试实现和将来的加密后端。
- `SecretStore` 提供 `list/get/set/delete/accessLog`；列表及写入结果只含元数据。读写复用 `core/lock.ts`，锁在凭据文件旁边的 `.memwiki/locks`；凭据和 JSON Lines 日志均复用 `core/fs.ts` 原子写。错误固定脱敏，不带底层异常或 cause。
- 日志字段仅 `at/agent/action/name/purpose`，动作 get/set/delete，get 的用途必填。日志按最新到最旧读取，limit 为 1–1000。写入前先记录操作，保留失败操作的审计轨迹。
- MCP 四个工具 `memwiki_secret_list/get/set/delete`；取值同时返回 scope 和“只用于 scope，不回显、不落文件或页面”的提醒。仅用户明确要求记住密码时 set。页面敏感扫描报错提示改用凭据库。
- CLI `secret list|get <name>|set <name> --scope <说明>|rm <name>|log [--limit N]`，支持 `--secrets-file`。set 从无回显终端输入或 stdin 第一行读取，不接受密码参数；get 可带 `--purpose`，明确向 stdout 取值。
- DSH 桌面设置页默认不显示凭据值；用户点击“显示”后显示 10 秒，查看会记入访问日志（`agent: human`、`purpose: DSH 设置页查看`），日志不含值。手动隐藏、显示另一条、切换设置页、卡片卸载或窗口失焦时立即清除组件中的值；显示期间可复制，30 秒后仅在剪贴板仍为该值且可读取时尝试清空。

## 12. DSH 设置卡片

配置 `{ dir, autoPush }` 原子保存到 `~/.dsh/dsh-memwiki.json`；命令行、MCP、host 和 patch 共用目录优先级。保存后需重启 DSH，不依赖未确认的 MCP 热重连。

- host 独立入口 `src/dsh/host.ts` → `lib/dsh-host.js`，公共 API `lib/index.js` 也导出 host 插件。patch 的 host 条目保持包名 `dsh-memwiki`；文件路径会导致 DSH 插件列表读取失败。client-modules 按所属 package.json 发现 `dsh.client`（普通子路径不会被它扫描）。
- `/api/dsh-memwiki/config` GET/PUT；`status` GET；`lint` POST；`secrets` GET/POST/DELETE；`secrets/log` GET；`secrets/reveal` 仅 POST，请求 `{ name }`，通过 `SecretStore.getWithScope` 返回 `{ name, scope, value }` 并审计查看操作。路由只接受 loopback 与浏览器同源请求，响应 no-store；其他凭据接口仍不返回值，错误信息不含值。HTTP 无关服务和分发函数可单测。
- 状态/体检直接读 Store、manifest、links、log、git 和 lintRecords；不调用会写索引/启动监视器的 Memwiki.open，不修复、不提交、不推送。
- client `src/client/index.ts` → `lib/client.js`，`dsh.client` 与 `exports["./client"]` 注册浏览器半。按 trilium 兼容规则只硬注入 slots + locale，注册 settings.section（id=memwiki，与 host 命名空间分开），不用 settings.plugin.item / dsh-client-runtime / settingsScope；挂载失败仅记录固定诊断，避免 GUI 崩溃。
- 卡片沿用 trilium 的 DSH CSS 变量、输入框和按钮风格，桌面布局，中文；密码输入仅用于写入并在提交时清空，凭据列表只含元数据。用户主动查看后在该行以等宽字体显示明文，同一时间只显示一条；隐藏会移除状态中的值并使未完成的查看请求失效。

## 13. 反馈与使用信号（0.2.0）

- `feedback({ kind: bug|friction|missing|rule, title, scenario, expected, actual, ctx })` 写到 `meta/feedback/YYYY-MM.md`（type=meta）。每条有随机 12 位十六进制短 ID（feedback- 前缀）、本地日期、agent、kind、标题、状态 open，正文分别列场景、期望、实际。追加与 resolve 在跨进程反馈锁内完成，普通存储层仍做敏感扫描，反馈不能包含凭据值或保留的条目标记。
- `feedbackResolve(id, resolution, ctx)` 只替换对应条目的状态为“已解决：<resolution>”（非空单行）；找不到或多条同 ID 报错。不删反馈历史。MCP 合并到 memwiki_feedback action=resolve，list 默认 open，all 含已解决。meta 进入 index 分组；context 不逐页列反馈，只显示待处理数量。
- 门面捕获搜索零结果 SEARCH_ZERO、CONFLICT、SECRET_DETECTED、EDIT_NOT_FOUND、AMBIGUOUS_EDIT、SIMILAR_EXISTS，以及成功强制新建 FORCE_CREATE。MCP/CLI 共用这条路径；不对凭据工具取用记录 usage。SECRET_DETECTED 仅记录扫描规则类别，绝不保存匹配内容、错误文本或写入输入。
- 使用信号为 `<vault>/.memwiki/usage.jsonl`，模板 gitignore 已忽略 `.memwiki/`。字段限于 UTC 时间、agent、事件、查询（仅 SEARCH_ZERO，最长 500 字符，疑似凭据整条脱敏）、页面 ID 的 SHA-256 前 12 位哈希、敏感扫描规则名。SIMILAR_EXISTS 与后续 FORCE_CREATE 通过同一 pageKey 关联；没有 FORCE_CREATE 记录代表未观察到成功强制创建。绝不记录页面正文、写入 reason/source、查询之外的用户内容、凭据值。
- 写入在独立锁内排队追加；下一行使文件超过 1 MiB 时将当前文件轮转为 usage.jsonl.1，覆盖旧备份，只保留一代。close 和 usage 汇总会等待本进程队列清空；统计读取两代文件，按 days 过滤，忽略损坏行。日志失败只发固定警告，不改变业务返回，不回显内容。
- `usage [--days 7]` / memwiki_usage 输出各事件次数与零结果查询 Top 10（次数降序）；usage 仅是工具改进线索，不能自动据此改代码。

## 14. 规则的唯一正文

`templates/vault/_guide.md` 是新库规范正文的唯一模板；运行时规则住在库内 `_guide`，AI 任务开始若没读过就读取它。回忆、写入、凭据取用四步、禁止项、维护与反馈细则全部在这里。`skills/memwiki/SKILL.md` 约 30 行，仅触发条件、核心五条和凭据/历史禁改摘要；MCP INSTRUCTIONS 同样摘要并指向 `_guide`。规则修改不用重装 skill，已有库不被代码升级静默覆盖。

核心约定：一个事实一个归属；纠正优先于补充，发现旧说法不对直接改旧页；页面只写当前正确的说法；整页重复或被替代用 merge；读到并核实过就 verify；遇到可复现工具问题、规则不清或反复搜索缺口用 feedback，一次普通零结果、可通过正常重读解决的冲突不用记录反馈。整理时先确认信息已在归属页再删源内容，禁止改写 git 历史。工具行为与代码改进只汇报，由另行确认的实现任务处理。
