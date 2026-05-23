# Notion Markdown Sync Vision

## The Problem

**Problem 1:** Notion pages are not portable as complete Markdown documents. Body content, page properties, comments, files, child pages, databases, and schema live on different Notion API surfaces.

**Problem 2:** Blind Markdown pushes can overwrite remote edits, delete out-of-band content, or turn local sync metadata into visible page content.

**Problem 3:** Notion enhanced Markdown is useful but not lossless for every Notion feature. Unsupported blocks, media files, comments, data-source schemas, and synced content need preservation outside the body string.

**Problem 4:** Humans and agents need an inspectable local format that can be reviewed, merged, tested, and diagnosed without depending on transient Notion URLs or hidden client state.

**Problem 5:** Sync failures need to be observable. Without structured errors, traces, and reproducible E2E fixtures, sync correctness degrades into manual debugging.

## The Vision

- Notion enhanced Markdown is the canonical interchange format for page body content.
- A synced page is modeled as multiple explicit surfaces: body, page metadata, properties, data-source schema, comments, files, unsupported blocks, and local review state.
- Local state is durable, inspectable, and portable through versioned `.nmd` files plus a content-addressed object store for large or volatile artifacts.
- The sync engine is Effect-native: services have typed dependencies, schemas validate every untrusted boundary, errors are explicit, resources are scoped, and watch mode is interruptible.
- Every sync operation emits useful OpenTelemetry spans and attributes so failures can be traced by page, file, surface, and operation.
- Production confidence comes from real E2E verification against Notion, not only unit tests or assumptions about Markdown syntax.

## What This Is Not

- It is not a replacement syntax for Notion enhanced Markdown.
- It is not a complete offline Notion clone.
- It is not a last-writer-wins backup tool.
- It is not a generic Markdown formatter.
- It is not a hidden metadata layer inside visible Markdown body content.
- It is not a way to bypass Notion permissions or ownership semantics.

## Success Criteria

1. A user can pull a Notion page to local state, inspect and edit the body as Notion enhanced Markdown, and push changes without sending local metadata as page content.
2. A normal push refuses to overwrite changed remote body content or delete unsupported/child content unless the user chooses an explicit destructive mode.
3. Page properties and data-source rows round-trip through typed schemas instead of being flattened into body Markdown.
4. Unsupported blocks and file artifacts are preserved through stable placeholders and content-addressed objects.
5. Watch mode can run continuously, coalesce local and remote changes, and shut down without orphaned work.
6. Every CLI command and watch pass produces traceable Effect spans with enough attributes to diagnose Notion API, filesystem, merge, and validation failures.
7. Supported body features are backed by E2E fixtures that create, pull, compare, and clean up real Notion pages.
