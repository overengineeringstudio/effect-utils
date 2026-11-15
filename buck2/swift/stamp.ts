/**
 * Embed a build stamp in the one Swift source that declares its placeholder.
 *
 * The product's `"__CLI_BUILD_STAMP__"` string literal becomes the stamp JSON
 * as a string literal: the shape Nix builds embed (context/builds/01-identity),
 * so a Buck-built product carries the same canonical identity.
 */
export const embedBuildStamp = ({
  source,
  placeholder,
  stamp,
}: {
  readonly source: string
  readonly placeholder: string
  readonly stamp: string
}): string => {
  const literal = JSON.stringify(placeholder)
  const occurrences = source.split(literal).length - 1
  if (occurrences !== 1) {
    throw new Error(`swift build stamp: expected exactly one ${literal} literal, found ${occurrences}`)
  }
  if (stamp === '' || /[\r\n]/.test(stamp)) {
    throw new Error('swift build stamp: the stamp must be a non-empty single line')
  }
  JSON.parse(stamp)
  return source.replace(literal, JSON.stringify(stamp))
}

if (import.meta.main) {
  const [input, output, placeholder, stamp] = process.argv.slice(2)
  if (input === undefined || output === undefined || placeholder === undefined || stamp === undefined) {
    throw new Error('usage: stamp.ts <input.swift> <output.swift> <placeholder> <stamp-json>')
  }
  await Bun.write(output, embedBuildStamp({ source: await Bun.file(input).text(), placeholder, stamp }))
}
