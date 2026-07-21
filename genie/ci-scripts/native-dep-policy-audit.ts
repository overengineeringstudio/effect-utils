#!/usr/bin/env bun
/**
 * Native npm dependency policy audit (issue #807).
 *
 * Cross-checks the pnpm lockfile against the authoritative
 * `nativeDependencyPolicy` classification in `genie/native-dependency-policy.ts` and fails CI
 * on drift. This runs install-free: the only inputs are the lockfile and the
 * genie policy source, which is all the builder-contract CI job has (it
 * restores no `node_modules`, so the pnpm build-script ledger is unavailable).
 *
 * The audit fails when:
 * - a CPU/OS/libc-gated native family appears in the lockfile with no
 *   `pure-package-artifact` or `nix-grafted` policy entry (new native family);
 * - a non-defensive `denied-lifecycle-build` or a `nix-grafted` family is
 *   absent from the lockfile (policy entry disappeared / shape changed);
 * - a `nix-grafted` entry's `via` Nix file is missing.
 *
 * Known gap (lockfile v9 dropped `requiresBuild`; ledger unavailable in-job): a
 * brand-new package that carries a lifecycle build but is neither gated-native
 * nor already in the policy cannot be auto-detected. The policy is the source
 * of truth; this audit enforces lockfile-vs-policy drift against it.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import {
  type NativeDependencyPolicyEntry,
  nativeDependencyPolicy,
} from '../native-dependency-policy.ts'
import { familyFor, stripVersion, stripYamlQuotes } from './native-dep-policy-lib.ts'

const repoRoot = resolve(import.meta.dir, '../..')

export type AuditOptions = {
  readonly lockfilePath: string
  readonly policy?: Record<string, NativeDependencyPolicyEntry>
  /** Resolve `nix-grafted` `via` files relative to this root (default: repo root). */
  readonly nixRoot?: string
}

export type AuditProblem = {
  readonly kind: 'unclassified-native-family' | 'missing-policy-package' | 'missing-graft-file'
  readonly family: string
  readonly detail: string
}

type NativePackageMeta = {
  cpu?: true
  os?: true
  libc?: true
}

/**
 * Parse the small pnpm-lock.yaml surface the audit needs: package keys plus
 * cpu/os/libc presence. Avoids coupling CI to Bun.YAML availability.
 */
const parseLockfilePackages = (text: string): Record<string, NativePackageMeta> => {
  const packages: Record<string, NativePackageMeta> = {}
  let inPackages = false
  let currentPackage: string | undefined

  for (const line of text.split('\n')) {
    if (line === 'packages:') {
      inPackages = true
      continue
    }

    if (inPackages === false) continue
    if (/^[^\s].*:/.test(line) === true) break

    const packageMatch = /^  (.+):(?:\s*\{\})?\s*$/.exec(line)
    if (packageMatch !== null) {
      currentPackage = stripYamlQuotes(packageMatch[1]!)
      packages[currentPackage] = {}
      continue
    }

    const platformFieldMatch = /^    (cpu|os|libc):/.exec(line)
    if (platformFieldMatch !== null && currentPackage !== undefined) {
      packages[currentPackage]![platformFieldMatch[1] as 'cpu' | 'os' | 'libc'] = true
    }
  }

  return packages
}

/** A lockfile package is "native-gated" if it carries cpu/os/libc constraints. */
const isGated = (meta: NativePackageMeta): boolean =>
  meta.cpu !== undefined || meta.os !== undefined || meta.libc !== undefined

export const auditNativeDependencyPolicy = (opts: AuditOptions): AuditProblem[] => {
  const policy = opts.policy ?? nativeDependencyPolicy
  const policyKeys = Object.keys(policy)
  const nixRoot = opts.nixRoot ?? repoRoot
  const problems: AuditProblem[] = []

  const packages = parseLockfilePackages(readFileSync(opts.lockfilePath, 'utf8'))

  const presentFamilies = new Set<string>()
  const gatedFamilies = new Set<string>()

  for (const [key, meta] of Object.entries(packages)) {
    const name = stripVersion(key)
    const family = familyFor({ pkgName: name, policyKeys })
    if (family !== undefined) presentFamilies.add(family)
    if (isGated(meta) === false) continue
    if (family === undefined) {
      // A gated native family with no policy entry: unclassified drift.
      gatedFamilies.add(name)
    } else {
      gatedFamilies.add(family)
    }
  }

  // (b) Every gated native family must carry some policy classification. Any
  // tag counts: a `denied-lifecycle-build` family (e.g. @parcel/watcher,
  // fsevents) legitimately ships both a lifecycle-built main package and gated
  // optional prebuilts. Only a wholly unclassified gated family is drift.
  for (const family of gatedFamilies) {
    if (policy[family] === undefined) {
      problems.push({
        kind: 'unclassified-native-family',
        family,
        detail: `gated native package family "${family}" has no nativeDependencyPolicy entry (classify as pure-package-artifact, nix-grafted, or denied-lifecycle-build)`,
      })
    }
  }

  // (c) Policy entries must still be present / well-shaped.
  for (const [family, entry] of Object.entries(policy)) {
    if (entry._tag === 'denied-lifecycle-build') {
      if (entry.defensive === true) continue
      if (presentFamilies.has(family) === false) {
        problems.push({
          kind: 'missing-policy-package',
          family,
          detail: `denied-lifecycle-build family "${family}" is no longer in the lockfile; remove it or mark it defensive`,
        })
      }
    } else if (entry._tag === 'nix-grafted') {
      if (existsSync(resolve(nixRoot, entry.via)) === false) {
        problems.push({
          kind: 'missing-graft-file',
          family,
          detail: `nix-grafted family "${family}" references missing graft file "${entry.via}"`,
        })
      }
      if (presentFamilies.has(family) === false) {
        problems.push({
          kind: 'missing-policy-package',
          family,
          detail: `nix-grafted family "${family}" is no longer in the lockfile; update or remove its policy entry`,
        })
      }
    }
  }

  return problems
}

const formatReport = (problems: readonly AuditProblem[]): string => {
  if (problems.length === 0) return 'native dependency policy audit: OK'
  const lines = [`native dependency policy audit: ${problems.length} problem(s)`, '']
  for (const p of problems) {
    lines.push(`  [${p.kind}] ${p.family}`)
    lines.push(`    ${p.detail}`)
  }
  return lines.join('\n')
}

if (import.meta.main) {
  const lockfilePath = process.argv[2] ?? resolve(repoRoot, 'pnpm-lock.yaml')
  const problems = auditNativeDependencyPolicy({ lockfilePath })
  const report = formatReport(problems)
  if (problems.length > 0) {
    console.error(report)
    process.exit(1)
  }
  console.log(report)
}
