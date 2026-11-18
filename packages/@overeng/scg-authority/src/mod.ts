import { Database } from 'bun:sqlite'
import { randomUUID, type KeyObject } from 'node:crypto'

import { Schema } from 'effect'

import * as Protocol from '@overeng/scg-protocol'

export interface Signer {
  readonly keyId: string
  readonly principalId: string
  readonly surfaceId: string
}
export interface SignerRegistration extends Signer {
  readonly publicKey: KeyObject
}
export interface CallerRegistration extends Protocol.Owner {
  readonly publicKey: KeyObject
}
export interface CatalogDefinition {
  readonly catalog: Protocol.Catalog
  readonly admit: (action: Protocol.Action) => {
    readonly action: Protocol.Action
    readonly fields: readonly { readonly label: string; readonly value: string }[]
    readonly sensitivity: 'low' | 'sensitive'
  }
}
export interface ExecutorResult {
  readonly state: 'succeeded' | 'failed' | 'unknown'
  readonly result: string
}
export interface AuthorityOptions {
  readonly dbPath: string
  readonly catalog: CatalogDefinition
  readonly authority: { readonly keyId: string; readonly privateKey: KeyObject }
  readonly signers: readonly SignerRegistration[]
  readonly callers: readonly CallerRegistration[]
  readonly audience: string
  readonly release: string
  readonly executor: (dispatch: Protocol.SignedDispatch) => Promise<ExecutorResult>
  readonly now?: () => number
  readonly pendingTtlMs?: number
  readonly authWindowMs?: number
}
export interface Authority {
  readonly submit: (owner: Protocol.Owner, submitted: Protocol.Submitted) => Protocol.Status
  readonly status: (owner: Protocol.Owner, id: string) => Protocol.Status
  readonly signerStatus: (signer: Signer, id: string) => Protocol.Status
  readonly pending: (signer: Signer, id: string) => Protocol.SignedPending
  readonly decide: (decision: Protocol.SignedDecision) => Promise<Protocol.Status>
  readonly sync: (signer: Signer, cursor: number) => Protocol.Sync
  readonly authenticate: (
    input: unknown,
    method: string,
    path: string,
    body: unknown,
  ) => { owner: Protocol.Owner } | { signer: Signer }
  readonly catalog: () => Protocol.SignedCatalog
  readonly health: (nonce?: string) => Protocol.Health
  readonly drain: () => Promise<void>
  readonly close: () => void
}
export class AuthorityError extends Error {
  readonly _tag = 'AuthorityError'
  readonly code: string
  readonly httpStatus: number
  constructor(code: string, httpStatus = 400) {
    super(code)
    this.code = code
    this.httpStatus = httpStatus
  }
}
interface ExecutionRow {
  id: string
  owner: string
  owner_key: string
  request_digest: string
  action_digest: string
  admitted: string
  pending: string
  state: Protocol.Status['state']
  result: string | null
  result_digest: string | null
  decision_digest: string | null
}
interface OutboxRow {
  cursor: number
  execution_id: string
  state: Protocol.Status['state']
  request_digest: string
}
const epoch = 'scg-experiment-v1' as const
const fail = (code: string, status = 400): never => {
  throw new AuthorityError(code, status)
}
const decode = <TSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: TSchema,
  input: unknown,
): TSchema['Type'] => {
  try {
    return Schema.decodeUnknownSync(schema, { onExcessProperty: 'error' })(input)
  } catch {
    return fail('invalid-payload')
  }
}
const decodeJson = <TSchema extends Schema.ConstraintDecoder<unknown>>(
  schema: TSchema,
  text: string,
): TSchema['Type'] => {
  try {
    return Protocol.decodeJson(schema, text)
  } catch {
    return fail('invalid-payload')
  }
}

/** A single authority owns a database. Open only after the previous process has stopped. */
export const createAuthority = (options: AuthorityOptions): Authority => {
  const now = options.now ?? Date.now
  const ttl = options.pendingTtlMs ?? 300_000
  const authWindow = options.authWindowMs ?? 60_000
  if (
    !Number.isSafeInteger(ttl) ||
    ttl <= 0 ||
    !Number.isSafeInteger(authWindow) ||
    authWindow <= 0
  )
    fail('invalid-duration')
  if (options.authority.privateKey.asymmetricKeyType !== 'ed25519') fail('invalid-authority-key')
  const signers = new Map(options.signers.map((entry) => [entry.keyId, entry]))
  const callers = new Map(options.callers.map((entry) => [entry.keyId, entry]))
  if (
    signers.size !== options.signers.length ||
    callers.size !== options.callers.length ||
    [...signers.keys()].some((key) => callers.has(key))
  )
    fail('duplicate-key-id')
  for (const entry of [...options.signers, ...options.callers]) {
    if (entry.publicKey.asymmetricKeyType !== 'ed25519') fail('invalid-registry-key')
  }
  const catalogPayload = decode(Protocol.Catalog, options.catalog.catalog)
  const signedCatalog = Protocol.signPayload(
    'catalog',
    catalogPayload,
    options.authority.keyId,
    options.authority.privateKey,
  )
  const catalogDigest = Protocol.digest(catalogPayload)
  const bootNonce = randomUUID()
  const db = new Database(options.dbPath, { create: true, strict: true })
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS executions (
      id TEXT PRIMARY KEY, owner TEXT NOT NULL, owner_key TEXT NOT NULL, idempotency_key TEXT NOT NULL,
      request_digest TEXT NOT NULL, action_digest TEXT NOT NULL, admitted TEXT NOT NULL, pending TEXT NOT NULL,
      state TEXT NOT NULL, result TEXT, result_digest TEXT, decision_digest TEXT,
      UNIQUE(owner, owner_key, idempotency_key));
    CREATE TABLE IF NOT EXISTS outbox (cursor INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL, state TEXT NOT NULL, request_digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS audit (sequence INTEGER PRIMARY KEY AUTOINCREMENT, digest TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS auth_nonces (key_id TEXT NOT NULL, nonce TEXT NOT NULL, expires_at INTEGER NOT NULL,
      PRIMARY KEY(key_id, nonce));`)
  let closed = false
  const tasks = new Set<Promise<void>>()
  const transaction = <TValue>(run: () => TValue): TValue => db.transaction(run).immediate()
  const row = (id: string): ExecutionRow =>
    db.query<ExecutionRow, [string]>('SELECT * FROM executions WHERE id = ?').get(id) ??
    fail('not-found', 404)
  const audit = (value: unknown): void => {
    db.query('INSERT INTO audit(digest) VALUES (?)').run(Protocol.digest(value))
  }
  const emit = (execution: ExecutionRow, state: Protocol.Status['state']): void => {
    db.query('INSERT INTO outbox(execution_id,state,request_digest) VALUES (?,?,?)').run(
      execution.id,
      state,
      execution.request_digest,
    )
    audit({ executionId: execution.id, requestDigest: execution.request_digest, state })
  }
  const terminal = (
    execution: ExecutionRow,
    state: Protocol.Status['state'],
    result?: string,
  ): void => {
    db.query('UPDATE executions SET state=?,result=?,result_digest=? WHERE id=?').run(
      state,
      result ?? null,
      result === undefined ? null : Protocol.digest(result),
      execution.id,
    )
    emit(execution, state)
  }
  transaction(() => {
    for (const execution of db
      .query<ExecutionRow, []>("SELECT * FROM executions WHERE state='reserved'")
      .all())
      terminal(execution, 'unknown')
  })
  const authorizeSigner = (signer: Signer): SignerRegistration => {
    const pinned = signers.get(signer.keyId)
    if (
      pinned === undefined ||
      pinned.principalId !== signer.principalId ||
      pinned.surfaceId !== signer.surfaceId
    )
      fail('unauthorized-signer', 403)
    return pinned ?? fail('unauthorized-signer', 403)
  }
  const authorizeOwner = (owner: Protocol.Owner): void => {
    const pinned = callers.get(owner.keyId)
    if (pinned === undefined || pinned.identity !== owner.identity) fail('unauthorized-owner', 403)
  }
  const expire = (execution: ExecutionRow): ExecutionRow => {
    if (execution.state === 'pending') {
      const pending = decode(Protocol.Pending, JSON.parse(execution.pending))
      if (now() >= pending.expiresAt) {
        terminal(execution, 'expired')
        return row(execution.id)
      }
    }
    return execution
  }
  const toStatus = (execution: ExecutionRow): Protocol.Status => ({
    executionId: execution.id,
    state: execution.state,
    requestDigest: execution.request_digest,
    ...(execution.result === null ? {} : { result: execution.result }),
    ...(execution.result_digest === null ? {} : { resultDigest: execution.result_digest }),
    ...(execution.decision_digest === null ? {} : { decisionDigest: execution.decision_digest }),
  })
  const signedPending = (execution: ExecutionRow): Protocol.SignedPending =>
    Protocol.signPayload(
      'pending',
      decode(Protocol.Pending, JSON.parse(execution.pending)),
      options.authority.keyId,
      options.authority.privateKey,
    )
  const submit = (ownerInput: Protocol.Owner, input: Protocol.Submitted): Protocol.Status => {
    const owner = decode(Protocol.Owner, ownerInput)
    authorizeOwner(owner)
    const submitted = decode(Protocol.Submitted, input)
    const requestDigest = Protocol.digest(submitted)
    return transaction(() => {
      const previous = db
        .query<ExecutionRow, [string, string, string]>(
          'SELECT * FROM executions WHERE owner=? AND owner_key=? AND idempotency_key=?',
        )
        .get(owner.identity, owner.keyId, submitted.idempotencyKey)
      if (previous !== null) {
        if (previous.request_digest !== requestDigest) fail('idempotency-conflict', 409)
        return toStatus(expire(previous))
      }
      if (submitted.catalogDigest !== catalogDigest) fail('stale-catalog', 409)
      const admission = options.catalog.admit(submitted.action)
      const action = decode(Protocol.Action, admission.action)
      const entry = catalogPayload.entries.find((item) => item.commandId === action.commandId)
      if (
        entry === undefined ||
        (entry.sensitivity === 'sensitive' && admission.sensitivity !== 'sensitive')
      )
        fail('invalid-admission')
      const sensitivity =
        admission.sensitivity === 'sensitive' || submitted.claimed.sensitivity === 'sensitive'
          ? 'sensitive'
          : 'low'
      const executionId = randomUUID()
      const issuedAt = now()
      const admitted: Protocol.Admitted = decode(Protocol.Admitted, {
        submitted,
        owner,
        executionId,
        requestDigest,
        actionDigest: Protocol.digestAction(submitted.catalogDigest, action),
        admittedAt: issuedAt,
        review: {
          command: action.commandId,
          account: action.account,
          sensitivity,
          fields: admission.fields,
          agentClaim: submitted.claimed.intent,
        },
      })
      const pending: Protocol.Pending = decode(Protocol.Pending, {
        epoch,
        kind: 'pending',
        executionId,
        requestDigest,
        actionDigest: admitted.actionDigest,
        review: admitted.review,
        options: [
          {
            optionId: 'allow-once',
            kind: 'allow-once',
            statement: 'Allow this exact action once.',
          },
          { optionId: 'deny', kind: 'deny', statement: 'Deny this action.' },
        ],
        issuedAt,
        expiresAt: issuedAt + ttl,
      })
      // The immutable admitted action is stored separately from the caller's submitted bytes.
      db.query(`INSERT INTO executions(id,owner,owner_key,idempotency_key,request_digest,action_digest,admitted,pending,state)
        VALUES (?,?,?,?,?,?,?,?, 'pending')`).run(
        executionId,
        owner.identity,
        owner.keyId,
        submitted.idempotencyKey,
        requestDigest,
        admitted.actionDigest,
        Protocol.canonical({ admitted, action }),
        Protocol.canonical(pending),
      )
      audit({
        executionId,
        owner,
        requestDigest,
        actionDigest: admitted.actionDigest,
        pendingDigest: Protocol.digest(pending),
      })
      return toStatus(row(executionId))
    })
  }
  const status = (owner: Protocol.Owner, id: string): Protocol.Status => {
    authorizeOwner(owner)
    return transaction(() => {
      const execution = row(id)
      if (execution.owner !== owner.identity || execution.owner_key !== owner.keyId)
        fail('not-found', 404)
      return toStatus(expire(execution))
    })
  }
  const signerStatus = (signer: Signer, id: string): Protocol.Status => {
    authorizeSigner(signer)
    return transaction(() => {
      const { result: _result, ...receipt } = toStatus(expire(row(id)))
      return receipt
    })
  }
  const pending = (signer: Signer, id: string): Protocol.SignedPending => {
    authorizeSigner(signer)
    return transaction(() => {
      const execution = expire(row(id))
      if (execution.state !== 'pending') fail('not-pending', 409)
      return signedPending(execution)
    })
  }
  const decide = async (input: Protocol.SignedDecision): Promise<Protocol.Status> => {
    const signed = decode(Protocol.SignedDecision, input)
    const decision = signed.payload
    const pinned = authorizeSigner({
      keyId: signed.keyId,
      principalId: decision.principalId,
      surfaceId: decision.surfaceId,
    })
    if (!Protocol.verifyPayload('decision', signed, pinned.publicKey))
      fail('invalid-signature', 403)
    if (decision.optionId !== 'allow-once' && decision.optionId !== 'deny')
      fail('unsupported-option')
    const outcome = transaction(() => {
      const execution = expire(row(decision.executionId))
      const pendingPayload = decode(Protocol.Pending, JSON.parse(execution.pending))
      if (
        decision.pendingDigest !== Protocol.digest(pendingPayload) ||
        !pendingPayload.options.some(
          (option) => option.optionId === decision.optionId && option.kind === decision.optionId,
        )
      )
        fail('decision-mismatch', 409)
      if (
        decision.decidedAt < pendingPayload.issuedAt ||
        decision.decidedAt > now() ||
        decision.decidedAt >= pendingPayload.expiresAt
      )
        fail('invalid-decision-time')
      if (execution.state !== 'pending') return { status: toStatus(execution), dispatch: undefined }
      db.query('UPDATE executions SET decision_digest=? WHERE id=?').run(
        Protocol.digest(signed),
        execution.id,
      )
      audit({ decisionDigest: Protocol.digest(signed) })
      if (decision.optionId === 'deny') {
        terminal(execution, 'denied')
        return { status: toStatus(row(execution.id)), dispatch: undefined }
      }
      const stored = decode(
        Schema.Struct({ admitted: Protocol.Admitted, action: Protocol.Action }),
        JSON.parse(execution.admitted),
      )
      const action = decode(Protocol.Action, stored.action)
      if (
        Protocol.digestAction(stored.admitted.submitted.catalogDigest, action) !==
        execution.action_digest
      )
        fail('corrupt-admitted-action', 500)
      const dispatch: Protocol.SignedDispatch = Protocol.signPayload(
        'dispatch',
        {
          epoch,
          kind: 'dispatch',
          executionId: execution.id,
          action,
          catalogDigest: stored.admitted.submitted.catalogDigest,
          actionDigest: execution.action_digest,
          requestDigest: execution.request_digest,
          audience: options.audience,
          reservationId: randomUUID(),
          deadline: pendingPayload.expiresAt,
        },
        options.authority.keyId,
        options.authority.privateKey,
      )
      terminal(execution, 'reserved')
      audit({ decisionDigest: Protocol.digest(signed), dispatchDigest: Protocol.digest(dispatch) })
      return { status: toStatus(row(execution.id)), dispatch }
    })
    if (outcome.dispatch !== undefined) {
      const dispatch = outcome.dispatch
      // Promise boundary is mandatory: no provider runs inside the grant transaction.
      const task = Promise.resolve()
        .then(() => (closed ? undefined : options.executor(dispatch)))
        .then((result) => {
          if (closed || result === undefined) return
          if (
            (result.state !== 'succeeded' &&
              result.state !== 'failed' &&
              result.state !== 'unknown') ||
            typeof result.result !== 'string'
          )
            fail('invalid-executor-result')
          transaction(() => {
            const execution = row(dispatch.payload.executionId)
            if (execution.state === 'reserved') terminal(execution, result.state, result.result)
          })
        })
        .catch(() => {
          if (!closed)
            transaction(() => {
              const execution = row(dispatch.payload.executionId)
              if (execution.state === 'reserved') terminal(execution, 'unknown')
            })
        })
      tasks.add(task)
      void task.finally(() => tasks.delete(task))
    }
    return outcome.status
  }
  const sync = (signer: Signer, cursor: number): Protocol.Sync => {
    authorizeSigner(signer)
    if (!Number.isSafeInteger(cursor) || cursor < 0) fail('invalid-cursor')
    return transaction(() => {
      const active = db
        .query<ExecutionRow, []>("SELECT * FROM executions WHERE state='pending' ORDER BY id")
        .all()
        .map(expire)
      const events = db
        .query<OutboxRow, [number]>('SELECT * FROM outbox WHERE cursor > ? ORDER BY cursor')
        .all(cursor)
      const latest =
        db
          .query<{ cursor: number }, []>('SELECT COALESCE(MAX(cursor),0) AS cursor FROM outbox')
          .get()?.cursor ?? 0
      if (cursor > latest) fail('invalid-cursor')
      return {
        cursor: latest,
        pending: active.filter((execution) => execution.state === 'pending').map(signedPending),
        terminal: events.map((event) => ({
          cursor: event.cursor,
          executionId: event.execution_id,
          state: event.state,
          requestDigest: event.request_digest,
        })),
      }
    })
  }
  const authenticate = (
    input: unknown,
    method: string,
    path: string,
    body: unknown,
  ): { owner: Protocol.Owner } | { signer: Signer } => {
    const signed = decode(Protocol.SignedAuthRequest, input)
    const auth = signed.payload
    const caller = callers.get(signed.keyId)
    const signer = signers.get(signed.keyId)
    const pinned = caller ?? signer
    if (pinned === undefined || !Protocol.verifyPayload('auth-request', signed, pinned.publicKey))
      fail('invalid-authentication', 401)
    if (
      auth.method !== method ||
      auth.path !== path ||
      auth.bodyDigest !== Protocol.digest(body) ||
      Math.abs(now() - auth.issuedAt) > authWindow
    )
      fail('invalid-authentication', 401)
    transaction(() => {
      db.query('DELETE FROM auth_nonces WHERE expires_at < ?').run(now())
      const seen = db
        .query('SELECT 1 FROM auth_nonces WHERE key_id=? AND nonce=?')
        .get(signed.keyId, auth.nonce)
      if (seen !== null) fail('replayed-authentication', 401)
      db.query('INSERT INTO auth_nonces(key_id,nonce,expires_at) VALUES (?,?,?)').run(
        signed.keyId,
        auth.nonce,
        auth.issuedAt + authWindow,
      )
    })
    if (caller !== undefined) return { owner: { identity: caller.identity, keyId: caller.keyId } }
    if (signer !== undefined)
      return {
        signer: {
          keyId: signer.keyId,
          principalId: signer.principalId,
          surfaceId: signer.surfaceId,
        },
      }
    return fail('invalid-authentication', 401)
  }
  return {
    submit,
    status,
    signerStatus,
    pending,
    decide,
    sync,
    authenticate,
    catalog: (): Protocol.SignedCatalog => signedCatalog,
    health: (nonce?: string): Protocol.Health =>
      decode(Protocol.Health, {
        epoch,
        release: options.release,
        catalogDigest,
        bootNonce,
        ready: !closed,
        ...(nonce === undefined ? {} : { nonce }),
      }),
    drain: async (): Promise<void> => {
      await Promise.all([...tasks])
    },
    close: (): void => {
      if (!closed) {
        closed = true
        db.close()
      }
    },
  }
}

/** Request authentication binds the exact path including query and the parsed JSON body (null for GET). */
export const createHttpHandler =
  (authority: Authority): ((request: Request) => Promise<Response>) =>
  async (request) => {
    try {
      const url = new URL(request.url)
      if (request.method === 'GET' && url.pathname === Protocol.routes.health) {
        return Response.json(authority.health(url.searchParams.get('nonce') ?? undefined), {
          headers: { 'cache-control': 'no-store' },
        })
      }
      const path = `${url.pathname}${url.search}`
      const text = request.method === 'GET' ? undefined : await request.text()
      const body: unknown = text === undefined ? null : decodeJson(Schema.Unknown, text)
      const header = request.headers.get('x-scg-auth') ?? fail('missing-authentication', 401)
      const identity = authority.authenticate(
        decodeJson(Protocol.SignedAuthRequest, header),
        request.method,
        path,
        body,
      )
      const routes = Protocol.routes
      let result: unknown
      if (request.method === 'GET' && url.pathname === routes.catalog) result = authority.catalog()
      else if (request.method === 'POST' && url.pathname === routes.submit && 'owner' in identity)
        result = authority.submit(identity.owner, decode(Protocol.Submitted, body))
      else if (
        request.method === 'GET' &&
        url.pathname.startsWith(routes.status) &&
        'owner' in identity
      )
        result = authority.status(
          identity.owner,
          decodeURIComponent(url.pathname.slice(routes.status.length)),
        )
      else if (
        request.method === 'GET' &&
        url.pathname.startsWith(routes.status) &&
        'signer' in identity
      )
        result = authority.signerStatus(
          identity.signer,
          decodeURIComponent(url.pathname.slice(routes.status.length)),
        )
      else if (
        request.method === 'GET' &&
        url.pathname.startsWith(routes.pending) &&
        'signer' in identity
      )
        result = authority.pending(
          identity.signer,
          decodeURIComponent(url.pathname.slice(routes.pending.length)),
        )
      else if (
        request.method === 'POST' &&
        url.pathname === routes.decision &&
        'signer' in identity
      ) {
        const signed = decode(Protocol.SignedDecision, body)
        if (signed.keyId !== identity.signer.keyId) fail('signer-mismatch', 403)
        result = await authority.decide(signed)
      } else if (request.method === 'GET' && url.pathname === routes.sync && 'signer' in identity)
        result = authority.sync(identity.signer, Number(url.searchParams.get('cursor') ?? '0'))
      else fail('forbidden-route', 403)
      return Response.json(result)
    } catch (error) {
      if (error instanceof Protocol.ProtocolError)
        return Response.json({ error: error.code }, { status: 400 })
      if (error instanceof AuthorityError)
        return Response.json({ error: error.code }, { status: error.httpStatus })
      if (error instanceof SyntaxError || error instanceof URIError)
        return Response.json({ error: 'invalid-payload' }, { status: 400 })
      return Response.json({ error: 'internal-error' }, { status: 500 })
    }
  }
