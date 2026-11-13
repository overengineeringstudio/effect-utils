import path from 'node:path'

import { NodeServices } from '@effect/platform-node'
import * as Vitest from '@effect/vitest'
import { Effect, FileSystem, Option, Schema } from 'effect'
import { expect } from 'vitest'

import { renderGenieOutput } from '@overeng/genie/render'

import { generateFile } from '../../core/generation.ts'

const encodeString = Schema.encodeSync(Schema.fromJsonString(Schema.String))

Vitest.it.live.prop(
  'public rendering matches the bytes generation writes',
  [
    Schema.String,
    Schema.Literals(['BUCK', 'defs.bzl', 'shell.nix', 'run.sh']),
    Schema.Boolean,
    Schema.Literals(['nested', 'deep/nested']),
  ],
  ([body, target, shebang, location]) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const cwd = yield* fs.makeTempDirectoryScoped()
      yield* fs.makeDirectory(path.join(cwd, '.git'))
      yield* fs.makeDirectory(path.join(cwd, location), { recursive: true })
      const genieFilePath = path.join(cwd, location, `${target}.genie.ts`)
      const content = `${shebang ? '#!/usr/bin/env sh\n' : ''}${body}\n`
      // This real source is loaded by generateFile, not replaced with an injected output.
      yield* fs.writeFileString(
        genieFilePath,
        `export default { data: {}, stringify: (ctx) => ${encodeString(content)} + ctx.location + ':' + ctx.mode + '\\n' }`,
      )
      const context = { cwd, location, mode: 'generate' as const }
      const output = {
        stringify: (ctx: typeof context) => `${content}${ctx.location}:${ctx.mode}\n`,
      }
      yield* generateFile({ genieFilePath, cwd, readOnly: false, oxfmtConfigPath: Option.none() })
      expect(new Uint8Array(yield* fs.readFile(genieFilePath.replace('.genie.ts', '')))).toEqual(
        new TextEncoder().encode(renderGenieOutput({ output, context, genieFilePath })),
      )
    }).pipe(Effect.provide(NodeServices.layer)),
  { arbitrary: { runs: 20 } },
)
