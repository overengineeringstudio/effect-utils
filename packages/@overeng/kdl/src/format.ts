import { InvalidKdlError } from './parser/internal-error.ts'
import { Document } from './model/document.ts'
import { Entry } from './model/entry.ts'
import { Identifier } from './model/identifier.ts'
import { Node } from './model/node.ts'
import { Tag } from './model/tag.ts'
import { Value } from './model/value.ts'
import { stringifyString } from './string-utils.ts'

const reStartsWithInlineWhitespace =
  /^[\uFEFF\u0009\u0020\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/

const formatTag = (tag: Tag | null): string => {
  if (tag == null) {
    return ''
  }

  let representation: string
  if (tag.representation?.[0] === '#') {
    representation = stringifyString(tag.name)
  } else {
    representation = formatIdentifier(tag)
  }

  return `(${tag.leading ?? ''}${representation}${tag.trailing ?? ''})`
}

const formatTagAsSuffix = (valueRepresentation: string, tag: Tag): string | undefined => {
  let representation = tag.representation
  if (!representation) {
    representation = stringifyString(tag.name)
  }

  if (
    representation[0] === '"' ||
    (representation.startsWith('#') && representation.endsWith('#'))
  ) {
    return undefined
  }

  let useHash = false

  if (representation?.[0] === '#') {
    useHash = true
    representation = representation.slice(1)
  }

  if (!useHash) {
    useHash =
      valueRepresentation.startsWith('0b') ||
      valueRepresentation.startsWith('0o') ||
      valueRepresentation.startsWith('0x') ||
      /^[,._]|^[a-zA-Z][0-9_]|^[eE][+-][0-9_]|[xX][a-fA-F]/.test(representation)
  }

  return useHash ? '#' + representation : representation
}

const ensureStartsWithWhitespace = (text: string | undefined): string => {
  if (text == null) {
    return ' '
  }

  return reStartsWithInlineWhitespace.test(text) || text.startsWith('\\') ? text : ` ${text}`
}

/** Format a finite number according to its numberFormat hint */
const formatNumberWithHint = (n: number, fmt: Value['numberFormat']): string => {
  switch (fmt) {
    case 'float': {
      const s = JSON.stringify(n)
      return s.includes('.') ? s : s + '.0'
    }
    case 'int-exponent': {
      const s = n.toExponential()
      const [mantissa, exp] = s.split('e')
      const expNum = Number.parseInt(exp!, 10)
      const expSign = expNum >= 0 ? '+' : ''
      return `${mantissa}E${expSign}${expNum}`
    }
    case 'float-exponent': {
      const s = n.toExponential()
      const [mantissa, exp] = s.split('e')
      const mantissaStr = mantissa!.includes('.') ? mantissa! : mantissa! + '.0'
      const expNum = Number.parseInt(exp!, 10)
      const expSign = expNum >= 0 ? '+' : ''
      return `${mantissaStr}E${expSign}${expNum}`
    }
    default:
      return JSON.stringify(n)
  }
}

const formatValue = (value: Value): string => {
  let representation = value.representation

  if (representation == null) {
    if (typeof value.value === 'boolean' || value.value === null) {
      representation = `#${value.value}`
    } else if (typeof value.value === 'string') {
      representation = stringifyString(value.value)
    } else if (typeof value.value === 'number') {
      if (Number.isNaN(value.value)) {
        representation = '#nan'
      } else if (!Number.isFinite(value.value)) {
        representation = value.value > 0 ? '#inf' : '#-inf'
      }
    }
  }

  if (representation == null) {
    representation = formatNumberWithHint(value.value as number, value.numberFormat)
  }

  if (
    value.tag?.suffix &&
    typeof value.value === 'number' &&
    representation[0] !== '#'
  ) {
    const tagRepresentation = formatTagAsSuffix(representation, value.tag)
    if (tagRepresentation) {
      return representation + tagRepresentation
    }
  }

  return (
    (value.tag ? formatTag(value.tag) + (value.betweenTagAndValue ?? '') : '') +
    representation
  )
}

const formatIdentifier = (identifier: Pick<Identifier, 'name' | 'representation'>): string => {
  if (identifier.representation != null) {
    return identifier.representation
  }

  return stringifyString(identifier.name)
}

const formatEntry = (entry: Entry): string =>
  `${ensureStartsWithWhitespace(entry.leading)}${
    entry.name ? `${formatIdentifier(entry.name)}${entry.equals ?? '='}` : ''
  }${formatValue(entry.value)}${entry.trailing ?? ''}`

const indent = '    '

const formatNode = (node: Node, indentation: number): string =>
  `${node.leading ?? indent.repeat(indentation)}${formatTag(node.tag)}${
    node.betweenTagAndName ?? ''
  }${formatIdentifier(node.name)}${node.entries
    .map((entry) => formatEntry(entry))
    .join('')}${
    node.children
      ? `${node.beforeChildren ?? ' '}{${formatDocument(node.children, indentation + 1)}}`
      : ''
  }${node.trailing ?? '\n'}`

const formatDocument = (document: Document, indentation: number): string =>
  `${
    document.nodes[0] != null && document.nodes[0].leading == null && indentation
      ? '\n'
      : ''
  }${document.nodes.map((node) => formatNode(node, indentation)).join('')}${
    document.trailing ?? indent.repeat((indentation || 1) - 1)
  }`

type KdlFormattable = Value | Identifier | Tag | Entry | Node | Document

const formatters = new Map<string, (value: any, indentation: number) => string>([
  [Value.type, formatValue],
  [Identifier.type, formatIdentifier],
  [Tag.type, formatTag],
  [Entry.type, formatEntry],
  [Node.type, formatNode],
  [Document.type, formatDocument],
])

/** Serialize a KDL AST node to string */
export const format = (v: KdlFormattable): string => {
  const formatter = formatters.get(v.type)
  if (formatter == null) {
    throw new InvalidKdlError(`Cannot format non-KDL ${v}`)
  }

  const result = formatter(v, 0)

  /** Ensure top-level documents always end with a newline */
  if (v.type === Document.type && !result.endsWith('\n')) {
    return result + '\n'
  }

  return result
}
