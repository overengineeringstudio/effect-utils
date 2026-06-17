# Webhook scope boundary: accept decoded dirty hints only; provisioning out of scope

Status: accepted

The package surface for webhooks accepts decoded dirty hints only. Subscription
provisioning, hosted-receiver lifecycle, and Worker lifecycle stay outside this
VRS decision and belong to the external-signals design.

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
