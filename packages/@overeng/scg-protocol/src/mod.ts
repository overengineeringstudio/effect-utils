import { createHash, sign, verify, type KeyObject } from 'node:crypto'

import { Schema } from 'effect'

export { decodeJson } from './json.ts'

/** Experimental wire epoch; its state must never be promoted into a trusted epoch. */
export const Version = Schema.Literal('scg-experiment-v1')
/** Fresh execution, reservation and transport-nonce identifiers. */
export const Uuid = Schema.String.check(Schema.isUUID())
/** SHA-256 commitment to the canonical JSON representation, including its algorithm prefix. */
export const Digest = Schema.String.check(Schema.isPattern(/^sha256:[a-f0-9]{64}$/))
/** Nonempty bounded wire identifiers; their authorization meaning belongs to the authority. */
export const Identifier = Schema.NonEmptyString.check(Schema.isMaxLength(256))
/** Absolute Unix time in milliseconds, representable without integer precision loss. */
export const Timestamp = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
)
/** Review classification, not permission to execute an action. */
export const Sensitivity = Schema.Literals(['low', 'sensitive'])
/** Catalog-tagged semantic action; never an arbitrary executable or shell command. */
export const Action = Schema.Struct({
  commandId: Identifier,
  account: Identifier,
  args: Schema.Record(
    Schema.String,
    Schema.Union([Schema.String, Schema.Finite, Schema.Boolean, Schema.Array(Schema.String)]),
  ),
})
export type Action = typeof Action.Type
/** Caller submission with a pinned catalog and owner-scoped durable idempotency key. */
export const Submitted = Schema.Struct({
  epoch: Version,
  catalogDigest: Digest,
  idempotencyKey: Identifier,
  action: Action,
  claimed: Schema.Struct({
    intent: Schema.NonEmptyString.check(Schema.isMaxLength(2000)),
    sensitivity: Sensitivity,
  }),
})
export type Submitted = typeof Submitted.Type
/** Authenticated caller identity and enrolled key; agent-provided claims cannot establish ownership. */
export const Owner = Schema.Struct({ identity: Identifier, keyId: Identifier })
export type Owner = typeof Owner.Type
/** Authority-projected review fields, keeping caller claims explicitly separate from trusted context. */
export const Review = Schema.Struct({
  command: Identifier,
  account: Identifier,
  sensitivity: Sensitivity,
  fields: Schema.Array(Schema.Struct({ label: Identifier, value: Schema.String })),
  agentClaim: Schema.String,
  tier: Schema.optionalKey(Schema.Literals(['read', 'write'])),
  session: Schema.optionalKey(Schema.Struct({ label: Identifier, verified: Schema.Boolean })),
  holds: Schema.optionalKey(
    Schema.Array(Schema.Struct({ label: Identifier, used: Schema.Int, cap: Schema.Int })),
  ),
  coverage: Schema.optionalKey(
    Schema.Struct({ kind: Schema.Literals(['covered-by', 'would-create']), text: Schema.String }),
  ),
  context: Schema.optionalKey(
    Schema.Struct({
      origin: Schema.Struct({
        locator: Schema.String,
        digest: Digest,
        provenance: Schema.Literals(['device-signed', 'fractal-recorded', 'claimed']),
        surface: Schema.Literals(['discord', 'other']),
        at: Timestamp,
        place: Schema.String,
        turn: Schema.optionalKey(Schema.String),
        wordsAvailable: Schema.Boolean,
      }),
      chain: Schema.Array(Schema.String),
      audit: Schema.Array(Schema.Struct({ at: Timestamp, text: Schema.String })).check(
        Schema.isMaxLength(3),
      ),
      flags: Schema.Array(
        Schema.Literals(['new-account', 'first-write', 'outside-delegation', 'asked-before']),
      ).check(Schema.isMaxLength(3)),
    }),
  ),
})
/** Authority admission binding the submission, authenticated owner and projected review to one execution. */
export const Admitted = Schema.Struct({
  submitted: Submitted,
  owner: Owner,
  executionId: Uuid,
  requestDigest: Digest,
  actionDigest: Digest,
  admittedAt: Timestamp,
  review: Review,
})
export type Admitted = typeof Admitted.Type
const OfferBase = { optionId: Identifier, statement: Schema.NonEmptyString }
const Selector = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
)
/** Signed offer vocabulary; the M1 authority accepts only allow-once and deny selections. */
export const Offer = Schema.Union([
  Schema.Struct({ ...OfferBase, kind: Schema.Literal('allow-once') }),
  Schema.Struct({ ...OfferBase, kind: Schema.Literal('deny') }),
  Schema.Struct({
    ...OfferBase,
    kind: Schema.Literal('similar-lease'),
    command: Identifier,
    account: Identifier,
    selector: Selector,
    duration: Schema.Literals(['1h', '4h', 'berlin-end-of-day']),
    until: Timestamp,
    guardrail: Schema.Struct({
      total: Schema.Literal(20),
      calls: Schema.Literal(6),
      windowSeconds: Schema.Literal(60),
    }),
  }),
  Schema.Struct({
    ...OfferBase,
    kind: Schema.Literal('session-rule'),
    session: Identifier,
    rules: Schema.Array(
      Schema.Struct({
        operation: Schema.Literals(['read', 'write']),
        command: Identifier,
        account: Identifier,
        where: Selector,
        mandatorySelectors: Schema.Array(Identifier),
        maxCalls: Schema.Int.check(Schema.isGreaterThan(0)),
        rate: Schema.Struct({
          calls: Schema.Int.check(Schema.isGreaterThan(0)),
          windowSeconds: Schema.Literal(60),
        }),
        until: Timestamp,
      }),
    ).check(Schema.isMinLength(1)),
  }),
  Schema.Struct({
    ...OfferBase,
    kind: Schema.Literal('manifest-approve'),
    items: Schema.Array(
      Schema.Struct({ executionId: Uuid, actionDigest: Digest, review: Review }),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(10)),
  }),
  Schema.Struct({
    ...OfferBase,
    kind: Schema.Literal('grant-to-parent'),
    parentSession: Identifier,
    command: Identifier,
    account: Identifier,
    selector: Selector,
    until: Timestamp,
    guardrail: Schema.Struct({
      total: Schema.Literal(20),
      calls: Schema.Literal(6),
      windowSeconds: Schema.Literal(60),
    }),
  }),
])
export type Offer = typeof Offer.Type
/** Whole approval request committed by a decision, including exact offers, statements and expiry. */
export const Pending = Schema.Struct({
  epoch: Version,
  kind: Schema.Literal('pending'),
  executionId: Uuid,
  requestDigest: Digest,
  actionDigest: Digest,
  review: Review,
  options: Schema.Array(Offer).check(
    Schema.isMinLength(1),
    Schema.makeFilter(
      (options) => new Set(options.map((option) => option.optionId)).size === options.length,
      { description: 'unique option identifiers' },
    ),
  ),
  issuedAt: Timestamp,
  expiresAt: Timestamp,
})
export type Pending = typeof Pending.Type
/** Signer selection bound to the complete pending digest, option and enrolled surface principal. */
export const Decision = Schema.Struct({
  epoch: Version,
  kind: Schema.Literal('decision'),
  executionId: Uuid,
  pendingDigest: Digest,
  optionId: Identifier,
  surfaceId: Identifier,
  principalId: Identifier,
  decidedAt: Timestamp,
})
export type Decision = typeof Decision.Type
/** Exact reserved execution sent across the executor boundary, with audience and deadline binding. */
export const Dispatch = Schema.Struct({
  epoch: Version,
  kind: Schema.Literal('dispatch'),
  executionId: Uuid,
  action: Action,
  catalogDigest: Digest,
  actionDigest: Digest,
  requestDigest: Digest,
  audience: Identifier,
  reservationId: Uuid,
  deadline: Timestamp,
})
export type Dispatch = typeof Dispatch.Type
/** Durable execution states; a reserved execution is never implicitly made spendable after restart. */
export const State = Schema.Literals([
  'pending',
  'denied',
  'expired',
  'reserved',
  'succeeded',
  'failed',
  'unknown',
])
/** Execution receipt; result plaintext is available only on the authenticated owner's boundary. */
export const Status = Schema.Struct({
  executionId: Uuid,
  state: State,
  requestDigest: Digest,
  result: Schema.optionalKey(Schema.String),
  resultDigest: Schema.optionalKey(Digest),
  decisionDigest: Schema.optionalKey(Digest),
})
export type Status = typeof Status.Type
/** Digest-only durable transition receipt for signer reconciliation. */
export const Terminal = Schema.Struct({
  cursor: Schema.Int,
  executionId: Uuid,
  state: State,
  requestDigest: Digest,
})
export type Terminal = typeof Terminal.Type
/** Signed semantic command definitions; concrete accounts and policy are supplied by private composition. */
export const Catalog = Schema.Struct({
  epoch: Version,
  revision: Identifier,
  entries: Schema.Array(
    Schema.Struct({
      commandId: Identifier,
      sensitivity: Sensitivity,
      description: Schema.String,
      accounts: Schema.Array(Identifier),
      argsSchema: Schema.Record(Schema.String, Schema.Unknown),
    }),
  ),
})
export type Catalog = typeof Catalog.Type
/** Replay-protected transport proof binding HTTP method, path and complete request-body digest. */
export const AuthRequest = Schema.Struct({
  epoch: Version,
  method: Schema.Literals(['GET', 'POST']),
  path: Schema.String,
  bodyDigest: Digest,
  nonce: Uuid,
  issuedAt: Timestamp,
})
export type AuthRequest = typeof AuthRequest.Type
/** Ed25519 envelope schema; verification must also pin the domain and enrolled key. */
export const signed = <TSchema extends Schema.Top>(payload: TSchema) =>
  Schema.Struct({
    payload,
    keyId: Identifier,
    algorithm: Schema.Literal('Ed25519'),
    signature: Schema.String,
  })
/** Authority-signed pending request, including its complete review and offers. */
export const SignedPending = signed(Pending)
/** Enrolled service-signed decision; the signed payload alone does not grant execution. */
export const SignedDecision = signed(Decision)
/** Authority-signed exact reservation for the enrolled executor audience. */
export const SignedDispatch = signed(Dispatch)
/** Authority-signed catalog used to pin submission semantics. */
export const SignedCatalog = signed(Catalog)
/** Enrolled caller or signer transport proof, checked independently from decision signatures. */
export const SignedAuthRequest = signed(AuthRequest)
export type SignedPending = typeof SignedPending.Type
export type SignedDecision = typeof SignedDecision.Type
export type SignedDispatch = typeof SignedDispatch.Type
export type SignedCatalog = typeof SignedCatalog.Type
export type SignedAuthRequest = typeof SignedAuthRequest.Type

/** Executor receipt bound to the exact signed dispatch and the digest of its result. */
export const ExecutionResult = Schema.Struct({
  epoch: Version,
  executionId: Uuid,
  dispatchDigest: Digest,
  state: Schema.Literals(['succeeded', 'failed', 'unknown']),
  result: Schema.String,
  resultDigest: Digest,
})
export type ExecutionResult = typeof ExecutionResult.Type
/** Enrolled worker's signed execution receipt, not a caller-supplied completion claim. */
export const SignedExecutionResult = signed(ExecutionResult)
export type SignedExecutionResult = typeof SignedExecutionResult.Type

/** JSON-only UTF-16 sorted keys, no normalization. Non-finite numbers and unsupported values reject. */
export const canonical = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value) === true) return JSON.stringify(value)
  if (Array.isArray(value) === true) return `[${value.map(canonical).join(',')}]`
  if (
    typeof value === 'object' &&
    value !== null &&
    Object.getPrototypeOf(value) === Object.prototype
  ) {
    return `{${Object.entries(value)
      .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
      .join(',')}}`
  }
  throw new ProtocolError('invalid-canonical-value')
}
/** Structured rejection of values outside the canonical protocol representation. */
export class ProtocolError extends Error {
  readonly _tag = 'ProtocolError'
  readonly code: string
  constructor(code: string) {
    super(code)
    this.code = code
  }
}
/** Domain-independent SHA-256 commitment to canonical JSON bytes. */
export const digest = (value: unknown): string =>
  `sha256:${createHash('sha256').update(canonical(value)).digest('hex')}`
/** Executable semantics are pinned along with the exact account and arguments. */
export const digestAction = ({
  catalogDigest,
  action,
}: {
  readonly catalogDigest: string
  readonly action: Action
}): string => digest({ catalogDigest, action })
/** Domain-separated canonical bytes binding the payload, key identifier and signature algorithm. */
export const signingBytes = ({
  domain,
  payload,
  keyId,
}: {
  readonly domain: string
  readonly payload: unknown
  readonly keyId: string
}): Uint8Array =>
  new TextEncoder().encode(
    canonical({ domain: `scg/${domain}/v1`, keyId, algorithm: 'Ed25519', payload }),
  )
/** Sign exactly the domain-separated wire bytes with the enrolled private key. */
export const signPayload = <TPayload>({
  domain,
  payload,
  keyId,
  key,
}: {
  readonly domain: string
  readonly payload: TPayload
  readonly keyId: string
  readonly key: KeyObject
}): {
  payload: TPayload
  keyId: string
  algorithm: 'Ed25519'
  signature: string
} => ({
  payload,
  keyId,
  algorithm: 'Ed25519',
  signature: sign(null, signingBytes({ domain, payload, keyId }), key).toString('base64'),
})
/** Verify the pinned domain and Ed25519 public key against the complete canonical envelope payload. */
export const verifyPayload = <TPayload>({
  domain,
  envelope,
  key,
}: {
  readonly domain: string
  readonly envelope: {
    readonly payload: TPayload
    readonly keyId: string
    readonly algorithm: 'Ed25519'
    readonly signature: string
  }
  readonly key: KeyObject
}): boolean =>
  key.asymmetricKeyType === 'ed25519' &&
  verify(
    null,
    signingBytes({ domain, payload: envelope.payload, keyId: envelope.keyId }),
    key,
    Buffer.from(envelope.signature, 'base64'),
  )

/** C2 transport: signed catalog, owner submit/status; signer-only pending/decision/sync. */
export const routes = {
  catalog: '/v1/catalog',
  submit: '/v1/submit',
  status: '/v1/status/',
  pending: '/v1/pending/',
  decision: '/v1/decision',
  sync: '/v1/sync',
  health: '/health',
} as const
/** Non-authorizing liveness and pinned-release response with an optional caller challenge. */
export const Health = Schema.Struct({
  epoch: Version,
  release: Identifier,
  catalogDigest: Digest,
  bootNonce: Uuid,
  ready: Schema.Boolean,
  nonce: Schema.optionalKey(Uuid),
})
export type Health = typeof Health.Type

/** Authenticated signer reconciliation: signed pending items and digest-only durable transitions. */
export const Sync = Schema.Struct({
  cursor: Schema.Int,
  pending: Schema.Array(SignedPending),
  terminal: Schema.Array(Terminal),
})
export type Sync = typeof Sync.Type
/** A decision returns the same durable execution receipt as status, not a separate transient grant. */
export const DecisionResponse = Status
export type DecisionResponse = typeof DecisionResponse.Type
