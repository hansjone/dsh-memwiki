export const zh = {
  'settings.title': '记忆库',
  'secrets.hint': '仅保存本地开发、测试账号、内网设备的低风险凭据。银行、邮箱、主账号和生产环境密码不要存。页面写 secret:<名字>。默认不显示密码，点击后显示 10 秒，查看会记入访问日志。',
  'secrets.reveal': '显示',
  'secrets.hide': '隐藏',
  'secrets.copy': '复制',
  'secrets.copyHint': '复制后 30 秒，若剪贴板仍为此值则自动清空。',
  'secrets.copied': '已复制，30 秒后尝试清空剪贴板',
}
export type MemwikiKey = keyof typeof zh
