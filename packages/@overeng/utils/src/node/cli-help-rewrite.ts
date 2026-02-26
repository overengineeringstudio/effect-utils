/** Rewrites `tool help <subcmd>` → `tool <subcmd> --help` for CLIs that lack a native `help` subcommand. */
export const rewriteHelpSubcommand = (argv: readonly string[]): string[] => {
  const [node, script, ...args] = argv
  if (args[0] === 'help') {
    const rest = args.slice(1)
    return rest.length > 0 ? [node!, script!, ...rest, '--help'] : [node!, script!, '--help']
  }
  return [...argv]
}
