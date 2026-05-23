# Notion Test Environment

This document describes the Notion workspace structure used for integration tests.

## Prerequisites

- A Notion integration token with access to the test workspace
- Set `NOTION_API_TOKEN` environment variable with the integration token

## Workspace Structure

The test environment is organized under a root page titled **"@overeng/notion-effect-client API test env"**.

```
@overeng/notion-effect-client API test env (root)
├── Test Database                 # Original test database (3 rows)
├── Page with Blocks             # Various block types for content tests
├── Empty Page                   # Mutation testing (skipped in CI)
├── Nested Page                  # Deeply nested blocks
├── Rich Text Page               # Rich text formatting tests
├── Dump Test Database           # All property types (10 rows)
├── Large Database               # Pagination testing (60 rows)
└── Deep Nesting Test            # Deeply nested content for dump tests
```

## Test Fixtures

### Original Fixtures

| Fixture                   | ID                                     | Description                                     |
| ------------------------- | -------------------------------------- | ----------------------------------------------- |
| Root Page                 | `2dbf141b18dc8133b921c786d2b00ecf`     | Container for all test content                  |
| Test Database             | `2adfbc6627894baf94e5e919a826c3f4`     | Basic database with 3 rows (alpha, beta, gamma) |
| Test Database Data Source | `7d8ab748-1f94-4211-a128-883256e3f559` | Data source ID for typed queries                |
| Page with Blocks          | `2dbf141b18dc8134b0a3e197c32ca3e8`     | Various block types                             |
| Empty Page                | `2dbf141b18dc818e8439ec9ff7d889eb`     | For mutation tests                              |
| Nested Page               | `2dbf141b18dc8171939df328b6ad9735`     | Nested block structure                          |
| Rich Text Page            | `2dbf141b18dc8180965adcff3dd7178b`     | Rich text formatting                            |

### Dump Test Fixtures

These fixtures were added for testing the `db dump` command:

| Fixture                    | ID                                     | Description                        |
| -------------------------- | -------------------------------------- | ---------------------------------- |
| Dump Test Database         | `c6b692f0cf31480e947d10515bc8c76b`     | All property types (10 rows)       |
| Dump Database Data Source  | `0c1a5e93-8e49-40bd-a6ab-d4b0ce633110` | Data source for Dump Test Database |
| Large Database             | `cbf559db334c4095ab5c5839a7612560`     | Pagination testing (60 rows)       |
| Large Database Data Source | `6b35c0bf-a4ad-4346-b1b0-565005fcdc66` | Data source for Large Database     |
| Deep Nesting Page          | `2e2f141b18dc8102969ff7b34cad3629`     | Deeply nested content blocks       |

## Dump Test Database Schema

The Dump Test Database includes all supported property types for comprehensive testing:

| Property    | Type             | Notes                          |
| ----------- | ---------------- | ------------------------------ |
| Name        | Title            | Page title                     |
| Status      | Status           | Not started, In progress, Done |
| Priority    | Select           | Low, Medium, High              |
| Tags        | Multi-select     | Feature, Bug, Docs, Test       |
| Due Date    | Date             | Various dates                  |
| Assignee    | People           | Test users                     |
| Email       | Email            | Test emails                    |
| URL         | URL              | Test URLs                      |
| Phone       | Phone            | Test phone numbers             |
| Checkbox    | Checkbox         | Boolean field                  |
| Number      | Number           | Numeric values                 |
| Notes       | Rich text        | Descriptive text               |
| Created     | Created time     | Auto-generated                 |
| Last edited | Last edited time | Auto-generated                 |

### Sample Rows

The database contains 10 rows (Row 1 through Row 10) with varied data:

- Rows 1-3: Status "Done", High priority
- Rows 4-6: Status "In progress", Medium priority
- Rows 7-10: Status "Not started", Low priority

## Large Database

The Large Database contains 60 rows (Item 001 through Item 060) to test pagination:

- Page size of 100 fits all items in one request
- Useful for verifying streaming/pagination logic with smaller page sizes

## Deep Nesting Page

The Deep Nesting page contains content structure with multiple levels of nesting:

```
# Deep Nesting Test Page
├── Level 1 Content (toggle)
│   ├── Level 2 Content (toggle)
│   │   └── Level 3 Content (toggle)
│   │       └── Level 4 nested paragraph
│   └── Bulleted list at Level 2
├── Numbered list at Level 1
├── Toggle with mixed content
│   ├── Paragraph
│   ├── Code block
│   └── Callout
├── Quote block
└── Divider
```

This structure tests recursive block fetching with configurable depth limits.

## Test Configuration

Tests use the `setup.ts` file which exports:

- `SKIP_INTEGRATION` - Set to `true` when `NOTION_API_TOKEN` is not available
- `SKIP_MUTATIONS` - Set to `true` in CI to prevent fixture corruption
- `TEST_IDS` - Object containing all fixture IDs
- `NotionConfigLive` - Layer with configured Notion token
- `IntegrationTestLayer` - Complete layer for integration tests

## Running Tests

```bash
# Run all tests
dt test:run

# Run only this package's tests
dt test:notion-effect-client

# Run integration tests (playwright)
dt test:integration
```

## Maintaining Fixtures

When modifying test fixtures:

1. Update the fixture in Notion using the Notion MCP or web interface
2. Update `TEST_IDS` in `setup.ts` if IDs change
3. Update this documentation if structure changes
4. Ensure changes don't break existing tests

Mutation tests are automatically skipped in CI (`SKIP_MUTATIONS=true`) to prevent accidental fixture corruption during automated test runs.
