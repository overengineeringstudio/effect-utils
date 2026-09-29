import { createHash } from 'node:crypto'

const encoder = new TextEncoder()
const frame = (value: string): Buffer => {
  const bytes = encoder.encode(value)
  if (bytes.length > 0xffff_ffff) throw new RangeError('pipeline identity component too long')
  const out = Buffer.allocUnsafe(4 + bytes.length)
  out.writeUInt32BE(bytes.length)
  out.set(bytes, 4)
  return out
}

/** K(job, dimensions): UTF-8 length frames, ordered by dimension-name bytes. */
export const canonicalJobKey = (job: string, dimensions: Readonly<Record<string, string>>): Buffer => {
  if (!job) throw new TypeError('pipeline job identifier is empty')
  const names = Object.keys(dimensions).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const count = Buffer.allocUnsafe(4)
  count.writeUInt32BE(names.length)
  const parts = [frame(job), count]
  for (const name of names) {
    const value = dimensions[name]
    if (!name || !value) throw new TypeError('pipeline dimension name and value must be nonempty')
    parts.push(frame(name), frame(value))
  }
  return Buffer.concat(parts)
}

const derive = (domain: string, runId: string, bytes: 8 | 16, jobKey?: Buffer): string => {
  if (!runId) throw new TypeError('pipeline run identifier is empty')
  const preimage = Buffer.concat([Buffer.from(`${domain}\0`), frame(runId), ...(jobKey ? [jobKey] : [])])
  for (let counter = 0; ; counter++) {
    const hash = createHash('sha256')
    hash.update(preimage)
    if (counter) {
      const suffix = Buffer.allocUnsafe(4)
      suffix.writeUInt32BE(counter)
      hash.update(suffix)
    }
    const id = hash.digest().subarray(0, bytes)
    if (id.some((byte) => byte !== 0)) return id.toString('hex')
  }
}

export const deriveJobTraceId = (runId: string, job: string, dimensions: Readonly<Record<string, string>>): string =>
  derive('buck2.job.trace/v1', runId, 16, canonicalJobKey(job, dimensions))
export const deriveJobRootSpanId = (runId: string, job: string, dimensions: Readonly<Record<string, string>>): string =>
  derive('buck2.job.root/v1', runId, 8, canonicalJobKey(job, dimensions))
export const derivePipelineTraceId = (runId: string): string => derive('buck2.pipeline-run.trace/v2', runId, 16)
export const derivePipelineRootSpanId = (runId: string): string => derive('buck2.pipeline-run.root/v2', runId, 8)
