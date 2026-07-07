// Notion API helpers over the `ntn` CLI (`ntn api …`). This is the harness's
// *authoritative* assertion surface — Playwright is only ever used for evidence
// screenshots, never assertions (Notion's DOM is too brittle).

import { run } from './exec.ts'
import type { Assertion, NotionApiLike, NotionBlock } from './spec.ts'

const NTN = process.env.NTN ?? 'ntn'

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

/** Call `ntn api` and parse the JSON response. Throws on CLI or API error. */
const call = async (
  path: string,
  extra: readonly string[] = [],
): Promise<Record<string, unknown>> => {
  const r = await run(NTN, ['api', path, ...extra], { timeoutMs: 30_000 })
  const out = r.stdout.trim()
  if (r.code !== 0) {
    throw new Error(`ntn api ${path} failed (${r.code}): ${r.stderr || out}`)
  }
  let json: Record<string, unknown>
  try {
    json = JSON.parse(out) as Record<string, unknown>
  } catch {
    throw new Error(`ntn api ${path} returned non-JSON: ${out.slice(0, 300)}`)
  }
  if (json.object === 'error') {
    throw new Error(`Notion API error on ${path}: ${JSON.stringify(json)}`)
  }
  return json
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
