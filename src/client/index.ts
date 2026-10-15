import type { Context } from '@deepseek-ai/cordis'
import type { MemwikiClientContext } from './context.ts'
import { MemwikiApi } from './api.ts'
import { MemwikiSettingsCard, type MemwikiSettingsFace } from './MemwikiSettingsCard.tsx'
import { zh } from './locales.ts'
// Register the desktop settings section; mounting failures must not bring down the GUI.
export const inject = ['slots', 'locale']
export function apply(context: Context): void {
  const ctx = context as MemwikiClientContext
  try {
    ctx.effect(() => ctx.locale.register('dsh-memwiki', { zh, en: zh }), 'dsh-memwiki: dictionaries')
    const api = new MemwikiApi()
    const t = ctx.locale.bind('dsh-memwiki')
    ctx.slots.inject('settings.section', () => {
      try {
        return ctx.slots.register({ name: 'settings.section', id: 'memwiki', order: 29, label: () => t('settings.title'), locale: 'dsh-memwiki', inject: (): MemwikiSettingsFace => ({ api }) }, MemwikiSettingsCard)
      } catch { ctx.logger?.error?.('dsh-memwiki: settings.section 注册失败'); return () => {} }
    })
  } catch { ctx.logger?.warn?.('dsh-memwiki: 设置页挂载失败') }
}
