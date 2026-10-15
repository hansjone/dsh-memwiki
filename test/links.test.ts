import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractLinks, formatLink, createResolver, rewriteLinks, markdownPageLinks, convertMarkdownLinks } from '../src/core/links.ts'

test('extracts target, heading and label', () => {
  const links = extractLinks('见 [[projects/netx/发布流程#Ollama|发布]] 和 [[PS 乱码]]。')
  assert.deepEqual(
    links.map(l => [l.target, l.heading, l.label]),
    [['projects/netx/发布流程', 'Ollama', '发布'], ['PS 乱码', undefined, undefined]],
  )
})

test('ignores links in fenced and inline code', () => {
  const body = ['`[[inline]]` [[real]]', '```', '[[fenced]]', '```', '~~~md', '[[tilde]]', '~~~', '[[after]]'].join('\n')
  assert.deepEqual(extractLinks(body).map(l => l.target), ['real', 'after'])
})

test('offsets cover the whole link', () => {
  const body = 'a [[x|y]] b'
  const [l] = extractLinks(body)
  assert.equal(body.slice(l.start, l.end), '[[x|y]]')
})

test('skips self-heading links and round-trips formatting', () => {
  assert.deepEqual(extractLinks('[[#只有标题]]'), [])
  assert.equal(formatLink('a/b', 'h', 'L'), '[[a/b#h|L]]')
})

test('resolver uses ordered case-insensitive tiers and deduplicates alias matches', () => {
  const resolve = createResolver([
    { id: 'topics/A', title: 'Title', aliases: ['Alias', 'ALIAS'] },
    { id: 'rules/A', title: 'Other', aliases: ['Title'] },
    { id: 'topics/B', title: 'Other', aliases: ['shared'] },
    { id: 'topics/C', title: 'Last', aliases: ['shared'] },
  ])
  assert.deepEqual(resolve('TOPICS/a'), { id: 'topics/A' })
  assert.deepEqual(resolve('title'), { id: 'topics/A' })
  assert.deepEqual(resolve('alias'), { id: 'topics/A' })
  assert.deepEqual(resolve('Other'), { ambiguous: ['rules/A', 'topics/B'] })
  assert.deepEqual(resolve('shared'), { ambiguous: ['topics/B', 'topics/C'] })
  assert.deepEqual(resolve('a'), { ambiguous: ['rules/A', 'topics/A'] })
  assert.deepEqual(resolve('b'), { id: 'topics/B' })
  assert.equal(resolve('missing'), undefined)
})

test('rewrite replaces targets only and preserves code and all suffix whitespace', () => {
  const body = '[[ old # Heading | Label ]] [[old|other#text]] [[keep]] `[[old]]`\n```\n[[old]]\n```\n[[#heading]]'
  assert.equal(rewriteLinks(body, target => target === 'old' ? 'new/id' : undefined), '[[ new/id # Heading | Label ]] [[new/id|other#text]] [[keep]] `[[old]]`\n```\n[[old]]\n```\n[[#heading]]')
})

test('Markdown page links convert relative paths, encoded names, headings and labels outside code', () => {
  const body = '[同级](./target.md) [中文](../howto/%E5%8F%91%E5%B8%83.md#%E6%AD%A5%E9%AA%A4) [括号](a(b).MD) [空格](<a b.md> "标题")\r\n'
    + '`[代码](code.md)`\n```md\n[围栏](fenced.md)\n```\n~~~\n[围栏](tilde.md)\n~~~\n'
    + '![图片](image.md) [网页](https://example.com/a.md) [邮箱](mailto:a.md) [站内](#heading) [资源](image.png) \\[转义](escaped.md)'
  assert.equal(markdownPageLinks(body, 'topics/source').length, 4)
  const converted = convertMarkdownLinks(body, 'topics/source')
  assert.equal(converted, '[[topics/target|同级]] [[howto/发布#步骤|中文]] [[topics/a(b)|括号]] [[topics/a b|空格]]\r\n' + body.slice(body.indexOf('`')))
  assert.equal(convertMarkdownLinks(converted, 'topics/source'), converted)
  assert.equal(extractLinks(body).length, 0)
})

test('Markdown links with unsafe paths or unrepresentable labels remain manual lint items', () => {
  const body = '[越界](../../outside.md) [坏编码](bad%ZZ.md) [竖线|标签](target.md) [目标](bad%23name.md)'
  const links = markdownPageLinks(body, 'topics/source')
  assert.equal(links.length, 4)
  assert.ok(links.every(link => link.replacement === undefined))
  assert.equal(convertMarkdownLinks(body, 'topics/source'), body)
})
