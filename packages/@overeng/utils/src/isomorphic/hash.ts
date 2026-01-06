import { sha1 } from '@noble/hashes/sha1'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'

export const sha256Hex = (data: string | Uint8Array): string => bytesToHex(sha256(data))
export const sha1Hex = (data: string | Uint8Array): string => bytesToHex(sha1(data))
