/**
 * Config subcommand group — push-refs, pin, unpin
 */

import * as Cli from '@effect/cli'

import { pinCommand, unpinCommand } from '../pin.ts'
import { pushRefsCommand } from './push-refs.ts'

/** Config subcommand: push-refs, pin, unpin */
export const configCommand = Cli.Command.make('config', {}).pipe(
  Cli.Command.withSubcommands([pushRefsCommand, pinCommand, unpinCommand]),
  Cli.Command.withDescription('Configuration operations: push refs, pin/unpin members'),
)
