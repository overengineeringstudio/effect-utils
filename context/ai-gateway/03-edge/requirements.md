# AI Gateway Edge — Requirements

## Context

The edge is the server-side authentication, forwarding, and accounting realization of the [public wire contract](../spec.md). These constraints refine [the root requirements](../requirements.md); deployment and credential custody remain outside this public package.

## Assumptions

- **AIG.EDGE-A01 Runtime configuration:** The deployer supplies the upstream origin, consumer names and SHA-256 bearer verifiers, and listener addresses. The upstream implements the shared wire and owns provider access.

## Acceptable Tradeoffs

- **AIG.EDGE-T01 Restart revocation:** Removing a consumer verifier takes effect when the edge is restarted with the new configuration.
- **AIG.EDGE-T02 Usage observation:** The edge observes supplied usage without validating generated application values or inferring missing token counts.

## Requirements

### Must isolate consumer authentication

- **AIG.EDGE-R01 Digest verification** (refines: AIG-R02): Protected routes accept only a bearer matching a configured SHA-256 verifier, compare every verifier with timing-safe digest comparison, and never forward the consumer bearer upstream. Removing one verifier leaves other configured consumers usable.
- **AIG.EDGE-R02 Runtime identity** (refines: AIG-R02, AIG-R09): Consumer labels come only from configuration, with unique names and verifiers; the source contains no deployment-specific identity, credentials, endpoints, or listener ports.

### Must preserve the shared wire

- **AIG.EDGE-R03 Usage forcing** (refines: AIG-R03): Streaming chat forces `stream_options.include_usage` to true while preserving other request fields and stream options. Missing usage produces no token metric.
- **AIG.EDGE-R04 Faithful forwarding** (refines: AIG-R04, AIG-R05, AIG-R07, AIG-R10, AIG-R11): The edge preserves model IDs, structured formats, tool exchanges, native decision payloads, upstream statuses and response bytes, including SSE error frames and incomplete streams. It strips hop-by-hop headers in each direction.
- **AIG.EDGE-R05 Local errors** (refines: AIG-R10): Invalid bearer receives 401 with `authentication_error`; invalid JSON or missing model receives 400 with `gateway_error`; upstream transport failure receives 502 with `gateway_error`. Local error envelopes contain `message`, `type`, and null `code`.

### Must account without exposing credentials

- **AIG.EDGE-R06 Consumer accounting** (refines: AIG-R03, AIG-R09): Authenticated requests are counted by configured consumer, bounded model label and status, with duration through body consumption. Only upstream 2xx responses may retain the request model as a label; non-2xx responses use `_rejected`. Distinct retained model labels are capped by runtime configuration (default 64), with new models beyond the cap using `_other`. Token counts and durations use the same bounded labels. Forwarded model IDs remain unchanged. Unauthenticated traffic has no consumer attribution; secrets, request bodies and provider cost are not metric labels.
- **AIG.EDGE-R07 Shared replay** (refines: AIG-R04, AIG-R10): Tests replay all shared conformance cases on supported endpoints through a real edge listener against a fake upstream, asserting authentication, forced usage, error shapes and unchanged response bytes. Any unsupported case is named with its reason rather than silently skipped.
