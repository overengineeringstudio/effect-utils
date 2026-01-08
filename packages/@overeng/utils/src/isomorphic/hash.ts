import { sha1 } from '@noble/hashes/sha1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

/** Computes SHA-256 hash and returns it as a hex string */
export const sha256Hex = (data: string | Uint8Array): string => bytesToHex(sha256(data))

/** Computes SHA-1 hash and returns it as a hex string */
export const sha1Hex = (data: string | Uint8Array): string => bytesToHex(sha1(data))
