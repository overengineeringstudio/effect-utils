# Requirements: 10-admin

**Role.** The opt-in `./admin` management surface — a typed Effect API over the
`restate-server` admin REST endpoints for OPERATING a running deployment (cancel /
kill / pause / resume / purge / restart invocations; deployment register / list /
get / update; typed SQL introspection). It is the operator-facing counterpart to
the cancel/interrupt edges that [04-error-boundary](../04-error-boundary/requirements.md)
(R31) surfaces from inside a handler; it introduces no new GLOBAL requirement IDs
of its own.

Builds on the cross-cutting [../requirements.md](../requirements.md) (global
A/T) and [../glossary.md](../glossary.md). The design rationale is
[../.decisions/0018](../.decisions/0018-admin-management-api.md); it mirrors the
`RestateIngress` secured-client pattern from
[../.decisions/0016](../.decisions/0016-secured-ingress-and-request-identity.md).
