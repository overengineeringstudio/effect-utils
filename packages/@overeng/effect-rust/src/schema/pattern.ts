import { Schema } from 'effect'

import { AdmissionError } from '../compiler/ir.ts'

/** Deliberately small intersection of ECMAScript Unicode and Rust regex syntax.
 * Full-string anchors avoid the engines' different unanchored/end-line rules.
 */
// eslint-disable-next-line overeng/named-args -- Preserve the public assertPortablePattern positional SDK signature.
export const assertPortablePattern = (
  source: string,
  flags: string = 'u',
  path = '$/pattern',
): void => {
  const fail = (feature: string): never => {
    throw new AdmissionError(
      path,
      feature,
      'Use a full-string anchored portable pattern with u or iu; remove lookaround, backreferences and engine-specific escapes',
    )
  }
  if (flags !== 'u' && flags !== 'iu') fail(`Non-portable flags ${flags}`)
  let endBackslashes = 0
  for (let index = source.length - 2; index >= 0 && source[index] === '\\'; index--)
    endBackslashes++
  if (
    source.startsWith('^') === false ||
    source.endsWith('$') === false ||
    endBackslashes % 2 === 1
  )
    fail('Full-string ^ and $ anchors required')
  let inClass = false
  let groups = 0
  for (let index = 1; index < source.length - 1; index++) {
    const character = source[index]!
    if (character === '\\') {
      const escaped = source[++index]
      if (escaped === 'p') {
        const property = source.slice(index + 1).match(/^\{(L|N|Nd|Letter|Number|Decimal_Number)\}/)
        if (property === null) fail('Unsupported Unicode property')
        index += property![0].length
      } else if (escaped === undefined || '\\^$.*+?()[]{}|/-'.includes(escaped) === false)
        fail(`Non-portable escape \\${escaped}`)
      continue
    }
    if (character === '[' && inClass === false) {
      inClass = true
      continue
    }
    if (character === ']' && inClass === true) {
      inClass = false
      continue
    }
    if (inClass === true) {
      if (character === '&' || character === '[') fail('Class set operations are not portable')
      continue
    }
    if (character === '(') {
      if (source[index + 1] === '?') fail('Special groups and lookaround are not portable')
      groups++
      continue
    }
    if (character === ')') {
      if (--groups < 0) fail('Unbalanced group')
      continue
    }
    if (character === '|' && groups === 0)
      fail('Alternation must be enclosed in a fully anchored group')
    if (character === '.' || character === '^' || character === '$')
      fail('Dot and interior anchors are not portable')
    if (
      '*+?}'.includes(character) === true &&
      (source[index + 1] === '?' || source[index + 1] === '+')
    )
      fail('Lazy and possessive quantifiers are not portable')
    if (character === '{') {
      const quantifier = source.slice(index).match(/^\{(\d+)(?:,(\d*))?\}/)
      if (quantifier === null) fail('Invalid bounded quantifier')
      if (
        Number(quantifier![1]) > 10000 ||
        (quantifier![2] !== undefined && quantifier![2] !== '' && Number(quantifier![2]) > 10000)
      )
        fail('Quantifier exceeds portable limit')
      index += quantifier![0].length - 1
    }
  }
  if (inClass === true || groups !== 0) fail('Unbalanced pattern')
  try {
    void new RegExp(source, flags)
  } catch {
    fail('Invalid regex syntax')
  }
}

/** Filter used with Schema.String.check(EffectRust.pattern(...)). */
// eslint-disable-next-line overeng/named-args -- Preserve the public pattern positional SDK signature.
export const pattern = (source: string, flags: 'u' | 'iu' = 'u') => {
  assertPortablePattern(source, flags)
  // Require complete consumption explicitly, even if future admitted patterns change.
  const regexp = new RegExp(source, flags)
  return Schema.makeFilter<string>(
    (value) => {
      const match = regexp.exec(value)
      return match !== null && match.index === 0 && match[0].length === value.length
    },
    {
      expected: `a string matching portable pattern ${source}`,
      representation: { id: 'effect/schema/isPattern', payload: { source, flags } },
      'x-effect-rust-pattern': source,
      'x-effect-rust-pattern-flags': flags,
    },
  )
}
