/**
 * Synchronous stdout writer for the result/data channel.
 *
 * Separated from the browser-safe modules because it needs `node:fs`, matching
 * the `OutputMode.node.ts` split.
 *
 * @module
 */

import * as fs from 'node:fs'

/**
 * Shared slot backing {@link sleepSync}. `Atomics.wait` requires a
 * `SharedArrayBuffer`-backed `Int32Array`; nothing ever notifies this slot, so
 * a wait on it is just a timed park of the calling thread.
 */
const SLEEP_SLOT = new Int32Array(new SharedArrayBuffer(4))

/** How long to park before retrying a write that returned `EAGAIN`. */
const EAGAIN_PAUSE_MS = 1

/**
 * Park the current thread for `ms` milliseconds without burning CPU.
 *
 * A busy `while` loop would also work but pegs a core for as long as the pipe
 * reader is behind, which can be seconds.
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(SLEEP_SLOT, 0, 0, ms)
}

/**
 * Write `text` to stdout (fd 1), returning only once the kernel has accepted
 * every byte.
 *
 * ## Why not `process.stdout.write` / `Console.log`
 *
 * `runMain` calls `process.exit(code)` whenever the exit code is non-zero (or
 * the run was signalled). `process.exit` does not flush the async libuv write
 * queue behind `process.stdout`, so a consumer slower than the producer loses
 * everything past the ~64 KiB pipe buffer. Observed with a 949834-byte JSON
 * payload and a non-zero exit: `cmd | cat > f` captured 393216 bytes and `jq`
 * failed with `unterminated string`, while `cmd > f` was complete.
 *
 * Measured with a 900001-byte payload through a deliberately slow reader
 * (`| (sleep 1; cat) | wc -c`):
 *
 * | write strategy                                  | bun    | node   |
 * | ----------------------------------------------- | ------ | ------ |
 * | `process.stdout.write` + `process.exit(1)`      | 65536  | 65536  |
 * | `console.log` + `process.exit(1)`               | 900001 | 65536  |
 * | `process.stdout.write` + write-callback → exit   | 65536  | 900001 |
 * | `fs.writeSync(1, …)` + `process.exit(1)`        | 900001 | 900001 |
 *
 * The write-callback row is why draining before exit is not a fix: on bun the
 * callback fires before the bytes reach the pipe (and `writableNeedDrain` reads
 * `false`), so there is nothing reliable to await. Letting the process exit
 * naturally does flush, but is not available to us either — raw-mode TTY input
 * handles can keep the loop alive, so teardown must stay explicit.
 *
 * Writing straight to the fd sidesteps the queue entirely: once this function
 * returns, the data is the kernel's problem and `process.exit` cannot drop it.
 *
 * ## Why the loop
 *
 * `fs.writeSync` is only "sync" in the sense that it issues one `write(2)`.
 * Once anything in the process has instantiated `process.stdout` (a TTY probe
 * such as `isTTY`/`columns` is enough), libuv puts fd 1 into non-blocking mode,
 * and `write(2)` on a full pipe either does a **short write** or fails with
 * `EAGAIN`. Both are silent data loss if the return value is ignored — a bare
 * `fs.writeSync(1, text)` truncates to 65536 bytes on both runtimes under the
 * probe above. So we advance by the accepted byte count and retry until done.
 *
 * `EPIPE` means the reader is gone (`cmd | head`); we stop quietly, which is
 * what `process.stdout.write` did and what shells expect.
 */
export const writeStdoutSync = (text: string): void => {
  if (text.length === 0) return

  const buffer = Buffer.from(text, 'utf8')
  let offset = 0

  while (offset < buffer.length) {
    try {
      offset += fs.writeSync(1, buffer, offset, buffer.length - offset)
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code
      if (code === 'EAGAIN') {
        sleepSync(EAGAIN_PAUSE_MS)
        continue
      }
      // Reader closed the pipe — nothing left to write to, and this is not an
      // error condition for a well-behaved CLI.
      if (code === 'EPIPE') return
      throw cause
    }
  }
}

/**
 * {@link writeStdoutSync} with a trailing newline, for callers that previously
 * relied on `Console.log` supplying one.
 */
export const writeStdoutLineSync = (text: string): void => {
  writeStdoutSync(`${text}\n`)
}
