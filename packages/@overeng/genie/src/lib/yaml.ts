/**
 * Simple YAML stringifier for GitHub Actions workflows
 * Handles the subset of YAML features needed for workflows
 */

const INDENT = '  '

const needsQuoting = (str: string): boolean => {
  if (str === '') return true
  if (str === 'true' || str === 'false' || str === 'null') return true
  if (/^\d+$/.test(str) || /^\d+\.\d+$/.test(str)) return true
  if (str.startsWith('${{') && str.endsWith('}}')) return false
  if (/^[{[\]!@#%&*|>?]/.test(str)) return true
  if (/[:#]/.test(str)) return true
  if (str.includes('\n')) return true
  return false
}

/** Quote a key if it needs quoting (e.g., starts with @) */
const quoteKey = (key: string): string => (needsQuoting(key) ? `"${key}"` : key)

const quoteString = (str: string): string => {
  if (str.includes('\n')) {
    return `|\n${str
      .split('\n')
      .map((line) => INDENT + line)
      .join('\n')}`
  }
  if (needsQuoting(str)) {
    return `"${str.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return str
}

// oxlint-disable-next-line overeng/named-args -- simple internal recursive helper
const stringifyValue = (value: unknown, indent: number): string => {
  if (value === null || value === undefined) {
    return 'null'
  }

  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }

  if (typeof value === 'number') {
    return String(value)
  }

  if (typeof value === 'string') {
    return quoteString(value)
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'

    const isSimpleArray = value.every(
      (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
    )

    if (isSimpleArray && value.length <= 5) {
      const items = value.map((item) =>
        typeof item === 'string' ? quoteString(item) : String(item),
      )
      return `[${items.join(', ')}]`
    }

    const prefix = INDENT.repeat(indent)
    return value
      .map((item) => `\n${prefix}- ${stringifyValue(item, indent + 1).trimStart()}`)
      .join('')
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(([, v]) => v !== undefined)
    if (entries.length === 0) return '{}'

    const prefix = INDENT.repeat(indent)
    const lines = entries.map(([key, val]) => {
      const quotedKey = quoteKey(key)
      const stringifiedVal = stringifyValue(val, indent + 1)
      if (
        typeof val === 'object' &&
        val !== null &&
        !Array.isArray(val) &&
        Object.keys(val).length > 0
      ) {
        return `${prefix}${quotedKey}:\n${stringifiedVal}`
      }
      if (Array.isArray(val) && val.length > 0 && !isSimpleInlineArray(val)) {
        return `${prefix}${quotedKey}:${stringifiedVal}`
      }
      return `${prefix}${quotedKey}: ${stringifiedVal}`
    })

    return lines.join('\n')
  }

  return String(value)
}

const isSimpleInlineArray = (arr: unknown[]): boolean => {
  if (arr.length > 5) return false
  return arr.every(
    (item) => typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean',
  )
}

/**
 * Stringify a value to YAML format
 * Designed for GitHub Actions workflow files
 */
export const stringify = (value: unknown): string => {
  if (typeof value !== 'object' || value === null) {
    return stringifyValue(value, 0)
  }

  const entries = Object.entries(value).filter(([, v]) => v !== undefined)
  const lines = entries.map(([key, val]) => {
    const quotedKey = quoteKey(key)
    const stringifiedVal = stringifyValue(val, 1)
    if (
      typeof val === 'object' &&
      val !== null &&
      !Array.isArray(val) &&
      Object.keys(val).length > 0
    ) {
      return `${quotedKey}:\n${stringifiedVal}`
    }
    if (Array.isArray(val) && val.length > 0 && !isSimpleInlineArray(val)) {
      return `${quotedKey}:${stringifiedVal}`
    }
    return `${quotedKey}: ${stringifiedVal}`
  })

  return lines.join('\n\n') + '\n'
}
