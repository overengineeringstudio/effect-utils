/** Rewrites `tool help <subcmd>` → `tool <subcmd> --help` for CLIs that lack a native `help` subcommand. */
export const rewriteHelpSubcommand = (argv: readonly string[]): string[] => {
  const [node, script, ...args] = argv
  if (args[0] === 'help') {
    return args[1] !== undefined ? [node!, script!, args[1], '--help'] : [node!, script!, '--help']
  }
  return [...argv]
}
