/**
 * Ambient declarations for bundler asset imports (e.g. `import '@xterm/xterm/css/xterm.css'`,
 * which the bundler injects as a side effect).
 *
 * This file is loaded via a `/// <reference path>` directive from each module that imports such an
 * asset, NOT via a tsconfig `include` glob. That distinction is the fix for #837: a floating
 * ambient `.d.ts` only enters the program whose tsconfig globs it in, so it does not ride along
 * when a downstream consumer compiles our source through `exports`-resolution — and the side-effect
 * import then fails with TS2882. A triple-slash reference is part of the importing file's own load
 * graph, so the declaration travels into every program that compiles that file.
 */

declare module '*.css' {}
