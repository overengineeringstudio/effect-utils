# @overeng Effect Utils

A collection of [Effect](https://effect.website) utilities and integrations.

## Packages

### Notion Integration

| Package | Description |
|---------|-------------|
| [@overeng/notion-effect-client](./packages/@overeng/notion-effect-client) | Effect-native HTTP client for the Notion API |
| [@overeng/notion-effect-schema](./packages/@overeng/notion-effect-schema) | Effect schemas for Notion API types |
| [@overeng/notion-effect-schema-gen](./packages/@overeng/notion-effect-schema-gen) | CLI tool for Notion schema generation |

### Schema Forms

| Package | Description |
|---------|-------------|
| [@overeng/effect-schema-form](./packages/@overeng/effect-schema-form) | Headless form component for Effect Schemas |
| [@overeng/effect-schema-form-aria](./packages/@overeng/effect-schema-form-aria) | React Aria implementation with Tailwind CSS ([Storybook](https://overeng-effect-utils-schema-form-aria.vercel.app)) |

### React Integration

| Package | Description |
|---------|-------------|
| [@overeng/effect-react](./packages/@overeng/effect-react) | React integration for Effect runtime |
| [@overeng/react-inspector](./packages/@overeng/react-inspector) | DevTools-style inspectors with Effect Schema support ([Storybook](https://overeng-effect-utils-react-inspector.vercel.app)) |

## Development

```bash
pnpm install
pnpm build
pnpm test
```

### Type Checking

```bash
pnpm tsc --build tsconfig.all.json
```

### Running Tests

```bash
# Unit tests only
pnpm test:unit

# Integration tests (requires NOTION_TOKEN)
NOTION_TOKEN=secret_xxx pnpm test:integration

# All tests
NOTION_TOKEN=secret_xxx pnpm test
```
