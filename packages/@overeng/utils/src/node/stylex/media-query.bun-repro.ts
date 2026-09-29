import assert from 'node:assert/strict'

import { transformSync } from '@babel/core'
import stylexPlugin from '@stylexjs/babel-plugin'

type Token = [string, ...unknown[]]
type TokenIterator = { nextToken: () => Token; endOfFile: () => boolean }
type TokenListInstance = {
  consumeNextToken: () => Token | null
  peek: () => Token | null
  setCurrentIndex: (index: number) => void
  isAtEnd: boolean
  consumedTokens: Token[]
}
type ParserForTests = {
  TokenList: new (input: TokenIterator) => TokenListInstance
  TokenParser: new (
    run: (input: TokenListInstance) => Token | null,
    label: string,
  ) => { parseToEnd: (input: TokenIterator) => Token | null }
  TokenType: { EOF: string }
}

// This private test-only seam exposes the parser embedded in the published plugin.
// The tokenizer deliberately returns EOF while endOfFile() still reports false.
const { TokenList, TokenParser, TokenType } = (
  stylexPlugin as typeof stylexPlugin & { __parserForTests: ParserForTests }
).__parserForTests
const eof: Token = [TokenType.EOF]
const tokenIterator = (tokens: readonly Token[]): TokenIterator => {
  let index = 0
  return {
    nextToken: () => tokens[index++] ?? eof,
    endOfFile: () => false,
  }
}

for (const consume of [
  (tokens: TokenListInstance) => tokens.consumeNextToken(),
  (tokens: TokenListInstance) => tokens.peek(),
  (tokens: TokenListInstance) => {
    tokens.setCurrentIndex(0)
    return tokens.peek()
  },
]) {
  const tokens = new TokenList(tokenIterator([eof]))
  assert.equal(consume(tokens), null)
  assert.equal(tokens.isAtEnd, true)
  assert.deepEqual(tokens.consumedTokens, [])
}

const first: Token = ['ident-token', 'first']
const trailing: Token = ['ident-token', 'trailing']
const oneToken = new TokenParser((tokens) => tokens.consumeNextToken(), 'one token')
assert.deepEqual(oneToken.parseToEnd(tokenIterator([first, eof])), first)
assert.throws(
  () => oneToken.parseToEnd(tokenIterator([first, trailing, eof])),
  /Expected end of input, got ident-token instead/,
)

const transformed = transformSync(
  `import * as stylex from '@stylexjs/stylex'
   const styles = stylex.create({
     narrow: { display: { default: 'flex', '@media (max-width: 63.99rem)': 'block' } },
     hover: { color: { default: 'black', '@media (hover: hover)': 'blue' } },
   })`,
  {
    filename: '/tmp/stylex-media-regression.js',
    babelrc: false,
    configFile: false,
    plugins: [[stylexPlugin, { enableMediaQueryOrder: true }]],
  },
)
const rules = transformed?.metadata.stylex as
  | ReadonlyArray<readonly [string, { ltr: string | null }, number]>
  | undefined
assert.ok(rules)
for (const condition of ['@media (max-width: 63.99rem)', '@media (hover: hover)']) {
  assert.ok(rules.some((rule) => rule[1].ltr?.includes(condition)))
}
console.log('tokenizer EOF ignored; trailing syntax rejected; media CSS emitted')
