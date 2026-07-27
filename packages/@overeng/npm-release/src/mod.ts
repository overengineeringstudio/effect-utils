/**
 * Verifying that an npm registry actually serves what a release intended to publish.
 *
 * `npm publish` exiting zero is not the same as the release being live. Three things
 * can independently be wrong afterwards, and only the first is commonly checked:
 *
 * 1. the version is not visible (not propagated, or the publish silently failed),
 * 2. the served tarball is not the artifact that was packed,
 * 3. the dist-tag still resolves to the previous version, so `npm install <pkg>`
 *    keeps serving the old release even though the new one published fine.
 *
 * This module is the decision layer for those checks: pure functions over plain
 * data, with no dependency on Effect, a registry client, or a process runtime.
 *
 * ## Why the decision layer is dependency-free
 *
 * The interesting part of registry verification is the classification — which
 * disagreements are worth retrying and which are terminal. That is pure logic, and
 * keeping it free of IO means it can be exhaustively tested without a registry,
 * a network, or a runtime, and reused from any caller: an Effect release command,
 * a workflow step, or a plain Node script.
 *
 * This mirrors the `@overeng/kdl` / `@overeng/kdl-effect` split — pure core, with
 * an Effect-flavoured wrapper layered on top rather than fused into it.
 *
 * A second, temporary reason reinforces it today: consumers sit on a different
 * Effect major than this repository, and the standing rule at that boundary is to
 * isolate rather than cast across majors. That constraint goes away once everything
 * is on Effect 4; the layering reason above does not, which is why an
 * `@overeng/npm-release-effect` wrapper belongs beside this module rather than
 * replacing it.
 */

/** What a registry currently serves for one package version. */
export type RemoteRegistryState = {
  /** `undefined` when the exact version is not visible on the registry (yet). */
  readonly version: string | undefined
  /** Subresource integrity of the served tarball, e.g. `sha512-…`. */
  readonly integrity: string | undefined
  /** Version the mutable dist-tag resolves to; `undefined` when the tag does not exist. */
  readonly distTag: string | undefined
}

/**
 * Outcome of comparing a registry against what was published.
 *
 * `pending` and `mismatch` are distinct because they need opposite handling.
 * Registry propagation is eventually consistent and worth retrying; a tarball
 * digest that disagrees with what was packed can never become correct, because a
 * published version is immutable on npm. Collapsing them into one "failed" state
 * is what turns a fast, clear failure into a silent multi-minute retry loop.
 */
export type RegistryVerification =
  | { readonly _tag: 'ok' }
  /** Registry has not caught up yet; retrying may resolve this. */
  | { readonly _tag: 'pending'; readonly reason: string }
  /** Registry disagrees with what was published; retrying cannot fix it. */
  | { readonly _tag: 'mismatch'; readonly reason: string }

/** What a caller knows about a package it just published, plus what the registry reports. */
export type RegistryVerificationInput = {
  /** Package name, used only to build readable reasons. */
  readonly pkg: string
  /** Version that was published. */
  readonly version: string
  /** dist-tag the release published under, e.g. `latest`, `dev`, `snapshot`. */
  readonly npmTag: string
  /**
   * Integrity of the locally packed tarball, when this run packed it.
   *
   * `undefined` disables the digest comparison — correct for packages skipped as
   * already-published (repairing a partial release), where there is no local
   * artifact to compare against.
   */
  readonly localIntegrity: string | undefined
  readonly remote: RemoteRegistryState
}

/**
 * Compare what a registry serves against what was published.
 *
 * A dist-tag pointing at a different version is reported as `pending`, not
 * `mismatch`: during normal propagation the tag legitimately lags behind the
 * version for a short window. It becomes a failure when the caller's retry budget
 * is exhausted, which keeps genuine lag from failing a release while still
 * catching a tag that never moves.
 */
export const registryVerification = ({
  pkg,
  version,
  npmTag,
  localIntegrity,
  remote,
}: RegistryVerificationInput): RegistryVerification => {
  if (remote.version === undefined) {
    return { _tag: 'pending', reason: `${pkg}@${version} is not visible on the registry yet` }
  }

  if (remote.version !== version) {
    return {
      _tag: 'mismatch',
      reason: `${pkg}: registry serves version ${remote.version}, expected ${version}`,
    }
  }

  if (
    localIntegrity !== undefined &&
    remote.integrity !== undefined &&
    remote.integrity !== localIntegrity
  ) {
    return {
      _tag: 'mismatch',
      reason: `${pkg}@${version}: registry tarball digest ${remote.integrity} does not match the locally packed ${localIntegrity}`,
    }
  }

  if (remote.distTag === undefined) {
    return {
      _tag: 'pending',
      reason: `${pkg}: dist-tag "${npmTag}" is absent, so ${version} published but nothing resolves to it`,
    }
  }

  if (remote.distTag !== version) {
    return {
      _tag: 'pending',
      reason: `${pkg}: dist-tag "${npmTag}" points at ${remote.distTag}, expected ${version}`,
    }
  }

  return { _tag: 'ok' }
}
