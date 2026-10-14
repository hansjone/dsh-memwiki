import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tokenize } from '../src/search/tokenize.ts'

test('CJK runs produce unigrams and adjacent bigrams without crossing punctuation', () => {
  assert.deepEqual(tokenize('中文乱码'), ['中', '中文', '文', '文乱', '乱', '乱码', '码'])
  assert.deepEqual(tokenize('中，文'), ['中', '文'])
  for (const term of ['日本', 'かな', 'カナ', '한국', '𠀀文']) assert.ok(tokenize(term).includes(term))
})

test('normalizes width and case, preserves compound words and subwords', () => {
  assert.deepEqual(tokenize('startNetx snake_case kebab-case HTTPServer'),
    ['startnetx', 'start', 'netx', 'snake_case', 'snake', 'case', 'kebab-case', 'kebab', 'case', 'httpserver', 'http', 'server'])
  assert.deepEqual(tokenize('ＮｅｔＸ１２３　ＡＢＣ'), ['netx123', 'net', 'x123', 'abc'])
  assert.deepEqual(tokenize('naïve Café42 123'), ['naïve', 'café42', '123'])
})

test('retains frequencies, does not stem or drop stopwords, handles empty input', () => {
  assert.deepEqual(tokenize('the the runners'), ['the', 'the', 'runners'])
  assert.deepEqual(tokenize(' \n🎉!'), [])
})
