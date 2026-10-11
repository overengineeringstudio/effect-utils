import { readFile } from 'node:fs/promises'
import { availableParallelism, loadavg } from 'node:os'

/** Host pressure sampled around a Bun test run. */
export type HostLoad = {
  readonly load1: number
  readonly cpus: number
  readonly memPsiFullAvg10: number | undefined
}

/** Wall-clock allowance only; this does not retry tests or change their outcome. */
export const timeoutFactor = ({
  load1,
  cpus,
  cap,
}: {
  readonly load1: number
  readonly cpus: number
  readonly cap: number
}): number => Math.min(cap, Math.max(1, load1 / cpus))

/** Resolves the bounded run-start factor and explicit opt-out from environment inputs. */
export const configuredTimeoutFactor = ({
  host,
  env,
}: {
  readonly host: HostLoad
  readonly env: Readonly<Record<string, string | undefined>>
}): number => {
  const cap = Number(env['BUN_TEST_TIMEOUT_CAP'] ?? 4)
  if (Number.isFinite(cap) === false || cap < 1)
    throw new Error('BUN_TEST_TIMEOUT_CAP must be a finite number >= 1')
  return env['BUN_TEST_TIMEOUT_SCALING'] === '0'
    ? 1
    : timeoutFactor({ load1: host.load1, cpus: host.cpus, cap })
}

/** Uses CPUs available to this process, including affinity restrictions. */
export const sampleHostLoad = async (): Promise<HostLoad> => {
  let memPsiFullAvg10: number | undefined
  try {
    const psi = await readFile('/proc/pressure/memory', 'utf8')
    const avg10 = /^full .*?avg10=([\d.]+)/mu.exec(psi)?.[1]
    if (avg10 !== undefined) memPsiFullAvg10 = Number(avg10)
  } catch {
    // PSI is Linux-only and may be unavailable inside an executor sandbox.
  }
  return { load1: loadavg()[0]!, cpus: availableParallelism(), memPsiFullAvg10 }
}

/** Explicit test deadlines use the same run-start factor as the CLI default. */
export const scaleTestTimeout = (base: number): number =>
  Math.ceil(base * Number(process.env['BUN_TEST_TIMEOUT_FACTOR'] ?? 1))
