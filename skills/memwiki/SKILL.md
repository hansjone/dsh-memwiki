---
name: memwiki
description: 使用共享记忆 wiki（dsh-memwiki）跨会话、跨 AI 记住和回忆知识。任务开始时回忆相关背景；用户说"记住""以后都这样"、纠正你的做法、或你解决了难题、做了决定、发现了看代码看不出来的项目知识时写入；用户问"之前怎么做的""上次那个"时检索。Use the shared memory wiki to recall context at task start and to record durable, non-obvious knowledge.
---

# 共享记忆 wiki

这个 wiki 由多个 AI（DeepSeek Harness、Claude、Codex、Cursor）和用户共用，存在一个 Markdown 文件夹里，用户在 Obsidian 里看。完整规则在库里的 `[[_guide]]`，用 `memwiki_read` 读 `_guide`。

## 回忆

1. **任务开始**：调用 `memwiki_context`（会话开始已注入就跳过），看目录里有没有和当前任务相关的页面。
2. **有可能相关时就搜**：`memwiki_search`，用两三个关键词，中文英文都行。不要凭印象说"之前没记过"。
3. **读全文**：`memwiki_read`。注意返回里的"记录于 N 天前"：涉及代码、配置、路径的内容，先核实当前状态再用；已经不对了就顺手改正。

## 写入

判断标准：**换一个 AI、下周新开会话，没有这条信息会不会做错事或多走弯路？** 会，就记。

1. **先搜**：`memwiki_search` 找有没有相关页面。
2. **有就更新**：`memwiki_read` 拿到 `rev`，再用 `memwiki_write`：
   - 改一节：`mode: section` + `heading`
   - 改一句：`mode: edit` + `old` / `new`（`old` 要在页面里恰好出现一次）
   - 加一条：`mode: append`
3. **没有才新建**：`mode: create`，必须给 `title` 和一句话 `summary`；放进对应目录（`user/`、`rules/`、`projects/<项目>/`、`topics/`、`howto/`、`decisions/`、`reference/`）。
4. **拿不准归属**：`memwiki_remember` 先记进 inbox。它会返回最相关的已有页面，合适就直接更新那一页。
5. 每次写入都要写 `reason`（为什么改），有依据就写 `source`。

规则类内容写三段：**规则** / **为什么** / **怎么用**。日期写绝对日期。

## 禁止

- 密码、token 不写进页面；低风险的（本地开发、测试账号、内网设备）存凭据库（用户明确要求时用 `memwiki_secret_set`），页面里写 `secret:<名字>`；银行、邮箱、主账号、生产环境的密码不要存。取值必须说明 purpose，仅按 scope 使用，不回显给用户，不写进文件或页面。
- 不记看代码或 git 记录就能知道的东西，不记只对当前会话有用的临时状态。
- 不复制已有内容到新页面，用 `[[双链]]` 指过去。
- 收到 `CONFLICT` 时不要强行覆盖：重新 `memwiki_read`，在最新内容上再改。

## 维护

- 用户要求"整理记忆"时：用 `memwiki-ingest` 流程，把 inbox 里的条目归入正式页面，归完的从 inbox 删掉。
- 用户要求"体检"时：`memwiki_lint`，先汇报问题，安全的修复用 `fix: true`，其余的逐条处理或询问用户。

## 没有 memwiki 工具时

库目录里直接改 Markdown 文件：保持页头格式，更新 `updated` 和 `updated_by`，然后 `git commit -m "[<你的名字>] 更新 <页面>：<原因>"`。
