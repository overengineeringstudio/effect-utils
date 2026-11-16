/** Private service-binding target. It must have no public hostname, route, or preview URL. */
export type AccessGatewayOrigin = {
  readonly fetch: (request: Request) => Promise<Response>
}

/** Standard binding contract for an Access-protected, assets-free gateway Worker. */
export type AccessGatewayEnvironment = {
  readonly ORIGIN: AccessGatewayOrigin
}

/** Native Workers execution context subset, supplied by the platform rather than request headers. */
export type AccessGatewayContext = {
  readonly access?: { readonly aud: string }
}

/** Native Worker fetch signature, restricted to the Access context needed by the gate. */
export type AccessGatewayFetch<TEnvironment> = (
  request: Request,
  environment: TEnvironment,
  context: AccessGatewayContext,
) => Response | Promise<Response>

/**
 * Require platform-authenticated Access context before running a gateway handler.
 *
 * The gateway must not declare Static Assets: their internal router does not
 * propagate ctx.access. Enroll production and preview URLs in Access. This gate
 * also rejects requests during enrollment gaps or out-of-band policy loss.
 */
export const withCloudflareAccess =
  <TEnvironment>(handler: AccessGatewayFetch<TEnvironment>): AccessGatewayFetch<TEnvironment> =>
  // oxlint-disable-next-line overeng/named-args -- Cloudflare's native Worker fetch signature.
  (request, environment, context) => {
    if (context.access === undefined) {
      return new Response('Cloudflare Access authentication required', { status: 403 })
    }
    return handler(request, environment, context)
  }

/** Access-protected gateway for a private ORIGIN service binding with no public routes or URLs. */
export const cloudflareAccessGateway = {
  // oxlint-disable-next-line overeng/named-args -- Cloudflare's native Worker fetch signature.
  fetch: withCloudflareAccess<AccessGatewayEnvironment>((request, environment) =>
    environment.ORIGIN.fetch(request),
  ),
}
