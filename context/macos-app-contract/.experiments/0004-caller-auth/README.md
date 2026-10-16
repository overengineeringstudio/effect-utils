# Experiment: audit-token Unix-socket caller authentication

Publication note: host labels, user-specific paths, temporary-directory roots
and keychain paths in this directory were mechanically replaced with generic
placeholders (`headless CI Mac`/`headless-ci-mac`, `interactive Mac`/
`interactive-mac`, `<worktree>`, `<keychain>`, `<temporary-directory>`), and
retained receipt filenames were renamed to match. Numeric values, hashes, exit
codes and observed results are unmodified.

## Final remote verdict: PASS bounded fixture matrix

The headless CI Mac run completed all six cases. `SecCodeCreateWithAuditToken` and
`csops_audittoken` both resolved on the actual host; the public fallback was
not used. Only the authorized live cdhash passed (`check_status=0`). Rejected
cdhash failed `-67050`; exited client failed `100003`; both actual exec cases
and the synthetic wrong-incarnation token failed `-67065`. All stale/exit
freshness checks returned `-1` / `ESRCH` (errno 3), while actual exec peers
remained live on the inherited socket. Primitive validation itself rejected
these cases, not merely the added liveness/freshness admission checks.

All 17 pre-step CI checks were idle. Audit flags were `0x5020`, window list
explicitly unavailable; both signing argv were asserted ad-hoc-only. The
temporary native build tree and all six private socket directories were
removed. `evidence.json` preserves every actual code/API/token/decision log.

This PASS includes a **synthetic same-PID/wrong-incarnation** negative, not
observed kernel PID recycling. No process-churn wraparound or other-UID negative
was run. It is not an atomic future-message authorization guarantee.

The headless gate reuses the merged ctl integration's `no_ui_session` helper
(#1834). Before every step and during monitoring, `getaudit_addr` must succeed
with GRAPHIC `0x10` and CONSOLE `0x2000` both absent. NULL CGWindowList is
recorded as **unavailable**, never zero. Audit failures or UI-capable session
transitions fail closed. The Manager accepted this no-UI proof for SSH.

## Authorized scope

The Manager authorized **ad-hoc clients on the headless CI Mac over SSH only**, after E5
and E3. All builds and subjects run at `nice -n 19`; shared `../safety.py` waits
for no Runner.Worker or CI job processes before every step. CGWindowList detects
any new visible window and aborts without touching a dialog. Every codesign
argv is logged and asserted by that single shared function to contain `-s -`
and no keychain or named identity. No certificate/trust/keychain, launchd, TCC,
sudo or production operation occurs. No Nix build is required.

```sh
ssh headless-ci-mac 'nice -n 19 python3 REMOTE/0004-caller-auth/run.py'
```

`fixture.c` is a native C client/server. Python only coordinates deterministic
process transitions. `evidence.json` preserves observed logs, return codes,
argv and CI checks; only actual completed cases can support a verdict.

## Method

The server compiles `cdhash H"ALLOWED_HASH" and identifier "ALLOWED_ID"` using
`SecRequirementCreateWithString`. A private Unix socket obtains the kernel peer
`audit_token_t` via `LOCAL_PEERTOKEN`. Both real/effective UIDs must match the
server UID. There is no PID-only identification or UID-only fallback.

The public SDK lacks a `SecCodeCreateWithAuditToken` declaration. The fixture
dynamically resolves that symbol and logs availability; if absent, it uses the
public `SecCodeCopyGuestWithAttributes` with `kSecGuestAttributeAudit` CFData.
It then calls `SecCodeCheckValidity` with strict/no-network flags. The fallback
retains the audit token rather than identifying by a recycled PID.

Dynamic `csops_audittoken` status checks compare captured PID/incarnation after
Security validation and immediately before admission. Missing SPI fails closed.
An `H` connection-liveness byte is additionally required. The evidence separates
`PRIMITIVE` code-requirement acceptance from tightened `DECISION` admission.

Server emits READY, then CAPTURED and a capture byte. The orchestration waits
for an actual client transition (LIVE, reaped exit, or replacement image's
EXECED) before releasing the server's CHECK gate. No sleep selects race order.

| Case | Required result |
| --- | --- |
| Allowed ad-hoc cdhash, live | Accept |
| Different ad-hoc cdhash/identifier, live | Reject |
| Authorized exit after connect, before check | Reject |
| Authorized exec rejected image before check | Reject, freshness ESRCH |
| Authorized exec same allowed image before check | Reject, freshness ESRCH |
| Synthetic same-PID/wrong-incarnation audit token | Reject |

The last case deliberately flips the captured pidversion to represent an old
incarnation at a still-live PID. It is a bounded **synthetic PID-reuse oracle**,
not evidence that the kernel actually recycled a PID during this run. Real
kernel PID reuse is not forced through unbounded process churn on the CI host.
No different-UID negative is run under the no-sudo constraint. These limitations
must accompany any PASS of the fixture matrix.

## Design consequences and limits

An audit-token requirement check must not be reported as race-safe merely
because the code API returned success: compare primitive and admission logs.
The same-image exec case isolates incarnation freshness from policy mismatch.
SPI availability is a production-design dependency, not a supported-API promise.

Freshness/liveness checks are not atomic lifetime guarantees: the peer may
exec/exit after the final check or delegate its socket. This does not establish
per-message sender identity, future authorization or resistance to authorized
fd delegation; product-native message-bound audit transport/lifecycle decisions
remain necessary. Concrete fixture results do not establish historical grants.

Sources: [Apple SecCode.cpp](https://github.com/apple-oss-distributions/Security/blob/main/OSX/libsecurity_codesigning/lib/SecCode.cpp)
and [XNU kern_proc.c](https://github.com/apple-oss-distributions/xnu/blob/main/bsd/kern/kern_proc.c).

## Earlier blocked window

E4 never ran on the interactive Mac: E3's missing ctl pin/guard caused a SecurityAgent
incident first. Its exact known prompting argv and unrecorded certificate-hash
limitation are retained in sibling `0003-sealed-boundary/README.md` and
`2026-10-14-interactive-mac-incident.json`. The original blockage is retained as
`2026-10-14-interactive-mac-blocked.json`. SecurityAgent was left untouched and fixture
files alone were deleted. The current ad-hoc-only approval does not authorize
retrying that certificate flow.
