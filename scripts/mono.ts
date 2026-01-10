#!/usr/bin/env bun

import { genieCommand } from '@overeng/genie/cli'
import {
  buildCommand,
  checkCommand,
  cleanCommand,
  createStandardCheckConfig,
  lintCommand,
  runMonoCli,
  testCommand,
  tsCommand,
} from '@overeng/mono'

import { contextCommand, nixCommand } from './commands/index.js'

/** Path to oxc configuration files used for linting and formatting */
const oxcConfig = { configPath: 'packages/@overeng/oxc-config' }

/** Genie coverage configuration */
const genieConfig = {
  scanDirs: ['packages', 'scripts', 'context'],
  skipDirs: ['node_modules', 'dist', '.git', '.direnv', '.devenv', 'tmp'],
}

runMonoCli({
  name: 'mono',
  version: '0.1.0',
  description: 'Monorepo management CLI',
  commands: [
    buildCommand(),
    testCommand(),
    lintCommand({ oxcConfig, genieConfig }),
    tsCommand(),
    cleanCommand(),
    checkCommand(createStandardCheckConfig({ oxcConfig, genieConfig })),
    genieCommand,
    nixCommand,
    contextCommand,
  ],
})
