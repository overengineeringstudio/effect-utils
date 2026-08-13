import { describe, expect, it } from 'vitest'

import { fingerprintSemanticManifest, parseStage0Config, stage0Tools } from './stage0-config.ts'

const inputs = [
  { path: 'flake.lock', sha256: 'a'.repeat(64) },
  { path: 'nix/buck2-stage0-tools.nix', sha256: 'b'.repeat(64) },
]

describe('Buck stage-0 config identity', () => {
  it('is stable across semantic input enumeration order', () => {
    expect(fingerprintSemanticManifest({ inputs, platform: 'linux', architecture: 'x64' })).toBe(
      fingerprintSemanticManifest({
        inputs: inputs.toReversed(),
        platform: 'linux',
        architecture: 'x64',
      }),
    )
  })

  it('separates semantic content and execution-platform changes', () => {
    const baseline = fingerprintSemanticManifest({ inputs, platform: 'linux', architecture: 'x64' })
    expect(
      fingerprintSemanticManifest({
        inputs: [{ ...inputs[0]!, sha256: 'c'.repeat(64) }, inputs[1]!],
        platform: 'linux',
        architecture: 'x64',
      }),
    ).not.toBe(baseline)
    expect(
      fingerprintSemanticManifest({ inputs, platform: 'darwin', architecture: 'arm64' }),
    ).not.toBe(baseline)
  })

  it('accepts exactly one absolute executable for every stage-0 config key', () => {
    const values = parseStage0Config(
      [
        '# generated',
        '[buck2_stage0]',
        ...stage0Tools.map(({ configKey }) => `  ${configKey} = /nix/store/${configKey}/bin/tool`),
      ].join('\n'),
    )
    expect(Object.keys(values)).toEqual(stage0Tools.map(({ configKey }) => configKey))
  })

  it('rejects partial, relative, duplicate, and unknown configurations', () => {
    expect(() => parseStage0Config('[buck2_stage0]\nclosure_tool = /nix/store/tool')).toThrow(
      'missing stage-0 config key',
    )
    const validLines = stage0Tools.map(
      ({ configKey }) => `${configKey} = /nix/store/${configKey}/bin/tool`,
    )
    expect(() =>
      parseStage0Config(`[buck2_stage0]\n${validLines.join('\n')}\nextra = /tmp/tool`),
    ).toThrow('unexpected stage-0 config key')
    expect(() =>
      parseStage0Config(`[buck2_stage0]\n${validLines.join('\n')}\n[unrelated]`),
    ).toThrow('unexpected stage-0 config section')
    expect(() =>
      parseStage0Config(`[buck2_stage0]\n${validLines.join('\n')}\n${validLines[0]}`),
    ).toThrow('duplicate stage-0 config key')
    expect(() =>
      parseStage0Config(
        `[buck2_stage0]\n${validLines.join('\n').replace('/nix/store', 'relative')}`,
      ),
    ).toThrow('stage-0 executable must be absolute')
  })
})
