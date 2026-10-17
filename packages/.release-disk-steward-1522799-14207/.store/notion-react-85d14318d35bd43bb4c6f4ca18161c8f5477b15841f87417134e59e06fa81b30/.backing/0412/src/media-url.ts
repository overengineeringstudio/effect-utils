/*
 * Hosted-media URL canonicalization (decision 0007 / R36).
 *
 * Notion-hosted media (image/file/video/pdf with `type: "file"`) renders with
 * an expiring signed S3 URL whose signature query params (`X-Amz-*`,
 * `Signature`, `Expires`, …) rotate on every pull. Left raw, the rendered body
 * hash is volatile — breaking `cat`→`put` idempotence, staling base hashes with
 * zero edits, and causing media-page pushes to be rejected by the post-push
 * `semanticEquivalent` gate.
 *
 * Canonicalization strips only the volatile signature/expiry family of query
 * params (by name) and keeps everything else, so a benign external query param
 * (`?v=2`, `?w=800`) survives untouched. This single function is the shared
 * source of truth: the renderer applies it so pull output is deterministic, and
 * `canonical-markdown.ts` applies it inside `semanticEquivalent` /
 * `canonicalizeBlockMarkdown` so the gate compares the same canonical form.
 */

/*
 * Volatile query-parameter names stripped from a signed URL. Covers the AWS
 * SigV4 family Notion's S3 presigner emits plus the legacy SigV2 names, matched
 * case-insensitively. Any other param (including benign external ones) is kept.
 */
const VOLATILE_QUERY_PARAMS: ReadonlySet<string> = new Set([
  'x-amz-algorithm',
  'x-amz-credential',
  'x-amz-date',
  'x-amz-expires',
  'x-amz-signature',
  'x-amz-signedheaders',
  'x-amz-security-token',
  'x-amz-content-sha256',
  // Legacy SigV2 / generic presign params.
  'awsaccesskeyid',
  'signature',
  'expires',
])

/**
 * Strip the volatile signature/expiry query params from a single URL while
 * keeping its origin, path, and any non-volatile query params. Non-URL or
 * unparseable input is returned unchanged.
 */
export const canonicalizeMediaUrl = (url: string): string => {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }

  const volatileKeys = Array.from(parsed.searchParams.keys()).filter((key) =>
    VOLATILE_QUERY_PARAMS.has(key.toLowerCase()),
  )
  if (volatileKeys.length === 0) return url
  for (const key of volatileKeys) parsed.searchParams.delete(key)

  /*
   * Rebuild from origin + pathname + remaining query so the result is the bare
   * canonical URL. `URL.toString()` would re-encode and append a trailing `?`
   * edge case; assemble explicitly instead.
   */
  const remaining = parsed.searchParams.toString()
  const query = remaining === '' ? '' : `?${remaining}`
  return `${parsed.origin}${parsed.pathname}${query}${parsed.hash}`
}

/*
 * Matches a Markdown URL occurrence inside `(...)` of an image/link, i.e. the
 * `](<url>)` form the renderer emits for media blocks. We only rewrite URLs in
 * that position so prose text that happens to contain `X-Amz-` is left alone.
 */
const MARKDOWN_URL_RE = /\]\(([^)\s]+)\)/g

/*
 * Hosts that serve Notion-hosted media (the signed S3/CDN URLs whose signature
 * params rotate per pull). An EXTERNAL signed URL (a user's own private S3
 * bucket embedded by URL) must NOT be touched — stripping its signature breaks
 * the credentials. So the markdown-string path (which, unlike the renderer,
 * cannot see `file` vs `external`) only canonicalizes URLs on these hosts.
 */
const isNotionMediaHost = (parsed: URL): boolean =>
  parsed.hostname === 'prod-files-secure.s3.us-west-2.amazonaws.com' ||
  parsed.hostname === 'file.notion.so' ||
  parsed.hostname.endsWith('.notion.so') ||
  parsed.hostname.endsWith('.notion-static.com') ||
  // Older bucket-in-path form: s3*.amazonaws.com/secure.notion-static.com/...
  (parsed.hostname.endsWith('.amazonaws.com') &&
    parsed.pathname.startsWith('/secure.notion-static.com/'))

/**
 * Canonicalize every hosted-media URL embedded in a Markdown string. Used by
 * the hashing/gating path where only the rendered text (not the source block)
 * is available. Unlike the renderer it cannot see `file` vs. `external`, so it
 * restricts signature stripping to known Notion-media hosts (see
 * `isNotionMediaHost`). External signed URLs — e.g. a user's own private S3
 * bucket embedded by URL, whose `X-Amz-*` params are load-bearing credentials —
 * are preserved untouched.
 */
export const canonicalizeMediaUrlsInMarkdown = (markdown: string): string =>
  markdown.replace(MARKDOWN_URL_RE, (match, url: string) => {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return match
    }
    if (isNotionMediaHost(parsed) === false) return match

    const canonical = canonicalizeMediaUrl(url)
    return canonical === url ? match : `](${canonical})`
  })
