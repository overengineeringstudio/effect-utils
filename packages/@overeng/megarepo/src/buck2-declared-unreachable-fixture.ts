/**
 * Benchmark-only production input proving the current package-level Buck closure is coarse.
 * It is deliberately not imported by the mr entrypoint and must not gain runtime behavior.
 */
export type Buck2DeclaredUnreachableFixture = 'package-level-input-boundary'
