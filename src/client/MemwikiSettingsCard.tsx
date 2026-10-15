import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { MemwikiSettingsCardProps } from './context.ts'
import type { ConfigView, VaultStatus } from '../dsh/protocol.ts'
import type { LintIssue } from '../types.ts'
import type { SecretAccess, SecretMeta } from '../secrets/store.ts'
import { SecretRevealController, copySecretTemporarily, type RevealState } from './secret-reveal.ts'
import { zh } from './locales.ts'

export type { MemwikiSettingsFace, MemwikiSettingsCardProps } from './context.ts'
const field: CSSProperties = { display: 'flex', flexDirection: 'column', gap: 8, padding: '14px 0', borderTop: '1px solid var(--dsw-alias-border-l2)' }
const input: CSSProperties = { height: 34, borderRadius: 8, border: '1px solid var(--dsw-alias-border-l2)', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', padding: '0 12px', fontSize: 13 }
const button: CSSProperties = { border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 16px', background: 'var(--dsw-alias-bg-layer-3)', color: 'var(--dsw-alias-label-primary)', cursor: 'pointer', fontSize: 13 }
const hint: CSSProperties = { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, margin: 0, lineHeight: 1.5 }

/** Desktop settings section; password inputs are write-only and cleared on every attempt. */
export function MemwikiSettingsCard({ api }: MemwikiSettingsCardProps) {
  const [config, setConfig] = useState<ConfigView>()
  const [status, setStatus] = useState<VaultStatus>()
  const [entries, setEntries] = useState<SecretMeta[]>([])
  const [protection, setProtection] = useState('')
  const [issues, setIssues] = useState<LintIssue[]>()
  const [log, setLog] = useState<SecretAccess[]>()
  const [reveal, setReveal] = useState<RevealState>({ kind: 'hidden' })
  const revealController = useRef<SecretRevealController>()
  const section = useRef<HTMLElement>(null)
  const [name, setName] = useState(''), [scope, setScope] = useState(''), [value, setValue] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('')
  const loadSecrets = async () => { const data = await api.secrets(); setEntries(data.entries); setProtection(data.protection) }
  useEffect(() => {
    const controller = new SecretRevealController(setReveal)
    revealController.current = controller
    const hide = () => controller.hide()
    const visibility = () => { if (document.hidden) hide() }
    const outside = (event: PointerEvent) => { if (event.target instanceof Node && !section.current?.contains(event.target)) hide() }
    window.addEventListener('blur', hide)
    window.addEventListener('pagehide', hide)
    document.addEventListener('visibilitychange', visibility)
    document.addEventListener('pointerdown', outside, true)
    // Clear on section teardown, including keyboard/programmatic settings navigation.
    return () => {
      controller.dispose(); revealController.current = undefined
      window.removeEventListener('blur', hide)
      window.removeEventListener('pagehide', hide)
      document.removeEventListener('visibilitychange', visibility)
      document.removeEventListener('pointerdown', outside, true)
    }
  }, [api])
  useEffect(() => {
    let active = true
    Promise.all([api.config(), api.status(), api.secrets()]).then(([c, s, secrets]) => {
      if (!active) return
      setConfig(c); setStatus(s); setEntries(secrets.entries); setProtection(secrets.protection)
    }).catch(() => { if (active) setError('读取失败，请检查插件配置后重试') })
    return () => { active = false }
  }, [api])
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError(''); setMessage('')
    try { await action() } catch { setError('操作失败，请检查输入、文件权限或稍后重试') }
    finally { setBusy(false) }
  }
  return <section ref={section} aria-label="记忆库" onBlur={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) revealController.current?.hide() }} style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '4px 4px 24px', color: 'var(--dsw-alias-label-primary, #1f2329)', fontSize: 13 }}>
    <h2 style={{ margin: 0, fontSize: 20, lineHeight: '28px' }}>记忆库</h2>
    <p style={{ ...hint, margin: '4px 0 12px' }}>共享 Markdown 记忆库与本机凭据</p>
    {error && <p role="alert" style={{ color: 'var(--dsw-alias-label-error, #c33)' }}>{error}</p>}
    {message && <p role="status">{message}</p>}
    {!config ? <p style={hint}>正在读取配置…</p> : <div style={field}>
      <label htmlFor="memwiki-dir">库目录</label>
      <input id="memwiki-dir" style={input} value={config.dir} disabled={busy} onChange={e => setConfig({ ...config, dir: e.target.value })} />
      <label><input type="checkbox" checked={config.autoPush} disabled={busy} onChange={e => setConfig({ ...config, autoPush: e.target.checked })} /> 自动推送到 git 远程</label>
      <p style={hint}>保存后重启 DSH 生效。自动推送需要库已配置 git 远程。</p>
      {config.overridden && <p style={hint}>MEMWIKI_DIR 环境变量优先，当前生效目录：{config.effectiveDir}</p>}
      <div><button style={button} disabled={busy || !config.dir.trim()} onClick={() => void run(async () => { setConfig(await api.save(config)); setStatus(await api.status()); setIssues(undefined); setMessage('已保存，重启 DSH 后生效') })}>保存</button></div>
    </div>}
    <div style={field}>
      <strong>库状态</strong>
      {status && <><p style={{ margin: 0 }}>目录：{status.dir}</p><p style={{ margin: 0 }}>{status.valid ? '合法记忆库' : '不是合法记忆库'} · {status.pages} 页 · inbox {status.inbox} 条 · git {status.git ? '已启用' : '未启用'} · 远程{status.remote ? '已配置' : '未配置'}</p>{status.error && <p style={hint}>{status.error}</p>}
        <strong>最近 5 条变更</strong>{status.recent.length ? <ul>{status.recent.map((e, i) => <li key={i}>{e.at} [{e.agent}] {e.action} {e.page}：{e.reason}</li>)}</ul> : <p style={hint}>暂无变更</p>}</>}
      <div style={{ display: 'flex', gap: 10 }}><button style={button} disabled={busy} onClick={() => void run(async () => setStatus(await api.status()))}>刷新状态</button><button style={button} disabled={busy || !status?.valid} onClick={() => void run(async () => setIssues((await api.health()).issues))}>体检</button></div>
      {issues && (issues.length ? <ul>{issues.map((e, i) => <li key={i}>[{e.code}] {e.page} {e.message}</li>)}</ul> : <p style={hint}>体检通过，无问题。</p>)}
      <p style={hint}>体检只读，不修复。</p>
    </div>
    <div style={field}>
      <strong>凭据库</strong><p style={hint}>{zh['secrets.hint']}</p>
      <p style={hint}>{protection === 'dpapi' ? 'Windows DPAPI：绑定当前用户，不能跨机器同步。' : protection === 'plain' ? '当前平台为明文文件存储，以 0600 文件权限保护。' : '正在读取保护方式…'}</p>
      {entries.length ? <table style={{ width: '100%', textAlign: 'left', borderCollapse: 'collapse' }}><thead><tr><th>名字</th><th>用途</th><th>更新时间</th><th>操作</th></tr></thead><tbody>{entries.map(e => {
        const secret = reveal.kind === 'revealed' && reveal.secret.name === e.name ? reveal.secret : undefined
        const selected = !!secret || (reveal.kind === 'loading' && reveal.name === e.name)
        return <tr key={e.name}><td>{e.name}</td><td>{e.scope}</td><td>{e.updated}</td><td>
          <div style={{ display: 'flex', gap: 8 }}>
            <button style={button} disabled={busy && !selected} onClick={() => {
              const controller = revealController.current
              if (!controller) return
              if (selected) { controller.hide(); return }
              void run(async () => {
                await controller.reveal(e.name, name => api.reveal(name))
                if (log && revealController.current === controller) setLog(await api.log())
              })
            }}>{selected ? zh['secrets.hide'] : zh['secrets.reveal']}</button>
            {secret && <button style={button} disabled={busy} title={zh['secrets.copyHint']} onClick={() => void run(async () => {
              await copySecretTemporarily(secret.value, navigator.clipboard)
              setMessage(zh['secrets.copied'])
            })}>{zh['secrets.copy']}</button>}
            <button style={button} disabled={busy} onClick={() => { if (window.confirm(`删除凭据 ${e.name}？不可恢复。`)) {
              revealController.current?.hide()
              void run(async () => { await api.delete(e.name); await loadSecrets(); if (log) setLog(await api.log()) })
            } }}>删除</button>
          </div>
          {secret && <code style={{ display: 'block', fontFamily: 'monospace', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', marginTop: 8 }}>{secret.value}</code>}
        </td></tr>
      })}</tbody></table> : <p style={hint}>暂无凭据</p>}
      <label htmlFor="memwiki-secret-name">名字（2–64 位，小写字母、数字、点、下划线、连字符）</label><input id="memwiki-secret-name" style={input} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
      <label htmlFor="memwiki-secret-scope">用途</label><input id="memwiki-secret-scope" style={input} value={scope} disabled={busy} placeholder="仅用于 localhost 开发实例" onChange={e => setScope(e.target.value)} />
      <label htmlFor="memwiki-secret-value">密码</label><input id="memwiki-secret-value" type="password" autoComplete="new-password" style={input} value={value} disabled={busy} onChange={e => setValue(e.target.value)} />
      <div style={{ display: 'flex', gap: 10 }}><button style={button} disabled={busy || !name || !scope.trim() || !value} onClick={() => {
        if (entries.some(e => e.name === name) && !window.confirm(`凭据 ${name} 已存在，覆盖？`)) return
        const password = value; setValue('')
        revealController.current?.hide()
        void run(async () => { await api.set(name, scope, password); setName(''); setScope(''); await loadSecrets(); if (log) setLog(await api.log()); setMessage('凭据已保存') })
      }}>新增 / 更新</button><button style={button} disabled={busy} onClick={() => void run(async () => setLog(await api.log()))}>查看访问日志</button></div>
      {log && (log.length ? <ul>{log.map((e, i) => <li key={i}>{e.at} [{e.agent}] {e.action} {e.name}：{e.purpose}</li>)}</ul> : <p style={hint}>暂无访问日志</p>)}
    </div>
  </section>
}
