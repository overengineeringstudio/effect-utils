import sodium, { ready, from_base64, to_base64, base64_variants } from 'libsodium-wrappers'

/** Initialize and validate before consuming a one-use manifest code or reading a source secret. */
export const prepareSealedBox = async (key: string): Promise<Uint8Array> => {
  await ready
  const bytes = from_base64(key, base64_variants.ORIGINAL)
  if (bytes.length !== sodium.crypto_box_PUBLICKEYBYTES)
    throw new TypeError('Invalid Actions public key')
  return bytes
}
/** Only ciphertext escapes; the caller owns and must zero the plaintext buffer. */
export const sealSecret = ({
  plaintext,
  publicKey,
}: {
  plaintext: Uint8Array
  publicKey: Uint8Array
}): string => to_base64(sodium.crypto_box_seal(plaintext, publicKey), base64_variants.ORIGINAL)
