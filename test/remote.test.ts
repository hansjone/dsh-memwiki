import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { createServer, request } from 'node:http'
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { hubPublicKey, verifyIdentity, type TeamIdentity } from '../src/mcp/identity.ts'
import { auditPath, createRemoteHandler, serveRemote } from '../src/mcp/remote.ts'
import { initVault } from '../src/core/vault.ts'
import { Store } from '../src/core/store.ts'
import { Memwiki } from '../src/memwiki.ts'
import { config, temporary } from './helpers.ts'

const keys = generateKeyPairSync('ed25519')
function identity(patch: Partial<TeamIdentity> = {}): TeamIdentity {
  const now = Math.floor(Date.now() / 1000)
  return { v: 1, sub: 'u_alice', name: 'Alice', src: 'local', kind: 'member', roles: ['member'], inst: 'kb', iat: now, exp: now + 30, jti: randomUUID(), ...patch }
}
function token(payload = identity(), privateKey = keys.privateKey) {
  const input = 'v1.' + Buffer.from(JSON.stringify(payload)).toString('base64url')
  return input + '.' + sign(null, Buffer.from(input), privateKey).toString('base64url')
}
async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args })
  return { text: (result.content as { type: string; text?: string }[]).map(c => c.text ?? '').join('\n'), isError: !!result.isError }
}
async function fixture(t: TestContext, git = false) {
  const dir = path.join(await temporary(t), 'vault')
  await initVault(dir, { git })
  const wiki = await Memwiki.open({ ...config(dir), git: { autoCommit: git, autoPush: false } }, { watch: false })
  const auditFile = path.join(path.dirname(dir), 'audit', 'kb.jsonl')
  const handler = createRemoteHandler(wiki, { publicKey: keys.publicKey, auditFile })
  const server = createServer((req, res) => { void handler(req, res) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`)
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await wiki.close() })
  async function client(payload = identity()) {
    const client = new Client({ name: payload.sub, version: '1' })
    await client.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { 'X-Dsh-Team-Identity': token(payload) } } }))
    t.after(() => client.close())
    return client
  }
  async function page(id: string, visibility?: 'company' | 'all', body = 'shared-needle 正文', extra = {}) {
    return wiki.write({ kind: 'create', id, body, meta: { title: id.split('/').at(-1)!, summary: `${id} 摘要`, visibility, ...extra } }, { agent: 'seed', reason: 'seed' })
  }
  return { dir, wiki, url, auditFile, client, page }
}

test('identity verifies Ed25519 and enforces all signed fields and clock limits', async t => {
  const p = identity()
  assert.deepEqual(verifyIdentity(token(p), keys.publicKey), p)
  const now = Math.floor(Date.now() / 1000)
  for (const [name, patch] of Object.entries({
    expired: { iat: now - 40, exp: now - 6 }, future: { iat: now + 6, exp: now + 36 },
    duration: { exp: now + 61 }, backwards: { exp: now }, instance: { inst: 'alice' },
    version: { v: 2 }, kind: { kind: 'unknown' }, src: { src: 'forged' }, roles: { roles: 'admin' },
    subject: { sub: '' }, name: { name: 1 }, newline: { name: 'Alice\nadmin' }, jti: { jti: '' }, integer: { iat: now + 0.5 },
  })) await t.test(name, () => assert.throws(() => verifyIdentity(token({ ...p, ...patch } as TeamIdentity), keys.publicKey), /unauthorized/))
  assert.throws(() => verifyIdentity(token(p, generateKeyPairSync('ed25519').privateKey), keys.publicKey), /unauthorized/)
  assert.throws(() => verifyIdentity(token(p).replace('v1.', 'v2.'), keys.publicKey), /unauthorized/)
  const parts = token(p).split('.')
  assert.throws(() => verifyIdentity(`v1.${parts[1]}=.${parts[2]}`, keys.publicKey), /unauthorized/)
  assert.throws(() => verifyIdentity(`${token(p)},${token(p)}`, keys.publicKey), /unauthorized/)
  assert.equal(hubPublicKey(keys.publicKey.export({ type: 'spki', format: 'pem' })).asymmetricKeyType, 'ed25519')
  assert.throws(() => hubPublicKey(keys.privateKey.export({ type: 'pkcs8', format: 'pem' })), /SPKI/)
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
  assert.throws(() => hubPublicKey(rsa.export({ type: 'spki', format: 'pem' })), /Ed25519/)
})

test('every HTTP request rejects missing, duplicate, invalid, expired and wrong-instance headers with 401', async t => {
  const { url } = await fixture(t)
  for (const suffix of ['/mcp', '/unknown', '/mcp?x=1']) {
    const response = await fetch(new URL(suffix, url), { method: 'GET' })
    assert.equal(response.status, 401)
    assert.equal(await response.text(), '{"error":"unauthorized"}')
  }
  for (const value of [token(identity({ inst: 'wrong' as 'kb' })), token(identity({ iat: 1, exp: 30 })), 'v1.bad.bad', token() + ',' + token()]) {
    assert.equal((await fetch(url, { headers: { 'X-Dsh-Team-Identity': value } })).status, 401)
  }
  const duplicate = await new Promise<number | undefined>((resolve, reject) => {
    const req = request(url, { headers: ['Host', url.host, 'X-Dsh-Team-Identity', token(), 'X-Dsh-Team-Identity', token()] }, res => { res.resume(); resolve(res.statusCode) })
    req.on('error', reject); req.end()
  })
  assert.equal(duplicate, 401)
  assert.equal((await fetch(new URL('/unknown', url), { headers: { 'X-Dsh-Team-Identity': token() } })).status, 404)
  assert.equal((await fetch(url, { headers: { 'X-Dsh-Team-Identity': token() } })).status, 405)
})

test('external users cannot see company pages through direct/alias reads, search, context or backlinks', async t => {
  const { client, page } = await fixture(t)
  await page('topics/company-private', undefined, 'shared-needle 内部正文 [[topics/public]]', { aliases: ['InternalAlias'] })
  await page('topics/public', 'all', 'shared-needle 外部正文 [[topics/company-private|内部链接]]')
  const external = await client(identity({ kind: 'external' }))
  for (const ref of ['topics/company-private', 'InternalAlias', 'index', 'log', '_guide']) {
    const result = await call(external, 'memwiki_read', { page: ref })
    assert.equal(result.isError, true, ref)
    assert.doesNotMatch(result.text, /company-private|内部正文|InternalAlias/)
  }
  const search = await call(external, 'memwiki_search', { query: 'shared-needle', limit: 1 })
  assert.match(search.text, /topics\/public/)
  assert.doesNotMatch(search.text, /company-private|InternalAlias|内部正文/)
  const context = await call(external, 'memwiki_context')
  assert.match(context.text, /topics\/public/)
  assert.doesNotMatch(context.text, /company-private|InternalAlias/)
  assert.doesNotMatch(context.text, /\[\[_guide\]\]/)
  const read = await call(external, 'memwiki_read', { page: 'topics/public' })
  assert.equal(read.isError, false, read.text)
  assert.doesNotMatch(read.text, /company-private|内部链接/)
  for (const [name, args] of [['memwiki_log', {}], ['memwiki_lint', {}], ['memwiki_usage', {}], ['memwiki_feedback', { action: 'list' }]] as const) {
    assert.equal((await call(external, name, args)).isError, true)
  }
  const member = await client()
  assert.match((await call(member, 'memwiki_read', { page: 'topics/company-private' })).text, /内部正文/)
})

test('all member mutations become complete inbox proposals without changing requested pages', async t => {
  const { client, page, wiki, dir, auditFile } = await fixture(t)
  const original = (await page('topics/original')).result.page
  const member = await client()
  const operations: Array<[string, Record<string, unknown>]> = [
    ['memwiki_write', { mode: 'replace', page: original.id, rev: original.rev, body: 'line one\nline two', reason: '提议' }],
    ['memwiki_write', { mode: 'create', page: 'topics/new', title: '新页', summary: '新页摘要', body: '新正文', reason: '提议' }],
    ['memwiki_move', { page: original.id, to: 'topics/moved', reason: '提议' }],
    ['memwiki_delete', { page: original.id, reason: '提议' }],
    ['memwiki_merge', { from: [original.id], into: 'topics/new', rev: 'old', reason: '提议' }],
    ['memwiki_restore', { trashPath: '.trash/topics/x.123.md' }],
    ['memwiki_verify', { page: original.id }],
    ['memwiki_remember', { text: 'member capture\nwith newline' }],
    ['memwiki_lint', { fix: true }],
    ['memwiki_feedback', { kind: 'bug', title: '提议', scenario: 's', expected: 'e', actual: 'a' }],
    ['memwiki_feedback', { action: 'resolve', id: 'not-real', resolution: '提议' }],
  ]
  for (const [name, args] of operations) {
    const result = await call(member, name, args)
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /已提交待审/)
  }
  assert.equal((await wiki.read(original.id)).page.rev, original.rev)
  const proposals = (await new Store(config(dir)).list()).filter(p => p.id.startsWith('inbox/proposals/'))
  assert.equal(proposals.length, operations.length)
  assert.ok(proposals.every(p => p.meta.updated_by === 'u_alice' && p.meta.visibility === 'company' && p.meta.sources?.includes('hub:u_alice (Alice)')))
  assert.ok(proposals.some(p => p.body.includes('line one\\nline two')))
  assert.ok(proposals.some(p => p.body.includes(original.rev)))
  const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.outcome !== 'attempt')
  assert.equal(audit.length, operations.length)
  assert.ok(audit.every(e => e.event === 'kb.propose' && e.actor_uid === 'u_alice' && e.at.endsWith('Z')))
  assert.ok(!JSON.stringify(audit).includes('line one'))
  assert.equal((await call(await client(identity({ roles: ['kb-maintainer'] })), 'memwiki_read', { page: proposals[0].id })).isError, false)
})

test('maintainers/admins write directly with signed attribution; remote never registers secrets', async t => {
  const { client, wiki, auditFile } = await fixture(t)
  for (const role of ['kb-maintainer', 'admin', 'super_admin']) {
    const maintainer = await client(identity({ roles: [role] }))
    const tools = await maintainer.listTools()
    assert.equal(tools.tools.some(tool => tool.name.startsWith('memwiki_secret_')), false)
    assert.ok((await maintainer.listPrompts()).prompts.some(p => p.name === 'memwiki-curate'))
    const result = await call(maintainer, 'memwiki_write', { mode: 'create', page: `topics/${role}`, title: role, summary: `direct ${role}`, body: `${role} separate content`, reason: '直接写入', meta: { updated_by: 'forged' } })
    assert.equal(result.isError, false, result.text)
    assert.match(result.text, /写入成功/)
    const page = (await wiki.read(`topics/${role}`)).page
    assert.equal(page.meta.updated_by, 'u_alice')
    assert.equal(page.meta.updated_by_name, 'Alice')
    assert.equal(page.meta.visibility, 'company')
    assert.ok(page.meta.sources?.includes('hub:u_alice (Alice)'))
    assert.equal((await call(maintainer, 'memwiki_secret_list')).isError, true)
  }
  const audit = (await readFile(auditFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line)).filter(e => e.outcome !== 'attempt')
  assert.equal(audit.length, 3)
  assert.ok(audit.every(e => e.event === 'kb.write' && e.outcome === 'success'))
})

test('two remote clients replacing the same revision produce one success and one CONFLICT', async t => {
  const { client, page, wiki } = await fixture(t)
  const original = (await page('topics/concurrent')).result.page
  const alice = await client(identity({ roles: ['kb-maintainer'] }))
  const bob = await client(identity({ sub: 'u_bob', name: 'Bob', roles: ['admin'] }))
  const results = await Promise.all([alice, bob].map((client, i) => call(client, 'memwiki_write', {
    mode: 'replace', page: original.id, rev: original.rev, body: `new content ${i}`, reason: '并发替换',
  })))
  assert.equal(results.filter(r => !r.isError).length, 1)
  assert.equal(results.filter(r => r.isError && /CONFLICT/.test(r.text)).length, 1)
  const final = (await wiki.read(original.id)).page
  assert.equal(final.meta.updated_by, results[0].isError ? 'u_bob' : 'u_alice')
})

test('concurrent inbox proposals do not lose entries or cross identities', async t => {
  const { client, dir } = await fixture(t)
  const clients = await Promise.all(Array.from({ length: 6 }, (_, i) => client(identity({ sub: `u_${i}`, name: `Person ${i}` }))))
  const results = await Promise.all(clients.map((c, i) => call(c, 'memwiki_remember', { text: `proposal-${i}` })))
  assert.ok(results.every(r => !r.isError))
  const pages = (await new Store(config(dir)).list()).filter(p => p.id.startsWith('inbox/proposals/'))
  assert.equal(pages.length, 6)
  assert.deepEqual(pages.map(p => p.meta.updated_by).sort(), Array.from({ length: 6 }, (_, i) => `u_${i}`))
  for (const p of pages) assert.ok(p.body.includes(`proposal-${p.meta.updated_by.slice(2)}`))
})

test('git author contains signed display name and subject, not tool metadata', async t => {
  const { client, dir } = await fixture(t, true)
  const alice = await client(identity({ roles: ['kb-maintainer'] }))
  const previous = [process.env.GIT_AUTHOR_NAME, process.env.GIT_AUTHOR_EMAIL]
  process.env.GIT_AUTHOR_NAME = 'Forged environment author'
  process.env.GIT_AUTHOR_EMAIL = 'forged@example.invalid'
  try {
    const result = await call(alice, 'memwiki_write', { page: 'topics/author', mode: 'create', title: '作者', summary: '作者测试', body: 'author test', reason: '验证作者' })
    assert.equal(result.isError, false, result.text)
  } finally {
    for (const [key, value] of [['GIT_AUTHOR_NAME', previous[0]], ['GIT_AUTHOR_EMAIL', previous[1]]]) {
      if (value === undefined) delete process.env[key!]
      else process.env[key!] = value
    }
  }
  const { stdout } = await promisify(execFile)('git', ['log', '-1', '--format=%an|%ae'], { cwd: dir })
  assert.equal(stdout.trim(), 'Alice (u_alice)|u_alice@memwiki.local')
})

test('external maintainer role never grants company read access or diagnostic access', async t => {
  const { client, page, wiki } = await fixture(t)
  const original = (await page('topics/internal')).result.page
  const external = await client(identity({ roles: ['admin'], kind: 'external' }))
  for (const [name, args] of [
    ['memwiki_write', { mode: 'replace', page: original.id, rev: original.rev, body: 'x', reason: 'x' }],
    ['memwiki_delete', { page: original.id, reason: 'x' }],
    ['memwiki_lint', { fix: true }],
  ] as Array<[string, Record<string, unknown>]>) assert.equal((await call(external, name, args)).isError, true)
  assert.equal((await wiki.read(original.id)).page.rev, original.rev)
})

test('audit paths outside the vault are enforced, including symlink aliases', async t => {
  const root = await temporary(t)
  const dir = path.join(root, 'vault')
  await mkdir(dir)
  assert.throws(() => auditPath(dir, path.join(dir, 'audit.jsonl')), /之外/)
  assert.equal(auditPath(dir), dir + '.audit.jsonl')
  const link = path.join(root, 'alias')
  await symlink(dir, link, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => auditPath(dir, path.join(link, 'audit.jsonl')), /之外/)
})

test('serveRemote validates startup configuration without listening on bad config', async t => {
  const dir = await temporary(t)
  await initVault(dir, { git: false })
  const wiki = await Memwiki.open(config(dir))
  t.after(() => wiki.close())
  const pub = path.join(dir, 'hub.pem')
  await writeFile(pub, 'not a key')
  await assert.rejects(serveRemote(wiki, { port: -1, hubPubkey: pub }), /port/)
  await assert.rejects(serveRemote(wiki, { port: 0, hubPubkey: pub }))
})

test('HTTP MCP is stateless and checks a fresh identity on every request', async t => {
  const { url } = await fixture(t)
  const post = (body: unknown, value = token()) => fetch(url, { method: 'POST', headers: {
    'X-Dsh-Team-Identity': value, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
  }, body: JSON.stringify(body) })
  const initialized = await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'stateless', version: '1' },
  } })
  assert.equal(initialized.status, 200)
  assert.equal(initialized.headers.get('mcp-session-id'), null)
  assert.equal((await initialized.json()).result.serverInfo.name, 'memwiki')
  const listed = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, token(identity({ sub: 'u_bob', name: 'Bob' })))
  assert.equal(listed.status, 200)
  assert.equal(listed.headers.get('mcp-session-id'), null)
  assert.ok((await listed.json()).result.tools.every((tool: { name: string }) => !tool.name.startsWith('memwiki_secret_')))
  const expired = await post({ jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }, token(identity({ iat: 1, exp: 30 })))
  assert.equal(expired.status, 401)
  for (const [body, status] of [['{rejected-request-fragment', 400], ['x'.repeat(1024 * 1024 + 1), 413]] as const) {
    const response = await fetch(url, { method: 'POST', headers: {
      'X-Dsh-Team-Identity': token(), Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json',
    }, body })
    assert.equal(response.status, status)
    assert.doesNotMatch(await response.text(), /rejected-request-fragment|xxxxxxxx/)
  }
})

test('unavailable audit sink prevents page writes and proposals', async t => {
  const { client, wiki, auditFile, dir } = await fixture(t)
  await writeFile(path.dirname(auditFile), 'not a directory')
  for (const roles of [['member'], ['kb-maintainer']]) {
    const result = await call(await client(identity({ roles })), 'memwiki_write', {
      mode: 'create', page: 'topics/no-audit', title: '审计', summary: '审计失败不得写', body: '正文', reason: '审计失败',
    })
    assert.equal(result.isError, true)
  }
  await assert.rejects(wiki.read('topics/no-audit'))
  assert.equal((await new Store(config(dir)).list()).filter(p => p.id.startsWith('inbox/proposals/')).length, 0)
})

test('visibility changes apply immediately to existing external clients and invalid visibility is rejected', async t => {
  const { client, page } = await fixture(t)
  const original = (await page('topics/changing', 'all')).result.page
  const external = await client(identity({ kind: 'external' }))
  assert.equal((await call(external, 'memwiki_read', { page: original.id })).isError, false)
  const maintainer = await client(identity({ roles: ['admin'] }))
  const invalid = await call(maintainer, 'memwiki_write', { page: original.id, mode: 'meta', rev: original.rev, meta: { visibility: 'private' }, reason: '无效范围' })
  assert.equal(invalid.isError, true)
  assert.match(invalid.text, /INVALID_META/)
  assert.equal((await call(maintainer, 'memwiki_write', { page: original.id, mode: 'meta', rev: original.rev, meta: { visibility: 'company' }, reason: '改为内部' })).isError, false)
  assert.equal((await call(external, 'memwiki_read', { page: original.id })).isError, true)
  assert.doesNotMatch((await call(external, 'memwiki_search', { query: 'shared-needle' })).text, /changing/)
  assert.doesNotMatch((await call(external, 'memwiki_context')).text, /changing/)
})

test('maintainers can apply and remove inbox proposals with original revision protection', async t => {
  const { client, page, wiki } = await fixture(t)
  const original = (await page('topics/review')).result.page
  const member = await client()
  const args = { mode: 'replace', page: original.id, rev: original.rev, body: '审核后的内容', reason: '审核测试' }
  const proposed = await call(member, 'memwiki_write', args)
  const id = /\[\[([^\]]+)\]\]/.exec(proposed.text)?.[1]
  assert.ok(id)
  const maintainer = await client(identity({ sub: 'u_reviewer', name: 'Reviewer', roles: ['kb-maintainer'] }))
  assert.match((await call(maintainer, 'memwiki_read', { page: id })).text, /审核后的内容/)
  assert.equal((await call(maintainer, 'memwiki_write', args)).isError, false)
  assert.equal((await wiki.read(original.id)).page.meta.updated_by, 'u_reviewer')
  assert.equal((await call(maintainer, 'memwiki_delete', { page: id, reason: '已审核应用' })).isError, false)
  await assert.rejects(wiki.read(id))
  const again = await call(maintainer, 'memwiki_write', args)
  assert.equal(again.isError, true)
  assert.match(again.text, /CONFLICT/)
})

test('an external member sees the id of their own proposal even though the proposal page is company-only', async t => {
  const { client, dir } = await fixture(t)
  const outsider = await client(identity({ sub: 'u_ext', name: 'Ext', kind: 'external' }))
  const result = await call(outsider, 'memwiki_remember', { text: 'external contribution' })
  assert.equal(result.isError, false, result.text)
  const id = /提议 id：(inbox\/proposals\/\d{4}-\d{2}-\d{2}\/[0-9a-f-]+)/.exec(result.text)?.[1]
  assert.ok(id, result.text)
  const page = (await new Store(config(dir)).list()).find(p => p.id === id)
  assert.ok(page); assert.equal(page.meta.visibility, 'company'); assert.equal(page.meta.updated_by, 'u_ext')
})
