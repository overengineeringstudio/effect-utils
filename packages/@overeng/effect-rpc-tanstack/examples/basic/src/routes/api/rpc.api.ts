import { createAPIFileRoute } from '@tanstack/start-api-routes'

import { makeHandler } from '../../../../../src/server.ts'
import { UserApi } from '../../rpc/api.ts'
import { UserHandlers } from '../../rpc/server.ts'

const { handler } = makeHandler({ group: UserApi, handlerLayer: UserHandlers })

/** RPC API route handler */
export const APIRoute = createAPIFileRoute('/api/rpc')({
  POST: ({ request }) => handler(request),
})
