# Open platform questions

These are release gates, not claims that the target design has been implemented
or approved on a live machine. Each question maps to a DQ in [spec.md](./spec.md).
Every experiment below is blocked on **an explicitly authorized experiment with
the human present**, using disposable fixtures and recording the tested OS,
signed release, session, responsible identity, actual API result and cleanup.
Do not reset existing grants or probe production data to satisfy these gates.

| Spec question                | Untested fact / blocker                                                                                                                                             | Evidence required to resolve                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| DQ1 Host upgrade continuity  | Grant survival across a host upgrade and designated-requirement stability are untested; blocked on a human-present experiment.                                      | Establish each used grant on the test host; compare unchanged reinstall, changed client, changed signed host satisfying the pinned DR and rollback. Treat certificate/DR changes separately. Actual positive operations, not just signature checks, prove continuity for the tested case.           |
| DQ2 Screen Recording         | Positive access and attribution for native capture and any required child topology are untested; blocked on a human-present experiment.                             | With host granted and client ungranted, capture a harmless synthetic frame through local and SSH clients; repeat after a client update and observe revocation. Do not infer child inheritance from native success or promise absence of future OS reminders.                                        |
| DQ3 Accessibility            | Positive AX access and attribution are untested; blocked on a human-present experiment.                                                                             | Perform a harmless bounded AX action through the host for an ungranted client; record host identity, GUI-session dependence and denial after revocation. Test a child separately only if an actual operation requires one.                                                                          |
| DQ4 Audio                    | Positive audio/microphone access, category-specific consent and child attribution are untested; blocked on a human-present experiment.                              | Test each needed native audio operation separately with synthetic audio, correct usage descriptions/entitlements, actual output and session/denial evidence. Do not generalize one audio category to another.                                                                                       |
| DQ5 Notifications            | Host notification attribution, authorization and visible branding are untested; blocked on a human-present experiment.                                              | Approve the host once, submit a bounded notification from an ungranted client, observe host name/icon and product-prefixed title, then distinguish submission, visible delivery and denied state.                                                                                                   |
| DQ6 Automation               | AppleEvents authorization and attribution per target are untested; blocked on a human-present experiment.                                                           | Send harmless typed events to allowlisted target A through an ungranted client; test first access to target B separately and verify no target-wide preapproval is claimed. Any child execution needs its own evidence.                                                                              |
| DQ7 Watchman fit             | The root-daemon lifetime/topology has not been shown to fit the single consent-bearing host; blocked on a human-present experiment.                                 | Use an isolated filesystem fixture to test the required UID/domain, event observation, client reconnect and restart behavior while retaining one permission identity. Show actual positive reads/events; document any platform obstacle rather than silently add another app or root execution API. |
| DQ8 Pinned restic worker     | Experiment 0001 proves FDA-denial attribution, not successful inherited access by an approved pinned worker; blocked on a human-present experiment.                 | Grant the test host FDA, run only the reviewed pinned worker against synthetic protected files, confirm successful read/backup and responsible host identity, then repeat with changed pinned worker bytes. No client-selected program, argv or script.                                             |
| DQ9 Documents through import | No host-native protected copy and end-to-end import is established; blocked on a human-present experiment for the protected read and the consumer's import receipt. | Copy representative allowlisted Documents fixtures for an ungranted client, verify bounds/hashes/audit correlation, hand off staging through the consumer's inbox contract and obtain one successful backup import. Temporary-directory tests or a sentinel alone are insufficient.                 |

## Evidence already available

[Experiment 0001](./.experiments/0001-tcc-attribution/README.md) observes FDA
**denials**: T7/T9 charge socket/SSH-origin requests to the launchd-started host;
T5 charges a non-disclaimed child's read to the host in that fixture. It does not
prove positive grant inheritance for FDA or other categories. Its former
universal child-grant statement is corrected in place; the experiment is present
on the base branch, not only on an unmerged branch.

The other retained experiments cover their recorded bounded fixture assertions.
In particular, [0006](./.experiments/0006-plist-breadth/README.md) is skipped:
real MachServices, supplied-plist breadth and user-domain convergence evidence
are not inferred from offline validation. The same human-present experiment gate
applies if those behaviors are required by a migrated operation. No experiment
in this rewrite was run and no consent was changed.
