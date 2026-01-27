// tui-core has no workspace deps - standalone package
// Only include itself, no siblings needed
export default {
  data: { packages: ['.'] },
  stringify: () => `packages:\n  - .\n`,
}
