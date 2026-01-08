# @overeng/effect-rpc-tanstack

Effect RPC integration for TanStack Start using idiomatic `@effect/rpc` patterns.

This package provides a transport layer that bridges `@effect/rpc` with TanStack Start's API routes, enabling type-safe RPC communication in TanStack Start applications.

## Features

- **Idiomatic Effect RPC** - Uses `Rpc.make()`, `RpcGroup.make()`, and `RpcGroup.toLayer()`
- **Type-safe end-to-end** - Full type inference from schema definitions
- **TanStack Start integration** - Seamless integration with API routes
- **Effect-native** - Handlers return `Effect` values for composition
- **SSR support** - Effect-native route loaders with Exit serialization

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
  Effect.succeed(
    UserApi.of({
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
    }),
  ),
)
```

### 3. Create API route

```typescript
// src/routes/api/rpc.ts
import { createFileRoute } from '@tanstack/react-router'
import { makeHandler } from '@overeng/effect-rpc-tanstack/server'
import { UserApi } from '../../rpc/api.ts'
import { UserHandlers } from '../../rpc/server.ts'

const { handler } = makeHandler({ group: UserApi, handlerLayer: UserHandlers })

export const Route = createFileRoute('/api/rpc')({
  server: {
    handlers: {
      POST: ({ request }) => handler(request),
    },
  },
})
```

### 4. Create client

```typescript
// src/rpc/client.ts
import { RpcClient, type RpcClientError } from '@effect/rpc'
import { Effect } from 'effect'
import { layerClient } from '@overeng/effect-rpc-tanstack/client'
import { UserApi, type User, type UserNotFoundError } from './api.ts'

const ProtocolLive = layerClient({ url: '/api/rpc' })

export const userClient = {
  getUser: (payload: { id: string }): Effect.Effect<User, UserNotFoundError | RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.GetUser(payload)
    }).pipe(Effect.provide(ProtocolLive), Effect.scoped),

  listUsers: (): Effect.Effect<readonly User[], RpcClientError.RpcClientError> =>
    Effect.gen(function* () {
      const client = yield* RpcClient.make(UserApi)
      return yield* client.ListUsers()
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

### Effect-native Route Loaders

For Effect-native loaders with proper error handling and SSR serialization:

```typescript
// src/routes/users.$id.tsx
import { createEffectRoute, makeEffectLoaderResult, type ExitEncoded } from '@overeng/effect-rpc-tanstack/router'
import { userClient } from '../rpc/client.ts'
import { type User, UserNotFoundError } from '../rpc/api.ts'

export const Route = createEffectRoute('/users/$id')<{ id: string }, User, UserNotFoundError>({
  loader: ({ params }) => userClient.getUser({ id: params.id }),
  component: () => {
    const encoded = Route.useLoaderData() as ExitEncoded
    const result = makeEffectLoaderResult<User, UserNotFoundError>(encoded)

    return result.match({
      onSuccess: (user) => <div>{user.name}</div>,
      onFailure: (error) => <div>Error: {error.userId}</div>,
    })
  },
})
```

## API Reference

### Server

#### `makeHandler(options)`

Creates a web handler for TanStack Start API routes from an RpcGroup and its handler layer.

- `options.group` - The `RpcGroup` defining the API
- `options.handlerLayer` - A `Layer` providing the handler implementations
- `options.serializationLayer` - Optional serialization layer (defaults to NDJSON)

Returns `{ handler, dispose }` where `handler` accepts a `Request` and returns a `Response`.

#### `makeHandlerWithRuntime(options)`

Same as `makeHandler` but with an additional `runtimeLayer` for dependency injection.

### Client

#### `layerClient(options)`

Creates an `RpcClient.Protocol` layer that uses HTTP transport.

- `options.url` - The URL of the RPC endpoint
- `options.transformClient` - Optional HTTP client transformer
- `options.httpClientLayer` - Optional custom HTTP client layer
- `options.serializationLayer` - Optional serialization layer (defaults to NDJSON)

### Router

#### `createEffectRoute(path)(options)`

Creates an Effect-native file route with typed loaders.

- `options.loader` - Effect-returning loader function
- `options.loaderLayer` - Optional layer for loader dependencies
- `options.component` - React component for the route

#### `makeEffectLoaderResult(encoded)`

Creates a result object from encoded Exit data with pattern matching helpers.

## Example

See the [basic example](./examples/basic) for a complete working example.

## License

MIT
