# 0001 - Effect 4 public-seam lifecycle prototype (rc.115)

Non-normative evidence for [../01-core/spec.md](../01-core/spec.md) and
[../.decisions/0001-public-seams-combine-middleware-and-protocol.md](../.decisions/0001-public-seams-combine-middleware-and-protocol.md).

## Question

Effect `4.0.0-rc.115` exposes enough public RPC surface to observe a complete,
honest lifecycle by combining server `RpcMiddleware` with client/server
`Protocol` decorators, without private imports.

## Method

A disposable one-file in-memory TypeScript prototype was executed against Effect
source revision `755e863a793e5621183e7992cb3f85d29030ad7b` (`4.0.0-rc.115`). It
used public `RpcClient.Protocol.make`, `RpcServer.Protocol.make`,
`RpcSerialization.json.codecFor`, `RpcMiddleware`, and public `RpcGroup`/
`RpcSchema` APIs. It exercised unary success, typed failure, finite stream,
`Stream.take(1)` cancellation, synthetic client Protocol send failure, and a
fatal handler defect. The temporary prototype was removed after execution; it
was not a tracked test or persistent artifact.

## Result

| Scenario               | Observed public-seam facts                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------ |
| unary success          | `Request → Exit.Success`; server middleware saw one successful terminal                          |
| typed failure          | `Request → Exit.Failure(Fail)`; middleware saw correlated typed failure                          |
| finite stream          | `Request → Chunk([1,2,3]) → Ack → Exit`; middleware saw one successful terminal                  |
| cancellation           | `Request → Chunk([1]) → Ack → Interrupt → Exit`; middleware saw an interrupted terminal          |
| synthetic send failure | client Protocol send failed while request ID was available; server middleware was not entered    |
| fatal handler defect   | middleware saw a correlated die; Protocol emitted only an uncorrelated connection-level `Defect` |

The probe passed its request-correlation and single-terminal invariants. It also
confirmed public metadata traversal: `RpcGroup` preserved RPC values,
annotations, and public stream element/error schemas.

## Conclusion

The hypothesis is supported for the exercised public rc.115 seams: combined
middleware and Protocol decoration can observe the required complementary
lifecycle facts without private imports.

## VRS Impact

The combined public seams are sufficient for the requested core boundary. The
fatal-defect correlation gap is real and requires connection-scoped uncertainty,
not guessed request attribution. The probe did not cover byte framing,
notifications, disconnect/EOF, multiple clients, transferables, or a real
HTTP/socket transport; those remain transport conformance work rather than
claimed prototype coverage.
