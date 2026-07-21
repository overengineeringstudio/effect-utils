/**
 * Shared native-dependency lockfile-key helpers (issue #807).
 *
 * Single source of truth for the small string transforms both the policy audit
 * (`native-dep-policy-audit.ts`) and the closure-completeness check
 * (`native-binding-closure-check.ts`) need to map a pnpm lockfile key to its
 * native-dependency family. Kept side-effect-free (no `node:fs`, no
 * `import.meta.main` CLI block) so either consumer can import it without pulling
 * the other tool's runtime into its bundle — this is the "one registry, not two"
 * guarantee (decision 0007) at the helper layer, complementing the single
 * `nativeDependencyPolicy` registry in `genie/native-dependency-policy.ts`.
 */

/**
 * Strip matching surrounding single/double quotes from a YAML scalar. Used by
 * the policy audit's small lockfile scanner (the closure check parses YAML
 * proper and does not need it, but keeps the shared registry single-sourced).
 */
export const stripYamlQuotes = (value: string): string => {
  const trimmed = value.trim()
  if (
    (trimmed.startsWith("'") === true && trimmed.endsWith("'") === true) ||
    (trimmed.startsWith('"') === true && trimmed.endsWith('"') === true)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/**
 * Strip a pnpm peer-dependency suffix from a lockfile key.
 *
 * pnpm v9 `snapshots:` keys carry the resolved peer set in parentheses, one
 * group per peer: `vite@8.0.16(@types/node@26.0.0)(esbuild@0.28.0)`. The
 * `packages:` section keys never carry it, so this is a no-op there.
 */
export const stripPeerSuffix = (key: string): string => key.replace(/\(.*\)$/, '')

/**
 * Remove the trailing `@<version>` from a lockfile key, returning the package
 * name. Strips any peer suffix first so a peer-bearing `snapshots:` key parses
 * to its bare name (`vite@8.0.16(react@19.0.0)` -> `vite`) instead of splitting
 * on the last `@` inside the peer group (which silently mis-names the package
 * and drops it from family matching — the peer-key skip the reviewers named).
 */
export const stripVersion = (key: string): string => stripPeerSuffix(key).replace(/@[^@]+$/, '')

/**
 * Map a versioned lockfile package name to its policy family key, if any policy
 * key is a prefix at a `-`/`/` boundary. Prefix matching keeps `esbuild`
 * (denied) distinct from `@esbuild/*` (fod-accepted).
 */
export const familyFor = ({
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
