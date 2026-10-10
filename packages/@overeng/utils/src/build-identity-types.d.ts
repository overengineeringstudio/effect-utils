/** The fields consumed from the canonical identity exposed by virtual:build-identity. */
export interface BuildIdentity {
  readonly displayVersion: string
  readonly machineVersion: string
  readonly dirty: boolean
  readonly rev?: string | undefined
  /** Unix seconds; never substitute buildTs for a missing commitTs. */
  readonly commitTs?: number | undefined
  /** Optional build/deploy timestamp in Unix seconds. */
  readonly buildTs?: number | undefined
}

/** Canonical identity and caller-owned clock used by human identity formatters. */
export interface BuildIdentityFormatOptions {
  readonly identity: BuildIdentity
  /** Current Unix seconds, supplied by the caller's clock. */
  readonly now: number
}

/** One labelled human-readable line in the build identity disclosure. */
export interface BuildIdentityDetail {
  readonly label: 'displayVersion' | 'machineVersion' | 'deployed'
  readonly value: string
}

/** Compact elapsed time: s/m/h/d/mo/y. Long preserves the CLI's existing prose. */
export declare const formatRelativeTime: (options: {
  readonly ts: number
  readonly now: number
  readonly format?: 'short' | 'long'
}) => string

/** Seven revision characters, optional dirty marker, and commit age (or n/a). */
export declare const formatBuildIdentityShort: (options: BuildIdentityFormatOptions) => string

/** Version lines followed by a deployment-age line only when buildTs is present. */
export declare const formatBuildIdentityDetails: (
  options: BuildIdentityFormatOptions,
) => readonly BuildIdentityDetail[]
