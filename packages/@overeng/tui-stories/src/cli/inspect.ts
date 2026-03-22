import { Args, Command, Options } from '@effect/cli'
import { Console, Effect } from 'effect'

import { discoverStories } from '../StoryDiscovery.ts'
import { findStory, type ArgType } from '../StoryModule.ts'

const storyIdArg = Args.text({ name: 'story-id' }).pipe(
  Args.withDescription('Story title or ID to inspect'),
)

const pathOption = Options.text('path').pipe(
  Options.withDescription('Package directory to search for stories'),
)

const jsonOption = Options.boolean('json').pipe(
  Options.withDescription('Output as JSON'),
  Options.withDefault(false),
)

const formatArgType = ({
  name,
  argType,
}: {
  readonly name: string
  readonly argType: ArgType
}): string => {
  const desc = argType.description !== undefined ? ` — ${argType.description}` : ''
  const ctrl = argType.control

  switch (ctrl.type) {
    case 'boolean':
      return `  --${name}  (boolean)${desc}`
    case 'select':
      return `  --${name}  (${ctrl.options?.join(' | ') ?? 'select'})${desc}`
    case 'text':
      return `  --${name}  (text)${desc}`
    case 'number':
      return `  --${name}  (number)${desc}`
    case 'range': {
      const range =
        ctrl.min !== undefined && ctrl.max !== undefined ? ` [${ctrl.min}..${ctrl.max}]` : ''
      return `  --${name}  (range${range})${desc}`
    }
  }
}

/** CLI subcommand to inspect story metadata and args */
export const inspectCommand = Command.make(
  'inspect',
  { storyId: storyIdArg, path: pathOption, json: jsonOption },
  ({ storyId, path, json }) =>
    Effect.gen(function* () {
      const modules = yield* discoverStories({ packageDirs: [path] })
      const story = findStory({ modules, query: storyId })

      if (story === undefined) {
        yield* Console.error(`Story not found: "${storyId}"`)
        return
      }

      if (json === true) {
        const data = {
          id: story.id,
          title: story.title,
          name: story.name,
          filePath: story.filePath,
          args: story.args,
          argTypes: story.argTypes,
          hasTimeline: story.args.interactive !== undefined,
        }
        yield* Console.log(JSON.stringify(data, null, 2))
        return
      }

      yield* Console.log(`\nStory: ${story.id}`)
      yield* Console.log(`File:  ${story.filePath}`)

      const argTypeEntries = Object.entries(story.argTypes)
      if (argTypeEntries.length > 0) {
        yield* Console.log('\nArgs:')
        for (const [name, argType] of argTypeEntries) {
          const conditional = argType.if !== undefined ? ` [if ${argType.if.arg}]` : ''
          const defaultVal = story.args[name]
          const defaultStr =
            defaultVal !== undefined ? `  (default: ${JSON.stringify(defaultVal)})` : ''
          yield* Console.log(`${formatArgType({ name, argType })}${defaultStr}${conditional}`)
        }
      }

      const hasTimeline = story.args.interactive !== undefined
      yield* Console.log(
        `\nTimeline: ${hasTimeline === true ? 'yes (use --final to apply)' : 'no'}`,
      )
      yield* Console.log('')
    }),
).pipe(Command.withDescription('Inspect story metadata and available args'))
