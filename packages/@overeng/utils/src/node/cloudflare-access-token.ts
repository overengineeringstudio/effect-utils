import { execFileSync } from 'node:child_process'

import { Option, Redacted, Schema } from 'effect'

/** Credential-free failure; subprocess output and schema parse causes are deliberately excluded. */
export class AlchemyAccessTokenError extends Schema.TaggedError<AlchemyAccessTokenError>()(
  'AlchemyAccessTokenError',
  {
    operation: Schema.Literals(['read', 'decode', 'publish']),
    message: Schema.String,
  },
) {}

const TokenState = Schema.fromJsonString(
  Schema.Struct({
    resourceType: Schema.Literal('Cloudflare.Access.ServiceToken'),
    attr: Schema.Struct({
      clientId: Schema.NonEmptyString,
      clientSecret: Schema.Struct({ __redacted__: Schema.NonEmptyString }),
    }),
  }),
)
const Credentials = Schema.fromJsonString(
  Schema.Struct({ clientId: Schema.NonEmptyString, clientSecret: Schema.NonEmptyString }),
)

/** Decode Alchemy's encoded service-token state without exposing secrets through parse errors. */
export const decodeAlchemyAccessTokenState = (
  state: Redacted.Redacted<string>,
): Redacted.Redacted<string> => {
  const decoded = Schema.decodeOption(TokenState)(Redacted.value(state))
  if (Option.isNone(decoded)) {
    throw new AlchemyAccessTokenError({
      operation: 'decode',
      message: 'Alchemy Access token state is missing or invalid',
    })
  }
  return Redacted.make(
    Schema.encodeSync(Credentials)({
      clientId: decoded.value.attr.clientId,
      // oxlint-disable-next-line no-underscore-dangle -- Alchemy's encoded Redacted state envelope.
      clientSecret: decoded.value.attr.clientSecret.__redacted__,
    }),
  )
}

/** Publish an Alchemy-owned Access token only through the reviewed credential broker's stdin. */
export const publishAlchemyAccessToken = (options: {
  readonly statePath: string
  readonly config: string
  readonly profile: string
  readonly inventoryId: string
  readonly reason: string
}): void => {
  let state: Redacted.Redacted<string>
  try {
    // Synchronous Node CLI adapter: capture both streams so a failed child cannot print encoded credentials.
    state = Redacted.make(
      execFileSync(
        'pnpm',
        [
          'exec',
          'alchemy',
          'state',
          'read',
          options.statePath,
          '--config',
          options.config,
          '--profile',
          options.profile,
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
      ),
    )
  } catch {
    throw new AlchemyAccessTokenError({
      operation: 'read',
      message: 'Cannot read Alchemy Access token state',
    })
  }
  const credential = decodeAlchemyAccessTokenState(state)
  try {
    execFileSync('op-proxy', ['refs', 'write', options.inventoryId, '--reason', options.reason], {
      input: Redacted.value(credential),
      stdio: ['pipe', 'pipe', 'pipe'],
    })
  } catch {
    // Never rethrow child-process errors: they can retain captured secret-bearing output.
    throw new AlchemyAccessTokenError({
      operation: 'publish',
      message: 'Cannot publish Alchemy Access token through the credential broker',
    })
  }
}
