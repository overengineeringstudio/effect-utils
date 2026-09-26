# 0006 - Age active records by idle time

Status: accepted

## Context

`ExplorerBounds.active.maxAge` turns an active record `uncertain` with
`RetentionExpired` evidence, but the spec did not define what the age
measures. The store measured it from `startedAt`. ServiceHub's primary feed,
`hub.streamServices`, stays open for as long as a dashboard is open and pushes
a snapshot on every registry refresh. With a 10-minute bound, every healthy
dashboard stream would be reported `uncertain`, and its later chunks would
become late-event anomalies.

## Options

| Option                                 | Result   | Reason                                                                     |
| -------------------------------------- | -------- | -------------------------------------------------------------------------- |
| Start age (status quo)                 | Rejected | One `maxAge` cannot both flag stuck unary calls and tolerate long streams. |
| Exempt streams from age expiry         | Rejected | A stuck, silent stream would never be flagged by age.                      |
| Idle age since the last observed event | Selected | Keeps active streams live while silent records still expire.               |

## Decision

A record's age is the current event time minus its `lastAt`. Active and
completed `maxAge` both use this definition. The principal chose it (session
decision q4).

## Evidence and Argument

`lastAt` is advanced by every admitted event, and completed eviction already
used it, so the change aligns active retention with existing completed
behavior. Memory stays bounded by `active.maxCount` regardless of age. A store
unit test covers the case: a stream started 20 s ago with its last chunk 4 s
ago stays active under a 10 s bound, while a silent record expires as
`uncertain` with `RetentionExpired` reason `age`. The test fails under
start-age measurement.

## Consequences

- Long-lived streams remain active while they emit.
- A silent stream or unary call still expires once idle beyond `maxAge`.
- Hosts can choose `maxAge` for stuck-call detection without sizing it to the
  longest stream.
