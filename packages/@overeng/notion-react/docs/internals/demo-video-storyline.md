# Notion React Demo Storyline

## Purpose

This document defines the demo before we automate it.

It is deliberately written like a screenwriter's beat sheet plus a technical acceptance spec:

- what the audience should understand
- what the demo must and must not try to prove
- what happens on screen, when, and why
- how we validate that the implementation matches the intended story

The implementation script should be treated as a translation of this document, not a replacement for it.

## Audience

Primary audience:

- engineers evaluating `@overeng/notion-react` for serious page-generation and sync workflows

Secondary audience:

- teammates who want a crisp intuition for the development loop
- people who might otherwise assume this is a toy JSX-to-Notion renderer

## Core Message

`@overeng/notion-react` lets you treat a Notion page as a programmable React tree, iterate locally in JSX, and repeatedly sync incremental page evolution into a real Notion page.

The demo must make that feel:

- simple at the start
- obviously live and iterative
- progressively more capable
- still understandable as the tree gets richer

## Demo Goals

1. Establish a clean mental model quickly: edit JSX on the left, rerun sync, page updates on the right.
2. Start from an empty page body and a minimal TSX file so the viewer can track every change.
3. Show that the page grows incrementally rather than appearing all at once from a giant prebuilt example.
4. Demonstrate that the same file evolves from hello-world simplicity to a richer structured Notion page.
5. Show a development loop that looks credible for real work: edit, save, sync, inspect result, continue.
6. Keep the changed block above the fold whenever possible so the viewer does not need to hunt for the effect.
7. Make the right-hand side unmistakably a real Notion page, not a mock web renderer.
8. Leave the viewer with the sense that complexity is authored, refactored, and composed in normal JSX.

## Anti-Goals

1. Do not start from a large pre-existing Storybook-derived tree.
2. Do not overwhelm the viewer with a giant wall of JSX before the basic loop is clear.
3. Do not try to prove every supported block type in one uninterrupted shot.
4. Do not rely on subtle diffs that are hard to see in the browser.
5. Do not require scrolling to discover the main effect in the early chapters.
6. Do not claim instantaneous public-share propagation; this demo targets the canonical logged-in Notion page.
7. Do not let browser automation or recording overlays distract from the product story.
8. Do not present the sync script as magical; it should read like a repeatable engineering workflow.

## Visual Language

Left side:

- `Ghostty` window with one `tmux` session
- top pane: the standalone TSX source file
- bottom pane: sync command and structured sync summary

Right side:

- dedicated CDP-controlled Chrome window
- logged-in manual demo page
- no personal browser windows

Shared principles:

- both windows must remain visible together in all final screenshots and video frames
- the changed browser content should remain near the vertical center of attention
- the left pane should highlight the exact edited line whenever possible

## Story Structure

The full demo should be around 60-90 seconds.

Recommended progression:

1. Chapter 0: Clear the page
2. Chapter 1: Establish the loop
3. Chapter 2: Add structure
4. Chapter 3: Add richer block composition
5. Chapter 4: Show an intentional refactor, not just additive growth
6. Chapter 5: Land on a page that is clearly more sophisticated than where we started

## Screenplay Beat Sheet

### Chapter 0 — Empty Page

Time:

- `00:00-00:08`

Goal:

- prove the demo really starts from a clean slate

On screen:

- left top pane shows the smallest possible TSX module
- right page shows only the existing Notion page title with an empty body

Validation:

- Notion API read of the page body must be empty
- bottom pane must show a structured sync summary, including duration and Notion API call count

### Chapter 1 — Hello World

Time:

- `00:00-00:12`

Goal:

- make the audience understand the mechanic in one glance

On screen:

- left top pane shows a tiny TSX file
- right page is almost empty except for a simple page title and one short paragraph

Source state:

- `syncMarker = "manual-demo-v1"`
- page contains:
  - title
  - one short explanatory paragraph
  - one small callout showing the marker

Action:

- viewer sees the file in a clearly minimal state
- bottom pane runs the sync command and prints a structured sync summary
- right page refreshes to the same minimal page

What the audience should learn:

- the left file is the source of truth
- the right page is a real Notion page
- sync is explicit and repeatable

Validation:

- combined screenshot must show both windows
- browser screenshot must show the minimal page with `manual-demo-v1`
- tmux screenshot must show the file and a successful sync summary with duration and Notion API calls

### Chapter 2 — First Visible Mutation

Time:

- `00:12-00:22`

Goal:

- prove that a tiny source change creates a tiny visible page delta

Action:

- top pane edits exactly one line:
  - `syncMarker = "manual-demo-v1"` -> `syncMarker = "manual-demo-v2"`
- bottom pane reruns the sync command
- browser updates from `manual-demo-v1` to `manual-demo-v2`

What the audience should learn:

- the loop is real
- we can reason about one change at a time

Validation:

- source file on disk must contain `manual-demo-v2`
- canonical Notion API must return `manual-demo-v2`
- browser screenshot must visibly show `manual-demo-v2`
- final combined frame must show both source and page on `manual-demo-v2`

### Chapter 3 — Grow Into Structure

Time:

- `00:22-00:40`

Goal:

- transition from toy page to meaningful Notion structure

Action:

- refactor the file from one minimal section into a small structured page
- add:
  - one heading
  - one callout
  - one short bullet list
  - one compact checklist

Design rule:

- the whole page should still remain above the fold

What the audience should learn:

- this is not limited to a single paragraph
- the page structure is still straightforward React composition

Validation:

- chapter-specific screenshot must show all new blocks above the fold
- tmux top pane should show a small but legible JSX tree, not a huge file dump

### Chapter 4 — Refactor, Don’t Just Append

Time:

- `00:40-00:58`

Goal:

- show that maintainable authoring matters as much as rendering

Action:

- extract repeated data into a small array or config object
- map over it to produce at least one repeated block type
- rerun sync

Example:

- checklist items move from repeated explicit JSX nodes to mapped data

What the audience should learn:

- this scales like normal React code
- page complexity can be managed through refactoring, not only manual block authoring

Validation:

- top pane should show the refactor clearly enough that the viewer notices a qualitative change
- browser page should remain visually correct after the refactor

### Chapter 5 — Credible End State

Time:

- `00:58-01:15`

Goal:

- end on a page that feels real enough to justify the tool

Action:

- final sync lands a compact but rich page containing:
  - title
  - summary
  - prominent status callout
  - one list
  - one checklist
  - one small nested structural concept such as a toggle or a section grouping

What the audience should learn:

- we started from hello world
- we ended with a non-trivial Notion page
- the path from simple to richer structure was incremental and understandable

Validation:

- final browser screenshot should look like a credible small working page
- final combined frame should show a richer TSX file on the left and the richer Notion page on the right

## Required Validation Workflow

Every chapter needs explicit evidence. We should not trust the recording by inspection alone.

For each chapter transition, collect:

1. `combined frame`
   - one screenshot of both visible windows together
2. `source proof`
   - either a top-pane screenshot or a direct file read showing the intended source state
3. `sync proof`
   - bottom-pane successful timing output
4. `browser proof`
   - screenshot of the dedicated CDP browser page
5. `canonical page proof`
   - direct Notion API read for the most important changed content

Tracked workflow:

- chapter model:
  - `src/demo/manual-video/chapters.ts`
- source emitter:
  - `src/demo/manual-video/emit-source.ts`
- validator:
  - `src/demo/manual-video/validate.ts`
- recording script:
  - `scripts/manual-video/record-full-demo.sh`

Required validation outputs per chapter:

1. `emit-source.json`
   - proves which tracked chapter was materialized into the visible demo source file
2. `top-pane.txt`
   - captures the visible source buffer as tmux text proof
3. `bottom-pane.txt`
   - captures the sync command and the `Executed in ...` timing proof
4. `combined.png`
   - one screenshot with both the Ghostty and Chrome windows together
5. `browser.png`
   - dedicated browser crop for close inspection
6. `terminal.png`
   - dedicated terminal crop for close inspection
7. `page-plain-text.txt`
   - flattened Notion block text from the canonical page via API
8. `validation-report.json`
   - machine-readable pass/fail report for the chapter

## Acceptance Criteria For The Final Demo

The demo is acceptable only if all of the following are true:

1. The video starts from a truly simple page, not a dense prebuilt page.
2. The first visible mutation is a single obvious line change.
3. The browser side shows the actual change the viewer expects.
4. The video never relies on the public share page.
5. The recorded region contains both windows together for the whole clip.
6. The browser content remains readable without zooming or hunting.
7. The progression from minimal to richer structure feels intentional.
8. The final state is more complex than the initial state but still legible.
9. The validation artifacts for each chapter exist and are named clearly.

## Implementation Notes For The Automation Script

The implementation script should mirror the chapters, not just "change random text and record."

Suggested automation phases:

1. `reset`
   - restore canonical source baseline
   - sync baseline into the manual demo page
   - reload CDP browser
   - capture baseline screenshots
2. `chapter-1`
   - record hello-world baseline
3. `chapter-2`
   - edit marker
   - wait for file save confirmation
   - sync
   - reload CDP browser if needed
   - verify marker via API and screenshot
4. `chapter-3`
   - apply structural expansion patch
   - sync
   - verify above-the-fold composition
5. `chapter-4`
   - apply refactor patch
   - sync
   - verify visual parity after refactor
6. `chapter-5`
   - apply final richer page patch
   - sync
   - capture final combined frame and final browser close-up

## Planned Script Variants

We should likely maintain several small standalone TSX states rather than one giant mutating file:

- `chapter-1-hello-world.tsx`
- `chapter-2-marker-change.tsx`
- `chapter-3-structured-page.tsx`
- `chapter-4-refactored-page.tsx`
- `chapter-5-final-page.tsx`

Alternative:

- keep one main file and patch it between chapters

Recommendation:

- keep one visible main file for the audience
- derive each chapter from scripted patches so the progression is authored and reviewable

## Resolved Direction

1. Browser update cadence
   - Prefer Notion's own live update behavior.
   - Do not intentionally trigger a visible browser reload in the main demo unless validation proves the page would otherwise stay stale.
2. Sync execution model
   - Show the sync loop clearly enough that the audience sees a real engineering workflow.
   - A follow-up iteration may keep an always-on auto-sync process running, but the current demo must still surface an explicit update line proving a sync occurred.
3. Final page richness
   - The demo should land on a compact but clearly hierarchical page.
   - Use headings, callouts, lists, checklists, and at least one nested structural concept such as a toggle.
4. Overlays and narration
   - Text overlays are useful and should be supported by the script metadata.
   - The first priority is a validated chaptered run; polishing narration timing comes after the workflow is trustworthy.

## Current Recommendation

Build the demo in two layers:

1. narrative layer
   - this document
2. execution layer
   - chaptered automation scripts with screenshot-based validation gates and explicit API evidence

The chapter model should stay the single source of truth for:

- the visible TSX source emitted into the tmux pane
- the expected on-screen narrative for each chapter
- the validation strings that prove the Notion page actually reached the intended state

The next step is not "record more." The next step is to keep refining the chapter states and the pacing while the validator continues to prove that each beat matches the intended on-screen outcome.
