import { Command } from '@effect/cli'

import { inspectCommand } from './inspect.ts'
import { listCommand } from './list.ts'
import { renderCommand } from './render.ts'

/** CLI entry point for the headless TUI story runner */
export const tuiStoriesCommand = Command.make('tui-stories').pipe(
  Command.withSubcommands([listCommand, renderCommand, inspectCommand]),
  Command.withDescription('Headless TUI story runner — render Storybook stories in the terminal'),
)
