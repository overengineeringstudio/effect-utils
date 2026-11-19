import { createHash } from 'node:crypto'

import { Effect, Schema } from 'effect'

const MAX_RESPONSE = 16 * 1024 * 1024
const U64_MAX = 18446744073709551615n
const Digest = Schema.String.check(Schema.isPattern(/^[0-9a-f]{64}$/u))
const Nonce = Schema.String.check(Schema.isPattern(/^[0-9a-f]{32}$/u))
const U64 = Schema.String.check(Schema.makeFilter((value) =>
  /^(?:0|[1-9][0-9]{0,19})$/u.test(value) && BigInt(value) <= U64_MAX,
))
const NonzeroU64 = U64.check(Schema.makeFilter((value) => value !== '0'))
const U32 = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4294967295 }))
const UUID = Schema.String.check(Schema.isPattern(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u))
const canonicalParts = (value: string) => value.split('/').every((part) =>
  part.length > 0 && part !== '.' && part !== '..',
)
const validText = (value: string) =>
  !/[\u0000\r\n\uD800-\uDFFF]/u.test(value) && Buffer.byteLength(value, 'utf8') <= 4096
const canonicalPath = (value: string) =>
  validText(value) && value.startsWith('/') && value !== '/' && canonicalParts(value.slice(1))
const Path = Schema.String.check(Schema.makeFilter(canonicalPath))
const RelativePath = Schema.String.check(Schema.makeFilter((value) =>
  validText(value) && (value === '.' || canonicalParts(value)),
))
const Producer = Schema.String.check(Schema.isPattern(/^\/nix\/store\/[0-9abcdfghijklmnpqrsvwxyz]{32}-[A-Za-z0-9+._?=-]+$/u))

/** The immutable package output and its compiled policy are one binding. */
export const WorktreeHolderEvidenceClientConfigSchema = Schema.Struct({
  path: Path,
  producerId: Producer,
  policyId: Digest,
}).check(Schema.makeFilter((client) =>
  client.path === `${client.producerId}/bin/worktree-holder-evidence`,
))
export type WorktreeHolderEvidenceClientConfig = typeof WorktreeHolderEvidenceClientConfigSchema.Type

/** Worktree requests reuse the response's nonce and canonical root-path rules. */
export const WorktreeHolderEvidenceRequestSchema = Schema.Struct({
  version: Schema.Literal(1),
  nonce: Nonce,
  kind: Schema.Literal('worktree'),
  paths: Schema.Array(Path).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(4096),
    Schema.makeFilter((paths) => new Set(paths).size === paths.length),
  ),
})

const Identity = Schema.Struct({ dev: U64, ino: NonzeroU64, mountId: NonzeroU64 })
const Reference = Schema.Struct({
  tgid: U32.check(Schema.isGreaterThan(0)),
  leaderStart: NonzeroU64,
  tid: U32.check(Schema.isGreaterThan(0)),
  taskStart: NonzeroU64,
  uid: Schema.Tuple([U32, U32, U32, U32]),
  reference: Schema.Literals(['root', 'cwd', 'exe', 'fd', 'map', 'mount']),
  relativePath: RelativePath,
  identity: Identity,
  effect: Schema.Literals(['in-use', 'retained-bytes']),
  fd: Schema.NullOr(U32),
}).check(Schema.makeFilter((reference) =>
  (reference.reference === 'fd') === (reference.fd !== null) &&
  (reference.effect !== 'retained-bytes' ||
    reference.reference === 'fd' || reference.reference === 'map' || reference.reference === 'exe'),
))
const Root = Schema.Struct({
  path: Path,
  identity: Schema.NullOr(Identity),
  complete: Schema.Boolean,
  status: Schema.Literals(['no-current-reference', 'in-use', 'unknown']),
  referencesComplete: Schema.Boolean,
  references: Schema.Array(Reference).check(Schema.isMaxLength(4096)),
  unknownReasons: Schema.Array(Schema.Literals([
    'permission', 'race', 'unsupported', 'capacity', 'root-uncovered', 'root-changed',
    'mount-backing-unknown', 'kernel-object-unknown', 'process-incomplete', 'reference-overflow',
  ])),
})

/** Scoped wire data, never a globally complete native process scan or deletion permission. */
export const WorktreeHolderEvidenceSchema = Schema.Struct({
  version: Schema.Literal(1),
  nonce: Nonce,
  kind: Schema.Literal('worktree'),
  producerId: Producer,
  policyId: Digest,
  model: Schema.Literal('managed-cooperative-v1'),
  hostId: Digest,
  bootId: UUID,
  capture: Schema.Struct({ startedBootNs: U64, finishedBootNs: U64, expiresBootNs: U64 }),
  scope: Schema.Struct({
    complete: Schema.Boolean,
    allUids: Schema.Literal(true),
    allTasks: Schema.Literal(true),
    processCount: U32,
    taskCount: U32,
    namespaces: Schema.Struct({ user: NonzeroU64, pid: NonzeroU64, mnt: NonzeroU64, net: NonzeroU64 }),
    requestedPathsDigest: Digest,
    // Opaque authenticated receipt: hidden census bytes cannot be reconstructed here.
    digest: Digest,
  }),
  roots: Schema.Array(Root).check(Schema.isMinLength(1), Schema.isMaxLength(4096)),
}).check(Schema.makeFilter((evidence) => {
  const start = BigInt(evidence.capture.startedBootNs)
  const finish = BigInt(evidence.capture.finishedBootNs)
  if (finish < start || finish - start > 25000000000n ||
      BigInt(evidence.capture.expiresBootNs) !== start + 30000000000n ||
      evidence.scope.taskCount < evidence.scope.processCount) return false
  let references = 0
  const paths = new Set<string>()
  for (const root of evidence.roots) {
    references += root.references.length
    if (paths.has(root.path)) return false
    paths.add(root.path)
    if (root.identity === null && (root.complete || root.status !== 'unknown')) return false
    if (root.complete && (!root.referencesComplete || root.unknownReasons.length > 0)) return false
    if (root.status === 'no-current-reference' &&
        (!evidence.scope.complete || !root.complete || !root.referencesComplete ||
         root.identity === null || root.references.some((reference) => reference.effect === 'in-use') ||
         root.unknownReasons.length > 0)) return false
    if (root.status === 'in-use' && !root.references.some((reference) => reference.effect === 'in-use')) return false
  }
  return references <= 65536
}))
export type WorktreeHolderEvidence = typeof WorktreeHolderEvidenceSchema.Type

export const requestedWorktreePathsDigest = (paths: ReadonlyArray<string>): string => {
  const hash = createHash('sha256').update('holder-evidence-paths-v1\0worktree\0')
  for (const path of paths) hash.update(path, 'utf8').update('\0')
  return hash.digest('hex')
}

/** Decode and bind only; host/boot freshness and consumer-specific vetoes remain mandatory. */
export const decodeWorktreeHolderEvidence = ({ client, paths, nonce, json }: {
  readonly client: WorktreeHolderEvidenceClientConfig
  readonly paths: ReadonlyArray<string>
  readonly nonce: string
  readonly json: string
}): Effect.Effect<WorktreeHolderEvidence | undefined> => Effect.gen(function* () {
  yield* Schema.decodeEffect(WorktreeHolderEvidenceClientConfigSchema, { onExcessProperty: 'error' })(client)
  if (Buffer.byteLength(json, 'utf8') > MAX_RESPONSE || paths.length === 0 || paths.length > 4096 ||
      paths.some((path) => !canonicalPath(path)) || new Set(paths).size !== paths.length) return undefined
  const evidence = yield* Schema.decodeEffect(Schema.fromJsonString(WorktreeHolderEvidenceSchema), {
    onExcessProperty: 'error',
  })(json)
  if (evidence.nonce !== nonce || evidence.producerId !== client.producerId ||
      evidence.policyId !== client.policyId || evidence.roots.length !== paths.length ||
      evidence.roots.some((root, index) => root.path !== paths[index]) ||
      evidence.scope.requestedPathsDigest !== requestedWorktreePathsDigest(paths)) return undefined
  return evidence
}).pipe(Effect.catch(() => Effect.succeed(undefined)))
