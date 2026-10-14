const PARTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}々ー]+|[\p{Script=Latin}\p{N}]+(?:[_-][\p{Script=Latin}\p{N}]+)*/gu
const CJK = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}々ー]/u

/** Returns lowercase word/subword tokens and CJK unigrams/bigrams; retains term frequency. */
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const [part] of text.normalize('NFKC').matchAll(PARTS)) {
    if (CJK.test(part)) {
      const chars = [...part]
      for (let i = 0; i < chars.length; i++) {
        out.push(chars[i])
        if (i + 1 < chars.length) out.push(chars[i] + chars[i + 1])
      }
    } else {
      const whole = part.toLowerCase()
      out.push(whole)
      const words = part.replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, '$1 $2')
        .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, '$1 $2').split(/[_\s-]+/u)
      if (words.length > 1) out.push(...words.map(word => word.toLowerCase()))
    }
  }
  return out
}
