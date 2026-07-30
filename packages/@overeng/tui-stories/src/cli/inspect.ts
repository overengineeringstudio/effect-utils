import { Effect } from 'effect'
import { Argument as Args, Command, Flag as Options } from 'effect/unstable/cli'
import React from 'react'

import { run } from '@overeng/tui-react'
import { outputOption, outputModeLayer } from '@overeng/tui-react/node'

import { StoryCaptureError } from '../StoryCapture.ts'
import { discoverStories } from '../StoryDiscovery.ts'
import { findStory } from '../StoryModule.ts'
import { InspectApp, InspectView } from './renderers/InspectOutput/mod.ts'

const storyIdArg = Args.string('story-id').pipe(
  Args.withDescription('Story title or ID to inspect'),
)

const pathOption = Options.string('path').pipe(
  Options.withDescription('Package directory to search for stories'),
)

/** CLI subcommand to inspect story metadata and args */
export const inspectCommand = Command.make(
  'inspect',
  { storyId: storyIdArg, path: pathOption, output: outputOption },
  ({ storyId, path, output }) =>
    Effect.gen(function* () {
      const { modules } = yield* discoverStories({ packageDirs: [path] })
      const story = findStory({ modules, query: storyId })

      if (story === undefined) {
        return yield* Effect.fail(
          new StoryCaptureError({ storyId, message: `Story not found: "${storyId}"` }),
        )
      }

      const argTypeEntries = Object.entries(story.argTypes)
      const args = argTypeEntries.map(([name, argType]) => ({
        name,
        controlType: argType.control.type,
        description: argType.description,
        defaultValue: story.args[name] !== undefined ? JSON.stringify(story.args[name]) : undefined,
        options: argType.control.type === 'select' ? [...argType.control.options] : undefined,
        conditional: argType.if?.arg,
      }))

      yield* run(
        InspectApp,
        (tui) =>
          Effect.sync(() => {
            tui.dispatch({
              _tag: 'SetState',
              state: {
                id: story.id,
                title: story.title,
                name: story.name,
                filePath: story.filePath,
                args,
                hasTimeline: story.args.interactive !== undefined,
                timelineEventCount: 0,
              },
            })
          }),
        { view: React.createElement(InspectView, { stateAtom: InspectApp.stateAtom }) },
      ).pipe(Effect.provide(outputModeLayer(output)))
    }),
).pipe(Command.withDescription('Inspect story metadata and available args'))
