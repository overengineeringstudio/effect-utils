#!/usr/bin/env bun

import { NodeContext, NodeRuntime } from '@effect/platform-node'
import { Effect } from 'effect'
import { cli } from '../src/cli/mod.ts'

cli.pipe(Effect.provide(NodeContext.layer), NodeRuntime.runMain)
