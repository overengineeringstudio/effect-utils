export default {
  test: {
    include: ['buck2/dependencies/**/*.unit.test.ts'],
    // Assembly exercises Bun's action runtime in test:buck2-tools (pr/buck2-tools).
    exclude: ['buck2/dependencies/assemble-store.unit.test.ts'],
  },
}
