import { expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { requireEditorPublicationInputs } from './editor-publication-inputs.ts'
import {
  editorPublicationIsolation,
  type EditorPublicationOwner,
  releaseEditorPublicationOwner,
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

it('rejects an explicitly released owner and an owner retained beyond its callback', () =>
  withInputs(async (root, privateInput) => {
    let retainedOwner: EditorPublicationOwner | undefined
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        retainedOwner = owner
        releaseEditorPublicationOwner(owner)
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).toThrow()
      },
    })
    expect(() =>
      requireEditorPublicationInputs({ root, paths: [privateInput], owner: retainedOwner }),
    ).toThrow()
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        retainedOwner = owner
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [privateInput], owner }),
        ).not.toThrow()
      },
    })
    expect(() =>
      requireEditorPublicationInputs({ root, paths: [privateInput], owner: retainedOwner }),
    ).toThrow()
  }))

it('checks both mutable symlink carriers and reached Buck inputs without capturing generic files', () =>
  withInputs(async (root, privateInput, defaultInput) => {
    const generic = join(root, 'ordinary-source.json')
    const carrier = join(dirname(defaultInput), 'carrier.json')
    const disguisedDefault = join(root, 'disguised-default.json')
    const disguisedPrivate = join(root, 'disguised-private.json')
    writeFileSync(generic, '{}\n')
    symlinkSync(generic, carrier)
    symlinkSync(defaultInput, disguisedDefault)
    symlinkSync(privateInput, disguisedPrivate)
    expect(() => requireEditorPublicationInputs({ root, paths: [generic] })).not.toThrow()
    for (const path of [carrier, disguisedDefault, disguisedPrivate]) {
      expect(() => requireEditorPublicationInputs({ root, paths: [path] })).toThrow()
    }
    await withEditorPublicationOwner({
      root,
      run: async (owner) => {
        for (const path of [carrier, disguisedDefault]) {
          expect(() => requireEditorPublicationInputs({ root, paths: [path], owner })).toThrow(
            'outside its reserved Buck isolation',
          )
        }
        expect(() =>
          requireEditorPublicationInputs({ root, paths: [disguisedPrivate], owner }),
        ).not.toThrow()
      },
    })
  }))
