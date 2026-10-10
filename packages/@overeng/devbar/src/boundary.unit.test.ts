// @vitest-environment node
import { NodeServices } from '@effect/platform-node'
import { describe, it } from '@effect/vitest'
import { Effect, FileSystem } from 'effect'
import { expect } from 'vitest'

const forbiddenModule = /^@overeng\/(?:meters|rpc-devtools|effect-rpc-[^/]+|otel-browser)(?:\/|$)/

// Scan module specifiers without depending on the unavailable tsgo compiler API.
const moduleImports = (options: {
  readonly source: string
  readonly fileName: string
}): readonly string[] => {
  const ignored: { readonly start: number; readonly end: number }[] = []
  const source = options.source
  for (let index = 0; index < source.length; index++) {
    const start = index
    const character = source[index]
    if (character === '/' && source[index + 1] === '/') {
      while (index < source.length && source[index] !== '\n') index++
    } else if (character === '/' && source[index + 1] === '*') {
      index += 2
      while (index < source.length && (source[index] !== '*' || source[index + 1] !== '/')) index++
      index++
    } else if (character === "'" || character === '"' || character === '`') {
      index++
      while (index < source.length && source[index] !== character) {
        if (source[index] === '\\') index++
        index++
      }
    } else if (character === '/') {
      // Ignore regex bodies too, including quotes and slashes inside character classes.
      let inClass = false
      index++
      while (index < source.length && source[index] !== '\n') {
        if (source[index] === '\\') index++
        else if (source[index] === '[') inClass = true
        else if (source[index] === ']') inClass = false
        else if (source[index] === '/' && inClass === false) break
        index++
      }
    } else continue
    ignored.push({ start, end: index + 1 })
  }
  const moduleSpecifier =
    /\b(?:import|export)\s+(?:type\s+)?(?:[\w$*,{}\s]+?\s+from\s*)?(?<quote>['"])(?<static>[^'"]+)\k<quote>|\b(?:import|require)\s*\(\s*(?<callQuote>['"])(?<call>[^'"]+)\k<callQuote>|@import\s+(?:url\()?(?<cssQuote>['"])(?<css>[^'"]+)\k<cssQuote>/g
  const found: string[] = []
  for (const match of source.matchAll(moduleSpecifier)) {
    if (ignored.some((range) => match.index >= range.start && match.index < range.end) === true)
      continue
    const specifier = match.groups?.['static'] ?? match.groups?.['call'] ?? match.groups?.['css']
    if (specifier !== undefined) found.push(specifier)
  }
  return found
}

const diagnosticImports = (options: {
  readonly source: string
  readonly fileName: string
}): readonly string[] =>
  moduleImports(options).filter((specifier) => forbiddenModule.test(specifier))

describe('devbar shell dependency boundary', () => {
  it('detects forbidden static, type-only, re-export and dynamic imports', () => {
    expect(
      diagnosticImports({
        fileName: 'example.ts',
        source: `
      import { MeterStrip } from '@overeng/meters/react'
      import type { RpcDevtools } from '@overeng/rpc-devtools/core'
      export * from '@overeng/effect-rpc-explorer'
      void import('@overeng/effect-rpc-observer')
      const telemetry = require('@overeng/otel-browser')
    `,
      }),
    ).toEqual([
      '@overeng/meters/react',
      '@overeng/rpc-devtools/core',
      '@overeng/effect-rpc-explorer',
      '@overeng/effect-rpc-observer',
      '@overeng/otel-browser',
    ])
    expect(
      diagnosticImports({
        fileName: 'example.ts',
        source: `const example = "import('@overeng/meters')"`,
      }),
    ).toEqual([])
  })

  it.effect('keeps utils and the optional identity segment out of the root entry graph', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const pending = [new URL('./mod.ts', import.meta.url)]
      const visited = new Set<string>()
      const violations: { readonly file: string; readonly import: string }[] = []
      while (pending.length > 0) {
        const file = pending.pop()
        if (file === undefined || visited.has(file.pathname) === true) continue
        visited.add(file.pathname)
        const source = yield* fs.readFileString(file.pathname)
        for (const specifier of moduleImports({ source, fileName: file.pathname })) {
          if (
            /^@overeng\/utils(?:\/|$)/.test(specifier) === true ||
            specifier.includes('BuildIdentitySegment') === true ||
            /^@overeng\/devbar\/build-identity(?:\/|$)/.test(specifier) === true
          ) {
            violations.push({ file: file.pathname, import: specifier })
          }
          if (specifier.startsWith('.') === true) pending.push(new URL(specifier, file))
        }
      }
      expect(violations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)),
  )

  it.effect('keeps every non-story src file free of diagnostic package imports', () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const src = new URL('.', import.meta.url).pathname
      const files = yield* fs.readDirectory(src, { recursive: true })
      const violations: { readonly file: string; readonly imports: readonly string[] }[] = []
      for (const file of files) {
        const normalized = file.replaceAll('\\', '/')
        if (normalized.startsWith('stories/') === true) continue
        const absolute = `${src}/${file}`
        const stat = yield* fs.stat(absolute)
        if (stat.type !== 'File') continue
        const source = yield* fs.readFileString(absolute)
        const imports = diagnosticImports({ source, fileName: absolute })
        if (imports.length > 0) violations.push({ file: normalized, imports })
      }
      // The Vite entry is in src/stories/host and uses only the guarded host loader.
      const fixtureEntry = new URL('./stories/host/fixture-entry.ts', import.meta.url).pathname
      expect(
        diagnosticImports({
          fileName: fixtureEntry,
          source: yield* fs.readFileString(fixtureEntry),
        }),
      ).toEqual([])
      expect(violations).toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)),
  )
})
