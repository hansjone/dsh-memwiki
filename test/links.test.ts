import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractLinks, formatLink, createResolver, rewriteLinks } from '../src/core/links.ts'

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
