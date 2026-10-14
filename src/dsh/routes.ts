import type { IncomingMessage, ServerResponse } from 'node:http'
import type { WebRoute } from '@deepseek-ai/dsh-host-webserver'
import { MemwikiError } from '../types.ts'
import { API } from './protocol.ts'
import { MemwikiSettingsService } from './service.ts'

/** Pure request guard; same-origin browser requests and loopback transports only. */
export function allowedRequest(address: string | undefined, headers: IncomingMessage['headers']): boolean {
  if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address ?? '') || headers['sec-fetch-site'] === 'cross-site') return false
  if (headers.origin !== undefined) {
    try { return !!headers.host && new URL(headers.origin).host === headers.host }
    catch { return false }
  }
  return true
}

/** HTTP-free route dispatch; only the explicit POST reveal operation returns a value. */
export async function handleSettingsRequest(service: MemwikiSettingsService, method: string, pathname: string, body: Record<string, unknown> = {}, limit = 20): Promise<{ status: number; body: unknown }> {
  try {
    let result: unknown
    if (pathname === API.config && method === 'GET') result = { config: await service.config() }
    else if (pathname === API.config && method === 'PUT') result = { config: await service.saveConfig(body) }
    else if (pathname === API.status && method === 'GET') result = { status: await service.status() }
    else if (pathname === API.lint && method === 'POST') result = await service.health()
    else if (pathname === API.secrets && method === 'GET') result = await service.listSecrets()
    else if (pathname === API.secrets && method === 'POST') result = await service.setSecret(body)
    else if (pathname === API.secrets && method === 'DELETE') result = await service.deleteSecret(body)
    else if (pathname === API.accessLog && method === 'GET') result = await service.accessLog(limit)
    else if (pathname === API.reveal && method === 'POST') result = await service.revealSecret(body)
    else return { status: 405, body: { error: '不支持此操作' } }
    return { status: 200, body: result }
  } catch (e) {
    const code = e instanceof MemwikiError ? e.code : 'ERROR'
    return { status: code === 'NOT_FOUND' ? 404 : code === 'LOCKED' ? 409 : e instanceof MemwikiError ? 400 : 500, body: { code, error: '操作失败，请检查参数、配置和文件权限' } }
  }
}
function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' })
  res.end(JSON.stringify(body))
}
async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of req) {
    const buf = Buffer.from(chunk)
    bytes += buf.length
    if (bytes > 1 << 20) throw new Error()
    chunks.push(buf)
  }
  const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error()
  return body as Record<string, unknown>
}
export function makeRoutes(service = new MemwikiSettingsService()): WebRoute[] {
  return Object.values(API).map(path => ({
    kind: 'exact', path,
    handler: async (req, res) => {
      if (!allowedRequest(req.socket.remoteAddress, req.headers)) { send(res, 403, { error: '仅限本机同源访问' }); return }
      try {
        const method = req.method ?? 'GET'
        const body = ['PUT', 'POST', 'DELETE'].includes(method) && path !== API.lint ? await readBody(req) : {}
        const url = new URL(req.url ?? '/', 'http://localhost')
        const result = await handleSettingsRequest(service, method, path, body, url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : 20)
        send(res, result.status, result.body)
      } catch { send(res, 400, { error: '请求格式无效' }) }
    },
  }))
}
