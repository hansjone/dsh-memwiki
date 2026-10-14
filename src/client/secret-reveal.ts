import type { RevealedSecret } from '../dsh/protocol.ts'

export const REVEAL_MS = 10_000
export const CLIPBOARD_MS = 30_000
export type RevealState = { kind: 'hidden' } | { kind: 'loading'; name: string } | { kind: 'revealed'; secret: RevealedSecret }
/** Returns a cancellation function, allowing time to be controlled in unit tests. */
export type Schedule = (ms: number, callback: () => void) => () => void
const schedule: Schedule = (ms, callback) => {
  const timer = setTimeout(callback, ms)
  return () => clearTimeout(timer)
}

/** One visible credential; hiding also invalidates any pending reveal response. */
export class SecretRevealController {
  private current: RevealState = { kind: 'hidden' }
  private generation = 0
  private cancel?: () => void
  private disposed = false
  private changed: (state: RevealState) => void
  private after: Schedule
  constructor(changed: (state: RevealState) => void, after: Schedule = schedule) {
    this.changed = changed
    this.after = after
  }
  get state(): RevealState { return this.current }
  private update(state: RevealState) { this.current = state; this.changed(state) }
  hide(): void {
    this.generation++
    this.cancel?.(); this.cancel = undefined
    if (!this.disposed) this.update({ kind: 'hidden' })
  }
  async reveal(name: string, get: (name: string) => Promise<RevealedSecret>): Promise<boolean> {
    if (this.disposed) return false
    this.hide()
    const generation = this.generation
    this.update({ kind: 'loading', name })
    try {
      const secret = await get(name)
      if (this.disposed || generation !== this.generation) return false
      if (secret.name !== name) throw new Error('凭据响应无效')
      this.update({ kind: 'revealed', secret })
      this.cancel = this.after(REVEAL_MS, () => this.hide())
      return true
    } catch (e) {
      if (this.disposed || generation !== this.generation) return false
      this.hide()
      throw e
    }
  }
  dispose(): void {
    this.hide()
    this.disposed = true
    this.changed = () => {}
  }
}

/** Clipboard cleanup survives card unmount; denied reads/writes are silently skipped. */
export async function copySecretTemporarily(value: string, clipboard: Pick<Clipboard, 'writeText' | 'readText'>, after: Schedule = schedule): Promise<void> {
  await clipboard.writeText(value)
  let copied: string | undefined = value
  after(CLIPBOARD_MS, () => {
    void (async () => {
      try { if (await clipboard.readText() === copied) await clipboard.writeText('') }
      catch { /* Clipboard permissions may have changed after copying. */ }
      finally { copied = undefined }
    })()
  })
}
