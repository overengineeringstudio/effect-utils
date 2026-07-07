// Notion API helpers over the `ntn` CLI (`ntn api …`). This is the harness's
// *authoritative* assertion surface — Playwright is only ever used for evidence
// screenshots, never assertions (Notion's DOM is too brittle).

import { run, sleep } from './exec.ts'
import type { Assertion, NotionApiLike, NotionBlock } from './spec.ts'

const NTN = process.env.NTN ?? 'ntn'

/** Notion is aggressively rate-limited today; back off + retry transient failures. */
const MAX_ATTEMPTS = 6
const isTransient = (msg: string): boolean =>
  /429|rate.?limit|conflict_error|timeout|ECONNRESET|ETIMEDOUT|socket hang up|internal_server_error|service_unavailable|502|503|504/i.test(
    msg,
  )

const plainText = (rt: unknown): string =>
  Array.isArray(rt)
    ? rt.map((r) => (r as { plain_text?: string }).plain_text ?? '').join('')
    : ''

const toBlock = (b: Record<string, unknown>): NotionBlock => {
  const type = String(b.type ?? '')
  const inner = (b[type] ?? {}) as Record<string, unknown>
  return {
    id: String(b.id ?? ''),
    type,
    text: plainText(inner.rich_text),
    checked: typeof inner.checked === 'boolean' ? inner.checked : undefined,
    raw: b,
  }
}

/**
 * Call `ntn api` and parse the JSON response. Throws on CLI or API error.
 * Retries transient failures (429 rate-limits, timeouts, 5xx) with exponential
 * backoff — Notion is heavily throttled and a bare read otherwise flakes.
 */
const call = async (
  path: string,
  extra: readonly string[] = [],
): Promise<Record<string, unknown>> => {
  let lastErr = ''
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let out = ''
    try {
      const r = await run(NTN, ['api', path, ...extra], { timeoutMs: 30_000 })
      out = r.stdout.trim()
      if (r.code !== 0) throw new Error(`ntn api ${path} failed (${r.code}): ${r.stderr || out}`)
      if (!out) throw new Error(`ntn api ${path} returned empty output`)
      const json = JSON.parse(out) as Record<string, unknown>
      if (json.object === 'error') {
        throw new Error(`Notion API error on ${path}: ${JSON.stringify(json)}`)
      }
      return json
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e)
      const retryable = isTransient(lastErr) || lastErr.includes('empty output') || lastErr.includes('non-JSON')
      if (!retryable || attempt === MAX_ATTEMPTS) {
        if (!out && !isTransient(lastErr) && lastErr.includes('empty')) {
          // treat as transient anyway on last look
        }
        if (attempt === MAX_ATTEMPTS) throw new Error(`${lastErr} (after ${attempt} attempts)`)
        throw new Error(lastErr)
      }
      // Exponential backoff with jitter: ~1s, 2s, 4s, 8s, 16s.
      await sleep(1000 * 2 ** (attempt - 1) + Math.floor(Math.random() * 400))
    }
  }
  throw new Error(lastErr || `ntn api ${path} failed`)
}

export const makeNotionApi = (): NotionApiLike => {
  const getBlocks = async (blockId: string): Promise<readonly NotionBlock[]> => {
    const json = await call(`/v1/blocks/${blockId}/children`)
    const results = Array.isArray(json.results) ? json.results : []
    return results.map((b) => toBlock(b as Record<string, unknown>))
  }

  const appendChildren = async (
    blockId: string,
    children: readonly unknown[],
  ): Promise<void> => {
    await call(`/v1/blocks/${blockId}/children`, [
      '-X',
      'PATCH',
      '-d',
      JSON.stringify({ children }),
    ])
  }

  const updateBlock = async (
    blockId: string,
    body: Record<string, unknown>,
  ): Promise<void> => {
    await call(`/v1/blocks/${blockId}`, ['-X', 'PATCH', '-d', JSON.stringify(body)])
  }

  const findBlockByText = async (
    blockId: string,
    text: string,
  ): Promise<NotionBlock | undefined> => {
    const blocks = await getBlocks(blockId)
    return blocks.find((b) => b.text === text)
  }

  return { getBlocks, appendChildren, updateBlock, findBlockByText }
}

// --- Assertion builders (used by demo specs) -------------------------------

/** Assert a `to_do` block with the given text has the expected checked state. */
export const todoChecked = async (
  api: NotionApiLike,
  pageId: string,
  text: string,
  expected: boolean,
): Promise<Assertion> => {
  const block = (await api.getBlocks(pageId)).find(
    (b) => b.type === 'to_do' && b.text === text,
  )
  if (!block) {
    return { ok: false, detail: `to_do "${text}" not found on page` }
  }
  return {
    ok: block.checked === expected,
    detail: `to_do "${text}" checked=${block.checked} (want ${expected})`,
  }
}

/** Assert a block with the given text exists (or not) somewhere on the page. */
export const pageHasText = async (
  api: NotionApiLike,
  pageId: string,
  text: string,
  present = true,
): Promise<Assertion> => {
  const blocks = await api.getBlocks(pageId)
  const found = blocks.some((b) => b.text.includes(text))
  return {
    ok: found === present,
    detail: `text "${text}" ${found ? 'present' : 'absent'} on page (want ${
      present ? 'present' : 'absent'
    })`,
  }
}

/** Assert a paragraph/block matching `text` exists exactly (Notion not clobbered). */
export const blockTextEquals = async (
  api: NotionApiLike,
  pageId: string,
  text: string,
): Promise<Assertion> => {
  const blocks = await api.getBlocks(pageId)
  const found = blocks.some((b) => b.text === text)
  return {
    ok: found,
    detail: `block with exact text "${text}" ${found ? 'present' : 'absent'} on page`,
  }
}

// --- Data-source (database) helpers ----------------------------------------
// The sqlite & schema demos operate on databases, whose properties live on a
// *data source*. These call `ntn api` directly (like the block helpers above)
// and are imported straight into those specs (they don't need the block-only
// `NotionApiLike` surface passed via ctx.api).

/** GET `/v1/databases/{id}` → its first data source id. */
export const resolveDataSourceId = async (databaseId: string): Promise<string> => {
  const json = await call(`/v1/databases/${databaseId}`)
  const sources = Array.isArray(json.data_sources) ? json.data_sources : []
  const id = (sources[0] as { id?: string } | undefined)?.id
  if (!id) throw new Error(`database ${databaseId} has no data source`)
  return id
}

const titleEqualsFilter = (title: string): string =>
  JSON.stringify({ filter: { property: 'Name', title: { equals: title } } })

/**
 * Assert the DB row whose title (Name) equals `title` has select property
 * `prop` set to `expected` — the authoritative check that a local SQLite edit
 * pushed through `notion db sync` actually landed remotely.
 */
export const dataSourceRowSelect = async (
  dataSourceId: string,
  title: string,
  prop: string,
  expected: string,
): Promise<Assertion> => {
  const json = await call(`/v1/data_sources/${dataSourceId}/query`, [
    '-X',
    'POST',
    '-d',
    titleEqualsFilter(title),
  ])
  const results = Array.isArray(json.results) ? json.results : []
  const row = results[0] as { properties?: Record<string, unknown> } | undefined
  if (!row) return { ok: false, detail: `row "${title}" not found in data source` }
  const cell = (row.properties?.[prop] ?? {}) as { select?: { name?: string } }
  const actual = cell.select?.name
  return {
    ok: actual === expected,
    detail: `row "${title}" · ${prop}="${actual}" (want "${expected}")`,
  }
}

/** Assert whether property `name` exists on the data source's schema. */
export const dataSourceHasProperty = async (
  dataSourceId: string,
  name: string,
  present = true,
): Promise<Assertion> => {
  const json = await call(`/v1/data_sources/${dataSourceId}`)
  const props = (json.properties ?? {}) as Record<string, unknown>
  const found = Object.prototype.hasOwnProperty.call(props, name)
  return {
    ok: found === present,
    detail: `property "${name}" ${found ? 'present' : 'absent'} on data source (want ${
      present ? 'present' : 'absent'
    })`,
  }
}

/**
 * PATCH the data source to add a checkbox property `name` (idempotent — a no-op
 * if it already exists). Used by the schema demo to introduce drift on camera.
 */
export const addCheckboxProperty = async (
  dataSourceId: string,
  name: string,
): Promise<void> => {
  const existing = await dataSourceHasProperty(dataSourceId, name)
  if (existing.ok) return
  await call(`/v1/data_sources/${dataSourceId}`, [
    '-X',
    'PATCH',
    '-d',
    JSON.stringify({ properties: { [name]: { checkbox: {} } } }),
  ])
}

/** PATCH the data source to remove property `name` (no-op if absent). */
export const removeProperty = async (
  dataSourceId: string,
  name: string,
): Promise<void> => {
  const existing = await dataSourceHasProperty(dataSourceId, name)
  if (!existing.ok) return
  await call(`/v1/data_sources/${dataSourceId}`, [
    '-X',
    'PATCH',
    '-d',
    JSON.stringify({ properties: { [name]: null } }),
  ])
}
