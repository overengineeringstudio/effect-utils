import type { NormalizedValue } from '@overeng/effect-rpc-explorer'

const quote = (value: string): string => JSON.stringify(value)

/** Serializes only the normalized algebra without inspecting a live application value. */
export const normalizedValueText = (value: NormalizedValue): string => {
  switch (value._tag) {
    case 'Null':
      return 'null'
    case 'Boolean':
    case 'Number':
      return String(value.value)
    case 'String':
      return quote(value.value)
    case 'BigInt':
      return `${value.value}n`
    case 'Bytes':
      return `<${value.byteLength} bytes: ${value.base64}>`
    case 'Redacted':
      return 'Redacted value'
    case 'Unsupported':
      return `Unsupported value type: ${value.type}`
    case 'Truncated':
      return `Value truncated: ${value.reason}${value.retained === undefined ? '' : `\n${normalizedValueText(value.retained)}`}`
    case 'Array':
      return `[${value.value.map(normalizedValueText).join(', ')}]`
    case 'Object':
      return `{${Object.entries(value.value)
        .map(([key, child]) => `${quote(key)}: ${normalizedValueText(child)}`)
        .join(', ')}}`
  }
}
