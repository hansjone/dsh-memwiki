import assert from 'node:assert/strict'
import { test } from 'node:test'
import { extractLinks, formatLink } from '../src/core/links.ts'

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
