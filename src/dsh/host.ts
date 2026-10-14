import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { makeRoutes } from './routes.ts'

export const name = 'memwiki-host'
export const inject = ['webServer']
/** Separate host entry; leaves the package's public API entry intact. */
export function apply(ctx: Context): void {
  ctx.effect(() => {
    const disposers: (() => void)[] = []
    try { for (const route of makeRoutes()) disposers.push(ctx.webServer.register(route)) }
    catch (e) { for (const dispose of disposers) dispose(); throw e }
    return () => { for (const dispose of disposers) dispose() }
  }, 'dsh-memwiki: routes')
}
