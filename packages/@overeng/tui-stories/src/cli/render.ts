import { Args, Command, Options } from '@effect/cli'
import { Console, Effect } from 'effect'

import { captureStoryProps, StoryCaptureError } from '../StoryCapture.ts'
import { discoverStories } from '../StoryDiscovery.ts'
import { findStory, parseArgOverrides } from '../StoryModule.ts'
import { renderStory, OUTPUT_MODES, type OutputMode, type TimelineMode } from '../StoryRenderer.ts'

const storyIdArg = Args.text({ name: 'story-id' }).pipe(
  Args.withDescription('Story title or ID to render (supports prefix/substring match)'),
)

const storyNameOption = Options.text('story').pipe(
  Options.withAlias('s'),
  Options.withDescription('Named story export to render (defaults to first)'),
  Options.optional,
)

const pathOption = Options.text('path').pipe(
  Options.withDescription('Package directory to search for stories'),
)

const widthOption = Options.integer('width').pipe(
  Options.withAlias('w'),
  Options.withDescription('Terminal width for layout'),
  Options.withDefault(80),
)

const outputOption = Options.choice('output', [...OUTPUT_MODES]).pipe(
  Options.withAlias('o'),
  Options.withDescription('Output mode: tty, alt-screen, ci, ci-plain, pipe, log, json, ndjson'),
  Options.withDefault('ci' as OutputMode),
)

const finalOption = Options.boolean('final').pipe(
  Options.withDescription('Apply all timeline events (show final state)'),
  Options.withDefault(false),
)

const atOption = Options.integer('at').pipe(
  Options.withDescription('Apply timeline events up to this timestamp (ms)'),
  Options.optional,
)

const argOption = Options.text('arg').pipe(
  Options.withAlias('a'),
  Options.withDescription('Override story arg (key=value format, repeatable)'),
  Options.repeated,
)

/** CLI subcommand to render a story to terminal output */
export const renderCommand = Command.make(
  'render',
  {
    storyId: storyIdArg,
    storyName: storyNameOption,
    path: pathOption,
    width: widthOption,
    output: outputOption,
    final: finalOption,
    at: atOption,
    argOverrides: argOption,
  },
  ({ storyId, storyName, path, width, output, final: isFinal, at, argOverrides }) =>
    Effect.gen(function* () {
      const modules = yield* discoverStories({ packageDirs: [path] })

      const query = storyName._tag === 'Some' ? `${storyId}/${storyName.value}` : storyId

      const story = findStory({ modules, query })
      if (story === undefined) {
        yield* Console.error(`Story not found: "${query}"`)
        yield* Console.error('Use `tui-stories list --path <dir>` to see available stories.')
        return yield* Effect.fail(
          new StoryCaptureError({ storyId: query, message: 'Story not found' }),
        )
      }

      const overrides = parseArgOverrides([...argOverrides])

      const captured = yield* Effect.tryPromise({
        try: () => captureStoryProps({ story, argOverrides: overrides }),
        catch: (error) =>
          new StoryCaptureError({
            storyId: story.id,
            message: error instanceof Error ? error.message : String(error),
          }),
      })

      const timelineMode: TimelineMode =
        at._tag === 'Some' ? { at: at.value } : isFinal === true ? 'final' : 'initial'

      const result = yield* renderStory({
        captured,
        width,
        timelineMode,
        output,
      })

      yield* Console.log(result)
    }),
).pipe(Command.withDescription('Render a story to terminal output'))
