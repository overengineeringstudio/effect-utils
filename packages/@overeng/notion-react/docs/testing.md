# Testing

How `@overeng/notion-react` is tested and which tests to run when. The
strategy is intentionally layered — pick the cheapest layer that can
falsify your change before escalating.

Three layers:

- **Unit tests** (`src/**/*.unit.test.tsx`) — pure reconciler + component
  behaviour, no network. Run on every change.
- **Mock-client integration tests** (`src/test/integration/*` with the mock
  Notion client) — full reconciler ↔ client loop without hitting Notion.
  Gated in CI.
- **Live-Notion integration tests** — run locally against a real Notion
  workspace. Required when changing block projection or mutation ordering.

<!-- TODO: list the exact commands for each layer (pnpm scripts) -->
<!-- TODO: document how to point the live-integration suite at a Notion workspace -->
<!-- TODO: decision table: "I changed X → run layer Y" -->
<!-- TODO: reference src/test/mock-client.ts and src/test/integration/setup.ts -->
