import type { SecretFinding } from '../types.ts'

const rules: Array<[string, RegExp]> = [
  ['private_key', /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----/g],
  ['aws', /\bAKIA[A-Z0-9]{16}\b/g],
  ['github', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g],
  ['api_key', /\bsk-[A-Za-z0-9_-]{16,}\b/g],
  ['slack', /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g],
  ['url_credentials', /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi],
]

/** `key = value` assignments; the value is checked by `looksLikeSecret` before reporting. */
const CREDENTIAL = /\b(password|passwd|pwd|token|secret|api[_-]?key)\s*[=:：]\s*["']?([^\s"'`,;，。；、）)]{8,})/gi

/**
 * Whether an assigned value looks like a literal secret rather than a pointer to one.
 * Wiki pages are expected to say where a secret lives (`token: NETX_FORGEJO_TOKEN`,
 * `password=$DB_PASS`, `token：在环境变量里`), so references, placeholders and prose pass.
 * Passwords are often short and plain, so any other value of ≥ 8 chars counts; tokens,
 * secrets and API keys must also look machine-generated (mixed character classes or long).
 */
export function looksLikeSecret(key: string, value: string): boolean {
  if (/[　-鿿＀-￯]/u.test(value)) return false
  if (/^(?:\$\{?|%|<|\{\{|\*{3,}|x{4,}|\.{3})/iu.test(value)) return false
  if (/^[A-Z][A-Z0-9_]*$/u.test(value)) return false
  if (/^(?:password|passwd|pwd)$/iu.test(key)) return value.length >= 8
  // Lowercase word-separated names are references into the secrets store (`secret:netx-local-admin`).
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(value)) return false
  const classes = [/[a-z]/u, /[A-Z]/u, /\d/u, /[^A-Za-z0-9]/u].filter(re => re.test(value)).length
  return classes >= 3 || (classes >= 2 && value.length >= 16) || value.length >= 32
}

/** Returns rule names and 1-based lines only; never returns any secret text. */
export function scanSecrets(text: string): SecretFinding[] {
  const hits: Array<SecretFinding & { offset: number }> = []
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length
  for (const [rule, pattern] of rules) {
    for (const m of text.matchAll(pattern)) hits.push({ rule, line: lineOf(m.index), offset: m.index })
  }
  for (const m of text.matchAll(CREDENTIAL)) {
    if (looksLikeSecret(m[1], m[2])) hits.push({ rule: 'credential', line: lineOf(m.index), offset: m.index })
  }
  return hits.sort((a, b) => a.offset - b.offset).map(({ rule, line }) => ({ rule, line }))
}
