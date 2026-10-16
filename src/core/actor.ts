import { AsyncLocalStorage } from 'node:async_hooks'

/** Set only by the authenticated remote entry point; never taken from tool arguments. */
export interface RemoteActor { sub: string; name: string }
export const remoteActor = new AsyncLocalStorage<RemoteActor>()

export function actorSource(actor: RemoteActor): string {
  return `hub:${actor.sub} (${actor.name})`
}
