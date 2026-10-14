import { spawn } from 'node:child_process'
import { MemwikiError } from '../types.ts'

export interface Protector {
  readonly kind: 'dpapi' | 'plain'
  protect(plain: string): Promise<string>
  unprotect(stored: string): Promise<string>
}

export const plainProtector: Protector = {
  kind: 'plain',
  async protect(plain) { return plain },
  async unprotect(stored) { return stored },
}

/** The fixed script contains no data. Both directions use piped UTF-8 stdin/stdout. */
export class DpapiProtector implements Protector {
  readonly kind = 'dpapi' as const
  private run(input: string, decrypt: boolean): Promise<string> {
    const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $utf8=New-Object System.Text.UTF8Encoding($false); [Console]::InputEncoding=$utf8; [Console]::OutputEncoding=$utf8; $s=[Console]::In.ReadToEnd(); ` + (decrypt
      ? '$b=[Convert]::FromBase64String($s); $p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write($utf8.GetString($p))'
      : '$b=$utf8.GetBytes($s); $p=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Write([Convert]::ToBase64String($p))')
    return new Promise((resolve, reject) => {
      const fail = () => reject(new MemwikiError('INVALID_META', '凭据加解密失败'))
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks: Buffer[] = []
      child.stdout.on('data', chunk => chunks.push(Buffer.from(chunk)))
      // Never forward PowerShell diagnostics: they may contain input data.
      child.stderr.resume()
      child.on('error', fail)
      child.stdin.on('error', fail)
      // Stay below the reused lock's 10-second stale window.
      const timer = setTimeout(() => { child.kill(); fail() }, 7_000)
      child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(Buffer.concat(chunks).toString('utf8')); else fail() })
      child.stdin.end(input, 'utf8')
    })
  }
  protect(plain: string) { return this.run(plain, false) }
  unprotect(stored: string) { return this.run(stored, true) }
}

export function defaultProtector(): Protector {
  return process.platform === 'win32' ? new DpapiProtector() : plainProtector
}
