#!/usr/bin/env bun

import { nixCommand, runMonoCli } from '@overeng/mono'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { contextCommand, nixPackages } from './commands/index.js'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

// NOTE: Most commands have been migrated to devenv tasks (use `run <task>`):
// - bun:install             - install dependencies
// - genie:run/watch/check   - generate config files
// - ts:check/watch/build/clean - TypeScript
// - lint:check/fix          - linting
// - test:run/watch/unit/integration - testing
// - check:quick/all         - run all checks

runMonoCli({
  name: 'mono',
  version,
  description: 'Monorepo management CLI',
  commands: [nixCommand({ packages: nixPackages }), contextCommand],
})
