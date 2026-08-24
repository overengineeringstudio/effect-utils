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
 * It exists because the deps FOD (`mk-pnpm-deps.nix`) installs without carrying
 * optional native bindings by default, which silently produces a tree with the
 * consumer package (e.g. `rolldown`) but ZERO native bindings. That tree builds
 * and caches happily on the build host, then fails at `vite build` / runtime on
 * a platform whose binding was never fetched (the
 * `@rolldown/binding-linux-arm64-gnu` gap on aarch64-linux). Nothing in the
 * closure hash catches this: the hash faithfully describes a bindingless tree.
 * This check makes the gap a hard, precisely-named build failure instead of a
 * silent ship.
 *
 * SCOPE (honest guarantee): this check enforces closure-COMPLETENESS for a root
 * that opts into carrying optional bindings — every declared triple of an active
 * family is present. It does NOT decide whether a root that needs bindings has
 * opted in; a non-opted-in root runs in advisory (warn) mode. The separate
 * downstream gate (a real cross-platform `vite build` in CI) is what catches a
 * needs-binding root that forgot to opt in.
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

import {
  type NativeDependencyPolicyEntry,
  nativeDependencyPolicy,
} from '../native-dependency-policy.ts'
import { familyFor, stripPeerSuffix, stripVersion } from './native-dep-policy-lib.ts'

// ---- YAML parse (real multi-document parse, not a line scanner) ----

/**
 * pnpm lockfiles are multi-document YAML (a `---`-separated pnpm-CLI bootstrap
 * document can precede the workspace document, each with its own
 * `packages:`/`snapshots:`). `Bun.YAML.parse` returns an array for a
 * multi-document input and a single object otherwise. The hand-rolled line
 * scanner this replaces was the source of the multi-document vacuous-pass
 * class: it
 * stopped at the first document boundary and never reached the workspace's
 * rolldown snapshot. A real parse removes that class entirely.
 */
const parseYaml = (text: string): unknown =>
  (Bun as unknown as { YAML: { parse: (input: string) => unknown } }).YAML.parse(text)

const asRecord = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && Array.isArray(value) === false
    ? (value as Record<string, unknown>)
    : {}

/** Normalize a scalar-or-list YAML field to a string array (multi-value safe). */
const asStringArray = (value: unknown): string[] =>
  Array.isArray(value) === true
    ? value.map((v) => String(v))
    : value === undefined
      ? []
      : [String(value)]

/** Split a lockfile into its documents as records (single-doc -> one element). */
export const parseLockfileDocs = (text: string): Record<string, unknown>[] => {
  const raw = parseYaml(text)
  const docs = Array.isArray(raw) === true ? raw : [raw]
  return docs.map((d) => asRecord(d))
}

// ---- triple / support types ----

/**
 * A binding's declared platform surface. Arrays (not a single value) so a
 * binding that legitimately declares multiple cpus/oses/libcs is checked in
 * full rather than by its first value only.
 */
export type BindingTriple = { os: string[]; cpu: string[]; libc: string[] }
export type SupportedArchitectures = {
  os: readonly string[]
  cpu: readonly string[]
  libc: readonly string[]
}
/** The build host's concrete platform, for `build-platform` completeness mode. */
export type BuildPlatformTriple = { os?: string; cpu?: string; libc?: string }

/**
 * Parse `packages:` across every document -> `name@version` -> cpu/os/libc
 * VALUES (the audit's own parser only records presence).
 */
export const parseBindingTriples = (text: string): Record<string, BindingTriple> => {
  const out: Record<string, BindingTriple> = {}
  for (const doc of parseLockfileDocs(text)) {
    const packages = asRecord(doc.packages)
    for (const [key, meta] of Object.entries(packages)) {
      const m = asRecord(meta)
      out[key] = { os: asStringArray(m.os), cpu: asStringArray(m.cpu), libc: asStringArray(m.libc) }
    }
  }
  return out
}

/**
 * Parse `snapshots:` across every document: consumer key -> its
 * optionalDependencies as `{ depName -> version }`. This is where pnpm lockfile
 * v9 records which native binding families each consumer pulls in.
 */
export const parseSnapshotOptionalDependencies = (
  text: string,
): Record<string, Record<string, string>> => {
  const out: Record<string, Record<string, string>> = {}
  for (const doc of parseLockfileDocs(text)) {
    const snapshots = asRecord(doc.snapshots)
    for (const [key, body] of Object.entries(snapshots)) {
      const optional = asRecord(asRecord(body).optionalDependencies)
      const deps: Record<string, string> = {}
      for (const [depName, version] of Object.entries(optional)) deps[depName] = String(version)
      out[key] = deps
    }
  }
  return out
}

/** Parse `supportedArchitectures:` from a (single-document) pnpm-workspace.yaml. */
export const parseSupportedArchitectures = (text: string): SupportedArchitectures => {
  const sa = asRecord(asRecord(parseYaml(text)).supportedArchitectures)
  return { os: asStringArray(sa.os), cpu: asStringArray(sa.cpu), libc: asStringArray(sa.libc) }
}

/**
 * A binding is "required" when its whole declared surface is within the declared
 * support. Every declared os/cpu/libc value must be supported (a binding that
 * targets an unsupported arch is not one we require). Darwin bindings carry no
 * libc, so libc only constrains when the binding declares one.
 */
const isWithinSupport = ({
  triple,
  support,
}: {
  triple: BindingTriple
  support: SupportedArchitectures
}): boolean => {
  // Must actually be a platform-gated binding (declares at least os or cpu).
  if (triple.os.length === 0 && triple.cpu.length === 0) return false
  if (triple.os.some((v) => support.os.includes(v) === false) === true) return false
  if (triple.cpu.some((v) => support.cpu.includes(v) === false) === true) return false
  if (triple.libc.some((v) => support.libc.includes(v) === false) === true) return false
  return true
}

/** Whether a pure-artifact binding dir (any triple) is present anywhere in the tree. */
const treeHasPureArtifactBinding = ({
  pnpmEntries,
  policyKeys,
  pureFamilies,
}: {
  pnpmEntries: Set<string>
  policyKeys: readonly string[]
  pureFamilies: ReadonlySet<string>
}): boolean => {
  for (const entry of pnpmEntries) {
    const name = stripVersion(entry)
    const family = familyFor({ pkgName: name.replace(/\+/g, '/'), policyKeys })
    if (family !== undefined && pureFamilies.has(family) === true) return true
  }
  return false
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

/** pnpm virtual-store entry name: `/` -> `+`, then `@version[_peers]`. */
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
    // Peer-bearing consumers materialize under an underscore-joined dir name
    // (`vite@8.0.16_@types+node@26.0.0_...`); the paren form is a defensive
    // fallback for any variant encoding.
    if (entry.startsWith(`${prefix}_`) === true || entry.startsWith(`${prefix}(`) === true)
      return true
  }
  return false
}

/** Split a (possibly peer-suffixed) snapshot key into its bare name + version. */
const consumerNameVersion = (consumerKey: string): { name: string; version: string } => {
  const bare = stripPeerSuffix(consumerKey)
  const name = stripVersion(bare)
  return { name, version: bare.slice(name.length + 1) }
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

/**
 * A reason-carrying, triple-scoped waiver (decision 0007, DMP.NIX.NATIVE-R11).
 * `triple` undefined waives the whole family; a `triple` (e.g. `linux-arm64-musl`)
 * waives only that binding — a waiver must not silently expand to triples it does
 * not name. `reason` is recorded in the report as an audit trail.
 */
export type Waiver = { readonly family: string; readonly triple?: string; readonly reason?: string }

/** Parse `family[@os-cpu-libc][=reason]` entries joined by `;`. */
export const parseWaivers = (raw: string): Waiver[] =>
  raw
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .map((entry) => {
      const eq = entry.indexOf('=')
      const spec = (eq === -1 ? entry : entry.slice(0, eq)).trim()
      const reason = eq === -1 ? undefined : entry.slice(eq + 1).trim()
      // Family may be scoped (`@scope/name`), so the triple separator is the
      // first `@` PAST a leading scope `@`, not `indexOf('@')` (which would grab
      // the scope marker). A triple never contains `@`.
      const at = spec.indexOf('@', spec.startsWith('@') === true ? 1 : 0)
      return at === -1
        ? { family: spec, reason }
        : { family: spec.slice(0, at), triple: spec.slice(at + 1), reason }
    })

const isWaived = ({
  waivers,
  family,
  tripleStr,
}: {
  waivers: readonly Waiver[]
  family: string
  tripleStr: string
}): Waiver | undefined =>
  waivers.find((w) => w.family === family && (w.triple === undefined || w.triple === tripleStr))

export type ClosureAuditOptions = {
  readonly preparedTreeDir: string
  readonly lockfileText: string
  readonly workspaceYamlText: string
  readonly policy?: Record<string, NativeDependencyPolicyEntry>
  readonly completenessMode?: CompletenessMode
  /** Required when completenessMode === 'build-platform'. */
  readonly buildPlatformTriple?: BuildPlatformTriple
  /**
   * Escape hatch (by design): the assertion is ALWAYS-ON and
   * auto-derives required families from the resolved closure — a consumer never
   * hand-lists what to require (that would reintroduce the multi-document
   * vacuous-pass omission).
   * Waivers are the only documented way to intentionally EXCLUDE a
   * family/triple whose absence is genuinely intended; each is reason-carrying
   * and scoped to the triple it names. Everything else auto-fails.
   */
  readonly waivers?: readonly Waiver[]
}

const tripleMatchesBuildPlatform = ({
  triple,
  build,
}: {
  triple: BindingTriple
  build: BuildPlatformTriple
}): boolean =>
  (build.os === undefined || triple.os.length === 0 || triple.os.includes(build.os)) &&
  (build.cpu === undefined || triple.cpu.length === 0 || triple.cpu.includes(build.cpu)) &&
  // libc only constrains when the binding declares one (darwin bindings don't).
  (triple.libc.length === 0 || build.libc === undefined || triple.libc.includes(build.libc))

const pureFamilyKeys = (policy: Record<string, NativeDependencyPolicyEntry>): string[] =>
  Object.entries(policy)
    .filter(([, e]) => e._tag === 'pure-package-artifact')
    .map(([k]) => k)

export const auditNativeBindingClosure = (opts: ClosureAuditOptions): ClosureProblem[] => {
  const policy = opts.policy ?? nativeDependencyPolicy
  const mode = opts.completenessMode ?? 'all-declared-triples'
  const waivers = opts.waivers ?? []
  const pureFamilies = pureFamilyKeys(policy)
  const policyKeys = Object.keys(policy)

  const triples = parseBindingTriples(opts.lockfileText)
  const snapshots = parseSnapshotOptionalDependencies(opts.lockfileText)
  const support = parseSupportedArchitectures(opts.workspaceYamlText)
  const pnpmEntries = collectPnpmEntries(opts.preparedTreeDir)

  const problems: ClosureProblem[] = []

  for (const [consumerKey, optionalDeps] of Object.entries(snapshots)) {
    const { name: consumerName, version: consumerVersion } = consumerNameVersion(consumerKey)
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

      const tripleStr = [...triple.os, ...triple.cpu, ...triple.libc].join('-')
      const waiver = isWaived({ waivers, family, tripleStr })
      if (waiver !== undefined) {
        // Reason-carrying waiver: this family/triple is intentionally excluded.
        console.log(
          `native binding closure check: waived ${family} :: ${tripleStr}` +
            (waiver.reason !== undefined && waiver.reason !== '' ? ` — ${waiver.reason}` : ''),
        )
        continue
      }

      if (presentInTree({ pnpmEntries, name: depName, version: depVersion }) === false) {
        problems.push({
          kind: 'missing-native-binding',
          family,
          consumer: consumerKey,
          binding: `${depName}@${depVersion}`,
          triple: tripleStr,
          detail: `consumer "${consumerKey}" is present but its supported-architecture binding "${depName}@${depVersion}" (${tripleStr}) is absent from the prepared dependency tree. The deps FOD was built without this optional native binding (the root did not carry optional native bindings for its declared triples). Enable optional-binding inclusion for this install root's deps build so every supportedArchitectures triple is materialized.`,
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
 * PostCSS path) is still listed; enabling optional-binding inclusion
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
    const { name: consumerName, version: consumerVersion } = consumerNameVersion(consumerKey)
    if (presentInTree({ pnpmEntries, name: consumerName, version: consumerVersion }) === false)
      continue
    for (const depName of Object.keys(optionalDeps)) {
      const family = familyFor({ pkgName: depName, policyKeys })
      if (family !== undefined && pureFamilies.has(family) === true) active.add(family)
    }
  }
  return [...active].toSorted()
}

/**
 * Fail-closed floor (compensating control). Even with a real YAML parse, the
 * check must never PASS vacuously: a green result on a tree it could not
 * actually inspect is worse than a loud failure. Returns human-readable reasons
 * the check could not have observed what it claims. The caller hard-fails on any
 * reason in fail (opted-in) mode and reports them as warnings otherwise.
 */
export const lockfileFloorViolations = (opts: ClosureAuditOptions): string[] => {
  const policy = opts.policy ?? nativeDependencyPolicy
  const policyKeys = Object.keys(policy)
  const pureFamilies = new Set(pureFamilyKeys(policy))
  const docs = parseLockfileDocs(opts.lockfileText)
  const violations: string[] = []

  const hasPackages = docs.some((d) => 'packages' in d)
  const hasSnapshots = docs.some((d) => 'snapshots' in d)
  const versions = docs
    .map((d) => d.lockfileVersion)
    .filter((v) => v !== undefined)
    .map((v) => String(v))
  const majors = versions
    .map((v) => Number.parseInt(v, 10))
    .filter((n) => Number.isNaN(n) === false)

  // (1) Unrecognized: no packages AND no snapshots -> not a pnpm lockfile shape.
  if (hasPackages === false && hasSnapshots === false) {
    violations.push(
      'lockfile has neither a `packages:` nor a `snapshots:` section — unrecognized format; cannot verify binding closure',
    )
    return violations // nothing else is meaningful
  }

  // (2) Pre-v9: no `snapshots:` model (optionalDependencies live elsewhere) ->
  // this check cannot resolve which consumer pulls which binding. Fail closed.
  if (hasSnapshots === false || (majors.length > 0 && majors.every((n) => n < 9) === true)) {
    violations.push(
      `lockfile version ${versions.join(', ') || '(unstated)'} predates the pnpm v9 \`snapshots:\` model — binding-closure verification is unsupported for this lockfile`,
    )
  }

  const snapshots = parseSnapshotOptionalDependencies(opts.lockfileText)
  const consumerCount = Object.keys(snapshots).length

  // (3) A `snapshots:` section exists but parsed to zero consumers -> the parse
  // is blind; a green result would be vacuous.
  if (hasSnapshots === true && consumerCount === 0) {
    violations.push(
      'a `snapshots:` section is present but zero consumer entries parsed — refusing to pass vacuously',
    )
  }

  // (3b) Within-support pure-artifact binding packages exist in `packages:` but
  // NO parsed snapshot optionalDependency references any pure-artifact family ->
  // the snapshot/optionalDependencies parse dropped the references.
  const triples = parseBindingTriples(opts.lockfileText)
  const support = parseSupportedArchitectures(opts.workspaceYamlText)
  const hasSupportedPureBindingPackage = Object.entries(triples).some(([key, triple]) => {
    const family = familyFor({ pkgName: stripVersion(key), policyKeys })
    return (
      family !== undefined &&
      pureFamilies.has(family) === true &&
      isWithinSupport({ triple, support })
    )
  })
  const anyOptionalReferencesPureFamily = Object.values(snapshots).some((deps) =>
    Object.keys(deps).some((depName) => {
      const family = familyFor({ pkgName: depName, policyKeys })
      return family !== undefined && pureFamilies.has(family)
    }),
  )
  if (
    hasSupportedPureBindingPackage === true &&
    anyOptionalReferencesPureFamily === false &&
    consumerCount > 0
  ) {
    violations.push(
      'lockfile declares supported-architecture pure-artifact binding packages, but no parsed snapshot optionalDependency references any of them — the optionalDependencies parse dropped the references',
    )
  }

  // (4) Tree/parse mismatch: the prepared tree materializes pure-artifact binding
  // dirs, yet no active family was derived from the lockfile -> the check is
  // blind to a tree that plainly carries native families.
  const pnpmEntries = collectPnpmEntries(opts.preparedTreeDir)
  if (
    treeHasPureArtifactBinding({ pnpmEntries, policyKeys, pureFamilies }) === true &&
    detectActiveFamilies(opts).length === 0
  ) {
    violations.push(
      'prepared tree contains pure-artifact binding directories, but no active family was derived from the lockfile — the check is not seeing the tree it is inspecting',
    )
  }

  return violations
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

const parseBuildPlatformTripleEnv = (raw: string | undefined): BuildPlatformTriple | undefined => {
  if (raw === undefined || raw.trim() === '') return undefined
  const [os, cpu, libc] = raw.split(',').map((s) => s.trim())
  const triple: BuildPlatformTriple = {}
  if (os !== undefined && os !== '') triple.os = os
  if (cpu !== undefined && cpu !== '') triple.cpu = cpu
  if (libc !== undefined && libc !== '') triple.libc = libc
  return triple
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

  // Engagement (decision 0009): 'warn' reports but exits 0, so a repin of a root
  // that has NOT opted into optional-binding inclusion is never broken by this
  // check; 'fail' exits nonzero. The Nix wrapper sets NBCC_ENGAGEMENT=fail for
  // roots that opted in. There is no global "flip the default" phase: making
  // inclusion the default for a class of roots is a deliberate versioned
  // prepared-deps transition, not a mode flag here (see 0009).
  const engagement = process.env.NBCC_ENGAGEMENT === 'warn' ? 'warn' : 'fail'
  const waivers = parseWaivers(process.env.NBCC_WAIVERS ?? '')
  const completenessMode: CompletenessMode =
    process.env.NBCC_COMPLETENESS_MODE === 'build-platform'
      ? 'build-platform'
      : 'all-declared-triples'
  const buildPlatformTriple = parseBuildPlatformTripleEnv(process.env.NBCC_BUILD_PLATFORM_TRIPLE)

  const auditOpts: ClosureAuditOptions = {
    preparedTreeDir: treeDir,
    lockfileText: readFileSync(lockfilePath, 'utf8'),
    workspaceYamlText: readFileSync(workspaceYamlPath, 'utf8'),
    waivers,
    completenessMode,
    buildPlatformTriple,
  }

  // Fail-closed floor: refuse to pass vacuously. In fail mode any floor
  // violation is a hard error; in warn (non-opted-in) mode it is reported but
  // does not gate the build (decision 0009 — the root's bindings are advisory).
  const floor = lockfileFloorViolations(auditOpts)
  if (floor.length > 0) {
    const header = `native binding closure check: cannot verify closure for ${treeDir}`
    console.error([header, ...floor.map((f) => `  - ${f}`)].join('\n'))
    if (engagement === 'warn') {
      console.error('native binding closure check: engagement=warn — reporting only, not failing.')
      return
    }
    process.exit(1)
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
          `  expected: ${[...expected].toSorted().join(', ') || '(none)'}\n` +
          `  detected: ${[...detected].toSorted().join(', ') || '(none)'}\n` +
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
      `native binding closure check: engagement=warn — reporting only, not failing (root has not opted into optional-binding inclusion).`,
    )
    return
  }
  process.exit(1)
}

if (import.meta.main) {
  main()
}
