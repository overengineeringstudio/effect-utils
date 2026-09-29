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
export const canonicalJobKey = ({
  job,
  dimensions,
}: {
  job: string
  dimensions: Readonly<Record<string, string>>
}): Buffer => {
  if (job === '') throw new TypeError('pipeline job identifier is empty')
  const names = Object.keys(dimensions)
  // oxlint-disable-next-line unicorn/no-array-sort -- Object.keys returns a fresh array; toSorted copies it again.
  names.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
  const count = Buffer.allocUnsafe(4)
  count.writeUInt32BE(names.length)
  const parts = [frame(job), count]
  for (const name of names) {
    const value = dimensions[name]
    if (name === '' || value === undefined || value === '')
      throw new TypeError('pipeline dimension name and value must be nonempty')
    parts.push(frame(name), frame(value))
  }
  return Buffer.concat(parts)
}

const derive = ({
  domain,
  runId,
  bytes,
  jobKey,
}: {
  domain: string
  runId: string
  bytes: 8 | 16
  jobKey?: Buffer
}): string => {
  if (runId === '') throw new TypeError('pipeline run identifier is empty')
  const preimage = Buffer.concat([
    Buffer.from(`${domain}\0`),
    frame(runId),
    ...(jobKey !== undefined ? [jobKey] : []),
  ])
  for (let counter = 0; ; counter++) {
    const hash = createHash('sha256')
    hash.update(preimage)
    if (counter !== 0) {
      const suffix = Buffer.allocUnsafe(4)
      suffix.writeUInt32BE(counter)
      hash.update(suffix)
    }
    const id = hash.digest().subarray(0, bytes)
    if (id.some((byte) => byte !== 0) === true) return id.toString('hex')
  }
}

/** Derives a stable trace ID for one job in an attempt. */
export const deriveJobTraceId = ({
  runId,
  job,
  dimensions,
}: {
  runId: string
  job: string
  dimensions: Readonly<Record<string, string>>
}): string =>
  derive({
    domain: 'buck2.job.trace/v1',
    runId,
    bytes: 16,
    jobKey: canonicalJobKey({ job, dimensions }),
  })

/** Derives a stable root span ID for one job in an attempt. */
export const deriveJobRootSpanId = ({
  runId,
  job,
  dimensions,
}: {
  runId: string
  job: string
  dimensions: Readonly<Record<string, string>>
}): string =>
  derive({
    domain: 'buck2.job.root/v1',
    runId,
    bytes: 8,
    jobKey: canonicalJobKey({ job, dimensions }),
  })

/** Derives the pipeline attempt trace ID. */
export const derivePipelineTraceId = (runId: string): string =>
  derive({ domain: 'buck2.pipeline-run.trace/v2', runId, bytes: 16 })

/** Derives the pipeline attempt root span ID. */
export const derivePipelineRootSpanId = (runId: string): string =>
  derive({ domain: 'buck2.pipeline-run.root/v2', runId, bytes: 8 })
