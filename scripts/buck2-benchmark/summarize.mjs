#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

import { parseJsonl, summarizeSamples } from './lib.mjs'

const [input, output] = process.argv.slice(2)
if (input === undefined || output === undefined) {
  console.error('usage: node summarize.mjs INPUT.jsonl OUTPUT.jsonl')
  process.exit(2)
}

const records = parseJsonl(readFileSync(input, 'utf8'))
const summaries = summarizeSamples(records)
writeFileSync(output, summaries.map((record) => JSON.stringify(record)).join('\n') + '\n')
console.log(`wrote ${summaries.length} summaries to ${output}`)
