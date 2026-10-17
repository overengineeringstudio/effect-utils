import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { checkRustToolchainShadows } from './repository-validation-runner.ts'

const roots: string[] = []

const fixture = (files: readonly string[]): string => {
  const root = mkdtempSync(path.join(tmpdir(), 'repository-validation-'))
  roots.push(root)
  for (const relativePath of files) {
    const absolutePath = path.join(root, relativePath)
    mkdirSync(path.dirname(absolutePath), { recursive: true })
    writeFileSync(absolutePath, '[toolchain]\nchannel = "stable"\n')
  }
  return root
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('Rust toolchain authority', () => {
  it('rejects a package-local toolchain shadow staged by the Cargo source set', () => {
    const sourceRoot = fixture([
      'rust-toolchain.toml',
      'packages/@overeng/otel-scrape/rust-toolchain.toml',
    ])

    expect(() =>
      checkRustToolchainShadows({
        sourceRoot,
        memberPaths: ['packages/@overeng/otel-scrape'],
      }),
    ).toThrow('packages/@overeng/otel-scrape shadows the repository Rust toolchain')
  })

  it('accepts packages governed by the repository toolchain', () => {
    const sourceRoot = fixture(['rust-toolchain.toml'])

    expect(() =>
      checkRustToolchainShadows({
        sourceRoot,
        memberPaths: ['packages/@overeng/otel-scrape'],
      }),
    ).not.toThrow()
  })
})
