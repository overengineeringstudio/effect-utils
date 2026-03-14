import type { GenieValidationIssue, PackageInfo } from './validation/mod.ts'

/** Context passed to genie generator functions */
export type GenieContext = {
  /** Repo-relative path to the directory containing this genie file (e.g., 'packages/@overeng/utils') */
  location: string
  /** Absolute path to the working directory (repo root) */
  cwd: string
  /** All workspace packages — populated during validation, undefined during stringify */
  workspace?: {
    packages: PackageInfo[]
    byName: Map<string, PackageInfo>
  }
}

/**
 * Enforces that T has no extra keys beyond what's defined in Base.
 * Used to catch typos and disallowed properties at compile time.
 */
export type Strict<T, TBase> = T & {
  [K in Exclude<keyof T, keyof TBase>]: never
}

/** Standard output shape returned by genie factory functions, containing structured data and a serializer. */
type GenieOutputBase<T> = {
  /** The structured configuration data */
  data: T
  /** Serialize the data to a string for file output */
  stringify: (ctx: GenieContext) => string
  /** Optional validation hook — runs during both generation and check */
  validate?: (ctx: GenieContext) => GenieValidationIssue[]
}

/** Standard output shape for Genie generators, with canonical emitted `data` and optional non-emitted `meta`. */
export type GenieOutput<T, TMeta = never> = [TMeta] extends [never]
  ? GenieOutputBase<T>
  : GenieOutputBase<T> & { meta: TMeta }

/** Construct a `GenieOutput` while preserving metadata typing for composition. */
export function createGenieOutput<T>(args: GenieOutputBase<T>): GenieOutput<T>
export function createGenieOutput<T, TMeta>(
  args: GenieOutputBase<T> & { meta: TMeta },
): GenieOutput<T, TMeta>
export function createGenieOutput<T, TMeta>(
  args: GenieOutputBase<T> | (GenieOutputBase<T> & { meta: TMeta }),
): GenieOutput<T, TMeta> {
  return args as GenieOutput<T, TMeta>
}
