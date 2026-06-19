# Delta 0001 — Status drift gate shipped via `apply --exit-code`, not file-vs-live `diff`

**Status:** divergence from `requirements.md` R7 (protected, signed-off). Needs
user re-sign-off or R7 revision.

## What R7 says

R7 specifies the drift-detection mechanism as the **file-vs-live `diff`**
(`diff --exit-code`) covering option names, colors, IDs, **and groups**, with the
desired side parsed from the `notionPropertyMeta` annotation.

## What was implemented

The status drift CI gate shipped as **`schema apply --dry-run --exit-code`**
(config-vs-live), reusing the tested planner. This was chosen because the issue
frames status drift as "fail CI when native status options/groups drift **from
desired config**" — config-vs-live — and it avoids the fragile annotation parser
for the common case.

## The gap (so the divergence is explicit)

| Dimension                   | R7 (file-vs-live diff)         | Shipped (apply --exit-code)             |
| --------------------------- | ------------------------------ | --------------------------------------- |
| Option name drift           | ✅                             | ✅                                      |
| Option color drift          | ✅                             | ✅ (vs config `colors`)                 |
| Option ID drift / rename    | ✅                             | ❌                                      |
| **Group** drift             | ✅                             | ❌ (config carries no groups)           |
| `.gen.ts`-vs-live staleness | ✅ (the point of file-vs-live) | ❌ (config-vs-live is a different axis) |

So the **group-drift** detection in R7 (and in the issue's acceptance criteria,
"native status options/**groups** drift") is **not yet delivered**. It remains a
follow-up (`open-questions.md` OQ4): implement option/color/ID/group diffing in
`computeDiff` by parsing the `notionPropertyMeta` annotation (`diff.ts:210` stub).

## Resolution options for the user

1. Accept the apply-based gate as the primary status drift gate and keep the
   file-vs-live diff (incl. groups) as a tracked follow-up → revise R7 to name
   `apply --exit-code` as the option/color gate and scope the file-vs-live diff
   as the group/staleness gate.
2. Treat group drift as in-scope-now → implement the file-vs-live annotation diff
   before considering #803 done.
