# Experiment: supplied plist breadth and user-domain convergence

## Question

Can direct native entrypoints and fixed argv support calendar-idle jobs,
KeepAlive.PathState, EnvironmentVariables and MachServices in gui/<uid> and
user/<uid>, with unchanged convergence performing no launchd mutation?

## Manager gate

**SKIPPED, not PASS or FAIL.** On 2026-10-14 the Manager prohibited E6 entirely:
the operator is away, and even a synthetic bootstrap may produce a visible
Background Items notification. No `launchctl bootstrap`, `bootout`, `kickstart`,
other launchd load, or synthetic plist installation was performed in E3–E6.
No offline-only result is represented as evidence of launchd behavior.

## Required later evidence

In an approved window, use only `dev.overeng.macos-app.m3-*` labels in the local
user's gui/user domains. Record real loaded state/PID-or-idle evidence for all
supplied keys; reject shell-wrapper/undeclared Program and wrong domain/UID;
trace repeated unchanged converge with zero bootstrap/bootout/kickstart. After
cleanup, every synthetic label must return exit 113 from `launchctl print`, and
all fixture files must be removed. That live falsifier remains an unmet design
release gate, not a reason to widen scope to a system domain or another user.
