import { createPublicKey, verify, type KeyObject } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export interface TeamIdentity {
  v: 1
  sub: string
  name: string
  src: 'uac' | 'local' | 'system'
  kind: 'member' | 'external' | 'system'
  roles: string[]
  inst: 'kb'
  iat: number
  exp: number
  jti: string
}

export function hubPublicKey(pem: string | Buffer): KeyObject {
  if (!/^\s*-----BEGIN PUBLIC KEY-----/.test(pem.toString())) throw new Error('Hub 公钥必须是 Ed25519 SPKI PEM')
  const key = createPublicKey(pem)
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Hub 公钥必须是 Ed25519 SPKI PEM')
  return key
}

function decode(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error('unauthorized')
  const bytes = Buffer.from(value, 'base64url')
  if (bytes.toString('base64url') !== value) throw new Error('unauthorized')
  return bytes
}

/** All failures deliberately have the same error and never echo the identity header. */
export function verifyIdentity(header: string, key: KeyObject, now = Math.floor(Date.now() / 1000)): TeamIdentity {
  try {
    if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519' || header.length > 16384) throw new Error()
    const parts = header.split('.')
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error()
    const bytes = decode(parts[1])
    const signature = decode(parts[2])
    if (signature.length !== 64 || !verify(null, Buffer.from(`v1.${parts[1]}`), key, signature)) throw new Error()
    const p = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as TeamIdentity
    const str = (s: unknown): s is string => typeof s === 'string' && !!s.trim() && !/[\x00-\x1f\x7f]/.test(s)
    if (!p || p.v !== 1 || !str(p.sub) || typeof p.name !== 'string' || /[\x00-\x1f\x7f]/.test(p.name)
      || !['uac', 'local', 'system'].includes(p.src) || !['member', 'external', 'system'].includes(p.kind)
      || !Array.isArray(p.roles) || !p.roles.every(r => typeof r === 'string') || !str(p.jti)
      || p.inst !== 'kb' || !Number.isInteger(p.iat) || !Number.isInteger(p.exp)
      || p.exp - p.iat <= 0 || p.exp - p.iat > 60 || p.exp < now - 5 || p.iat > now + 5) throw new Error()
    return p
  } catch { throw new Error('unauthorized') }
}

export function requestIdentity(req: IncomingMessage, key: KeyObject): TeamIdentity {
  const values: string[] = []
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'x-dsh-team-identity') values.push(req.rawHeaders[i + 1])
  }
  if (values.length !== 1) throw new Error('unauthorized')
  return verifyIdentity(values[0], key)
}
