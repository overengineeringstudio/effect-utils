#!/usr/bin/env bun

import { genieCommand } from '@overeng/genie/cli'
import {
  buildCommand,
  checkCommandWithTaskSystem,
  cleanCommand,
  installCommand,
  lintCommand,
  nixCommand,
  runMonoCli,
  testCommand,
  tsCommand,
} from '@overeng/mono'
import { resolveCliVersion } from '@overeng/utils/node/cli-version'

import { contextCommand, nixPackages } from './commands/index.js'

/** OXC linter/formatter configuration */
const oxcConfig = {
  configPath: '.',
}

/** Genie coverage configuration */
const genieConfig = {
  scanDirs: ['packages', 'scripts', 'context'],
  skipDirs: ['node_modules', 'dist', '.git', '.direnv', '.devenv', 'tmp'],
}

/** Install configuration */
const installConfig = {
  scanDirs: ['packages', 'scripts', 'context'],
}

const baseVersion = '0.1.0'
const buildVersion = '__CLI_VERSION__'
const version = resolveCliVersion({
  baseVersion,
  buildVersion,
  runtimeStampEnvVar: 'NIX_CLI_BUILD_STAMP',
})

runMonoCli({
  name: 'mono',
  version,
  description: 'Monorepo management CLI',
  commands: [
    buildCommand(),
    testCommand(),
    lintCommand({ oxcConfig, genieConfig }),
    tsCommand(),
    cleanCommand(),
    installCommand(installConfig),
    checkCommandWithTaskSystem({ oxcConfig, genieConfig }),
    genieCommand,
    nixCommand({ packages: nixPackages }),
    contextCommand,
  ],
})
