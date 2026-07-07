// Notion API access for the demo-env CLI, over the `ntn` CLI (`ntn api …`).
//
// Notion is heavily 429-rate-limiting, so every call goes through a single
// global throttle (min gap between calls) + bounded exponential backoff on
// rate-limit / conflict responses. Provisioning is sequential by construction
// (one env at a time), so the throttle is a plain module-level clock.

import { run, sleep } from './exec.ts'

const NTN = process.env.NTN ?? 'ntn'

// --- global throttle -------------------------------------------------------
// Minimum spacing between consecutive `ntn api` calls. Notion's published limit
// is ~3 req/s; we stay comfortably under it and let backoff absorb bursts.
const MIN_GAP_MS = 400
let lastCallAt = 0

const throttle = async (): Promise<void> => {
  const wait = MIN_GAP_MS - (Date.now() - lastCallAt)
  if (wait > 0) await sleep(wait)
  lastCallAt = Date.now()
}

const MAX_RETRIES = 6
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 20_000

export interface NtnApiOptions {
  /** HTTP method (default GET). */
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  /** Request body — object (JSON-serialized) or raw string. */
  readonly body?: unknown
  /** Extra inline inputs (query params / headers), e.g. `page_size=100`. */
  readonly query?: readonly string[]
  readonly timeoutMs?: number
}

type Json = Record<string, unknown>

const looksRateLimited = (json: Json | undefined, stderr: string): boolean => {
  if (json && json.object === 'error') {
    const status = typeof json.status === 'number' ? json.status : undefined
    const code = typeof json.code === 'string' ? json.code : ''
    if (status === 429 || status === 409) return true
    if (/rate_limited|conflict/i.test(code)) return true
  }
  return /rate.?limit|429|too many requests/i.test(stderr)
}

/**
 * Call `ntn api <path>` and parse the JSON response. Throttled, and retried with
 * bounded backoff on rate-limit / conflict. Throws (loudly) on any other error
 * or once retries are exhausted — a persistent 429 must fail, never hang.
 */
export const ntnApi = async (
  path: string,
  opts: NtnApiOptions = {},
): Promise<Json> => {
  const args: string[] = ['api', path]
  if (opts.method && opts.method !== 'GET') args.push('-X', opts.method)
  if (opts.query) args.push(...opts.query)
  if (opts.body !== undefined) {
    args.push('-d', typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body))
  }

  let lastErr = ''
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    await throttle()
    const r = await run(NTN, args, { timeoutMs: opts.timeoutMs ?? 60_000 })
    const out = r.stdout.trim()
    let json: Json | undefined
    if (out.length > 0) {
      try {
        json = JSON.parse(out) as Json
      } catch {
        json = undefined
      }
    }

    if (looksRateLimited(json, r.stderr)) {
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** attempt, MAX_BACKOFF_MS)
      const jitter = Math.floor(Math.random() * 400)
      lastErr = `rate-limited on ${path}`
      if (attempt < MAX_RETRIES) {
        await sleep(backoff + jitter)
        continue
      }
      throw new Error(`ntn api ${path}: still rate-limited after ${MAX_RETRIES} retries`)
    }

    if (r.code !== 0) {
      throw new Error(`ntn api ${path} failed (${r.code}): ${r.stderr || out}`)
    }
    if (json === undefined) {
      throw new Error(`ntn api ${path} returned non-JSON: ${out.slice(0, 300)}`)
    }
    if (json.object === 'error') {
      throw new Error(`Notion API error on ${path}: ${JSON.stringify(json)}`)
    }
    return json
  }
  throw new Error(`ntn api ${path}: exhausted retries (${lastErr})`)
}

// --- convenience wrappers --------------------------------------------------

const title = (content: string) => [{ type: 'text', text: { content } }]

/** Create a child page under `parentPageId`; returns its id + canonical URL. */
export const createPage = async (
  parentPageId: string,
  pageTitle: string,
  emoji?: string,
): Promise<{ id: string; url: string }> => {
  const body: Json = {
    parent: { type: 'page_id', page_id: parentPageId },
    properties: { title: { title: title(pageTitle) } },
  }
  if (emoji) body.icon = { type: 'emoji', emoji }
  const res = await ntnApi('/v1/pages', { method: 'POST', body })
  return { id: String(res.id), url: String(res.url ?? pageUrl(String(res.id))) }
}

/** Create a page under a data source (a database row). Returns page id. */
export const createRow = async (
  dataSourceId: string,
  properties: Json,
): Promise<string> => {
  const res = await ntnApi('/v1/pages', {
    method: 'POST',
    body: { parent: { type: 'data_source_id', data_source_id: dataSourceId }, properties },
  })
  return String(res.id)
}

/** Create a database with an initial data source. Returns db id, ds id, URL. */
export const createDatabase = async (
  parentPageId: string,
  dbTitle: string,
  properties: Json,
  emoji?: string,
): Promise<{ dbId: string; dsId: string; url: string }> => {
  const body: Json = {
    parent: { type: 'page_id', page_id: parentPageId },
    title: title(dbTitle),
    initial_data_source: { properties },
  }
  if (emoji) body.icon = { type: 'emoji', emoji }
  const res = await ntnApi('/v1/databases', { method: 'POST', body })
  const sources = Array.isArray(res.data_sources) ? res.data_sources : []
  const dsId = sources.length > 0 ? String((sources[0] as Json).id) : ''
  if (!res.id || !dsId) {
    throw new Error(`database create for "${dbTitle}" returned no id/data source`)
  }
  return { dbId: String(res.id), dsId, url: String(res.url ?? pageUrl(String(res.id))) }
}

/** List block children of a page (follows pagination). */
export const getChildren = async (blockId: string): Promise<Json[]> => {
  const all: Json[] = []
  let cursor: string | undefined
  do {
    // ntn inline query-param syntax is `name==value` (double equals).
    const query = ['page_size==100', ...(cursor ? [`start_cursor==${cursor}`] : [])]
    const res = await ntnApi(`/v1/blocks/${blockId}/children`, { query })
    if (Array.isArray(res.results)) all.push(...(res.results as Json[]))
    cursor = res.has_more === true ? String(res.next_cursor) : undefined
  } while (cursor)
  return all
}

/** Move a page to the Notion trash. Cascades to child pages + databases. */
export const trashPage = async (pageId: string): Promise<void> => {
  await ntnApi(`/v1/pages/${pageId}`, { method: 'PATCH', body: { in_trash: true } })
}

/** Canonical no-dashes Notion URL for a page/db id. */
export const pageUrl = (id: string): string => `https://www.notion.so/${id.replace(/-/g, '')}`
