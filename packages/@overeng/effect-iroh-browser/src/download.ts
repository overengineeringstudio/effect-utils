/**
 * Downloads `url` completely and reports every received chunk. Progress counts decoded bytes,
 * so `totalBytes` is the file's real size (a compressed `Content-Length` would not match); a
 * file that turns out larger raises the total instead of overshooting 100 %.
 */
export const fetchWithProgress = async ({
  url,
  totalBytes,
  onProgress,
  fetchImpl = fetch,
}: {
  url: string
  totalBytes: number
  onProgress: (progress: { receivedBytes: number; totalBytes: number }) => void
  fetchImpl?: typeof fetch
}): Promise<Uint8Array<ArrayBuffer>> => {
  onProgress({ receivedBytes: 0, totalBytes })
  const response = await fetchImpl(url)
  if (response.ok === false) throw new Error(`HTTP ${response.status} loading ${url}`)
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const bytes = new Uint8Array(await response.arrayBuffer())
    onProgress({
      receivedBytes: bytes.byteLength,
      totalBytes: Math.max(totalBytes, bytes.byteLength),
    })
    return bytes
  }
  const chunks: Uint8Array[] = []
  let received = 0
  // Adapt the reader directly so streamed responses and getReader-only implementations work alike.
  const incoming: AsyncIterable<Uint8Array> = {
    [Symbol.asyncIterator]: () => ({ next: () => reader.read() }),
  }
  for await (const value of incoming) {
    chunks.push(value)
    received += value.byteLength
    onProgress({ receivedBytes: received, totalBytes: Math.max(totalBytes, received) })
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}
