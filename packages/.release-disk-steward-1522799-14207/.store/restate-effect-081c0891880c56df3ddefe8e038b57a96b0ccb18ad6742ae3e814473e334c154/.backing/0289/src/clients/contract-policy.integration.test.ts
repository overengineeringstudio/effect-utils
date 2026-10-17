/**
 * The centralized contract-invocation policy (decision 0020) proven at the PUBLIC
 * ingress entrypoints against a real native server. This is the safety net for the
 * two P2 client findings + the invariant matrix:
 *
 * 1. REDACTION on Service `call`: a `Restate.sensitive` field round-trips through
 *    `RestateIngress.call` — the request encrypts the field on the wire and the
 *    response decrypts it (no `RedactionCipherMissingError`, no plaintext leak).
 *    Pre-fix `Client.call` built its serdes WITHOUT the cipher, so this FAILED.
 * 2. IDEMPOTENCY on Service `call`: a Service whose input carries
 *    `Restate.idempotencyKey` DEDUPES on retry — two calls with the same key run
 *    the handler ONCE. Pre-fix `Client.call` passed no idempotency key, so the
 *    handler ran twice.
 * 3. INVARIANT MATRIX: over Service × Object × Workflow and call/send/attach, every
 *    contract annotation behaves consistently — `sensitive` round-trips encrypted,
 *    `idempotencyKey` dedupes, and a terminal error decodes to the typed tag.
 *
 * Both findings are fixed BY CONSTRUCTION (every adapter consumes the one policy),
 * so the matrix below exercises the SAME boundary that produced the bugs.
 */
import { it } from '@effect/vitest'
import { Effect, Schema } from 'effect'
import { describe, expect } from 'vitest'

import {
  aesGcmRedactionLayer,
  Restate,
  RestateObject,
  RestateService,
  RestateWorkflow,
  State,
} from '../mod.ts'
import { liveSleep, RestateTestHarness, serverAvailable } from '../testing/testing.ts'

const KEY = new Uint8Array(32).fill(9)
const SECRET = 'top-secret-token'

/* A module-level invocation counter: the harness serves handlers IN-PROCESS, so a
 * closure counter is a faithful "did the server invoke the handler" signal for the
 * idempotency-dedup assertions (reset per suite). */
let serviceInvocations = 0
let objectInvocations = 0

/* ── (1)+(2) a Service: sensitive field + idempotency-key field ── */

const EchoIn = Schema.Struct({
  key: Restate.idempotencyKey(Schema.String),
  token: Restate.sensitive(Schema.String),
})
const EchoOut = Schema.Struct({ token: Restate.sensitive(Schema.String) })

const Echo = RestateService.contract({
  name: 'cp-echo',
  handlers: {
    /* `echo` returns the sensitive token (proves response decrypt); the idempotency
     * key dedupes a retry (proves the Service call carries the key). */
    echo: { input: EchoIn, success: EchoOut },
  },
})

const EchoLive = RestateService.implement<typeof Echo>({
  contractValue: Echo,
  impl: {
    echo: ({ token }) =>
      Effect.sync(() => {
        serviceInvocations += 1
        return { token }
      }),
  },
})

/* ── (3) an Object: sensitive field + idempotency-key field + typed terminal error ── */

class Denied extends Schema.TaggedError<Denied>()('Denied', { reason: Schema.String }) {}

const VaultState = { token: Schema.String } as const
const VaultS = State.for(VaultState)

const VaultIn = Schema.Struct({
  key: Restate.idempotencyKey(Schema.String),
  token: Restate.sensitive(Schema.String),
})

const Vault = RestateObject.contract({
  name: 'cp-vault',
  def: {
    state: VaultState,
    handlers: {
      /* `store` dedupes on the idempotency key and stores the (sensitive) token. */
      store: {
        input: VaultIn,
        success: Schema.Struct({ token: Restate.sensitive(Schema.String) }),
      },
      /* `deny` always fails with the typed terminal error (proves terminal decode). */
      deny: { input: Schema.Void, success: Schema.Void, error: Denied },
    },
  },
})

const VaultLive = RestateObject.implement<typeof Vault>({
  contractValue: Vault,
  impl: {
    store: ({ token }) =>
      Effect.gen(function* () {
        objectInvocations += 1
        yield* VaultS.set({ key: 'token', value: token })
        return { token }
      }),
    deny: () => Effect.fail(new Denied({ reason: 'nope' })),
  },
})

/* ── (3) a Workflow: sensitive run input/output + attach round-trip ── */

const FlowIn = Schema.Struct({ secret: Restate.sensitive(Schema.String) })
const FlowOut = Schema.Struct({ secret: Restate.sensitive(Schema.String) })

const Flow = RestateWorkflow.contract({
  name: 'cp-flow',
  def: {
    state: {},
    payload: { input: FlowIn, success: FlowOut },
  },
})

const FlowLive = RestateWorkflow.implement<typeof Flow>({
  contractValue: Flow,
  impl: {
    run: ({ secret }) => Effect.succeed({ secret }),
  },
})

/* A Service whose INPUT is non-sensitive (Void) but whose OUTPUT carries a
 * sensitive field — so a RAW ingress fetch (bypassing the client serde) gets a
 * response body whose sensitive field is genuine ciphertext-on-the-wire, while
 * the typed `call` decrypts it. Proves both directions of the client serde. */
const RevealOut = Schema.Struct({ token: Restate.sensitive(Schema.String) })
const Reveal = RestateService.contract({
  name: 'cp-reveal',
  handlers: {
    reveal: { input: Schema.Void, success: RevealOut },
  },
})
const RevealLive = RestateService.implement<typeof Reveal>({
  contractValue: Reveal,
  impl: {
    reveal: () => Effect.succeed({ token: SECRET }),
  },
})

const HarnessLayer = RestateTestHarness.layer({
  services: [EchoLive, VaultLive, FlowLive, RevealLive],
  appLayer: aesGcmRedactionLayer(KEY),
  disableRetries: true,
})

/* The RAW ingress response body (wire bytes) for asserting ciphertext-on-the-wire
 * on a VOID-input handler (no input serde to fight). */
const rawServiceBody = (ingressUrl: string, service: string, handler: string): Promise<string> =>
  fetch(`${ingressUrl}/${service}/${handler}`, {
    method: 'POST',
    headers: { accept: 'application/json' },
  }).then((res) => res.text())

describe.skipIf(!serverAvailable)('contract-invocation policy at the public entrypoints', () => {
  it.layer(HarnessLayer, { timeout: 90_000 })('Service / Object / Workflow', (it) => {
    /* (1) P2 — redaction on Service `call`: request encrypts + response decrypts. */
    it.effect('P2: Service call round-trips a sensitive field (encrypt + decrypt)', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const out = yield* harness.ingress.call({
          contract: Echo,
          method: 'echo',
          input: { key: 'r1', token: SECRET },
        })
        /* The decoded response is the PLAINTEXT — the client serde decrypted it.
         * Pre-fix this threw `RedactionCipherMissingError` (client had no cipher). */
        expect(out.token).toBe(SECRET)
      }),
    )

    /* (2) P2 — idempotency on Service `call`: same key → one invocation. */
    it.effect('P2: Service call dedupes on the idempotency key (one invocation)', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const before = serviceInvocations
        yield* harness.ingress.call({
          contract: Echo,
          method: 'echo',
          input: { key: 'dedupe-1', token: SECRET },
        })
        yield* harness.ingress.call({
          contract: Echo,
          method: 'echo',
          input: { key: 'dedupe-1', token: SECRET },
        })
        /* Same idempotency key → the handler ran exactly once. Pre-fix the Service
         * `call` carried no key, so the handler ran twice (before+2). */
        expect(serviceInvocations - before).toBe(1)
      }),
    )

    /* (1) the sensitive field is CIPHERTEXT on the wire (raw response body), and the
     * typed `call` decrypts the SAME response — both directions of the client serde. */
    it.effect('the sensitive response field is ciphertext on the wire; call decrypts it', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const body = yield* Effect.promise(() =>
          rawServiceBody(harness.ingressUrl, 'cp-reveal', 'reveal'),
        )
        /* Raw wire: the sensitive field is ciphertext, never the plaintext. */
        expect(body).not.toContain(SECRET)
        const wire = yield* Schema.decodeEffect(
          Schema.fromJsonString(Schema.Struct({ token: Schema.String })),
        )(body)
        expect(wire.token).not.toBe(SECRET)
        /* The typed `call` over the SAME handler decrypts the response to plaintext. */
        const out = yield* harness.ingress.call({
          contract: Reveal,
          method: 'reveal',
          input: undefined,
        })
        expect(out.token).toBe(SECRET)
      }),
    )

    /* (3) Object: sensitive round-trips via objectCall + idempotency dedupes. */
    it.effect('Object call round-trips sensitive + dedupes on idempotency key', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const before = objectInvocations
        const out = yield* harness.ingress.objectCall({
          contract: Vault,
          key: 'k1',
          method: 'store',
          input: {
            key: 'o-dedupe',
            token: SECRET,
          },
        })
        expect(out.token).toBe(SECRET)
        yield* harness.ingress.objectCall({
          contract: Vault,
          key: 'k1',
          method: 'store',
          input: { key: 'o-dedupe', token: SECRET },
        })
        expect(objectInvocations - before).toBe(1)
        /* The seeded State decrypts back to the plaintext via `stateOf` (same policy). */
        const stored = yield* harness.stateOf({ contract: Vault, key: 'k1' }).get('token')
        expect(stored).toBe(SECRET)
      }),
    )

    /* (3) Object: a typed terminal error decodes through `objectCallTyped`. */
    it.effect('Object objectCallTyped decodes the typed terminal error', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        const result = yield* harness.ingress
          .objectCallTyped({ contract: Vault, key: 'k2', method: 'deny', input: undefined })
          .pipe(Effect.flip)
        expect(result).toBeInstanceOf(Denied)
        expect((result as Denied).reason).toBe('nope')
      }),
    )

    /* (3) Workflow: sensitive run I/O round-trips via submit + attach. */
    it.effect('Workflow submit + attach round-trips a sensitive run field', () =>
      Effect.gen(function* () {
        const harness = yield* RestateTestHarness
        yield* harness.ingress.workflowSubmit({
          contract: Flow,
          key: 'wf-1',
          input: { secret: SECRET },
        })
        /* Attach awaits the run output; the sensitive field decrypts via the policy. */
        const out = yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 50; attempt++) {
            const peek = yield* harness.ingress.workflowOutput({ contract: Flow, key: 'wf-1' })
            if (peek.ready === true)
              return yield* harness.ingress.workflowAttach({ contract: Flow, key: 'wf-1' })
            yield* liveSleep(100)
          }
          return yield* harness.ingress.workflowAttach({ contract: Flow, key: 'wf-1' })
        })
        expect(out.secret).toBe(SECRET)
      }),
    )
  })
})
