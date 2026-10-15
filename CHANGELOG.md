# Changelog

## 0.2.1（未发布）

- `INVALID_META` 返回字段名和具体原因，错误 details 保留结构化字段信息，MCP 正常显示。
- `memwiki_write` 所有模式均可用 title/summary 更新页头；append 修改页头须带 rev。
- `memwiki_write.meta` 兼容对象或 JSON 字符串，tags/aliases 的逗号分隔字符串自动规范为数组。
- section 替换时去掉 body 开头与目标同名的标题行，避免重复标题。
- create 拒绝超过 120 个字符的 summary，报告当前长度，工具 schema 明示限制。
- create 遇到 `_` 开头的文件名时明确提示其保留给特殊页面。

## 0.2.0（未发布）

- 新建相似页拦截 `SIMILAR_EXISTS`，支持注明理由后 force；remember 不拦截。
- 新增 merge（链接改写、别名迁移、保留旧页跳转、一次提交）和 verify（刷新核实日期、恢复 stale）。
- 内容体检新增 overlap、fact_repeat 和 feedback_open；新增按月反馈与解决状态、本地脱敏使用信号及统计。
- MCP / CLI 增加维护接口，新增 memwiki-curate 整理流程；规则细则统一放在库内 `_guide`，skill 与服务说明保留摘要。

## 0.1.0（未发布）

- 首个版本。
