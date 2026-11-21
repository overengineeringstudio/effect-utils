/** Canonical local source build stamp. */
export interface LocalStamp {
  readonly type: 'local'
  readonly rev: string
  readonly ts: number
  readonly commitTs?: number
  readonly dirty: boolean
}

/** Canonical Nix build stamp. */
export interface NixStamp {
  readonly type: 'nix'
  readonly version: string
  readonly rev: string
  readonly commitTs: number
  readonly buildTs?: number
  readonly dirty: boolean
}

/** Canonical source metadata accepted from embedded or runtime JSON stamps. */
export type CliStamp = LocalStamp | NixStamp

/** Structured build identity shared by CLIs, UIs, diagnostics, and telemetry. */
export interface CliBuildIdentity {
  readonly baseVersion: string
  readonly displayVersion: string
  readonly machineVersion: string
  readonly sourceKind: 'package' | 'local' | 'nix'
  readonly rev?: string
  readonly dirty: boolean
  readonly commitTs?: number
  readonly buildTs?: number
}

/** Inputs for resolving embedded metadata with optional runtime environment and clock overrides. */
export interface ResolveBuildIdentityOptions {
  readonly baseVersion: string
  readonly buildStamp: string
  readonly env?: Readonly<Record<string, string | undefined>>
  readonly now?: number
  readonly runtimeStampEnvVar?: string
}

/** Parse the canonical local/Nix JSON stamp. */
export declare const parseCliBuildStamp: (stamp: string) => CliStamp | undefined

/** Embedded Nix metadata takes precedence over runtime stamps. */
export declare const resolveCliBuildIdentity: (
  options: ResolveBuildIdentityOptions,
) => CliBuildIdentity

/** Stable machine-readable version without relative ages or descriptive prose. */
export declare const resolveCliMachineVersion: (options: ResolveBuildIdentityOptions) => string

/** Human-readable version using the process environment and current clock. */
export declare const resolveCliVersion: (options: {
  baseVersion: string
  buildStamp: string
  runtimeStampEnvVar?: string
}) => string
