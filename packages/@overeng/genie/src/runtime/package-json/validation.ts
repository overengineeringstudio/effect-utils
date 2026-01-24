/**
 * Package.json validation types and utilities.
 *
 * This module provides generic types and mechanisms for validation.
 * Opinionated rules (e.g., peer deps conventions) should be defined
 * in consuming repos, not here.
 */

// =============================================================================
// Types
// =============================================================================

/** A constraint that pins a specific dependency to a version for certain packages */
export type VersionConstraint = {
  /** Human-readable description of why this constraint exists */
  reason: string
  /** The dependency name to constrain */
  dependency: string
  /** Package name patterns this constraint applies to (glob patterns supported) */
  packages: string[]
  /** The version to pin to */
  version: string
  /** Dependency types this applies to (default: all) */
  dependencyTypes?: Array<'prod' | 'dev' | 'peer'>
}

/** A validation issue found during package.json generation */
export type ValidationIssue = {
  /** Issue severity */
  severity: 'error' | 'warning'
  /** The package where the issue was found */
  packageName: string
  /** The dependency involved */
  dependency: string
  /** Human-readable message */
  message: string
  /** The rule that was violated */
  rule: string
}

/** Dependencies object for validation */
export type DepsToValidate = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  peerDependencies?: Record<string, string>
}

/** Validation function signature */
export type ValidationFn = (packageName: string, deps: DepsToValidate) => ValidationIssue[]

/** Validation configuration */
export type ValidationConfig = {
  /** Custom validation function (receives package name and resolved deps) */
  validate?: ValidationFn
  /** Package patterns to exclude from validation (e.g., examples) */
  excludePackages?: string[]
  /** Whether to throw on validation errors (default: true) */
  throwOnError?: boolean
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Check if a package name matches a glob pattern.
 * Supports `*` (single segment) and `**` (any segments).
 */
export const matchesPattern = (args: {
  /** The package name to check */
  name: string
  /** The glob pattern to match against */
  pattern: string
}): boolean => {
  if (args.pattern === args.name) return true
  if (args.pattern === '**') return true

  if (args.pattern.includes('*')) {
    const regex = new RegExp(
      '^' +
        args.pattern
          .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*') +
        '$',
    )
    return regex.test(args.name)
  }
  return false
}

/**
 * Check if a package matches any of the given patterns.
 */
export const matchesAnyPattern = (args: {
  /** The package name to check */
  name: string
  /** The glob patterns to match against */
  patterns: string[]
}): boolean => args.patterns.some((pattern) => matchesPattern({ name: args.name, pattern }))

// =============================================================================
// Version Constraint Validation
// =============================================================================

/**
 * Validate special version constraints (e.g., Tailwind v3 for expo-linearlite).
 * This is a generic mechanism - the specific constraints are defined by the caller.
 */
export const validateVersionConstraints = (args: {
  /** The package being validated */
  packageName: string
  /** The resolved dependencies */
  deps: DepsToValidate
  /** Version constraints to check */
  constraints: VersionConstraint[]
}): ValidationIssue[] => {
  const issues: ValidationIssue[] = []

  for (const constraint of args.constraints) {
    // Check if this package matches the constraint's package patterns
    if (
      !matchesAnyPattern({
        name: args.packageName,
        patterns: constraint.packages,
      })
    )
      continue

    // Check each dependency type
    const depTypes = constraint.dependencyTypes ?? ['prod', 'dev', 'peer']
    const depSources: Array<{
      type: string
      deps: Record<string, string> | undefined
    }> = [
      { type: 'prod', deps: args.deps.dependencies },
      { type: 'dev', deps: args.deps.devDependencies },
      { type: 'peer', deps: args.deps.peerDependencies },
    ]

    for (const { type, deps: depsObj } of depSources) {
      if (!depTypes.includes(type as 'prod' | 'dev' | 'peer')) continue
      if (!depsObj) continue

      const currentVersion = depsObj[constraint.dependency]
      if (currentVersion === undefined) continue

      // Skip catalog: protocol - the constraint should be in the genie config itself
      if (currentVersion === 'catalog:' || currentVersion.startsWith('catalog:')) {
        issues.push({
          severity: 'error',
          packageName: args.packageName,
          dependency: constraint.dependency,
          message: `"${constraint.dependency}" should be pinned to "${constraint.version}" for this package (${constraint.reason}), but uses catalog: protocol. Override in package.json.genie.ts.`,
          rule: 'version-constraint',
        })
        continue
      }

      // Check if version matches constraint
      if (currentVersion !== constraint.version && !currentVersion.endsWith(constraint.version)) {
        issues.push({
          severity: 'error',
          packageName: args.packageName,
          dependency: constraint.dependency,
          message: `"${constraint.dependency}" should be "${constraint.version}" (${constraint.reason}), but is "${currentVersion}".`,
          rule: 'version-constraint',
        })
      }
    }
  }

  return issues
}

// =============================================================================
// Output Utilities
// =============================================================================

/**
 * Format validation issues for console output.
 */
export const formatValidationIssues = (issues: ValidationIssue[]): string => {
  if (issues.length === 0) return ''

  const lines: string[] = []
  const grouped = new Map<string, ValidationIssue[]>()

  // Group by package
  for (const issue of issues) {
    const existing = grouped.get(issue.packageName) ?? []
    existing.push(issue)
    grouped.set(issue.packageName, existing)
  }

  for (const [pkg, pkgIssues] of grouped) {
    lines.push(`\n${pkg}:`)
    for (const issue of pkgIssues) {
      const prefix = issue.severity === 'error' ? '  ✗' : '  ⚠'
      lines.push(`${prefix} ${issue.message}`)
    }
  }

  return lines.join('\n')
}

/**
 * Throw if there are any error-level issues.
 */
export const assertNoValidationErrors = (issues: ValidationIssue[]): void => {
  const errors = issues.filter((i) => i.severity === 'error')
  if (errors.length > 0) {
    const formatted = formatValidationIssues(errors)
    throw new Error(`Package.json validation failed:${formatted}`)
  }
}
