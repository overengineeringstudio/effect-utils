# @overeng/effect-rpc-tanstack

Effect RPC integration for TanStack Start using idiomatic `@effect/rpc` patterns.

This package provides a transport layer that bridges `@effect/rpc` with TanStack Start's server function mechanism, enabling type-safe RPC communication in TanStack Start applications.

## Features

- **Idiomatic Effect RPC** - Uses `Rpc.make()`, `RpcGroup.make()`, and `RpcGroup.toLayer()`
- **Type-safe end-to-end** - Full type inference from schema definitions
- **TanStack Start integration** - Seamless integration with `createServerFn`
- **Effect-native** - Handlers return `Effect` values for composition
- **Streaming support** - Stream RPCs are delivered via NDJSON responses

## Installation

```bash
pnpm add @overeng/effect-rpc-tanstack @effect/rpc effect
```

## Usage

### 1. Define your API (shared)

```typescript
// src/rpc/api.ts
import { Rpc, RpcGroup } from '@effect/rpc'
import { Schema } from 'effect'

export class User extends Schema.Class<User>('User')({
  id: Schema.String,
  name: Schema.String,
  email: Schema.String,
}) {}

export class UserNotFoundError extends Schema.TaggedError<UserNotFoundError>()(
  'UserNotFoundError',
  { userId: Schema.String },
) {}

export const GetUser = Rpc.make('GetUser', {
  payload: { id: Schema.String },
  success: User,
  error: UserNotFoundError,
})

export const ListUsers = Rpc.make('ListUsers', {
  success: Schema.Array(User),
})

export const CreateUser = Rpc.make('CreateUser', {
  payload: { name: Schema.String, email: Schema.String },
  success: User,
})

export const UserApi = RpcGroup.make(GetUser, ListUsers, CreateUser)
```

### 2. Implement handlers (server)

```typescript
// src/rpc/server.ts
import { Effect, Ref } from 'effect'
import { User, UserApi, UserNotFoundError } from './api.ts'

const usersRef = Ref.unsafeMake<User[]>([
  new User({ id: '1', name: 'Alice', email: 'alice@example.com' }),
])

export const UserHandlers = UserApi.toLayer(
  Effect.gen(function* () {
    return UserApi.of({
      GetUser: ({ id }) =>
        Effect.gen(function* () {
          const users = yield* Ref.get(usersRef)
          const user = users.find((u) => u.id === id)
          if (!user) {
            return yield* Effect.fail(new UserNotFoundError({ userId: id }))
          }
          return user
        }),

      ListUsers: () => Ref.get(usersRef),

      CreateUser: ({ name, email }) =>
        Effect.gen(function* () {
          const newUser = new User({ id: crypto.randomUUID(), name, email })
          yield* Ref.update(usersRef, (users) => [...users, newUser])
          return newUser
        }),
    })
  }),
)
```

### 3. Create server function

```typescript
// src/rpc/serverFn.ts
import { createServerFn } from '@tanstack/react-start'
import { makeHandler, type RpcMessage } from '@overeng/effect-rpc-tanstack/server'
import { UserApi } from './api.ts'
import { UserHandlers } from './server.ts'

const handler = makeHandler({ group: UserApi, handlerLayer: UserHandlers })

export const userRpc = createServerFn({ method: 'POST' })
  .inputValidator((data: unknown) => data as RpcMessage.FromClientEncoded)
  .handler(
    handler as (ctx: {
      data: RpcMessage.FromClientEncoded
    }) => Promise<ReadonlyArray<object> | Response>,
  )
```

### 4. Create client

```typescript
// src/rpc/client.ts
import { RpcClient, RpcClientError } from '@effect/rpc'
import { Effect } from 'effect'
import { layerProtocol } from '@overeng/effect-rpc-tanstack/client'
import { UserApi, type User, type UserNotFoundError } from './api.ts'
import { userRpc } from './serverFn.ts'

const ProtocolLive = layerProtocol(userRpc)

export const userClient = {
  getUser: (payload: { id: string }): Effect.Effect<User, UserNotFoundError | RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.GetUser(payload)
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),

  listUsers: (): Effect.Effect<readonly User[], RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.ListUsers({})
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),

  createUser: (payload: { name: string; email: string }): Effect.Effect<User, RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.CreateUser(payload)
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),
}
```

### 5. Use in routes

```typescript
// src/routes/index.tsx
import { createFileRoute } from '@tanstack/react-router'
import { Effect } from 'effect'
import { userClient } from '../rpc/client.ts'

export const Route = createFileRoute('/')({
  loader: async () => {
    const users = await userClient.listUsers().pipe(Effect.runPromise)
    return { users }
  },
  component: Home,
})

function Home() {
  const { users } = Route.useLoaderData()
  return (
    <ul>
      {users.map((user) => (
        <li key={user.id}>{user.name}</li>
      ))}
    </ul>
  )
}
```

## API Reference

### Server

#### `makeHandler(options)`

Creates a TanStack Start server function handler from an RpcGroup and its handler layer.

- `options.group` - The `RpcGroup` defining the API
- `options.handlerLayer` - A `Layer` providing the handler implementations
- `options.runtimeLayer` - Optional runtime layer for dependencies

Stream RPCs return a `Response` with `application/x-ndjson`; the client protocol consumes the stream incrementally.

### Client

#### `layerProtocol(serverFn)`

Creates an `RpcClient.Protocol` layer that uses a TanStack Start server function as transport.

- `serverFn` - The TanStack Start server function created with `createServerFn`

## Example

See the [basic example](./examples/basic) for a complete working example.

## License

MIT
