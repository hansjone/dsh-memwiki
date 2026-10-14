import assert from 'node:assert/strict'
import { test } from 'node:test'
import { scanSecrets } from '../src/core/secrets.ts'

test('each secret rule returns only its rule and line', () => {
  const cases: Array<[string, string]> = [
    ['private_key', '-----BEGIN RSA PRIVATE KEY-----'], ['private_key', '-----BEGIN PRIVATE KEY-----'],
    ['aws', 'AKIA1234567890ABCDEF'], ['github', 'ghp_' + 'a'.repeat(36)], ['github', 'github_pat_' + 'a'.repeat(40)],
    ['api_key', 'sk-ant-api03-' + 'a'.repeat(30)], ['api_key', 'sk-proj-' + 'a'.repeat(30)],
    ['slack', 'xoxb-1234567890-abc'], ['jwt', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk'],
    ['credential', 'password=abcdefgh'], ['credential', 'password: hunter2025'],
    ['credential', 'TOKEN: "a8Kd93jLq0Zx"'], ['credential', 'secret=Zx81kq0Lp2mN7vR4'], ['credential', 'api_key=' + 'f'.repeat(40)],
    ['url_credentials', 'https://user:pass@host/path'],
  ]
  for (const [rule, secret] of cases) {
    const hits = scanSecrets('safe\n' + secret)
    assert.ok(hits.some(h => h.rule === rule && h.line === 2), rule)
    assert.ok(hits.every(h => Object.keys(h).join(',') === 'rule,line'))
    assert.ok(!JSON.stringify(hits).includes(secret))
  }
})

test('ordinary text, short values and URLs without credentials are allowed', () => {
  assert.deepEqual(scanSecrets('password=short\ntoken: tiny\nhttps://example.org/@user\npublic key\nsk-example'), [])
  assert.deepEqual(scanSecrets('password=abcdefgh\nsecret: Ab3dEf9hIj').map(h => h.line), [1, 2])
})

test('pointers to secrets are not secrets', () => {
  const pointers = [
    'token: NETX_FORGEJO_TOKEN', 'token：在用户环境变量 NETX_FORGEJO_TOKEN 里', 'token：在环境变量里，不要写进配置',
    'password=$DB_PASSWORD', 'password=${DB_PASSWORD}', 'password=%DB_PASSWORD%', 'secret=<your-secret-here>',
    'token: ********', 'api_key=xxxxxxxxxxxx', 'secret: 存在 1Password 的「NAS」条目里', 'token=placeholder',
    '密码在凭据库：`secret:netx-local-admin`', 'secret: nas.admin.web', 'token=forgejo-api-token',
  ]
  for (const text of pointers) assert.deepEqual(scanSecrets(text), [], text)
})
