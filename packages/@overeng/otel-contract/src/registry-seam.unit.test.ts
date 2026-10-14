import { readdirSync, readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import agentContract from './agent.contract.ts'
import { fragment } from './registry.ts'

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url))

// NOTE: this test lives in `@overeng/otel-contract`, which cannot import `@overeng/genie` (genie
// depends on it — a project-reference cycle). It therefore reads both sides from the filesystem
// rather than importing the aggregator/composition modules. The reusable `orphanSeamPaths`
// helper itself is unit-tested (pure, with a planted orphan) inside genie's composition tests.

const SKIP_DIRS = new Set([
  'node_modules',
  'buck-out',
  'dist',
  'tmp',
  'target',
  '.git',
  '.devenv',
  '.editor-view',
  'repos',
  'result',
])

/** Every telemetry seam file (`*.contract.ts`) in the repo, repo-relative (fs walk — robust to git state). */
const seamFilesOnDisk = (dir: string = repoRoot): string[] => {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory() === true) {
      if (SKIP_DIRS.has(entry.name) === true) continue
      out.push(...seamFilesOnDisk(`${dir}/${entry.name}`))
    } else if (entry.name.endsWith('.contract.ts') === true) {
      out.push(relative(repoRoot, `${dir}/${entry.name}`))
    }
  }
  return out
}

/** Parse the aggregator's `memberSeamPaths = [...]` string-literal list from source. */
const importedSeamPaths = (): string[] => {
  const src = readFileSync(
    new URL('../../../../genie/weaver-registry/registry.ts', import.meta.url),
    'utf8',
  )
  const block = /memberSeamPaths\s*=\s*\[([\s\S]*?)\]/.exec(src)
  if (block === null) throw new Error('could not locate memberSeamPaths in the aggregator')
  return [...block[1]!.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]!)
}

const orphans = (onDisk: readonly string[], imported: readonly string[]): string[] => {
  const set = new Set(imported)
  return onDisk.filter((p) => set.has(p) === false).toSorted((a, b) => a.localeCompare(b))
}

describe('no-orphan-seam check (decision 0005)', () => {
  it('every seam file on disk is imported by the root aggregator (no orphans)', () => {
    const onDisk = seamFilesOnDisk()
    expect(onDisk.length).toBeGreaterThan(0) // guard: the glob must actually find seam files
    expect(orphans(onDisk, importedSeamPaths())).toEqual([])
  })

  it('FAILS (reports the orphan) when a seam file on disk is NOT imported by the aggregator', () => {
    const plantedOrphan = 'packages/@overeng/some-pkg/src/orphan.contract.ts'
    expect(orphans([...seamFilesOnDisk(), plantedOrphan], importedSeamPaths())).toContain(
      plantedOrphan,
    )
  })
})

describe('tree-shaking: ./registry projector stays out of the `.` runtime bundle (decision 0006)', () => {
  const modSource = readFileSync(new URL('./mod.ts', import.meta.url), 'utf8')

  it('the `.` entry (mod.ts) does not import the `./registry` design-time module', () => {
    // Static import-graph guarantee: registry.ts imports mod.ts (one direction); mod.ts has no
    // local imports at all. A stronger bundle-grep for the weaver annotation symbol runs in the
    // weaver tree-shake verification step.
    expect(modSource).not.toMatch(/from ['"]\.\/registry(-demo\.contract)?\.ts['"]/)
    expect(modSource).not.toContain('@overeng/genie/weaver/Attr')
  })
})

describe('reusable agent contract', () => {
  const agent = fragment(agentContract)
  const expectedConstants = {
    AGENT_ACTOR_ID: 'agent.actor.id',
    AGENT_PERSONA: 'agent.persona',
    AGENT_SUPERVISOR_ID: 'agent.supervisor.id',
    AGENT_MISSION_NAME: 'agent.mission.name',
    AGENT_MISSION_RUN_ID: 'agent.mission.run.id',
    AGENT_STEP_NAME: 'agent.step.name',
    AGENT_STEP_RUN_ID: 'agent.step.run.id',
    AGENT_HARNESS_TOOL: 'agent.harness.tool',
    AGENT_HARNESS_VERSION: 'agent.harness.version',
    AGENT_HARNESS_SESSION_ID: 'agent.harness.session.id',
    AGENT_MODEL_EFFORT: 'agent.model.effort',
    AGENT_PRINCIPAL_ID: 'agent.principal.id',
  }

  it('defines shared string attributes with exact public constant names', () => {
    expect(Object.fromEntries(agent.attributes.map((a) => [a.constName, a.id]))).toEqual(
      expectedConstants,
    )
    expect(agent.attributes.every((a) => a.type === 'string')).toBe(true)
    expect(agent.foreignRefs).toEqual(['gen_ai.request.model'])
    expect(agent.upstream).toEqual(agentContract.upstream)
    const refs = agent.signals[0]!.attributes
    expect(refs.find((a) => a.ref === 'agent.principal.id')?.requirement_level).toBe('opt_in')
    expect(
      refs
        .filter((a) => a.ref !== 'agent.principal.id')
        .every((a) => a.requirement_level === 'recommended'),
    ).toBe(true)
    expect(agent.attributes.find((a) => a.id === 'agent.principal.id')?.note).toContain(
      'Never include principal values in public artifacts or metric labels',
    )
    expect(agent.attributes.find((a) => a.id === 'agent.harness.session.id')?.note).toContain(
      'distinct from a PTY session and from the logical agent actor identity',
    )
  })

  it('committed TS and Rust agent constants have exact name-to-value parity', () => {
    // Filesystem reads avoid the otel-contract → genie project-reference cycle, as above.
    const ts = readFileSync(
      new URL('../../../../genie/weaver-registry/constants.ts', import.meta.url),
      'utf8',
    )
    const rust = readFileSync(
      new URL('../../../../genie/weaver-registry/constants.rs', import.meta.url),
      'utf8',
    )
    const tsConstants = Object.fromEntries(
      [...ts.matchAll(/export const (\w+) = ['"]((?:span\.)?agent\.[^'"]+)['"]/g)].map((m) => [
        m[1]!,
        m[2]!,
      ]),
    )
    const rustConstants = Object.fromEntries(
      [...rust.matchAll(/pub const (\w+): &str = "((?:span\.)?agent\.[^"]+)";/g)].map((m) => [
        m[1]!,
        m[2]!,
      ]),
    )
    const expectedContractConstants = {
      ...expectedConstants,
      AGENT_ACTIVITY: 'span.agent.activity',
    }
    expect(tsConstants).toEqual(expectedContractConstants)
    expect(rustConstants).toEqual(expectedContractConstants)
    expect(tsConstants).toEqual(rustConstants)
  })
})
