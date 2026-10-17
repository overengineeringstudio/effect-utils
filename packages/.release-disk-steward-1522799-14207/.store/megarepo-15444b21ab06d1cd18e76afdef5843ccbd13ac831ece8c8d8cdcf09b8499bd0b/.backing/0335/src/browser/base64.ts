/**
 * Base64 encoding/decoding utilities.
 *
 * Thin facade over upstream `effect/encoding/Base64`, which owns this capability as of
 * Effect 4. Kept as a module so browser consumers have a stable namespace
 * import (`base64.encode` & co.) without depending on Deno stdlib ports.
 */

import { Result } from 'effect'
import { Base64 } from 'effect/encoding'

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
export const encode = (data: Uint8Array | string): string => Base64.encode(data)

/**
 * Decodes a base64 string to a Uint8Array.
 *
 * Throws an `EncodingError` for input that is not valid padded
 * base64 (CRLF inside the string is tolerated).
 *
 * @param b64 - Base64 encoded string
 * @returns Decoded bytes as Uint8Array
 *
 * @example
 * ```ts
 * decode('SGVsbG8=') // Uint8Array([72, 101, 108, 108, 111])
 * ```
 */
export const decode = (b64: string): Uint8Array => Result.getOrThrow(Base64.decode(b64))

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
export const decodeToString = (b64: string): string => Result.getOrThrow(Base64.decodeString(b64))
