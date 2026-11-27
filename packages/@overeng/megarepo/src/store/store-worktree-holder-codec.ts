import { createHash } from 'node:crypto'

import { Effect, Schema } from 'effect'

/** Names the caller-qualified immutable Rust client path and expected producer/policy.
 * This type neither validates the executable nor grants authentication or freshness. */
export type HolderEvidenceClientConfig = {
  readonly path: string
  readonly producerId: string
  readonly policyId: string
}

/** Fixed public failure for unavailable, malformed or request-mismatched holder evidence. */
export class HolderEvidenceError extends Schema.TaggedError<HolderEvidenceError>()(
  'HolderEvidenceError',
  {},
) {
  override get message(): string {
    return 'Worktree holder evidence unavailable'
  }
}

const U64 = Schema.String.check(
  Schema.makeFilter((s) => /^(0|[1-9][0-9]{0,19})$/u.test(s) && BigInt(s) <= 18446744073709551615n),
)
const PositiveU64 = U64.check(Schema.makeFilter((s) => s !== '0'))
const U32 = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 0, maximum: 4294967295 }),
)
const Pid = U32.check(Schema.isGreaterThan(0))
const Hex64 = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const Nonce = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))
const Path = Schema.String.check(
  Schema.makeFilter(
    (s) =>
      Buffer.byteLength(s) <= 4096 &&
      !s.includes('\0') &&
      !/[\r\n]/u.test(s) &&
      s.startsWith('/') &&
      s
        .slice(1)
        .split('/')
        .every((c) => c !== '' && c !== '.' && c !== '..'),
  ),
)
const RelativePath = Schema.String.check(
  Schema.makeFilter(
    (s) =>
      s === '.' ||
      (Buffer.byteLength(s) <= 4096 &&
        !s.includes('\0') &&
        !/[\r\n]/u.test(s) &&
        s.split('/').every((c) => c !== '' && c !== '.' && c !== '..')),
  ),
)
const Identity = Schema.Struct({ dev: U64, ino: PositiveU64, mountId: PositiveU64 })
const Reference = Schema.Struct({
  tgid: Pid,
  leaderStart: PositiveU64,
  tid: Pid,
  taskStart: PositiveU64,
  uid: Schema.Tuple([U32, U32, U32, U32]),
  reference: Schema.Literals(['root', 'cwd', 'mount', 'exe', 'fd', 'map']),
  relativePath: RelativePath,
  identity: Identity,
  effect: Schema.Literals(['in-use', 'retained-bytes']),
  fd: Schema.NullOr(U32),
  /** Native descriptor-table AND corresponding OFD proof, bound to these task generations.
   * Schema validation alone does not authenticate the proof or grant a pin exemption. */
  leaderFdAlias: Schema.optionalKey(Schema.Literal(true)),
}).check(
  Schema.makeFilter(
    (h) =>
      (h.reference === 'fd') === (h.fd !== null) &&
      (h.leaderFdAlias === undefined || (h.reference === 'fd' && h.tid !== h.tgid)) &&
      !(
        h.effect === 'retained-bytes' &&
        (h.reference === 'root' || h.reference === 'cwd' || h.reference === 'mount')
      ),
  ),
)
const Root = Schema.Struct({
  path: Path,
  identity: Schema.NullOr(Identity),
  complete: Schema.Boolean,
  status: Schema.Literals(['no-current-reference', 'in-use', 'unknown']),
  referencesComplete: Schema.Boolean,
  references: Schema.Array(Reference).check(Schema.isMaxLength(4096)),
  unknownReasons: Schema.Array(
    Schema.Literals([
      'permission',
      'race',
      'unsupported',
      'capacity',
      'root-uncovered',
      'root-changed',
      'mount-backing-unknown',
      'kernel-object-unknown',
      'process-incomplete',
      'reference-overflow',
    ]),
  ),
}).check(
  Schema.makeFilter((r) => {
    const inUse = r.references.some((h) => h.effect === 'in-use')
    return (
      (!r.complete || (r.identity !== null && r.unknownReasons.length === 0)) &&
      (r.status !== 'no-current-reference' || (r.complete && r.referencesComplete && !inUse)) &&
      (r.status !== 'in-use' || inUse)
    )
  }),
)

/** Shape of canonical output from the authenticated Rust client, not arbitrary JSON
 * duplicate-key validation. Decoding grants neither freshness nor absence authority. */
export const HolderEvidenceResponse = Schema.Struct({
  version: Schema.Literal(1),
  nonce: Nonce,
  kind: Schema.Literal('worktree'),
  producerId: Schema.NonEmptyString,
  policyId: Hex64,
  model: Schema.Literal('managed-cooperative-v1'),
  hostId: Hex64,
  bootId: Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u)),
  capture: Schema.Struct({ startedBootNs: U64, finishedBootNs: U64, expiresBootNs: U64 }),
  scope: Schema.Struct({
    complete: Schema.Boolean,
    allUids: Schema.Literal(true),
    allTasks: Schema.Literal(true),
    processCount: U32,
    taskCount: U32,
    namespaces: Schema.Struct({
      user: PositiveU64,
      pid: PositiveU64,
      mnt: PositiveU64,
      net: PositiveU64,
    }),
    requestedPathsDigest: Hex64,
    digest: Hex64,
  }),
  roots: Schema.Array(Root).check(Schema.isBetweenLength(1, 4096)),
}).check(
  Schema.makeFilter((r) => {
    const start = BigInt(r.capture.startedBootNs)
    const finish = BigInt(r.capture.finishedBootNs)
    return (
      start <= finish &&
      finish - start <= 25000000000n &&
      start + 30000000000n === BigInt(r.capture.expiresBootNs) &&
      r.scope.processCount <= r.scope.taskCount &&
      r.roots.reduce((n, root) => n + root.references.length, 0) <= 65536 &&
      r.roots.every((root) => root.status !== 'no-current-reference' || r.scope.complete)
    )
  }),
)
export type HolderEvidenceResponse = typeof HolderEvidenceResponse.Type

/** Only call on bounded stdout of the fixed, trusted Rust holder client. The
 * caller must separately check completeness, pinned identities and boot freshness. */
export const decodeWorktreeHolderEvidence = (input: {
  readonly stdout: string
  readonly nonce: string
  readonly paths: ReadonlyArray<string>
  readonly producerId: string
  readonly policyId: string
}): Effect.Effect<HolderEvidenceResponse, HolderEvidenceError> =>
  Effect.gen(function* () {
    if (
      input.stdout.length > 16 * 1024 * 1024 ||
      Buffer.byteLength(input.stdout) > 16 * 1024 * 1024
    ) {
      return yield* new HolderEvidenceError({})
    }
    const response = yield* Schema.decodeEffect(Schema.fromJsonString(HolderEvidenceResponse), {
      onExcessProperty: 'error',
    })(input.stdout).pipe(Effect.mapError(() => new HolderEvidenceError({})))
    const digest = createHash('sha256').update('holder-evidence-paths-v1\0worktree\0')
    for (const path of input.paths) digest.update(path).update('\0')
    if (
      response.nonce !== input.nonce ||
      response.producerId !== input.producerId ||
      response.policyId !== input.policyId ||
      new Set(input.paths).size !== input.paths.length ||
      response.roots.length !== input.paths.length ||
      response.roots.some((root, index) => root.path !== input.paths[index]) === true ||
      response.scope.requestedPathsDigest !== digest.digest('hex')
    ) {
      return yield* new HolderEvidenceError({})
    }
    return response
  })
