# 0002 - Fail closed with independent whole-channel capture policies

Status: accepted

## Context

An embedded explorer can see credentials and private business values across
request, response, stream, error, defect, and header surfaces. A UI-only mask,
reveal-by-default policy, or generic heuristic cannot establish a storage
safety boundary.

## Options

| Option                                              | Result          | Reason                                                                                   |
| --------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------- |
| Reveal by default with UI masking or key heuristics | Rejected        | Raw values can already have escaped storage; heuristics cannot cover unknown fields.     |
| Generic nested Schema field policy                  | Rejected for v1 | Public metadata cannot safely traverse every decoded Schema shape.                       |
| Independent whole-channel fail-closed policy        | Selected        | Establishes a storage boundary using supported metadata and explicit trusted transforms. |

## Decision

Resolve each of seven channels as host > RPC > root Schema > default omission,
then normalize only the selected reveal/redact result before retention.

## Evidence and Argument

The rc.115 policy probe proved four-level seven-channel precedence and absence
of its sentinel from retained omit/redact graphs. It also demonstrated that a
permissive `Schema.toCodecJson` may expose a Redacted backing value, so UI
masking or codec serialization cannot be the storage boundary.

## Consequences

- Every channel resolves host > RPC > root Schema > default omission.
- Inclusion stays separate from capture policy, so inspector RPCs can be
  excluded without relying on a content rule.
- Raw values never enter events, deltas, snapshots, telemetry, or storage;
  redaction transforms before detached normalization and failures omit content.
- v1 supports whole-channel annotations; safe nested shaping is an explicit
  trusted root transform, not a generic field-annotation promise.
- Redacted wrappers normalize to irreversible placeholders; Schema JSON encoding
  is not a sanitizer.
