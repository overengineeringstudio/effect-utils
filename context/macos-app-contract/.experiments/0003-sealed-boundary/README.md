# Experiment: sealed/no-sign boundary and compiled requirements

Publication note: host labels, user-specific paths, temporary-directory roots
and keychain paths in this directory were mechanically replaced with generic
placeholders (`headless CI Mac`/`headless-ci-mac`, `interactive Mac`/
`interactive-mac`, `<worktree>`, `<keychain>`, `<temporary-directory>`), and
retained receipt filenames were renamed to match. Numeric values, hashes, exit
codes and observed results are unmodified.

## Final remote verdict: PASS (ad-hoc scope)

The headless CI Mac run completed every matrix case. Presentation and external pinned
payload changes caused zero signing and preserved sealed digest
`30aa1a931b18e28c16a1edf4adeaf1490e1be1e81a011cd7ad21b92e7439b1f9`.
Info.plist-only change compiled its predicate but failed static validity
`-67030`. A changed helper invalidated the original seal and then signed
helper-first/outer-app once each, no `--deep`. An undeclared Mach-O was rejected.
Reordered identifier/cdhash predicates accepted both concrete artifacts; a
different identifier rejected both. Temporary bundle/build tree was removed.

All 21 pre-step CI checks were idle; all no-UI observations were audit flags
`0x5020` and window-list **unavailable**. The four actual codesign argv were
ad-hoc-only and recorded in `evidence.json`. This PASS does not prove trusted
certificate/grant continuity or logical requirement equivalence.

The accepted headless gate reuses merged `nix/macos-app/ctl-integration.py`'s
`no_ui_session` helper (#1834): `getaudit_addr` must succeed and GRAPHIC
`0x10` and CONSOLE `0x2000` must both be absent before every step and while
monitoring. A NULL CGWindowList is recorded as **unavailable**, not zero.
Any audit failure/capable-session transition fails closed. In this SSH session
the no-UI proof is the Manager-approved alternative to a window-server monitor.

## Current scope

The Manager approved a revised experiment **on the headless CI Mac over SSH only**.
No fixture build/run takes place on the interactive Mac. Every step runs at `nice -n 19`
and waits for absence of Runner.Worker and CI job processes first. The shared
`../safety.py` takes a CGWindowList baseline and stops on any new visible window,
leaving any dialog alone. No launchd, TCC, keychain, certificate identity or trust
settings are used. No Nix build is needed for these C-only fixtures.

Every codesign invocation goes through one shared argv assertion: it must have
`-s -`, and must not have `--keychain`, `--sign` or a named signing identity.
Every argv and pre-step CI check is recorded. This intentionally does **not**
claim trusted-certificate behavior or compatibility with historical grants.

## Question and method

`native.c` is compiled into a main executable and nested Helper.app. The signing
inventory consists of Helper.app then Fixture.app. Each is signed once per host
code release, leaf-first, without `--deep`; outer bundle signing signs its main
executable implicitly. The sealed digest covers all file names and bytes,
including Info.plist and signatures. External presentation and pinned native
payloads are outside that boundary and require zero signing. Real static code
validation must remain valid after those external changes.

An Info.plist-only change must fail strict static validation and be classified
as requiring explicit host-release review. Changing the nested executable also
invalidates the original seal; signing the complete inventory restores it. A
Mach-O scan rejects an undeclared extra executable before signing.

`requirement.c` calls `SecRequirementCreateWithString` and
`SecStaticCodeCheckValidity` with strict/nested/no-network flags. It retrieves
actual cdhash bytes using `SecCodeCopySigningInformation`. An identifier+cdhash
predicate and its reversed clause order cross-check two copies of the artifact;
text differs but both compiled predicates accept. A different identifier must
be rejected on both copies. This establishes concrete compatibility, not
universal predicate equivalence. Ad-hoc designated requirements are cdhash
based; no certificate leaf is available or invented.

```sh
ssh headless-ci-mac 'nice -n 19 python3 REMOTE/0003-sealed-boundary/run.py'
```

The C builds use one compiler invocation at a time. If Nix is introduced in a
later authorized experiment, its binding limits are `--option builders ''
--option max-jobs 2`. See `evidence.json` for actual argv, outcomes and cleanup.

## Earlier interactive Mac safety incident (retained, not rerun)

`2026-10-14-interactive-mac-incident.json` retains the aborted certificate fixture.
Its first direct codesign raised a SecurityAgent window; the tripwire killed
its process group. It omitted ctl `prove-signing-key --no-sign` partition pin
and the ctl guard after provision/import. This was a **fixture error**, not
falsification of THIN. The matrix and DR cases were not reached.

The prompting argv was:

```text
nice -n 10 /usr/bin/codesign --force --sign <certificateSha1> --keychain <keychain> --timestamp=none -r '=designated => identifier "dev.overeng.macos-app.m3-helper" and certificate leaf = H"<certificateSha1>"' <worktree>/tmp/m3-experiments-f7ma8dhc/Fixture.app/Contents/Helpers/Helper.app
```

The dynamic SHA1 was not persisted before abort and is unavailable after
file-only cleanup; every other element is exact. A final lock attempt was
refused by its baseline before execution. The whole own temporary tree,
including keychain/ACL, was deleted by file-only cleanup. SecurityAgent was not
touched. All experiments stopped for that window. The replacement harness
removes all keychain signing paths entirely; the ad-hoc authorization is not
permission to retry that certificate flow.
