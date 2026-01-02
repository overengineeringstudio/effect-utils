# @overeng Effect Utils

A collection of production-ready [Effect](https://effect.website) utilities and integrations.

## Packages

### Notion Integration

Full-featured Effect-native Notion API client with type-safe schema generation.

#### [@overeng/notion-effect-client](./packages/@overeng/notion-effect-client)
Effect-native HTTP client for the Notion API with typed queries

- **Schema-aware queries** - Pass Effect schemas to get fully typed results with automatic decoding
- **Markdown conversion** - Convert pages/blocks to Markdown with customizable transformers
- **Streaming API** - Auto-pagination via Effect Streams for all list operations

#### [@overeng/notion-effect-schema](./packages/@overeng/notion-effect-schema)
Comprehensive Effect schemas for all Notion API types

- **Complete coverage** - Schemas for all 27 block types and 21+ property types
- **Property transforms** - `asString`, `asNumber`, `asOption` variants for ergonomic access
- **Write support** - Dedicated write schemas for creating/updating pages

#### [@overeng/notion-effect-cli](./packages/@overeng/notion-effect-cli)
CLI tool to generate type-safe schemas from your Notion databases

- **Schema generation** - Generate typed schemas from live Notion databases
- **Drift detection** - Track schema changes with `diff` command for CI/CD
- **API wrapper generation** - Generate typed CRUD operations with `--include-api`

### Schema Forms

Headless form library for Effect Schemas with accessible React Aria implementation.

| Package | Description |
|---------|-------------|
| [@overeng/effect-schema-form](./packages/@overeng/effect-schema-form) | Headless form component with schema introspection |
| [@overeng/effect-schema-form-aria](./packages/@overeng/effect-schema-form-aria) | Styled React Aria components with Tailwind CSS ([Storybook](https://overeng-effect-utils-schema-form-ar.vercel.app)) |

- **Schema introspection** - Automatically generate form fields from Effect Schema structure
- **Headless architecture** - Bring your own components or use pre-built React Aria implementation
- **Tagged struct support** - Automatic handling of discriminated unions with labeled groups
- **Flexible rendering** - Provider pattern, render props, or hooks API for full control
- **Accessible by default** - React Aria Components with WCAG compliance

### React Integration

React hooks and utilities for building Effect-powered applications.

| Package | Description |
|---------|-------------|
| [@overeng/effect-react](./packages/@overeng/effect-react) | React integration for Effect runtime with hooks and context providers |
| [@overeng/react-inspector](./packages/@overeng/react-inspector) | DevTools-style inspectors with Effect Schema support ([Storybook](https://overeng-effect-utils-react-inspecto.vercel.app)) |

- **EffectProvider** - Initialize Effect runtime from a Layer and provide to React tree
- **Hooks API** - `useEffectRunner`, `useEffectCallback`, `useEffectOnMount` for running effects in components
- **Automatic error handling** - Built-in error boundaries with custom error components
- **DevTools inspectors** - Browser-style object/table inspectors with Effect Schema awareness
- **Type-safe runtime access** - Direct access to Effect runtime for advanced use cases

### Utilities

| Package | Description |
|---------|-------------|
| [@overeng/utils](./packages/@overeng/utils) | Distributed locks plus workspace-aware command helpers |

Key features:

- Workspace-aware command helpers with optional logging/retention
- Effect-native CWD and workspace root services for Node tooling
- File system-backed distributed locks with TTL expiration and atomic operations

## Quick Start

### Install Dependencies

```bash
pnpm install
```

### Build All Packages

```bash
pnpm build
```

### Run Tests

```bash
# Unit tests only
pnpm test:unit

# Integration tests (requires NOTION_TOKEN for Notion packages)
NOTION_TOKEN=secret_xxx pnpm test:integration

# All tests
NOTION_TOKEN=secret_xxx pnpm test
```

### Type Checking

Continuous type checking across the entire monorepo:

```bash
pnpm typecheck:watch
```

Or one-off type check:

```bash
pnpm typecheck
```

### Linting

```bash
# Check for issues
pnpm lint

# Auto-fix issues
pnpm lint:fix
```

## Package Structure

Each package follows modern ESM conventions:

- Source files in `src/` (TypeScript with `.ts` extension)
- Entry point at `src/mod.ts`
- Compiled output in `dist/` (gitignored)
- Development exports point to source files
- Published exports point to compiled JavaScript

## Contributing

This monorepo uses:

- **pnpm workspaces** for package management
- **TypeScript project references** for incremental builds
- **Biome** for linting and formatting
- **Vitest** for testing
- **Effect** for core functionality

See individual package READMEs for package-specific documentation.
