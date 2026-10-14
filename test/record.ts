import type { PageMeta, PageRecord } from '../src/types.ts'

export function record(id: string, meta: Partial<PageMeta> = {}, body = '普通正文'): PageRecord {
  return {
    id, meta: { title: id.split('/').at(-1)!, summary: '页面摘要', type: 'topic', tags: [], aliases: [],
      status: 'active', created: '2026-10-01', updated: '2026-10-14T12:00:00+08:00', updated_by: 'codex', ...meta },
    body, bytes: Buffer.byteLength(body), mtimeMs: Date.parse('2026-10-14T12:00:00+08:00'), links: [], brokenLinks: [],
  }
}
