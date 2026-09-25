# 0005 - Treat server-side protocol EOF as a transport fact

Status: accepted

## Context

`RPCX.CORE-R15` originally made every uncorrelated EOF a connection fault that
marked each active request on that connection `uncertain`. Effect's HTTP server
protocol (`RpcServer.makeProtocolWithHttpEffect`) delivers `Eof` after every
decoded request batch, before any response is produced. Adopting the explorer
in ServiceHub over HTTP showed every RPC ending `uncertain`: the fault forced
the shared coordinator lifecycle to terminal, so neither the middleware nor
the protocol terminal was admitted.

## Options

| Option                                             | Result   | Reason                                                                  |
| -------------------------------------------------- | -------- | ----------------------------------------------------------------------- |
| Keep EOF as a fault on both sides                  | Rejected | Every HTTP RPC misreports as `uncertain`; terminal correlation is lost. |
| Host flag selecting EOF semantics                  | Rejected | Hosts must know transport internals; the wrong default ships the bug.   |
| Server EOF is a transport fact; client EOF a fault | Selected | Matches protocol meaning on both sides without host configuration.      |

## Decision

Server-side `Eof` creates no event and leaves every in-flight request
untouched, like `Ping`. Client-side EOF keeps connection-fault semantics
because no further responses can arrive on that channel. The principal
confirmed the requirement amendment (session decision q3).

## Evidence and Argument

Effect's HTTP protocol calls `writeRequest(id, constEof)` unconditionally after
the batch loop, while responses are still queued. On the server, EOF means
"this body carries no further client messages." Real loss is reported
separately: the protocol finalizer fires `disconnects` and synthesizes an
`Interrupt` for each pending request. The ServiceHub integration run observed
`RequestObserved → ConnectionFault(eof)` with zero `TerminalObserved` in both
request-observation modes. With the change, the same run records `succeeded`.
A protocol unit test pins request → `Eof` → `Exit` to `succeeded` with no
`ConnectionFault`.

## Consequences

- `RPCX.CORE-R15` scopes EOF uncertainty to the client side.
- The server decorator classifies `Eof` like `Ping`.
- Unsolicited server disconnects remain unobservable through the public seam,
  as specified.
