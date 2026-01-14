# TypeScript-Go (tsgo) Evaluation

**Date:** 2026-01-14
**tsgo Version:** 7.0.0-dev.20260114.1
**tsc Version:** 5.9.3

## Summary

**tsgo works for type-checking individual packages** in this monorepo. There are no fundamental blockers preventing adoption for type-checking purposes. However, there are considerations for full adoption.

## Test Results

### Individual Packages (✅ All Pass)

| Package | tsgo | tsc |
|---------|------|-----|
| @overeng/genie | ✅ Pass | ✅ Pass (+ Effect plugin suggestions) |
| @overeng/utils | ✅ Pass | ✅ Pass (+ Effect plugin suggestions) |
| @overeng/mono | ✅ Pass | ✅ Pass (+ Effect plugin suggestions) |
| @overeng/dotdot | ✅ Pass | ✅ Pass (+ Effect plugin suggestions) |

### Build Mode (`--build`)

Both `tsc` and `tsgo` show TS6310 errors ("Referenced project may not disable emit") when using `--noEmit` with build mode. This is expected behavior - the tsconfig needs adjustment for build mode to work properly with `noEmit`.

## Key Findings

### What Works

1. **Type checking** - tsgo correctly type-checks all packages with Effect.ts code
2. **Module resolution** - NodeNext module resolution works correctly
3. **tsconfig options** - ES2024 target, strictness options, and composite projects are supported
4. **rewriteRelativeImportExtensions** - Appears to work (no errors related to .ts imports)

### Known Limitations & Blockers

#### 1. Language Service Plugins NOT Supported

**Blocker for IDE experience:** The `@effect/language-service` plugin configured in tsconfig.json will NOT work with tsgo:

```json
"plugins": [
  {
    "name": "@effect/language-service",
    "reportSuggestionsAsWarningsInTsc": true
  }
]
```

**Impact:** You'll lose Effect-specific suggestions/warnings in the editor when using tsgo's language server.

**Workaround:** Use `typescript` (≤6.0) for IDE/tooling integration, and `tsgo` for type-checking speed.

**Related Issue:** TypeScript 7.0 [will not support the existing Strada API](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)

#### 2. Project References Status

Project references support was completed in November 2025:
- [Issue #529](https://github.com/microsoft/typescript-go/issues/529) - CLOSED (completed)
- [Issue #506](https://github.com/microsoft/typescript-go/issues/506) - CLOSED (duplicate of #529)

Build mode (`--build`) and `--incremental` are now supported.

#### 3. Declaration Emit

Declaration emit is "mostly complete" but some edge cases may not work. If you're only using tsgo for type-checking (not emitting), this isn't a concern.

#### 4. Watch Mode

Watch mode is functional but described as a "prototype" - it watches files and rebuilds but lacks incremental rechecking optimization.

## Performance

tsgo typically provides **7-10x speedup** over tsc for type-checking. This would significantly improve CI and development iteration times.

## Recommendations

### For CI Type-Checking Only
✅ **Ready to adopt** - Replace `mono ts` with tsgo for faster CI checks.

### For Full Replacement
⚠️ **Wait for plugin support** - The @effect/language-service plugin is valuable for Effect codebases.

### Suggested Approach

1. **Add tsgo as optional** - Keep tsc for IDE/plugin support
2. **Use tsgo in CI** - For faster type-checking in pipelines
3. **Monitor progress** - Watch for API/plugin support improvements

## Installation

```bash
bun add -d @typescript/native-preview
npx tsgo --noEmit  # or npx tsgo -b tsconfig.all.json
```

## Relevant GitHub Issues

| Issue | Status | Description |
|-------|--------|-------------|
| [#529](https://github.com/microsoft/typescript-go/issues/529) | ✅ Closed | Project references |
| [#506](https://github.com/microsoft/typescript-go/issues/506) | ✅ Closed | Composite projects |
| [#1431](https://github.com/microsoft/typescript-go/issues/1431) | Open | baseUrl removal affecting monorepos |

## mk-bun-cli Nix Integration

### Current Setup

`nix/mk-bun-cli.nix` uses tsc for type-checking (line 296):
```nix
bun "$tsc_entry" --project "$tsconfig_path" --noEmit
```

Where `$tsc_entry` is `node_modules/typescript/bin/tsc`.

### Test Results

| Fixture | tsgo | tsc |
|---------|------|-----|
| shared-lib | ✅ Pass | ✅ Pass |
| @acme/utils | ✅ Pass | ✅ Pass |

### Integration Options

#### Option 1: npm package (Recommended)

Add `@typescript/native-preview` to devDependencies and modify mk-bun-cli.nix:

```nix
# Replace tsc_entry with tsgo_entry
tsgo_entry="$package_path/node_modules/@typescript/native-preview/bin/tsgo"
if [ -f "$tsgo_entry" ]; then
  bun "$tsgo_entry" --project "$tsconfig_path" --noEmit
else
  # Fallback to tsc
  bun "$tsc_entry" --project "$tsconfig_path" --noEmit
fi
```

**Pros:** Simple, works now
**Cons:** Requires adding devDependency to each package

#### Option 2: Nix package (Recommended)

`tsgo` is available in nixpkgs unstable:

```nix
nativeBuildInputs = [ pkgsUnstable.bun pkgsUnstable.tsgo pkgs.cacert ];

# Then use directly:
tsgo --project "$tsconfig_path" --noEmit
```

**Pros:** Cleaner, no npm dependency needed, native binary
**Cons:** Requires nixpkgs unstable

### Recommendation for mk-bun-cli

**Use Option 2** (nixpkgs unstable tsgo package) - cleanest integration with the Nix build system.

### Parameter Addition

Consider adding a `typechecker` parameter to mk-bun-cli.nix:

```nix
{
  # ...existing params...
  typechecker ? "tsc",  # "tsc" or "tsgo"
}
```

This allows per-package choice without breaking existing builds.

## Resources

- [Official npm package](https://www.npmjs.com/package/@typescript/native-preview)
- [typescript-go repository](https://github.com/microsoft/typescript-go)
- [December 2025 Progress Update](https://devblogs.microsoft.com/typescript/progress-on-typescript-7-december-2025/)
- [VS Code Extension](https://marketplace.visualstudio.com/items?itemName=TypeScript.native-preview)
