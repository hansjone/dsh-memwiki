import type { Context } from '@deepseek-ai/cordis'
import type { ComponentType } from 'react'
import type { MemwikiApi } from './api.ts'

/** The settings slots and locale calls exposed by the DSH desktop host. */
export interface MemwikiSettingsFace { api: MemwikiApi }
export interface MemwikiSettingsCardProps extends MemwikiSettingsFace { t?: (key: 'settings.title') => string }
export type MemwikiClientContext = Omit<Context, 'locale'> & {
  locale: {
    register(namespace: 'dsh-memwiki', dictionaries: Record<'zh' | 'en', Record<'settings.title', string>>): () => void
    bind(namespace: 'dsh-memwiki'): (key: 'settings.title') => string
  }
  slots: {
    inject(name: 'settings.section', mount: () => () => void): unknown
    register(options: { name: 'settings.section'; id: string; order: number; label: () => string; locale: string; inject: () => MemwikiSettingsFace }, component: ComponentType<MemwikiSettingsCardProps>): () => void
  }
}
