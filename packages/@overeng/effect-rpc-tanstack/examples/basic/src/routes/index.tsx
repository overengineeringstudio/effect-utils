import { Effect } from 'effect'
import { useState } from 'react'

import {
  createEffectRoute,
  type ExitEncoded,
  makeEffectLoaderResult,
} from '../../../../src/router.ts'
import type { User } from '../rpc/api.ts'
import { userClient } from '../rpc/client.ts'

/** Home page route showing user list */
export const Route = createEffectRoute('/')<void, readonly User[], never>({
  loader: () => userClient.listUsers(),
  component: () => {
    const encoded = Route.useLoaderData() as ExitEncoded
    const result = makeEffectLoaderResult<readonly User[], never>(encoded)

    return result.match({
      onSuccess: (initialUsers) => <UserList initialUsers={initialUsers} />,
      onFailure: (error) => (
        <div>
          <h2>Error loading users</h2>
          <p style={{ color: 'red' }}>{String(error)}</p>
        </div>
      ),
    })
  },
})

const UserList = ({ initialUsers }: { initialUsers: readonly User[] }): React.ReactElement => {
  const [users, setUsers] = useState<readonly User[]>(initialUsers)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    setError(null)

    await userClient
      .createUser({ name, email })
      .pipe(
        Effect.tap((newUser) =>
          Effect.sync(() => {
            setUsers([...users, newUser])
            setName('')
            setEmail('')
          }),
        ),
        Effect.catchAll((err) => Effect.sync(() => setError(String(err)))),
        Effect.runPromise,
      )
      .finally(() => setLoading(false))
  }

  return (
    <div>
      <h2>Users</h2>

      <ul data-testid="user-list">
        {users.map((user) => (
          <li key={user.id} data-testid={`user-${user.id}`}>
            <strong>{user.name}</strong> ({user.email})
          </li>
        ))}
      </ul>

      <h3>Create User</h3>
      <form onSubmit={handleCreateUser}>
        <div>
          <label>
            Name:
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              data-testid="name-input"
            />
          </label>
        </div>
        <div>
          <label>
            Email:
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              data-testid="email-input"
            />
          </label>
        </div>
        <button type="submit" disabled={loading} data-testid="submit-button">
          {loading ? 'Creating...' : 'Create User'}
        </button>
        {error && <p style={{ color: 'red' }}>{error}</p>}
      </form>
    </div>
  )
}
