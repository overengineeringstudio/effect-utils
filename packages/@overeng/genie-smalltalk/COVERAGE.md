# Smalltalk declaration coverage

Authoritative grammar: `compoundingtech/smalltalk`, `crates/st3/src/graph.rs` at the pinned st revision used by CI. This library validates authoring inputs; the st daemon remains the final parser and runtime authority. Constructor field names are TypeScript camelCase only where KDL uses hyphens.

| Grammar node                                                                                                                                  | Status      | Notes                                                                                                                                                                                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`                                                                                                                                       | Partial     | All 19 ALLOWED child names modeled; complex `render`, `harness`, `pty`, `exec`, authority and restart forms are **not** fully represented; avoid assuming full parser parity.                                        |
| `mission`, `step`, `gate`, `exec`, `depends-on`, `schedule`, `work`                                                                           | Partial     | Covers finite missions, step dependencies, field gates, exec, interval and daily/single-weekday calendar schedules. Mission declarations embedded within missions, cancellation and additional step forms not modeled. |
| `resource`                                                                                                                                    | Partial     | Three resource kinds modeled; upstream accepts more kinds.                                                                                                                                                           |
| `account`, `pty`, `host`, `doc`, `lane`, `observer`, `subscription`, `person`, `mission-run`, `planning-session`, `message`, `repair`, `stop` | Not covered | Root grammar nodes omitted.                                                                                                                                                                                          |
| `version 2`                                                                                                                                   | Covered     | All emitted documents start with this directive.                                                                                                                                                                     |

The conformance test is opt-in with `ST_BIN` pointing to a binary built from the exact pinned upstream revision. Its scratch daemon must be isolated from the caller's runtime directories.

Harness authoring supports OMP model/effort and Codex optional model/effort/args. Codex `resume: { session }` lowers to `env.ST3_NATIVE_RESUME_SESSION`, binding the exact native thread; conflicting authored values are rejected. Omitted Codex model/effort preserve provider configuration defaults.

## OMP conversation recovery

OMP harness intent accepts `resume: { transcript: '/sessions/example.jsonl' }` to emit `args "--resume" "/sessions/example.jsonl"`, or `resume: 'latest'` to emit `args "--continue"`. The `omp({ model, effort, resume })` helper accepts the same optional field. Omitted recovery intent starts a fresh conversation.

Use an exact transcript for managed seats when preserving a particular conversation; `latest` selects the newest session in the harness session directory. Paths are interpreted on the seat host and validated by the OMP launcher, not resolved by this generator. Recovery is a mutually exclusive typed choice, not free-form harness arguments. Applying a declaration does not itself authorize restarting a seat.

## Calendar schedules

Schedules accept a tagged calendar variant alongside the existing interval shape:

```ts
schedule({
  id: 'daily',
  host: 'local',
  _tag: 'calendar',
  at: '08:00',
  timezone: 'Europe/Berlin',
  catchUp: 'latest',
  work: { mission: `demo@${'a'.repeat(64)}`, workspace: '/work/demo' },
})
```

This lowers to the runtime's `calendar { at "08:00"; timezone "Europe/Berlin" }`
block, with `host`, `catch-up` and `work` remaining schedule children. `at` is
validated as a 24-hour `HH:MM` local time. The timezone is required, branded by
`IanaTimezoneSchema`, and checked against the JavaScript runtime's IANA timezone
data; st remains authoritative with its bundled `chrono-tz` database, which may
differ in version or accepted aliases.

Omit `days` for a daily schedule. `days: ['Mon']` emits `at "Mon 08:00"` for a
weekly schedule. The typed tuple accepts exactly one of `Mon`, `Tue`, `Wed`,
`Thu`, `Fri`, `Sat`, `Sun`: st does not accept multi-day rules or a KDL `days`
child. Calendar schedules cannot also contain `every` or `anchor`.
Interval declarations can use `_tag: 'every'`; existing untagged
`{ every, anchor, ... }` declarations remain source-compatible.

Both variants require `catchUp: 'latest'`, preserving the library's latest-only
policy: an already reached occurrence is not replayed, missed occurrences
collapse to the latest one, and a prior active mission run prevents starting
another occurrence. Calendar keys are local dates. st resolves a spring DST
gap to the first valid instant after the gap and an autumn fold to its earlier
instant, firing only once. No `misfire` field is accepted by st or this library;
st's broader `all`/`skip` catch-up controls are not modeled here.

Runtime contract: [`mission-graph-runtime.md`, Continuous missions](https://github.com/compoundingtech/smalltalk/blob/main/docs/st3/mission-graph-runtime.md#continuous-missions),
with grammar validation in `crates/st3/src/graph.rs` (`validate_schedule` and
`parse_calendar_time`).
