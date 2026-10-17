# One stable permissions host

Status: accepted

- Decision date: 2026-10-16
- Scope: runtime privilege, caller policy, assembly, consent and migration

## Context

Shared packaging with a separate signed consent identity for every product does
not remove repeated System Settings work as tools change. The existing stable
signing, sealing and installation machinery remains useful, but the rule that
products never share runtime privilege conflicts with the chosen user outcome.
The host must mediate protected work rather than merely install independent apps.

The platform evidence is narrower than universal inheritance: experiment 0001
records the evaluated subject of denied Full Disk Access reads. Socket/SSH work
was charged to the launchd-started host; non-disclaimed children retained that
subject in this fixture. Successful inherited access, other permission types
and grant survival across upgrades remain untested release gates.

## Decision

Use one stable signed permissions host performing typed protected operations for
same-user clients, with public runtime and private assembly. The accepted choices
and alternatives are recorded below.

## Options

| Decision               | Selected option                                                                                                                   | Alternatives rejected or deferred                                                                 | Rationale and consequences                                                                                                                                                                                                   | Axe answer record      |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Protected interface    | Host performs typed operations itself                                                                                             | Run arbitrary programs with host grants                                                           | Narrow reviewed operations are auditable; a new operation can require a host release. No arbitrary program/script execution API.                                                                                             | `1792140866170-a9bsa8` |
| Interim landing policy | Grant-neutral changes only                                                                                                        | Freeze all changes; continue all per-product identity rollouts                                    | Existing fixes can land without additional consent; per-product identity work stays paused until its host operation exists.                                                                                                  | `1792143222941-jsayad` |
| Grant scope            | Host holds FDA and every other grant its operations require                                                                       | Narrow host with permanent FDA helper exceptions; decide FDA later                                | One eventual grant holder; every operation is reviewed as a whole-disk reader. Restic and Watchman migrate later and their identities retire.                                                                                | `1792143326911-f8x17w` |
| Caller trust           | Any same-UID process, with narrow operation policy and audit                                                                      | Executable allowlists by default; per-seat bearer tokens                                          | Caller scripts/interpreters and same-user token theft defeat purported seat isolation. Kernel peer evidence and asserted labels remain distinct; tighter per-operation caller checks can be added without client changes.    | `1792152436571-iazplu` |
| Delivery order         | Pause identity rollouts, rewrite spec, human-present experiments, host with Documents copy, then operation-by-operation migration | Experiments before the spec rewrite                                                               | Contract changes do not need a consent session. Protected platform experiments do. Documents acceptance includes one successful backup import, not staging alone.                                                            | `1792153658883-tgw9n1` |
| Code ownership         | Public runtime, private assembly                                                                                                  | Everything in the consumer repo                                                                   | effect-utils owns runtime, IPC, audit, Nix module and generic operations. The consumer owns private config/operations and assembles/signs one app. New generic operations require an effect-utils PR and consumer repin.     | `1792154401937-ac2ka1` |
| Display name           | Descriptive consent-facing name chosen by the consumer, fixed before first grant                                                  | Short host names; protected-access, agent-broker and workstation-service names                    | The consumer repo fixes a descriptive, consent-facing display name before the first grant (for example "Mac Permissions Host"); renaming later is a re-consent migration. The public runtime keeps a generic technical name. | `1792159935471-zccj7o` |
| Notifications          | Host posts all new tools' notifications                                                                                           | Migrate every existing notifier immediately; retain per-product branding identities for new tools | Host name/icon in the banner, product label in its title; one host Notifications allowance. An already separately allowed notifier may remain temporarily. Later unification can preserve per-app UI and behavior.           | `1792160203641-s1610d` |

The initial short-name question was explicitly reframed rather than accepted:
Axe answer record `1792155121870-zzdvwg`. The through-import acceptance boundary
was already accepted in answer record `1792139432058-uavydj`.

References above are stable Axe record IDs, not question handles or public URLs.
The source interview is not published here; private topology, product labels,
source paths and repository links are intentionally omitted.

## Consequences

- One stable signed native app performs protected operations for changing clients;
  clients receive bounded results, not possession of its grants.
- Full Disk Access deliberately enlarges the impact of an implementation bug.
  Allowlisted sources/targets, bounds, no arbitrary paths or exec, and audit are
  mandatory. Same-user admission is not isolation between tools or agents.
- Consent remains per permission type, and Automation per target app. There is no
  unmanaged pre-grant or promise that changed identities preserve old grants.
- Existing sealed descriptors, pinned compiled requirements, dedicated-keychain
  signing and verified artifact installation are retained. The generic external
  action runner is not the new privileged operation registry.
- Watchman's root topology and a pinned restic worker need positive platform
  experiments with the human present before migration. Arbitrary execution is
  not a fallback if either does not fit.
- This supersedes the former per-product runtime-privilege rule in the spec.
  There is no older decision file in this contract directory to amend. Decisions
  in a consumer repo are outside this public change and require their own amendment.

## Evidence and Argument

The normative target is [spec.md](../spec.md). Unresolved platform gates and
their blockers are in [open-questions.md](../open-questions.md). This decision
records accepted direction, not implementation, consent or migration success.

## Amendment 1

Date: 2026-10-17. The following Q25–Q29 outcomes refine the delivery and consent
boundary without changing the single-host decision. They record accepted
direction, not verified implementation or successful platform approval.

| Question | Recorded outcome |
| -------- | ---------------- |
| Q25 Build/test execution | Use only an idle dedicated secondary build host, `nice` level 19, Nix `max-jobs = 2`, and `builders = ""`. Do not drain CI or consume active capacity; do not substitute another machine. |
| Q26 Implementation boundary | Implement the real unsigned native host now. Signing, installation, launch and grants await an explicitly authorized human-present session. |
| Q27 Release-one grants and onboarding | Implement all six permission families: Full Disk Access, Notifications, Screen Recording, Accessibility, audio and per-target Automation. Audio includes distinct microphone and system-audio (TCC AudioCapture) categories, giving seven concrete grant strings. Explicit `onboard --human-present --config PATH` performs setup and a harmless positive check for each enabled category/target. An empty Automation target allowlist skips target checks, not implicit consent. Startup and ordinary requests never request consent; unmet prerequisites return typed action-required denials. |
| Q28 Upgrade policy | Pending DQ1. Pin the consumer identity and actual designated requirement; no claim of grant continuity until positive human-present upgrade/rollback evidence. |
| Q29 Bundle identity | `bundleId` is required consumer input to the public module. The final private identity is neither chosen nor published by effect-utils. |
| Q30 | No outcome recorded; no answer was supplied. |

Release-one operation IDs are `host.status`, `documents.copy` and `notify`.
The single-word `notify` is a deliberate fixed exception to the dotted-name
grammar, not a general bare-name namespace. This replaces the draft `core.*`
reservation and examples: clients use the assigned IDs directly, with no
`core.notify` alias or implicit migration fallback.

Permission denials use `permission-required` plus structured `actionRequired`
details, so clients can report the human step without prompting or borrowing
another app's grants. Positive evidence for all seven concrete categories, Documents
through import, and upgrade continuity remains gated as described in
[spec.md](../spec.md) and [open-questions.md](../open-questions.md).
No build/test, signing, installation, launch, grant or migration success is
established by this amendment.
