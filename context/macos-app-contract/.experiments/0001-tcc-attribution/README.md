# Experiment: TCC attribution per launch topology

## Question

Date: 2026-10-13. Host: macOS 27.0.1, arm64.

Which code does TCC (Transparency, Consent, and Control) treat as the
responsible subject when a protected resource is accessed from each topology
the macOS app contract may use? A grant only helps if it attaches to the
subject that TCC actually evaluates.

## Method

- [`probe.c`](./probe.c) opens `~/Library/Safari`, which needs Full Disk
  Access (`kTCCServiceSystemPolicyAllFiles`). Full Disk Access never prompts,
  so the probe is denied silently. No grant was added, reset or requested.
- Three ad-hoc signed copies with distinct identifiers: an app bundle
  (`dev.overeng.m0-probe`), a loose `leaf` binary and a `wrapper` binary.
- `tccd` decisions were captured with
  `log stream --level info --predicate 'process == "tccd" AND eventMessage CONTAINS "AUTHREQ_"'`.
  `AUTHREQ_SUBJECT` names the evaluated subject; `AUTHREQ_ATTRIBUTION` names
  the responsible and accessing processes. Reading these logs needs no special
  grant. Info-level `tccd` logs are retained for hours only, so capture must
  run during the experiment.
- launchd jobs were created with `launchctl submit` in the `gui/<uid>` domain
  and removed after one run. SSH runs used a background session
  (`launchctl managername` = `Background`).

## Observations

| ID  | Topology                                                 | TCC subject                     |
| --- | -------------------------------------------------------- | ------------------------------- |
| T2  | launchd runs the app executable directly                 | app bundle ID                   |
| T3  | launchd runs `/bin/sh -c 'exec <app executable>'`        | app bundle ID                   |
| T4  | launchd runs a wrapper that fork/execs the app           | wrapper                         |
| T4b | same wrapper, child spawned with responsibility disclaim | app bundle ID                   |
| T5  | app `posix_spawn`s a leaf binary                         | app bundle ID                   |
| T6  | app spawns a leaf with responsibility disclaim           | leaf                            |
| T7  | shell client asks a launchd-started app over a socket    | app bundle ID                   |
| T8  | SSH session runs the leaf directly                       | `com.apple.sshd-keygen-wrapper` |
| T9  | SSH client asks the launchd-started app over a socket    | app bundle ID                   |

Repeated requests for the same responsible process may be answered from the
`tccd` cache and produce no new log line.

Code signing over SSH with an Apple Development identity in the login keychain
fails with `errSecInternalComponent`; `security show-keychain-info` reports
`User interaction is not allowed`. Finding the identity over SSH does not
authorize use of its private key.

## Conclusions

- The process launchd starts is the subject unless it execs into another
  image. A launchd wrapper that stays resident as parent (for example to record
  exit rusage) takes over the subject and must spawn its child with
  `responsibility_spawnattrs_setdisclaim` or not wrap consent-identity jobs.
- In this FDA-denial fixture, a non-disclaimed child was evaluated against the
  host's identity (T5). This does **not** prove successful inherited access or
  grant transfer for every child or permission type. Any later pinned worker
  requires a positive capability-specific experiment; arbitrary `exec` is not
  the host's interface.
- SSH-origin work must reach the protected resource through IPC to a
  launchd-started host. Direct SSH execution is attributed to `sshd`.
- The login-keychain signing attempt over SSH failed in this experiment.
  This does not establish that signing always requires a GUI session: the
  current contract uses headless dedicated-keychain sealing through ctl.
  See [the release contract](../../spec.md#stable-signed-releases-and-existing-machinery).

## Open

- Positive path with an existing grant (granted host, changed payload).
- launchd system daemon with `AssociatedBundleIdentifiers`.
- Signing from a `gui/<uid>` agent after reboot and before or after login.
