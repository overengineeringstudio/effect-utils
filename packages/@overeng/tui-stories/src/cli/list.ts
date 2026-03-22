import { Command, Options } from '@effect/cli'
import { Console, Effect } from 'effect'

import { discoverStories } from '../StoryDiscovery.ts'

const pathOption = Options.text('path').pipe(
  Options.withDescription('Package directory to search for stories'),
)

const jsonOption = Options.boolean('json').pipe(
  Options.withDescription('Output as JSON'),
  Options.withDefault(false),
)

/** CLI subcommand to list all discovered stories */
export const listCommand = Command.make(
  'list',
  { path: pathOption, json: jsonOption },
  ({ path, json }) =>
    Effect.gen(function* () {
      const modules = yield* discoverStories({ packageDirs: [path] })

      if (json === true) {
        const data = modules.flatMap((mod) =>
          mod.stories.map((story) => ({
            id: story.id,
            title: story.title,
            name: story.name,
            hasTimeline: story.args.interactive !== undefined,
            argCount: Object.keys(story.argTypes).length,
            filePath: story.filePath,
          })),
        )
        yield* Console.log(JSON.stringify(data, null, 2))
        return
      }

      if (modules.length === 0) {
        yield* Console.log('No stories found.')
        return
      }

      for (const mod of modules) {
        yield* Console.log(`\n${mod.meta.title}`)
        for (const story of mod.stories) {
          const timeline = story.args.interactive !== undefined ? ' [timeline]' : ''
          const argCount = Object.keys(story.argTypes).length
          const args = argCount > 0 ? ` (${argCount} args)` : ''
          yield* Console.log(`  ${story.name}${timeline}${args}`)
        }
      }
      yield* Console.log('')
    }),
).pipe(Command.withDescription('List all discovered stories'))
