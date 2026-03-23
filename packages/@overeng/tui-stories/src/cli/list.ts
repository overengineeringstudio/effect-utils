import { Command, Options } from '@effect/cli'
import { Effect } from 'effect'
import React from 'react'

import { run } from '@overeng/tui-react'
import { outputOption, outputModeLayer } from '@overeng/tui-react/node'

import { discoverStories } from '../StoryDiscovery.ts'
import { ListApp, ListView } from './renderers/ListOutput/mod.ts'

const pathOption = Options.text('path').pipe(
  Options.withDescription('Package directory to search for stories'),
)

/** CLI subcommand to list all discovered stories */
export const listCommand = Command.make(
  'list',
  { path: pathOption, output: outputOption },
  ({ path, output }) =>
    Effect.gen(function* () {
      const { modules, skippedCount } = yield* discoverStories({ packageDirs: [path] })

      const groups = modules.map((mod) => ({
        title: mod.meta.title,
        stories: mod.stories.map((story) => ({
          name: story.name,
          hasTimeline: story.args.interactive !== undefined,
          argCount: Object.keys(story.argTypes).length,
        })),
      }))

      yield* run(
        ListApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetState',
              state: { groups, skippedCount, packagePath: path },
            })
          }),
        { view: React.createElement(ListView, { stateAtom: ListApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(Command.withDescription('List all discovered stories'))
