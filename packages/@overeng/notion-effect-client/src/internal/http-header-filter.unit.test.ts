/**
 * Regression: `@effect/platform`'s `HttpClient` tracer hardcodes emission
 * of every response header as a `http.response.header.<name>` span
 * attribute. For Notion that's ~31 low-signal attrs per span (cf-ray,
 * alt-svc, HSTS, cookie flagging, ...). The effect-utils-local patch in
 * `packages/@overeng/utils/patches/@effect__platform@0.96.0.patch`
 * restricts emission to a small allowlist.
 *
 * Static check: asserts the installed `@effect/platform` dist bundle
 * carries the `HTTP_HEADER_ATTR_ALLOWLIST` sentinel introduced by the
 * patch. A full e2e span capture is covered by downstream pixeltrail
 * trace-quality assertions.
 */
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'

import { describe, expect, it } from 'vitest'

const requirePkg = createRequire(import.meta.url)
const platformPkgJsonPath = requirePkg.resolve('@effect/platform/package.json')
const platformRoot = platformPkgJsonPath.replace(/\/package\.json$/, '')

describe('@effect/platform header attr filter (local patch)', () => {
  it('dist/esm carries the HTTP_HEADER_ATTR_ALLOWLIST sentinel', () => {
    const esm = readFileSync(`${platformRoot}/dist/esm/internal/httpClient.js`, 'utf8')
    expect(esm).toMatch(/HTTP_HEADER_ATTR_ALLOWLIST\.has\(name\.toLowerCase\(\)\) === false/)
    expect(esm).toMatch(/x-notion-request-id/)
  })

  it('dist/cjs carries the HTTP_HEADER_ATTR_ALLOWLIST sentinel', () => {
    const cjs = readFileSync(`${platformRoot}/dist/cjs/internal/httpClient.js`, 'utf8')
    expect(cjs).toMatch(/HTTP_HEADER_ATTR_ALLOWLIST\.has\(name\.toLowerCase\(\)\) === false/)
  })
})
