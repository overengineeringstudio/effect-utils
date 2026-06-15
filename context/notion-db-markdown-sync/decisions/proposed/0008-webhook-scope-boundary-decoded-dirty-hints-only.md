# Webhook scope boundary: accept decoded dirty hints only; provisioning out of scope

Status: proposed

The package surface for Phase 7 (webhooks) accepts decoded dirty hints only.
Subscription provisioning, hosted-receiver lifecycle, and Worker lifecycle stay
out of PR #775 (deferred to the external-signals epic and a dedicated decision).

Hints received via webhook are followed by fresh reads before planning. Webhooks
are never a correctness source — they are acceleration signals only. This matches
the existing `webhook/` modules' intent.

## Considered Options

| Option                                                                                          | Result   | Reason                                                                                                                                        |
| ----------------------------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Accept decoded dirty hints only; provisioning and hosted-receiver/Worker lifecycle out of scope | Selected | Explicit in the epic scope; webhooks as correctness source would violate the fail-closed model; provisioning is a separate lifecycle concern. |

## Consequences

Subscription provisioning and hosted-receiver/Worker lifecycle are deferred work
with their own epic and decision record. Any Phase 7 implementation that assumes
webhook delivery guarantees correctness must be flagged as a VRS violation.
