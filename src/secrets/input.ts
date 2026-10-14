import { emitKeypressEvents } from 'node:readline'
import { MemwikiError } from '../types.ts'

/** Hidden terminal input, or the first piped line. The value is never echoed. */
export async function readSecretInput(): Promise<string> {
  if (!process.stdin.isTTY) {
    process.stdin.setEncoding('utf8')
    let text = ''
    for await (const chunk of process.stdin) {
      text += chunk.toString('utf8')
      const line = text.indexOf('\n')
      if (line !== -1) return text.slice(0, line).replace(/\r$/, '')
    }
    return text.replace(/\r$/, '')
  }
  process.stderr.write('密码（输入不回显）：')
  emitKeypressEvents(process.stdin)
  const oldRaw = process.stdin.isRaw
  const wasPaused = process.stdin.isPaused()
  process.stdin.setRawMode(true)
  process.stdin.resume()
  return new Promise((resolve, reject) => {
    let value = ''
    const cleanup = () => {
      process.stdin.off('keypress', onKey)
      process.stdin.off('end', onEnd)
      process.stdin.setRawMode(oldRaw)
      if (wasPaused) process.stdin.pause()
      process.stderr.write('\n')
    }
    const onEnd = () => { cleanup(); reject(new MemwikiError('INVALID_META', '密码输入已取消')) }
    const onKey = (text: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && (key.name === 'c' || key.name === 'd')) { onEnd(); return }
      if (key.name === 'return' || key.name === 'enter') { cleanup(); resolve(value); return }
      if (key.name === 'backspace') { value = Array.from(value).slice(0, -1).join(''); return }
      if (!key.ctrl && text && !/[\x00-\x1f\x7f]/.test(text)) value += text
    }
    process.stdin.on('keypress', onKey)
    process.stdin.on('end', onEnd)
  })
}
