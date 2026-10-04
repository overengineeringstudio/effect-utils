/** Canonical package version and embedded stamp supplied by a Vite consumer. */
export interface BuildIdentityPluginOptions {
  readonly baseVersion: string
  /** Canonical JSON Nix stamp, or the source placeholder '__CLI_BUILD_STAMP__'. */
  readonly buildStamp: string
}

/** Structural plugin boundary permits consumers on a different Vite major. */
export interface BuildIdentityVitePlugin {
  name: string
}

/**
 * Provides virtual:build-identity ({buildIdentity, deploymentId}) and build-identity.json.
 * Uses the CLI formatter for all versions. Source runs read Git from Vite's root;
 * pure Nix builds use only their embedded revision and reproducible commit time.
 * Static hosts inject globalThis.__BUILD_DEPLOYMENT_ID__ before browser entry modules.
 */
export declare const createBuildIdentityPlugin: (
  options: BuildIdentityPluginOptions,
) => BuildIdentityVitePlugin
