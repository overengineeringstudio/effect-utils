import { chmod, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as NodePath from 'node:path'

import { describe, expect, it } from 'vitest'

import { compositionRuntimeEnvironmentNames } from '../lib/composition-runtime.ts'
import { resolvePinnedCoreutils } from './coreutils.ts'

const withFixture = async <A>(run: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(NodePath.join(tmpdir(), 'megarepo-coreutils-test-'))
  try {
    return await run(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const writeExecutable = async (path: string): Promise<void> => {
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
}

describe('resolvePinnedCoreutils', () => {
  it('uses a complete exact cp/mv injection without consulting PATH', () =>
    withFixture(async (root) => {
      const cpPath = NodePath.join(root, 'cp')
      const mvPath = NodePath.join(root, 'mv')
      await writeExecutable(cpPath)
      await writeExecutable(mvPath)

      await expect(
        resolvePinnedCoreutils({
          env: {
            [compositionRuntimeEnvironmentNames.cpPath]: cpPath,
            [compositionRuntimeEnvironmentNames.mvPath]: mvPath,
          },
          searchPath: '',
        }),
      ).resolves.toEqual({ cpPath, mvPath })
    }))

  it('fails closed on partial injection', () =>
    withFixture(async (root) => {
      const cpPath = NodePath.join(root, 'cp')
      await writeExecutable(cpPath)

      await expect(
        resolvePinnedCoreutils({
          env: { [compositionRuntimeEnvironmentNames.cpPath]: cpPath },
          searchPath: process.env.PATH ?? '',
        }),
      ).rejects.toThrow('must provide both cp and mv')
    }))

  it('rejects executable ambient tools that are not pinned Nix coreutils aliases', () =>
    withFixture(async (root) => {
      const bin = NodePath.join(root, 'bin')
      await mkdir(bin)
      await writeExecutable(NodePath.join(bin, 'cp'))
      await writeExecutable(NodePath.join(bin, 'mv'))

      await expect(resolvePinnedCoreutils({ env: {}, searchPath: bin })).rejects.toThrow(
        'not pinned to a Nix coreutils store item',
      )
    }))
})
