import { readdirSync } from 'node:fs'

/** Committed schema files shared by the Cargo build script, Buck inputs, and Nix source closure. */
export const agentTraceSchemaBuildInputs = readdirSync(new URL('../generated/', import.meta.url), {
  withFileTypes: true,
})
  .filter((entry) => entry.isFile() && entry.name.endsWith('.schema.json'))
  .map(({ name }) => ({
    path: `flakes/agent-trace/generated/${name}`,
    label: `//flakes/agent-trace:${name}`,
  }))
  .toSorted((left, right) => left.path.localeCompare(right.path))
