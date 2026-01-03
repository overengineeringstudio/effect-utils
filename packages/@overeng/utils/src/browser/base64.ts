/**
 * Base64 encoding/decoding utilities.
 * Browser-compatible implementation based on Deno standard library.
 * @see https://deno.land/std/encoding/base64.ts
 *
 * Copyright 2018-2022 the Deno authors. All rights reserved. MIT license.
 */

const base64abc = [
  'A',
  'B',
  'C',
  'D',
  'E',
  'F',
  'G',
  'H',
  'I',
  'J',
  'K',
  'L',
  'M',
  'N',
  'O',
  'P',
  'Q',
  'R',
  'S',
  'T',
  'U',
  'V',
  'W',
  'X',
  'Y',
  'Z',
  'a',
  'b',
  'c',
  'd',
  'e',
  'f',
  'g',
  'h',
  'i',
  'j',
  'k',
  'l',
  'm',
  'n',
  'o',
  'p',
  'q',
  'r',
  's',
  't',
  'u',
  'v',
  'w',
  'x',
  'y',
  'z',
  '0',
  '1',
  '2',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '+',
  '/',
] as const

const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/**
 * Encodes data to a base64 string.
 *
 * @param data - String or Uint8Array to encode
 * @returns Base64 encoded string
 *
 * @example
 * ```ts
 * encode('Hello') // "SGVsbG8="
 * encode(new Uint8Array([72, 101, 108, 108, 111])) // "SGVsbG8="
 * ```
 */
export const encode = (data: Uint8Array | string): string => {
  const uint8 =
    typeof data === 'string'
      ? textEncoder.encode(data)
      : data instanceof Uint8Array
        ? data
        : new Uint8Array(data)

  let result = ''
  let i: number
  const l = uint8.length

  for (i = 2; i < l; i += 3) {
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[uint8[i - 2]! >> 2]
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[((uint8[i - 2]! & 0x03) << 4) | (uint8[i - 1]! >> 4)]
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[((uint8[i - 1]! & 0x0f) << 2) | (uint8[i]! >> 6)]
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[uint8[i]! & 0x3f]
  }

  if (i === l + 1) {
    // 1 byte remaining
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[uint8[i - 2]! >> 2]
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[(uint8[i - 2]! & 0x03) << 4]
    result += '=='
  }

  if (i === l) {
    // 2 bytes remaining
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[uint8[i - 2]! >> 2]
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[((uint8[i - 2]! & 0x03) << 4) | (uint8[i - 1]! >> 4)]
    // biome-ignore lint/style/noNonNullAssertion: index guaranteed in bounds
    result += base64abc[(uint8[i - 1]! & 0x0f) << 2]
    result += '='
  }

  return result
}

/**
 * Decodes a base64 string to a Uint8Array.
 *
 * @param b64 - Base64 encoded string
 * @returns Decoded bytes as Uint8Array
 *
 * @example
 * ```ts
 * decode('SGVsbG8=') // Uint8Array([72, 101, 108, 108, 111])
 * ```
 */
export const decode = (b64: string): Uint8Array => {
  const binString = atob(b64)
  const size = binString.length
  const bytes = new Uint8Array(size)
  for (let i = 0; i < size; i++) {
    bytes[i] = binString.charCodeAt(i)
  }
  return bytes
}

/**
 * Decodes a base64 string directly to a UTF-8 string.
 *
 * @param b64 - Base64 encoded string
 * @returns Decoded UTF-8 string
 *
 * @example
 * ```ts
 * decodeToString('SGVsbG8=') // "Hello"
 * ```
 */
export const decodeToString = (b64: string): string => textDecoder.decode(decode(b64))
