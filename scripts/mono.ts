#!/usr/bin/env bun

import { genieCommand } from '@overeng/genie/cli'
import {
  buildCommand,
  cleanCommand,
  nixCommand,
  runMonoCli,
  testCommand,
  tsCommand,
} from '@overeng/mono'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { contextCommand, nixPackages } from './commands/index.js'

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

// NOTE: The following commands have been migrated to devenv tasks:
// - install -> devenv tasks run bun:install --mode before
// - lint    -> devenv tasks run lint:check --mode before (or lint:fix)
// - check   -> devenv tasks run check:all --mode before (or check:quick)

runMonoCli({
  name: 'mono',
  version,
  description: 'Monorepo management CLI',
  commands: [
    buildCommand(),
    testCommand(),
    tsCommand(),
    cleanCommand(),
    genieCommand,
    nixCommand({ packages: nixPackages }),
    contextCommand,
  ],
})
