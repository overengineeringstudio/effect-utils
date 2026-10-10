type Labels = { readonly consumer: string; readonly model: string }
type Kind = 'input' | 'output' | 'cached' | 'reasoning'

const escapeLabel = (value: string) =>
  value.replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"')
const label = (value: string) => `"${escapeLabel(value)}"`
const buckets = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300] as const

/** Bounded per-consumer Prometheus request, token and duration accounting. */
export class Metrics {
  private readonly requests = new Map<string, { labels: Labels; status: number; count: number }>()
  private readonly tokens = new Map<string, { labels: Labels; kind: Kind; count: number }>()
  private readonly durations = new Map<
    string,
    { labels: Labels; count: number; sum: number; buckets: number[] }
  >()
  private readonly models = new Set<string>()
  private readonly maxModelLabels: number

  constructor(maxModelLabels = 64) {
    if (Number.isSafeInteger(maxModelLabels) === false || maxModelLabels < 0)
      throw new RangeError('maxModelLabels must be a nonnegative safe integer')
    this.maxModelLabels = maxModelLabels
  }

  private boundedLabels({ labels, status }: { labels: Labels; status: number }): Labels {
    let model: string
    if (status < 200 || status >= 300) model = '_rejected'
    else if (
      labels.model === '_other' ||
      labels.model === '_rejected' ||
      this.models.has(labels.model) === true
    )
      model = labels.model
    else if (this.models.size >= this.maxModelLabels) model = '_other'
    else {
      this.models.add(labels.model)
      model = labels.model
    }
    return model === labels.model ? labels : { consumer: labels.consumer, model }
  }

  record({ labels, status, seconds }: { labels: Labels; status: number; seconds: number }) {
    labels = this.boundedLabels({ labels, status })
    const key = JSON.stringify([labels.consumer, labels.model])
    const requestKey = JSON.stringify([labels.consumer, labels.model, status])
    const request = this.requests.get(requestKey)
    if (request !== undefined) request.count++
    else this.requests.set(requestKey, { labels, status, count: 1 })
    const duration = this.durations.get(key) ?? {
      labels,
      count: 0,
      sum: 0,
      buckets: buckets.map(() => 0),
    }
    duration.count++
    duration.sum += seconds
    buckets.forEach((bound, index) => {
      if (seconds <= bound) duration.buckets[index]!++
    })
    this.durations.set(key, duration)
  }

  addTokens({
    labels,
    status,
    kind,
    count,
  }: {
    labels: Labels
    status: number
    kind: Kind
    count: number
  }) {
    if (Number.isSafeInteger(count) === false || count < 0) return
    labels = this.boundedLabels({ labels, status })
    const key = JSON.stringify([labels.consumer, labels.model, kind])
    const entry = this.tokens.get(key)
    if (entry !== undefined) entry.count += count
    else this.tokens.set(key, { labels, kind, count })
  }

  render(): string {
    const lines = [
      '# HELP requests_total Gateway requests by upstream response status',
      '# TYPE requests_total counter',
    ]
    for (const { labels, status, count } of this.requests.values())
      lines.push(
        `requests_total{consumer=${label(labels.consumer)},model=${label(labels.model)},status=${label(String(status))}} ${count}`,
      )
    lines.push(
      '# HELP tokens_total Tokens reported by upstream usage',
      '# TYPE tokens_total counter',
    )
    for (const { labels, kind, count } of this.tokens.values())
      lines.push(
        `tokens_total{consumer=${label(labels.consumer)},model=${label(labels.model)},kind=${label(kind)}} ${count}`,
      )
    lines.push(
      '# HELP request_duration_seconds Gateway request duration',
      '# TYPE request_duration_seconds histogram',
    )
    for (const { labels, count, sum, buckets: counts } of this.durations.values()) {
      const base = `consumer=${label(labels.consumer)},model=${label(labels.model)}`
      buckets.forEach((bound, index) =>
        lines.push(
          `request_duration_seconds_bucket{${base},le=${label(String(bound))}} ${counts[index]}`,
        ),
      )
      lines.push(`request_duration_seconds_bucket{${base},le="+Inf"} ${count}`)
      lines.push(`request_duration_seconds_sum{${base}} ${sum}`)
      lines.push(`request_duration_seconds_count{${base}} ${count}`)
    }
    return `${lines.join('\n')}\n`
  }
}
