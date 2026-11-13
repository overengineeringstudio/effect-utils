/**
 * Render an app bundle's Info.plist: the rule's own keys in their declared
 * order, then the consumer's extra keys sorted, which may not override them.
 */
type PlistValue = string | number | boolean | readonly PlistValue[] | { readonly [key: string]: PlistValue }

const escape = (text: string) => text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')

const renderValue = (value: PlistValue, indent: string): string[] => {
  if (typeof value === 'string') return [`${indent}<string>${escape(value)}</string>`]
  if (typeof value === 'boolean') return [`${indent}<${value}/>`]
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`info plist: only integer numbers are supported: ${value}`)
    return [`${indent}<integer>${value}</integer>`]
  }
  if (Array.isArray(value)) {
    return [`${indent}<array>`, ...value.flatMap((item: PlistValue) => renderValue(item, `${indent}  `)), `${indent}</array>`]
  }
  if (typeof value === 'object' && value !== null) {
    return [`${indent}<dict>`, ...renderEntries(sortedEntries(value), `${indent}  `), `${indent}</dict>`]
  }
  throw new Error(`info plist: unsupported value ${JSON.stringify(value)}`)
}

const renderEntries = (entries: readonly (readonly [string, PlistValue])[], indent: string): string[] =>
  entries.flatMap(([key, value]) => [`${indent}<key>${escape(key)}</key>`, ...renderValue(value, indent)])

const sortedEntries = (record: { readonly [key: string]: PlistValue }) =>
  Object.entries(record).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))

export const renderInfoPlist = ({
  entries,
  extra,
}: {
  readonly entries: readonly (readonly [string, PlistValue])[]
  readonly extra: { readonly [key: string]: PlistValue }
}): string => {
  const owned = new Set(entries.map(([key]) => key))
  const overridden = Object.keys(extra).filter((key) => owned.has(key))
  if (overridden.length > 0) throw new Error(`info plist: extra keys override rule-owned keys: ${overridden.join(', ')}`)
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    ...renderEntries([...entries, ...sortedEntries(extra)], '  '),
    '</dict>',
    '</plist>',
    '',
  ].join('\n')
}

if (import.meta.main) {
  const [input, output] = process.argv.slice(2)
  if (input === undefined || output === undefined) throw new Error('usage: info-plist.ts <input.json> <Info.plist>')
  await Bun.write(output, renderInfoPlist(await Bun.file(input).json()))
}
