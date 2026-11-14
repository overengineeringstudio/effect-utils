# Live target keys with an inline prompt; remove rows and replace changed addresses

Status: accepted

## Context

Johannes chose live target editing on 2026-11-14: dedicated keys with an inline
prompt (interaction approval `keys-prompt`, step-run/ask
f68a7693ca52063278332d01b536d624), then removal of rows and fresh history for
changed addresses (semantics approval `remove-row-edit-new`, step-run/ask
d12c2db63dfa977d5669fde88d4ff59a). After trying the prototype, he approved it:
“works. go ahead” (trial approval, step-run/ask
cd3d7d45a9ae69bee0f8ac0c5d435b5c). These human approvals establish the
interaction and lifecycle choices. Johannes approved
[R27 Live target editing](../requirements.md#must-let-targets-change-while-running)
via ask `step-run/ask-bd40d4987d73a8ad203582bc10fcd2fa/ask` (answer `add`);
the [spec](../spec.md#live-membership-r27) defines its implementation.

## Evidence and Argument

The approved prototype supports editing without interrupting probing or leaving
the inline view. Removing a target should remove its contribution, not leave a
stopped row; measurements for a different IP should not inherit old statistics.

## Options

| Option                                              | Tradeoffs                                                                                                            |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `a` / `e` / `d` and inline prompt                   | Direct, discoverable hints; prompt focus temporarily captures live keys. Chosen (`keys-prompt`).                     |
| `:` command line                                    | Extensible syntax, but requires learning commands for three actions.                                                 |
| Overlay dialog                                      | More room for forms, but obscures the live view and adds modal layout.                                               |
| Keep removed rows / keep history across changed IPs | Preserves old measurements, but mixes retired targets into the current comparison. Rejected (`remove-row-edit-new`). |

## Decision

Use `a` to add, `e` to edit the selection and `d` to remove it; `d` opens an
inline confirmation, where `y` removes and `n`/`Esc` cancels. Up/Down and mouse
click select; `+`/`-` and the wheel zoom. The inline prompt accepts printable
ASCII and space, with punycode required for IDNs; invalid characters and whole
invalid pastes are rejected without changing the draft. This avoids splitting
Unicode grapheme clusters without adding a segmentation dependency. Canonical
tailnet-name completion is shared with shell completion. Resolution is
asynchronous; batches apply atomically and Escape invalidates pending results.

Removal retires workers and drops the row and its statistics, including final
summary totals. A changed-IP edit creates a fresh target at the same position;
a same-IP rename preserves history. Stable, never-reused IDs isolate retired
events. Initial `-c` workers stay finite; additions are unbounded until quit.

## Consequences

The empty list remains editable. Membership is separate from worker identity,
shared scheduling and global network context. Retired events and cancelled
resolver generations cannot mutate replacement rows.
