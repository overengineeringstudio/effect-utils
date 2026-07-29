# Pattern: terminal-prompt-pty

**Area:** Platform / Terminal / CLI Prompt **Kind:** semantic **Our usage:** `tui-react` and
`pty-effect` depend on raw-mode lifecycle, key decoding, resize behavior, interrupts, and terminal
control bytes.

## v3

```ts
import { Prompt } from '@effect/cli'
import { Terminal } from '@effect/platform'
import { NodeContext } from '@effect/platform-node'
```

## v4

```ts
import { Terminal } from 'effect/Terminal'
import { Prompt } from 'effect/unstable/cli'
import { NodeServices } from '@effect/platform-node'
```

## Equivalence

This probe genuinely requires an interactive terminal. Each side is run under util-linux
`script`, which allocates a pseudo-terminal; piped stdin is not an adequate substitute.

```sh
bun run run terminal-prompt-pty
```

Result: **ALLOWLISTED, 2 exact paths, 0 unexpected**. Five same-major repetitions were stable on
each side.

Identical semantic observations:

- stdin transitions cooked -> raw -> cooked (`false`, `true`, `false`);
- `a`, Up (`ESC [ A`), standalone Escape, and Ctrl-C decode to the same input/key/modifier fields;
- a real PTY resize plus `SIGWINCH` changes Terminal dimensions from 80x24 to 101x37;
- Effect interruption restores cooked mode;
- Down + Enter selects `beta`;
- Ctrl-C quits Prompt, rings the bell, restores cursor visibility, and restores cooked mode.

The two allowlisted paths preserve exact PTY transcript bytes and expose a rendering difference:
Prompt selection is 452 bytes in v3 versus 356 in v4; interrupted Prompt is 136 versus 104. v4
uses shorter ANSI SGR/reset sequences. Visible text and semantic cleanup are unchanged, but encoded
bytes are not.

## Intended differences (alignment register entries)

- `prompt-pty-ansi-rendering`: keep this as a migration review item, not a blanket accepted
  difference. Raw-byte snapshots, parsers, and inline-renderer cleanup may depend on the sequence
  shape. A package may accept the shorter v4 rendering only after its PTY and visual contracts pass.

## Gotchas

- Never test `Terminal` / `Prompt` behavior through ordinary pipes: `stdin.isTTY`, raw mode,
  cursor control, and resize behavior would all be bypassed.
- Resize requires changing PTY dimensions and delivering `SIGWINCH`; changing dimensions alone
  can leave Node/Bun's cached `stdout.columns` and `stdout.rows` stale.
- v4 removes `Terminal.isTTY` from the service interface. The runtime TTY observation remains
  available from the platform stream, but call sites using the service member need semantic repair.
- `QuitException` becomes `QuitError`; the probe normalizes the class name to the shared `Quit`
  behavior while preserving exact output bytes.

## Codemod rule

Prompt and Terminal import moves are mechanical only after the owning package's real-PTY replay
passes. Do not rebaseline ANSI snapshots or replace raw-mode lifecycle code mechanically.
