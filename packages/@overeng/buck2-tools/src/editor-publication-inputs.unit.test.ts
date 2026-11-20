import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { requireEditorPublicationInputs } from './editor-publication-inputs.ts'
import {
  editorPublicationIsolation,
  type EditorPublicationOwner,
  withEditorPublicationOwner,
} from './editor-publication-owner.ts'

const withInputs = async (
  run: (root: string, privateInput: string, defaultInput: string) => Promise<void>,
): Promise<void> => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'editor-publication-inputs-')))
  const privateInput = join(root, 'buck-out', editorPublicationIsolation, 'gen', 'input.json')
  const defaultInput = join(root, 'buck-out', 'v2', 'gen', 'input.json')
  try {
    for (const path of [privateInput, defaultInput]) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, '{}\n')
    }
    await run(root, privateInput, defaultInput)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

it('requires a real owner for mutable inputs and rejects default outputs even for that owner', () =>
  withInputs(async (root, privateInput, defaultInput) => {
    expect(() => requireEditorPublicationInputs({ root, paths: [privateInput] })).toThrow()
    expect(() => requireEditorPublicationInputs({ root, paths: [defaultInput] })).toThrow()
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).not.toThrow()
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [defaultInput], owner }),
        ).toThrow('outside its reserved Buck isolation')
      },
    })
  }))

it('rejects forged or copied owner objects and owners for another root', () =>
  withInputs(async (root, privateInput) => {
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        for (const forged of [{}, { ...owner }, Object.create(owner)] as EditorPublicationOwner[]) {
          expect(() =>
            requireEditorPublicationInputs({ root, paths: [privateInput], owner: forged }),
          ).toThrow()
        }
        await withInputs(async (foreignRoot, foreignInput) => {
          expect(() =>
            requireEditorPublicationInputs({
              root: foreignRoot,
              paths: [foreignInput],
              owner,
            }),
          ).toThrow()
        })
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).not.toThrow()
      },
    })
  }))
