# Test Quarantine Requirements

## Context

Test quarantine is the subsystem of [ci-tools](../requirements.md) that defines
what it means for a repository to hold a known-failing test target non-blocking
without its required check lying about it.

The parent owns the `ci-tools` CLI identity, its Effect boundaries, and its
output discipline. This subsystem owns one contract: the shape of a quarantine
entry, the rule that retires it, and the channels that make a tolerated failure
visible. The consuming repository owns which targets are quarantined and how its
test invocations are composed — those are properties of that repository's lanes,
not of the contract.

## Assumptions

- **A01 ci-tools base:** This subsystem refines the parent's Effect boundaries
  (ci-tools R04 Effect CLI entrypoint, R05 tagged expected errors, R06
  schema-decoded data) and its output discipline (R09 problems first, R12 no
  secret leakage).
- **A02 Consumer owns the ledger:** The set of quarantined targets is repository
  state, supplied to this subsystem as data. This subsystem never enumerates or
  stores quarantined targets itself.
- **A03 Consumer owns the policy decision:** Whether a given invocation is
  blocking or quarantined is decided by the consumer, which knows its own test
  lanes. This subsystem is reached only once a tolerated failure has occurred.

## Acceptable Tradeoffs

- **T01 Process boundary:** Consumers invoke a CLI and serialize their ledger to
  JSON rather than importing a function. This costs a subprocess per tolerated
  failure and forbids sharing types directly, in exchange for consumers needing
  no npm dependency on this package. Tolerated failures are rare by
  construction.

## Requirements

### Must Make Suppression Declared

- **R01 Ledger-declared suppression:** A failure may be tolerated only under an
  entry naming the suppressed target, the reason, a tracking issue, and an
  expiry date. An entry missing any of these is rejected.
- **R02 Target match enforced:** An entry applies only to the target it declares.
  Applying it to any other target is an error, so one entry cannot suppress
  unrelated work under another target's justification.
- **R03 Unknown key rejected:** A quarantine key with no ledger entry is an
  error. It is never treated as "suppress everything".

### Must Keep Quarantines Temporary

- **R04 Expiry is enforced:** A ledger holding an entry whose expiry date has
  passed fails its check, forcing a renew-or-remove decision.
- **R05 Malformed expiry counts as expired:** An expiry that is not a well-formed
  date is treated as expired rather than as never expiring, so a typo cannot
  become a permanent quarantine.

### Must Keep the Signal Visible

- **R06 Announcement is self-contained:** A tolerated failure is announced with
  the target, reason, tracking issue, and expiry, so the record is readable
  without consulting the ledger.
- **R07 Announcement reaches the runner:** The announcement is emitted as a
  GitHub workflow command on stdout, so a tolerated failure becomes an
  annotation and stays distinguishable from a genuine pass.
- **R08 Failing to announce fails the run:** If the announcement cannot be made,
  the run fails rather than tolerating the failure silently. Suppressing a
  failure while losing its signal is the outcome this subsystem exists to
  prevent.
