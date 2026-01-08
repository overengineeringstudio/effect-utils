import { createFileRoute } from '@tanstack/react-router'

import { makeHandler } from '../../../../../src/server.ts'
import { UserApi } from '../../rpc/api.ts'
import { UserHandlers } from '../../rpc/server.ts'

const { handler } = makeHandler({ group: UserApi, handlerLayer: UserHandlers })

/** RPC API route handler */
export const Route = createFileRoute('/api/rpc')({
  server: {
    handlers: {
      POST: ({ request }) => handler(request),
    },
  },
})
