/** Advisory key-fact patterns. Values are not assertions of duplication on their own. */
export const FACT_RULES = [
  { kind: 'ipv4', pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}(?![\d.])/gu },
  { kind: 'version', pattern: /(?<![\p{L}\p{N}.])v?\d+\.\d+(?:\.\d+){0,3}(?![\p{L}\p{N}.])/giu },
  { kind: 'windows_path', pattern: /\b[A-Za-z]:[\\/][^\s`"'<>|\[\](){},;，。；：]+/gu },
  { kind: 'unix_path', pattern: /(?<![\p{L}\p{N}:/\\])\/(?:[\p{L}\p{N}_.~@-]+\/)*[\p{L}\p{N}_.~@-]+/gu },
  { kind: 'port', pattern: /:(\d{1,5})(?![\d.])/gu },
] as const

/** Distinct advisory fact tokens, excluding invalid IPs/ports, ordinary URLs and clock times. */
export function factTokens(text: string): Set<string> {
  const tokens = new Set<string>()
  const ips = new Set<string>()
  for (const rule of FACT_RULES) for (const match of text.matchAll(rule.pattern)) {
    let token = match[0]
    if (rule.kind === 'ipv4') {
      if (!token.split('.').every(part => Number(part) <= 255)) continue
      ips.add(token)
      // Loopback, wildcard, network (.0) and broadcast (.255) addresses are generic, not facts.
      if (/^(?:127\.|0\.)|\.(?:0|255)$/u.test(token)) continue
    }
    // Single-segment paths like /ip or /etc are command words, not locations.
    if (rule.kind === 'unix_path' && token.lastIndexOf('/') === 0) continue
    if (rule.kind === 'version' && ips.has(token.replace(/^v/iu, ''))) continue
    if (rule.kind === 'version' && /^\d+(?:\.\d+){3}$/u.test(token)) continue
    if (rule.kind === 'port') {
      if (Number(match[1]) < 1 || Number(match[1]) > 65535) continue
      // Ignore wall-clock timestamps; address:port remains a useful key fact.
      const prefix = text.slice(0, match.index)
      const hosted = /(?:(?:\d{1,3}\.){3}\d{1,3}|localhost|[\w-]+\.[a-z]{2,})$/iu.test(prefix)
      // Bare ports need a non-word boundary and a realistic number; skips IPv6 groups like ::2.
      if (!hosted && (!/(?:^|[\s`(（])$/u.test(prefix) || Number(match[1]) < 80)) continue
    }
    if (rule.kind === 'windows_path') token = token.replace(/[\\/]+$/u, '').replaceAll('\\', '/').toLowerCase()
    tokens.add(token)
  }
  return tokens
}
