# Integration note — wiring schema-iac into the control dashboard (later milestone)

This demo is **content only** right now. Nothing is wired into the React app, the
`demo/dashboard` registry, or the explainers. This note is how a later milestone
should register it. **Do not wire it up as part of this authoring task.**

## Proposed registry identity

The dashboard model is `Demo` in `demo/dashboard/screenplay.ts`
(`{ id, tab, gapwow, resetCmd, explainerSrc, beats, summary }`) — parsed from each
demo's `SCREENPLAY.md` and enriched by `demo/dashboard/build.ts`.

| field | proposed value | notes |
|---|---|---|
| `id` | `schema-iac` | new, distinct from the existing `schema` (codegen) demo. |
| demo number | **3.2** | sub-numbered under a **"notion schema"** group where **3.1 = codegen** (`demo/schema/`, id `schema`) and **3.2 = IaC** (this). If the registry has no grouping concept yet, that grouping is the small addition needed. |
| `tab` | `notion schema · apply (IaC)` | or whatever the group renderer wants; keep "planned/preview" visible. |
| `resetCmd` | `null` | nothing runs; nothing to reset. |
| `explainerSrc` | `demo/explainers/notion-schema-iac.html` | **authored in a later milestone** — does not exist yet. |
| `summary.harnessed` | `false` | not harnessed; there is no e2e spec and no live capture. |

## New field the registry will need: `planned`

There is **no `planned` flag on `Demo` today.** This demo needs one so the
renderer can badge it and suppress harness/pass-fail affordances:

- `planned: true`
- status label: **"mock / illustrative"** (not "pass", not "fail", not harnessed).
- The renderer should show the PLANNED banner from `SCREENPLAY.md`'s gap/wow block
  prominently, and should **not** show a green/red run status or a "reset"
  control for this demo.

Because `planned` doesn't exist on the model yet, adding this demo to the
dashboard is gated on introducing that flag (and teaching `build.ts` to skip
evidence enrichment when `planned === true`).

## Explainer target (later)

- filename: `notion-schema-iac.html` (sibling of the other `demo/explainers/*.html`).
- authored in a **later milestone**, not now.
- it should frame 3.2 as the inverse of 3.1 and preserve the honest "planned /
  additive-only / destructive-fails-closed" framing from `README.md`.

## Evidence / status

- mock-evidence dir: `demo/schema-iac/mock/` (committed text mock
  `terminal-apply.txt`; optional local-only screenshots — see `MOCK-EVIDENCE.md`).
- status: **mock / illustrative**, not harnessed. No `e2e.spec.ts`, no
  `evidence/<timestamp>/` capture, no reset script.
- when the real `notion schema apply` / `plan` ships, this demo can graduate:
  add an `e2e.spec.ts`, real evidence capture, and flip `planned` to `false`.

## Do-not-touch reminder (this task)

Creating this note does **not** authorize editing `demo/dashboard/**`,
`demo/explainers/control.html`, `demo/dashboard/build.ts`, `demo/serve.sh`, or any
package source. Those changes belong to the later wiring milestone.
