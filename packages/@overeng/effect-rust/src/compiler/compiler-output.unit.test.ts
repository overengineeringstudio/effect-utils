import { createHash } from 'node:crypto'

import { describe, expect, it } from 'vitest'

import { boundedContracts, boundedVectors } from './fixtures/bounded-contracts.ts'
import { contracts } from './fixtures/contracts.ts'
import { compile } from './mod.ts'

// Captured by executing the compiler at origin/main 9cf644d2c3948ab1c5b64fb7f17d393ede366321,
// before extracting admission and IR. These hashes cover every returned file byte and the complete IR.
const cases = [
  {
    name: 'contracts-default',
    schemas: contracts,
    options: {},
    files: 16,
    bytes: 175450,
    filesSha256: 'a70cbd499f27c7a5b345eacb4fd284e0c47d6885b83ac0ab691262cc99dcaa3f',
    irSha256: 'fa473956115be51c786315b1ec277126a0ba2125c12da2dcd948a39206ea3c98',
  },
  {
    name: 'contracts-schemars',
    schemas: contracts,
    options: { schemaMetadata: 'schemars', crateName: 'contracts-proof' },
    files: 16,
    bytes: 193705,
    filesSha256: '6b648770cac8475effeee9ae547480e64b5ff51c4dad315a72a91b2984d9c1ae',
    irSha256: '5057620ea5d74276895be2a770b1868f3f114dd8af1db62b9d12aa52111fcb0b',
  },
  {
    name: 'bounded-default',
    schemas: boundedContracts,
    options: {},
    files: 24,
    bytes: 80739,
    filesSha256: 'e84543031fb533ab4b93635e1962eccaaf892912221643078c54c4bd4ceeb74e',
    irSha256: '1167879ce8b97504385eded5f0eb45ad7f1ee92feb5fa77c5aff1a84614d9bf5',
  },
  {
    name: 'bounded-vectors',
    schemas: boundedContracts,
    options: { vectors: boundedVectors, crateName: 'bounded-proof' },
    files: 25,
    bytes: 102177,
    filesSha256: '3393fa8641b4c603233fedb94385d827cd3a6451641564d9daae4e2cddd2a8f6',
    irSha256: '7bbb76fce931e14099d2ff9e9b482201efbdd7427811fb3657b36ae98ea1c8d5',
  },
] as const

describe('Rust compiler extraction byte contract', () => {
  it.each(cases)('$name', (fixture) => {
    const output = compile(fixture.schemas, fixture.options)
    expect(Object.keys(output.files)).toHaveLength(fixture.files)
    expect(
      Object.values(output.files).reduce((sum, content) => sum + Buffer.byteLength(content), 0),
    ).toBe(fixture.bytes)
    expect(createHash('sha256').update(JSON.stringify(output.files)).digest('hex')).toBe(
      fixture.filesSha256,
    )
    expect(createHash('sha256').update(JSON.stringify(output.ir)).digest('hex')).toBe(
      fixture.irSha256,
    )
  })
})
