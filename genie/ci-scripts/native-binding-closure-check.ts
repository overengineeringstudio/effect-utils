#!/usr/bin/env bun
/**
 * Native binding closure-completeness check (issue #807 — executable guarantee).
 *
 * Complements `native-dep-policy-audit.ts`. That audit enforces
 * lockfile-vs-policy *classification* drift (every gated native family is
 * classified). This check enforces the *materialization* invariant that the
 * classification implies: for every `pure-package-artifact` family whose
 * consumer is actually present in a prepared dependency tree (the deps FOD
 * output), EVERY platform binding within the declared `supportedArchitectures`
 * must be physically present in that tree.
 *
 * It exists because the deps FOD (`mk-pnpm-deps.nix`) installs with
 * `--no-optional` by default, which silently produces a tree with the consumer
 * package (e.g. `rolldown`) but ZERO native bindings. That tree builds and
 * caches happily on the build host, then fails at `vite build` / runtime on a
 * platform whose binding was never fetched (the `@rolldown/binding-linux-arm64-gnu`
 * gap on aarch64-linux). Nothing in the closure hash catches this: the hash
 * faithfully describes a bindingless tree. This check makes the gap a hard,
 * precisely-named build failure instead of a silent ship.
 *
 * Data-driven: families come from `nativeDependencyPolicy` (pure-package-artifact
 * entries) + the lockfile, never a hardcoded package list. Triples come from the
 * prepared tree's own `pnpm-workspace.yaml` `supportedArchitectures`.
 *
 * Usage:
 *   native-binding-closure-check.ts <prepared-tree-dir> [lockfile] [workspace-yaml]
 *
 * Defaults: lockfile / workspace-yaml resolve inside <prepared-tree-dir>.
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

// NOTE (prototype): in-repo this imports from the shared modules; the exports
// `stripYamlQuotes`, `stripVersion`, `familyFor` are added to
// `native-dep-policy-audit.ts`, and `nativeDependencyPolicy` from
// `genie/native-dependency-policy.ts`. Inlined here so the prototype runs
// standalone against experiment trees.
type NativeDependencyPolicyEntry =
  | { readonly _tag: 'nix-grafted'; readonly graft: 'link' | 'fetch-only'; readonly via: string }
  | { readonly _tag: 'denied-lifecycle-build'; readonly defensive?: boolean }
  | { readonly _tag: 'pure-package-artifact' }

const nativeDependencyPolicy = {
  '@parcel/watcher': { _tag: 'denied-lifecycle-build' },
  '@myobie/pty': { _tag: 'denied-lifecycle-build' },
  esbuild: { _tag: 'denied-lifecycle-build' },
  fsevents: { _tag: 'denied-lifecycle-build' },
  'msgpackr-extract': { _tag: 'denied-lifecycle-build' },
  'node-pty': { _tag: 'nix-grafted', graft: 'link', via: 'nix/node-pty-native.nix' },
  sharp: { _tag: 'denied-lifecycle-build', defensive: true },
  'unix-dgram': { _tag: 'denied-lifecycle-build', defensive: true },
  '@opentui/core': { _tag: 'nix-grafted', graft: 'fetch-only', via: 'nix/opentui-core-native.nix' },
  '@rollup/rollup': { _tag: 'pure-package-artifact' },
  '@rolldown/binding': { _tag: 'pure-package-artifact' },
  '@esbuild': { _tag: 'pure-package-artifact' },
  '@msgpackr-extract': { _tag: 'pure-package-artifact' },
  lightningcss: { _tag: 'pure-package-artifact' },
  '@oxc-parser/binding': { _tag: 'pure-package-artifact' },
  '@oxc-resolver/binding': { _tag: 'pure-package-artifact' },
  '@tailwindcss/oxide': { _tag: 'pure-package-artifact' },
  '@oxlint-tsgolint': { _tag: 'pure-package-artifact' },
} as const satisfies Record<string, NativeDependencyPolicyEntry>

// ---- shared parser helpers (in-repo: import from native-dep-policy-audit.ts) ----

const stripYamlQuotes = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") === true && trimmed.endsWith("'") === true) ||
    (trimmed.startsWith('"') === true && trimmed.endsWith('"') === true)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

const stripVersion = (key: string): string => key.replace(/@[^@]+$/, '')

const familyFor = ({
  pkgName,
  policyKeys,
}: {
  pkgName: string
  policyKeys: readonly string[]
}): string | undefined => {
  for (const key of policyKeys) {
    if (pkgName === key) return key
    if (pkgName.startsWith(`${key}-`) === true || pkgName.startsWith(`${key}/`) === true) {
      return key
    }
  }
  return undefined
}

// ---- new parsing: cpu/os/libc VALUES + snapshot optionalDependencies ----

export type BindingTriple = { os?: string; cpu?: string; libc?: string }
export type SupportedArchitectures = {
  os: readonly string[]
  cpu: readonly string[]
  libc: readonly string[]
}

/** Parse a single `[a, b]` inline YAML list. */
const parseInlineList = (value: string): string[] => {
  const trimmed = value.trim()
  const inner =
    trimmed.startsWith('[') === true && trimmed.endsWith(']') === true
      ? trimmed.slice(1, -1)
      : trimmed
  return inner
    .split(',')
    .map((v) => stripYamlQuotes(v))
    .filter((v) => v !== '')
}

/**
 * Parse the `packages:` section for each key's cpu/os/libc VALUES (the audit's
 * own parser only records presence). Returns name@version -> triple.
 */
export const parseBindingTriples = (text: string): Record<string, BindingTriple> => {
  const out: Record<string, BindingTriple> = {}
  let inPackages = false
  let current: string | undefined
  for (const line of text.split('\n')) {
    if (line === 'packages:') {
      inPackages = true
      continue
    }
    if (inPackages === false) continue
    // A top-level key ends the `packages:` section — but the pnpm lockfile is a
    // MULTI-DOCUMENT YAML (a `---`-separated pnpm-CLI bootstrap document precedes
    // the workspace document, each with its own `packages:`/`snapshots:`). So we
    // must LEAVE the section and keep scanning, re-entering at the next
    // document's `packages:`. A `break` here stops at the first document boundary
    // and never reaches the workspace's rolldown/lightningcss bindings (the
    // multi-document vacuous-pass defect).
    if (/^[^\s].*:/.test(line) === true) {
      inPackages = false
      current = undefined
      continue
    }

    const pkgMatch = /^  (.+):(?:\s*\{\})?\s*$/.exec(line)
    if (pkgMatch !== null) {
      current = stripYamlQuotes(pkgMatch[1]!)
      out[current] = {}
      continue
    }
    const fieldMatch = /^    (cpu|os|libc):\s*(.+)$/.exec(line)
    if (fieldMatch !== null && current !== undefined) {
      const values = parseInlineList(fieldMatch[2]!)
      if (values[0] !== undefined) out[current]![fieldMatch[1] as 'cpu' | 'os' | 'libc'] = values[0]
    }
  }
  return out
}

/**
 * Parse the `snapshots:` section: consumer name@version -> its
 * optionalDependencies as { depName -> version }. This is where pnpm lockfile
 * v9 records which native binding families each consumer pulls in.
 */
export const parseSnapshotOptionalDependencies = (
  text: string,
): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {}
  const lines = text.split('\n')
  let inSnapshots = false
  let current: string | undefined
  let inOptional = false
  for (const line of lines) {
    if (line === 'snapshots:') {
      inSnapshots = true
      continue
    }
    if (inSnapshots === false) continue
    // Multi-document lockfile: leave the section on a top-level key and re-enter
    // at the next document's `snapshots:` rather than `break`ing at the first
    // document boundary (see parseBindingTriples for the full rationale). Without
    // this, only the pnpm-CLI bootstrap document's ~20 snapshots are seen and the
    // workspace's `rolldown@1.0.3` snapshot is never reached — the vacuous pass.
    if (/^[^\s].*:/.test(line) === true) {
      inSnapshots = false
      current = undefined
      inOptional = false
      continue
    }

    const snapMatch = /^  (\S.*):(?:\s*\{\})?\s*$/.exec(line)
    if (snapMatch !== null) {
      current = stripYamlQuotes(snapMatch[1]!)
      out[current] = {}
      inOptional = false
      continue
    }
    if (/^    optionalDependencies:\s*$/.test(line) === true) {
      inOptional = true
      continue
    }
    if (/^    \S/.test(line) === true) {
      // any other 4-space section (dependencies:, transitivePeerDependencies:, …)
      inOptional = false
      continue
    }
    if (inOptional === true && current !== undefined) {
      const depMatch = /^      (.+):\s*(.+)$/.exec(line)
      if (depMatch !== null) {
        out[current]![stripYamlQuotes(depMatch[1]!)] = stripYamlQuotes(depMatch[2]!)
      }
    }
  }
  return out
}

/** Parse `supportedArchitectures:` from a pnpm-workspace.yaml. */
export const parseSupportedArchitectures = (text: string): SupportedArchitectures => {
  const lines = text.split('\n')
  const result: { os: string[]; cpu: string[]; libc: string[] } = { os: [], cpu: [], libc: [] }
  let inBlock = false
  for (const line of lines) {
    if (line.trimEnd() === 'supportedArchitectures:') {
      inBlock = true
      continue
    }
    if (inBlock === false) continue
    if (/^\S/.test(line) === true) break
    const fieldMatch = /^  (os|cpu|libc):\s*(.+)$/.exec(line)
    if (fieldMatch !== null)
      result[fieldMatch[1] as 'os' | 'cpu' | 'libc'] = parseInlineList(fieldMatch[2]!)
  }
  return result
}

/**
 * A binding is "required" when its triple is fully within the declared support.
 * Darwin bindings carry no libc, so libc is only checked when the binding has one.
 */
const isWithinSupport = ({
  triple,
  support,
}: {
  triple: BindingTriple
  support: SupportedArchitectures
}): boolean => {
  if (triple.os !== undefined && support.os.includes(triple.os) === false) return false
  if (triple.cpu !== undefined && support.cpu.includes(triple.cpu) === false) return false
  if (triple.libc !== undefined && support.libc.includes(triple.libc) === false) return false
  // Must actually be a platform-gated binding (has at least os or cpu).
  return triple.os !== undefined || triple.cpu !== undefined
}

/** Collect every `.pnpm/<entry>` directory basename anywhere in the tree. */
const collectPnpmEntries = (root: string): Set<string> => {
  const entries = new Set<string>()
  const walk = ({ dir, depth }: { dir: string; depth: number }): void => {
    if (depth > 8) return
    let children: string[]
    try {
      children = readdirSync(dir)
    } catch {
      return
    }
    for (const name of children) {
      const full = join(dir, name)
      let isDir = false
      try {
        isDir = statSync(full).isDirectory()
      } catch {
        continue
      }
      if (isDir === false) continue
      if (name === '.pnpm') {
        for (const entry of readdirSync(full)) entries.add(entry)
        continue
      }
      if (name === 'node_modules' || name.startsWith('@') === true || depth < 4)
        walk({ dir: full, depth: depth + 1 })
    }
  }
  walk({ dir: root, depth: 0 })
  return entries
}

/** pnpm virtual-store entry name: `/` -> `+`, then `@version[_peerhash]`. */
const flatName = (name: string): string => name.replace(/\//g, '+')

const presentInTree = ({
  pnpmEntries,
  name,
  version,
}: {
  pnpmEntries: Set<string>
  name: string
  version: string
}): boolean => {
  const prefix = `${flatName(name)}@${version}`
  if (pnpmEntries.has(prefix) === true) return true
  for (const entry of pnpmEntries) {
    // peer-suffixed entries: `<name>@<version>_<hash>` or `<version>(<peers>)`
    if (entry.startsWith(`${prefix}_`) === true || entry.startsWith(`${prefix}(`) === true)
      return true
  }
  return false
}

export type ClosureProblem = {
  readonly kind: 'missing-native-binding'
  readonly family: string
  readonly consumer: string
  readonly binding: string
  readonly triple: string
  readonly detail: string
}

/**
 * Completeness criterion (hash-contract decision):
 *  - 'all-declared-triples' (DEFAULT): every triple within supportedArchitectures
 *    must be present. This IS the `mkSharedHash`-soundness gate — it fails on a
 *    host-variant tree (e.g. only the build host's binding), which is exactly the
 *    tree that would break a shared cross-system hash.
 *  - 'build-platform': only the current build platform's triple must be present.
 *    Use with per-system `mkHash`, where full coverage is the union across the
 *    per-system FODs.
 */
export type CompletenessMode = 'all-declared-triples' | 'build-platform'

export type ClosureAuditOptions = {
  readonly preparedTreeDir: string
  readonly lockfileText: string
  readonly workspaceYamlText: string
  readonly policy?: Record<string, NativeDependencyPolicyEntry>
  readonly completenessMode?: CompletenessMode
  /** Required when completenessMode === 'build-platform'. */
  readonly buildPlatformTriple?: BindingTriple
  /**
   * Escape hatch (by design): the assertion is ALWAYS-ON and
   * auto-derives required families from the resolved closure — a consumer never
   * hand-lists what to require (that would reintroduce that omission). These
   * families are the only documented way to intentionally EXCLUDE a family whose
   * absence is genuinely intended (a waiver). Everything else auto-fails.
   */
  readonly waiveFamilies?: readonly string[]
}

const tripleMatchesBuildPlatform = ({
  triple,
  build,
}: {
  triple: BindingTriple
  build: BindingTriple
}): boolean =>
  (build.os === undefined || triple.os === build.os) &&
  (build.cpu === undefined || triple.cpu === build.cpu) &&
  // libc only constrains when the binding declares one (darwin bindings don't).
  (triple.libc === undefined || build.libc === undefined || triple.libc === build.libc)

export const auditNativeBindingClosure = (opts: ClosureAuditOptions): ClosureProblem[] => {
  const policy = opts.policy ?? nativeDependencyPolicy
  const mode = opts.completenessMode ?? 'all-declared-triples'
  const waived = new Set(opts.waiveFamilies ?? [])
  const pureFamilies = Object.entries(policy)
    .filter(([, e]) => e._tag === 'pure-package-artifact')
    .map(([k]) => k)
    .filter((k) => waived.has(k) === false)
  const policyKeys = Object.keys(policy)

  const triples = parseBindingTriples(opts.lockfileText)
  const snapshots = parseSnapshotOptionalDependencies(opts.lockfileText)
  const support = parseSupportedArchitectures(opts.workspaceYamlText)
  const pnpmEntries = collectPnpmEntries(opts.preparedTreeDir)

  const problems: ClosureProblem[] = []

  for (const [consumerKey, optionalDeps] of Object.entries(snapshots)) {
    const consumerName = stripVersion(consumerKey)
    const consumerVersion = consumerKey.slice(consumerName.length + 1)
    // Only enforce for consumers actually materialized in THIS prepared tree.
    if (presentInTree({ pnpmEntries, name: consumerName, version: consumerVersion }) === false)
      continue

    for (const [depName, depVersion] of Object.entries(optionalDeps)) {
      const family = familyFor({ pkgName: depName, policyKeys })
      if (family === undefined || pureFamilies.includes(family) === false) continue

      const triple = triples[`${depName}@${depVersion}`]
      if (triple === undefined) continue
      if (isWithinSupport({ triple, support }) === false) continue // not a supported target
      if (
        mode === 'build-platform' &&
        opts.buildPlatformTriple !== undefined &&
        tripleMatchesBuildPlatform({ triple, build: opts.buildPlatformTriple }) === false
      ) {
        continue // build-platform mode: only require this host's triple
      }

      if (presentInTree({ pnpmEntries, name: depName, version: depVersion }) === false) {
        const tripleStr = [triple.os, triple.cpu, triple.libc].filter(Boolean).join('-')
        problems.push({
          kind: 'missing-native-binding',
          family,
          consumer: consumerKey,
          binding: `${depName}@${depVersion}`,
          triple: tripleStr,
          detail: `consumer "${consumerKey}" is present but its supported-architecture binding "${depName}@${depVersion}" (${tripleStr}) is absent from the prepared dependency tree. The deps FOD was built without this optional native binding (likely --no-optional / includeOptionalDependencies=false). Enable optional dependencies for this install root's deps build so pnpm fetches every supportedArchitectures triple.`,
        })
      }
    }
  }

  return problems
}

/**
 * The auto-derived set of pure-package-artifact families whose consumer is
 * actually materialized in this prepared tree. This IS `requiredNativeFamilies`
 * — computed, never hand-listed (by design). Over-approximates
 * safely: a family in-closure but not build-loaded (e.g. lightningcss via the
 * PostCSS path) is still listed; enabling includeOptionalDependencies
 * materializes its bindings for free, so all-declared-triples passes cleanly.
 */
export const detectActiveFamilies = (opts: ClosureAuditOptions): string[] => {
  const policy = opts.policy ?? nativeDependencyPolicy
  const policyKeys = Object.keys(policy)
  const pureFamilies = new Set(
    Object.entries(policy)
      .filter(([, e]) => e._tag === 'pure-package-artifact')
      .map(([k]) => k),
  )
  const snapshots = parseSnapshotOptionalDependencies(opts.lockfileText)
  const pnpmEntries = collectPnpmEntries(opts.preparedTreeDir)
  const active = new Set<string>()
  for (const [consumerKey, optionalDeps] of Object.entries(snapshots)) {
    const consumerName = stripVersion(consumerKey)
    const consumerVersion = consumerKey.slice(consumerName.length + 1)
    if (presentInTree({ pnpmEntries, name: consumerName, version: consumerVersion }) === false)
      continue
    for (const depName of Object.keys(optionalDeps)) {
      const family = familyFor({ pkgName: depName, policyKeys })
      if (family !== undefined && pureFamilies.has(family) === true) active.add(family)
    }
  }
  return [...active].sort()
}

const formatReport = ({
  problems,
  treeDir,
}: {
  problems: readonly ClosureProblem[]
  treeDir: string
}): string => {
  if (problems.length === 0) return `native binding closure check: OK (${treeDir})`
  const lines = [
    `native binding closure check: ${problems.length} missing binding(s) in ${treeDir}`,
    '',
  ]
  for (const p of problems) {
    lines.push(`  [${p.kind}] ${p.family} :: ${p.triple}`)
    lines.push(`    ${p.detail}`)
  }
  return lines.join('\n')
}

const resolveInput = ({
  treeDir,
  override,
  base,
}: {
  treeDir: string
  override: string | undefined
  base: string
}): string => {
  if (override !== undefined) return override
  const inTree = join(treeDir, base)
  if (existsSync(inTree) === true) return inTree
  return resolve(treeDir, base)
}

const main = (): void => {
  const treeDir = process.argv[2]
  if (treeDir === undefined) {
    console.error(
      'usage: native-binding-closure-check.ts <prepared-tree-dir> [lockfile] [workspace-yaml]',
    )
    process.exit(2)
  }
  const lockfilePath = resolveInput({ treeDir, override: process.argv[3], base: 'pnpm-lock.yaml' })
  const workspaceYamlPath = resolveInput({
    treeDir,
    override: process.argv[4],
    base: 'pnpm-workspace.yaml',
  })

  // Engagement phasing (rollout-safety guard): 'warn' reports but exits 0 so a
  // repin of a root that has NOT opted into includeOptionalDependencies never
  // breaks; 'fail' exits nonzero. The Nix wrapper sets NBCC_ENGAGEMENT=fail for
  // roots that opted in (phase 1) and flips the default to fail in phase 2.
  const engagement = process.env.NBCC_ENGAGEMENT === 'warn' ? 'warn' : 'fail'
  const waiveFamilies = (process.env.NBCC_WAIVE_FAMILIES ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '')

  const auditOpts: ClosureAuditOptions = {
    preparedTreeDir: treeDir,
    lockfileText: readFileSync(lockfilePath, 'utf8'),
    workspaceYamlText: readFileSync(workspaceYamlPath, 'utf8'),
    waiveFamilies,
  }

  // Optional defense-in-depth tripwire (off by default): consumer declares the
  // families it believes it needs; fail on drift so a dep bump that silently
  // adds a native family is caught. Auto-derive stays authoritative.
  const expect = process.env.NBCC_EXPECT_FAMILIES
  if (expect !== undefined) {
    const expected = new Set(
      expect
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
    )
    const detected = new Set(detectActiveFamilies(auditOpts))
    const added = [...detected].filter((f) => expected.has(f) === false)
    const removed = [...expected].filter((f) => detected.has(f) === false)
    if (added.length > 0 || removed.length > 0) {
      console.error(
        `native binding closure check: native-family drift in ${treeDir}\n` +
          `  expected: ${[...expected].sort().join(', ') || '(none)'}\n` +
          `  detected: ${[...detected].sort().join(', ') || '(none)'}\n` +
          (added.length > 0 ? `  ADDED (unexpected native family): ${added.join(', ')}\n` : '') +
          (removed.length > 0 ? `  REMOVED (declared but gone): ${removed.join(', ')}\n` : ''),
      )
      process.exit(1)
    }
  }

  const problems = auditNativeBindingClosure(auditOpts)
  const report = formatReport({ problems, treeDir })
  if (problems.length === 0) {
    console.log(`${report} [families: ${detectActiveFamilies(auditOpts).join(', ') || 'none'}]`)
    return
  }
  console.error(report)
  if (engagement === 'warn') {
    console.error(
      `native binding closure check: engagement=warn — reporting only, not failing (root has not opted into includeOptionalDependencies).`,
    )
    return
  }
  process.exit(1)
}

if (import.meta.main) {
  main()
}
