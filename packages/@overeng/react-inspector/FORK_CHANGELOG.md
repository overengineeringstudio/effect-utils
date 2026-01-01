# Fork Changelog

This document tracks all changes made in this fork relative to [upstream storybookjs/react-inspector](https://github.com/storybookjs/react-inspector).

## Keeping This Changelog Up to Date

**Important:** This changelog must be updated whenever:

1. **Adding fork-specific changes** - Document every modification made in this fork
2. **Syncing with upstream** - Note the upstream commit/tag synced to and any merge conflicts resolved
3. **Removing fork changes** - If a feature is merged upstream and removed from the fork

Each entry should include:
- Date of change
- Brief description of what changed
- Link to relevant PR/commit if applicable

---

## Upstream Base

**Last synced:** 2024-12-17
**Upstream commit:** `c0cfe13` (HEAD of main)
**Upstream version:** 8.0.0

---

## Fork Principles

**Keep changes isolated**: New features should be implemented in new files whenever possible, with minimal modifications to existing upstream files. This makes it easier to:
- Track fork-specific changes
- Sync with upstream updates
- Review and maintain the fork

## Fork Changes

### Planned

- [ ] Minor improvements and fixes

### Added

#### Effect Schema Support (2024-12-17)

Optional support for Effect Schema annotations to enrich the inspector display.

**New files added** (all in `src/schema/`):
- `effectSchema.tsx` - Core utilities for extracting Effect Schema annotations
- `SchemaContext.tsx` - React context for passing schema info down the tree
- `SchemaAwareObjectInspector.tsx` - HOC to add schema support to ObjectInspector
- `SchemaAwareObjectValue.tsx` - Schema-aware wrapper for ObjectValue
- `SchemaAwareObjectPreview.tsx` - Schema-aware wrapper for ObjectPreview
- `mod.tsx` - Module exports

**New story added**:
- `stories/effect-schema.stories.tsx` - Storybook stories demonstrating schema features

**Minimal changes to existing files**:
- `package.json` - Added `effect` as optional peer dependency
- `src/index.tsx` - Added re-exports for schema utilities (clearly marked section)

**Features**:
- `withSchemaSupport(ObjectInspector)` - HOC to create a schema-aware inspector
- `SchemaProvider` - Context provider for schema information
- Uses schema `title` or `identifier` annotation for type names
- Uses schema `pretty` annotation for custom value formatting
- Supports nested schemas for struct fields and array elements

**Usage**:
```tsx
import { ObjectInspector, withSchemaSupport, SchemaProvider } from '@overeng/react-inspector';
import { Schema } from 'effect';

const UserSchema = Schema.Struct({
  id: Schema.Number,
  name: Schema.String,
}).annotations({ title: 'User' });

// Option 1: Using HOC
const SchemaInspector = withSchemaSupport(ObjectInspector);
<SchemaInspector data={user} schema={UserSchema} />

// Option 2: Using SchemaProvider directly
<SchemaProvider schema={UserSchema}>
  <ObjectInspector data={user} />
</SchemaProvider>
```

#### Netlify Configuration (2024-12-17)

- Add `netlify.toml` for Storybook deployment ([PR #4](https://github.com/overengineeringstudio/react-inspector/pull/4))
  - Configures Netlify with Node 22, corepack, and correct build/publish settings

### Changed

#### Condensed Preview for Expanded Nodes (2024-12-17)

When using schema-aware inspectors, expanded objects now show only the type identifier instead of the full inline preview.

**Before**: `Order {orderId: "ORD-2024-001", customer: "John Doe", items: Array(2), ...}` (always)

**After**:
- Collapsed: `Order {orderId: "ORD-2024-001", customer: "John Doe", ...}` (full preview)
- Expanded: `Order` (just identifier, since children are visible below)

This reduces visual clutter when exploring expanded objects, as the full preview is redundant when all properties are already visible in the tree.

**Files modified**:
- `src/schema/SchemaAwareNodeRenderer.tsx` - Added `expanded` prop handling to show condensed view

**New story added**:
- `stories/effect-schema.stories.tsx` - Added "Expanded vs collapsed preview" story to demonstrate

#### Workspace exports now point to source (2025-12-21)

Exports now resolve to `src/` in the workspace, with `publishConfig.exports` pointing at `dist/` for published builds.

**Files modified**:
- `package.json` - Updated `exports` and added `publishConfig.exports` mapping

### Fixed

#### Schema-aware preview uses path-aware context for inline previews (2025-12-21)

Inline previews now resolve field schemas from the correct path so nested objects display their schema identifiers instead of falling back to "Object". Expanded complex objects also suppress inline previews even when no identifier is present.

**Files modified**:
- `src/schema/SchemaAwareNodeRenderer.tsx` - Wrap previews with path-scoped SchemaProvider and hide inline preview on expanded objects

#### Workspace exports use dist typings (2025-12-21)

Workspace consumers resolve types from `dist/index.d.ts` while keeping runtime imports on `src/index.tsx`, avoiding NodeNext resolution issues without altering upstream source files.

**Files modified**:
- `package.json` - Added `types` condition in export map for workspace builds

#### React 19 + TS build compatibility for workspace references (2025-12-21)

Updated a small set of files so the package typechecks under the monorepo compiler settings without large refactors.

**Files modified**:
- `tsconfig.json` - Allowed `.tsx` import extensions for schema files
- `src/dom-inspector/DOMNodePreview.tsx` - Replaced `ReactChild` with `ReactNode`
- `src/tree-view/pathUtils.ts` - Avoided `never[]` inference for wildcard paths
- `src/tree-view/TreeView.tsx` - Adjusted `memo` typing to accept props
- `src/utils/propertyUtils.tsx` - Guarded possibly-undefined property descriptors

#### Enable declaration output for workspace references (2025-12-21)

React-inspector now emits `dist/*.d.ts` during the monorepo build, keeping workspace types up to date without manual builds.

**Files modified**:
- `tsconfig.json` - Enabled `composite` + declaration-only output to `dist`

#### Schema-aware inline preview uses identifiers for nested objects (2025-12-21)

Inline previews now use the schema-aware ObjectValue wrapper so nested object values display their schema identifier instead of "Object".

**Files modified**:
- `src/schema/SchemaAwareObjectPreview.tsx` - Swapped ObjectValue for SchemaAwareObjectValue in array/object previews

#### Schema annotations resolve through transforms and unions (2025-12-21)

Schema-aware display now unwraps transformations, refinements, suspends, and nullable/optional unions when resolving annotations for display.

**Files modified**:
- `src/schema/effectSchema.tsx` - Added AST unwrapping for transformations and unions

#### Date values not rendering with Effect Schema (2024-12-17)

Fixed an issue where `Date` values were not being rendered when using schema-aware inspectors with Effect's `Schema.DateFromSelf` or similar built-in schemas.

**Root cause**: Effect's built-in schemas have `Pretty` annotations that return formatter functions (hooks) rather than formatted strings directly. The `formatWithPretty` function was treating these function returns as valid output.

**Fix**: Added a type check to ensure `formatWithPretty` only returns string results, falling back to default rendering for non-string returns.

**Files modified**:
- `src/schema/effectSchema.tsx` - Added `typeof result === 'string'` check in `formatWithPretty`

---

## Sync History

| Date | Upstream Commit | Notes |
|------|-----------------|-------|
| 2024-12-17 | `c0cfe13` | Initial fork from upstream |
