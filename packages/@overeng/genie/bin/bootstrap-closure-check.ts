#!/usr/bin/env bun

import path from 'node:path'

import { bootstrapClosureCheckMain } from '../src/runtime/node/bootstrap-closure-check-cli.ts'

bootstrapClosureCheckMain({
  argv: process.argv.slice(2),
  defaultRepoRoot: path.resolve(import.meta.dir, '../../../..'),
})
