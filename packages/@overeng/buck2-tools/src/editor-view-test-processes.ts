import type { ChildProcess, spawn } from 'node:child_process'

import { editorViewProcessTestScope } from './editor-view-readers.ts'

/** Scope enumeration, not observations or policy; refresh live fixture PIDs on every scan. */
export const scopeEditorViewTestProcesses =
  <TArgs extends unknown[], TResult>({
    processIds,
    operation,
  }: {
    readonly processIds: ReadonlySet<number>
    readonly operation: (...args: TArgs) => TResult
  }): ((...args: TArgs) => TResult) =>
  (...args) =>
    editorViewProcessTestScope.run(
      () => [...processIds],
      () => operation(...args),
    )

/** Preserve spawn's overloads while retaining every live child in the fixture census. */
export const trackEditorViewTestSpawn = ({
  processIds,
  spawnProcess,
}: {
  readonly processIds: Set<number>
  readonly spawnProcess: typeof spawn
}): typeof spawn =>
  new Proxy(spawnProcess, {
    apply: (target, receiver, args) => {
      const child: ChildProcess = Reflect.apply(target, receiver, args)
      const pid = child.pid
      if (pid !== undefined) {
        processIds.add(pid)
        child.once('close', () => processIds.delete(pid))
      }
      return child
    },
  })
