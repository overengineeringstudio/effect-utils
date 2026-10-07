# Changelog fragments

Each PR adds a new `changelog.d/<branch-slug>.<section>.md` file instead of
editing `CHANGELOG.md`. Use a descriptive lowercase kebab-case slug, unique to
that PR; a PR number is not needed before opening it. Do not reuse or modify
another PR's fragment to satisfy the check.

Sections retain the existing changelog taxonomy and order:

| Filename suffix | Changelog heading | Use                                          |
| --------------- | ----------------- | -------------------------------------------- |
| `.added.md`     | Added             | New features                                 |
| `.fixed.md`     | Fixed             | Bug fixes                                    |
| `.changed.md`   | Changed           | Behavior changes, including breaking changes |
| `.removed.md`   | Removed           | Removed features or APIs                     |

Write Markdown bullets with user-facing descriptions, links and indented
continuation text as needed; do not add headings. Multiple bullets or fragments
are allowed when a PR spans sections. For example,
`changelog.d/cache-admission.fixed.md`:

```markdown
- Cache admission distinguishes DNS failures from TLS failures.
  Diagnostics retain elapsed time without exposing credentials.
```

For breaking changes, include migration instructions in the fragment, keep the
`!` commit/PR title marker, and retain the `BREAKING CHANGE:` commit footer.

## Checks and exemptions

`devenv tasks run changelog:check` validates all pending fragments and the
changelog's Unreleased section. CI runs it and `changelog:test` inside the
existing required `pr/quality` gate. On `pull_request` events it also compares
the actual PR head with its merge base (not GitHub's synthetic merge commit)
and requires at least one added, valid fragment. Merge-group and main-push runs
validate the combined fragment set; individual PR coverage is checked before
queue admission. No branch-protection check names change.

A PR with no user-facing change may instead put an explicit Git trailer on
its **latest commit**, separated from the message by a blank line:

```text
Changelog-None: Tests only; no user-facing behavior changes
```

The reason must be nonempty. The exemption applies to the whole PR and remains
a reviewer decision, not a classification guessed by CI. A later commit must
retain the trailer if the PR still needs the exemption. Adding it requires a
new/amended commit and therefore the normal `synchronize` CI event; no label,
PR-body edit trigger or API write permission is needed. Release-assembly PRs
use this trailer because their entries come from already-reviewed fragments.
Local checks outside a PR event validate content without requiring a committed
fragment; CI is authoritative for PR coverage.

## Release assembly

The release maintainer runs `devenv tasks run changelog:assemble` in the release
PR **before** renaming `## Unreleased` to the release version or date. The task
sorts fragments bytewise by filename within each section, prepends their
entries to existing entries, and creates missing sections in taxonomy order.
It writes `CHANGELOG.md` and removes the consumed fragments, leaving this
README. Commit that changelog edit and the fragment deletions together. The
assembler does not choose versions, publish packages, create tags, or rewrite
released history. Running it again with no fragments leaves the log unchanged.
Do not run it in ordinary feature/fix PRs: that would recreate the shared-file
merge conflict.

There is no repository-wide version-cut/release workflow to hook into today;
CI's main-push product publishing is not a changelog release. Assembly is an
explicit release-maintainer task, not a periodic job. Existing consumers keep
reading `CHANGELOG.md`, which remains the human-readable release record; the
fragment directory contains the pending entries between releases. Tests run
with `devenv tasks run changelog:test`.

## Migration

Existing `## Unreleased` entries stay in `CHANGELOG.md` unchanged. Only new PRs
add fragments. The first assembly merges the two sources without duplicating
legacy entries. PRs already in flight when this policy lands add a fragment (or
a justified exemption) on their next update and move their own unmerged
changelog entry into it. Do not migrate other PRs' entries or historical
releases.
