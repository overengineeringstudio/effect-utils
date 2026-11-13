import path from 'node:path'

/** Render a generator's final UTF-8 file content, including its generated header.
 *
 * `genieFilePath` names the source (the target is its sibling without `.genie.ts`).
 * Context is forwarded unchanged. For targets formatted by genie, supply `format`
 * using the same formatter/configuration; BUCK and other unformatted targets need none.
 * This entry deliberately imports no generation engine or formatter.
 */
export const renderGenieOutput = <TContext>({
  output,
  context,
  genieFilePath,
  format = (content) => content,
}: {
  output: { stringify: (context: TContext) => string }
  context: TContext
  genieFilePath: string
  format?: (content: string) => string
}): string =>
  renderGeneratedContent({
    content: format(output.stringify(context)),
    targetFilePath: genieFilePath.replace('.genie.ts', ''),
    sourceFile: path.basename(genieFilePath),
  })

/** Assemble already-formatted content and the generated header, preserving shebangs. */
export const renderGeneratedContent = ({
  content,
  targetFilePath,
  sourceFile,
}: {
  content: string
  targetFilePath: string
  sourceFile: string
}): string =>
  addHeaderComment({ content, header: getHeaderComment({ targetFilePath, sourceFile }) })

/**
 * Get the appropriate header comment for a generated file based on its extension.
 *
 * The source file reference uses just the basename (e.g., `package.json.genie.ts`) rather than
 * a path relative to the working directory. This design choice avoids ambiguity when genie runs
 * in a monorepo with git submodules: if the source path were relative to cwd, running genie from
 * the parent repo would produce paths like `submodules/child-repo/packages/.../file.genie.ts`,
 * while running from the child repo would produce `packages/.../file.genie.ts`. Using basename
 * ensures consistent output regardless of where genie is invoked, since the `.genie.ts` source
 * file is always a sibling of the generated file.
 */
export const getHeaderComment = ({
  targetFilePath,
  sourceFile,
}: {
  targetFilePath: string
  sourceFile: string
}): string => {
  const ext = path.extname(targetFilePath)
  const basename = path.basename(targetFilePath)

  // tsconfig*.json files support JS-style comments
  if (basename.startsWith('tsconfig') === true && ext === '.json') {
    return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
  }

  // JSONC files support JS-style comments
  if (ext === '.jsonc') {
    return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
  }

  // Strict JSON formats rely on read-only permissions + .gitattributes, not comments.
  if (ext === '.json' || basename === '.watchmanconfig') {
    return ''
  }

  if (ext === '.yml' || ext === '.yaml') {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  if (
    basename === '.buckconfig' ||
    basename === 'BUCK' ||
    ext === '.bzl' ||
    ext === '.bxl' ||
    ext === '.nix'
  ) {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  if (ext === '.sh') {
    return `# Generated file - DO NOT EDIT\n# Source: ${sourceFile}\n\n`
  }

  // Default to JS/TS style comments
  return `// Generated file - DO NOT EDIT\n// Source: ${sourceFile}\n`
}

/**
 * Prepend the generated-file header to content, preserving a leading `#!` shebang line
 * (the banner is inserted after the shebang, not before it).
 *
 * A hashbang is only valid as the very first bytes of a file. That is a hard rule for scripts of any
 * language, not just `.sh`: putting a comment banner ahead of `#!` in a `.mjs` makes the file a
 * `SyntaxError` rather than merely mis-executing it. So this keys off the shebang itself, not the
 * extension.
 */
export const addHeaderComment = ({
  content,
  header,
}: {
  content: string
  header: string
}): string => {
  if (content.startsWith('#!') === false) {
    return header + content
  }

  const firstNewlineIndex = content.indexOf('\n')
  if (firstNewlineIndex < 0) {
    return `${content}\n${header}`
  }

  const shebangLine = content.slice(0, firstNewlineIndex + 1)
  const rest = content.slice(firstNewlineIndex + 1)
  return shebangLine + header + rest
}
