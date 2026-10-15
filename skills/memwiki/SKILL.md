---
name: memwiki
description: 使用共享记忆 wiki（dsh-memwiki）跨会话、跨 AI 记住和回忆知识。任务开始回忆；用户说“记住”“以后都这样”、纠正做法、解决难题、做出决定或发现非显然项目知识时写入；问“之前”“上次”时检索。
---

# 共享记忆 wiki

多个 AI 和用户共用 Markdown / Obsidian 长期记忆。
**细则以库里 `_guide` 为准，任务开始若没读过就 `memwiki_read _guide`。**

## 核心五条

1. 任务开始 `memwiki_context`（已注入可跳过）；相关时先搜索再读全文，旧内容先核实。
2. 写前先搜；一个事实一个归属，纠正优先于补充，直接改旧页，只写当前正确说法。无归属才新建，拿不准用 remember。
3. 带 reason/source；更新带 rev，CONFLICT 重读。相似拦截先看候选；核实后 verify；重复页用 merge。
4. 页面不写凭据值，只留 `secret:<名字>`；不记临时状态或看代码/git 就知道的信息，不复制内容到新页。
5. 整理用 memwiki-curate；工具问题、规则不清或有价值的搜索缺口用 memwiki_feedback。禁止改写 git 历史。

## 凭据取用四步

1. 搜服务名，找引用或取用位置。
2. secret_list 核对名字与 scope。
3. secret_get 写具体 purpose，仅按 scope 使用；不回显，不落文件、页面、提交或日志。
4. 都没有才问用户；明确要求记住低风险凭据才 secret_set，带 scope。高风险凭据禁存，详见 `_guide`。

## 工具不可用时

按 `_guide` 直接改库文件，保持页头、更新 updated/updated_by，做普通提交。
不 amend/rebase 已推送提交，不 force push、不 squash、不删除或重建 `.git`。
