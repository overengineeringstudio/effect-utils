export const isUnicodeSpace = (codePoint: number): boolean => {
  switch (codePoint) {
    case 0x0009: // Character Tabulation
    case 0x0020: // Space
    case 0x00a0: // No-Break Space
    case 0x1680: // Ogham Space Mark
    case 0x2000: // En Quad
    case 0x2001: // Em Quad
    case 0x2002: // En Space
    case 0x2003: // Em Space
    case 0x2004: // Three-Per-Em Space
    case 0x2005: // Four-Per-Em Space
    case 0x2006: // Six-Per-Em Space
    case 0x2007: // Figure Space
    case 0x2008: // Punctuation Space
    case 0x2009: // Thin Space
    case 0x200a: // Hair Space
    case 0x202f: // Narrow No-Break Space
    case 0x205f: // Medium Mathematical Space
    case 0x3000: // Ideographic Space
      return true
  }
  return false
}

export const isNewLine = (codePoint: number): boolean =>
  codePoint === 0x0d || // Carriage Return
  codePoint === 0x0a || // Line Feed
  codePoint === 0x85 || // Next Line
  codePoint === 0x0b || // Line Tabulation
  codePoint === 0x0c || // Form Feed
  codePoint === 0x2028 || // Line Separator
  codePoint === 0x2029 // Paragraph Separator

export const isInvalidCharacter = (codePoint: number): boolean =>
  codePoint < 0x08 ||
  (codePoint >= 0x0e && codePoint <= 0x19) ||
  codePoint === 0x7f ||
  (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
  codePoint > 0x10ffff ||
  codePoint === 0x200e ||
  codePoint === 0x200f ||
  (codePoint >= 0x202a && codePoint <= 0x202e) ||
  (codePoint >= 0x2066 && codePoint <= 0x2069) ||
  codePoint === 0xfeff

export const isIdentifierChar = (codePoint: number): boolean =>
  !isNaN(codePoint) &&
  !isUnicodeSpace(codePoint) &&
  !isNewLine(codePoint) &&
  codePoint !== 0x3d && // =
  codePoint !== 0x5c && // \
  codePoint !== 0x2f && // /
  codePoint !== 0x28 && // (
  codePoint !== 0x29 && // )
  codePoint !== 0x7b && // {
  codePoint !== 0x7d && // }
  codePoint !== 0x3b && // ;
  codePoint !== 0x5b && // [
  codePoint !== 0x5d && // ]
  codePoint !== 0x22 && // "
  codePoint !== 0x23 // #

export const isAlpha = (codePoint: number): boolean =>
  (codePoint >= 0x41 && codePoint < 0x5b) || // A-Z
  (codePoint >= 0x61 && codePoint < 0x7b) // a-z

export const isHexadecimalDigit = (codePoint: number): boolean =>
  (codePoint >= 0x30 && codePoint < 0x40) || // 0-9
  (codePoint >= 0x41 && codePoint < 0x47) || // A-F
  (codePoint >= 0x61 && codePoint < 0x67) // a-f

export const isHexadecimalDigitOrUnderscore = (codePoint: number): boolean =>
  isHexadecimalDigit(codePoint) || codePoint === 0x5f

export const isDecimalDigit = (codePoint: number): boolean => codePoint >= 0x30 && codePoint < 0x3a

export const isDecimalDigitOrUnderscore = (codePoint: number): boolean =>
  isDecimalDigit(codePoint) || codePoint === 0x5f

export const isOctalDigit = (codePoint: number): boolean => codePoint >= 0x30 && codePoint < 0x38

export const isOctalDigitOrUnderscore = (codePoint: number): boolean =>
  isOctalDigit(codePoint) || codePoint === 0x5f

export const isBinaryDigit = (codePoint: number): boolean =>
  codePoint === 0x30 || codePoint === 0x31

export const isBinaryDigitOrUnderscore = (codePoint: number): boolean =>
  isBinaryDigit(codePoint) || codePoint === 0x5f

export const isNumberSign = (codePoint: number): boolean => codePoint === 0x2d || codePoint === 0x2b
