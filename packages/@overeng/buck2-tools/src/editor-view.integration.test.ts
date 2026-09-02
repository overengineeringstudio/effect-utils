import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  canonicalTreeFingerprint,
  checkEditorView,
  publishEditorView,
  recoverEditorViewLock,
  type EditorViewOptions,
} from './editor-view.ts'

const requireTool = (name: string): string => {
  const tool = Bun.which(name)
  if (tool === null) throw new Error(`required test tool is unavailable: ${name}`)
  return tool
}

const cp = requireTool('cp')
const mv = requireTool('mv')
const falseTool = requireTool('false')

type Fixture = {
  readonly root: string
  readonly packageDir: string
  readonly editorRoot: string
  readonly editorInputs: string
  readonly nodeModules: string
  readonly options: EditorViewOptions
  readonly workspaceAuthority: string
  readonly consumerCache: string
}

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), 'editor-view-integration-'))
  const packageDir = join(root, 'packages', '@overeng', 'tui-core')
  const editorRoot = join(root, 'packages', '.editor-view')
  const editorInputs = join(root, 'inputs', 'editor_inputs')
  const nodeModules = join(root, 'inputs', 'node_modules')
  const workspaceAuthority = join(root, 'workspace-authority.json')
  const consumerCache = join(root, '.devenv', 'vite-cache', 'tui-core')
  mkdirSync(join(packageDir, 'node_modules'), { recursive: true })
  writeFileSync(join(packageDir, 'package.json'), '{}\n')
  writeFileSync(join(packageDir, 'node_modules', 'legacy-root-install'), 'retained')
  mkdirSync(editorInputs, { recursive: true })
  writeFileSync(join(editorInputs, 'install-descriptor.json'), '{"revision":1}\n')
  mkdirSync(join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), { recursive: true })
  writeFileSync(
    join(nodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
    'export default 1\n',
  )
  symlinkSync('.pnpm/dep@1/node_modules/dep', join(nodeModules, 'dep'))
  writeFileSync(
    workspaceAuthority,
    `${JSON.stringify({
      schema: 'effect-utils/workspace-dependency-authority/v1',
      requiredPackages: ['packages/@overeng/tui-core'],
      ownedPackages: ['packages/@overeng/tui-core'],
    })}\n`,
  )
  const options: EditorViewOptions = {
    repoRoot: root,
    package: 'packages/@overeng/tui-core',
    cell: 'tui-core',
    target: '//packages/@overeng/tui-core:editor_inputs',
    editorInputs,
    nodeModules,
    cp,
    workspaceAuthority,
    consumerCache,
    snapshotRetention: 2,
    mv,
  }
  return {
    root,
    packageDir,
    editorRoot,
    editorInputs,
    nodeModules,
    workspaceAuthority,
    consumerCache,
    options,
  }
}
const makeWritable = (path: string): void => {
  const status = lstatSync(path)
  if (status.isSymbolicLink() === true) return
  if (status.isDirectory() === true) {
    chmodSync(path, 0o700)
    for (const name of readdirSync(path)) makeWritable(join(path, name))
    return
  }
  chmodSync(path, 0o600)
}

const cleanup = (fixture: Fixture): void => {
  makeWritable(fixture.root)
  rmSync(fixture.root, { recursive: true, force: true })
}

const currentTarget = (fixture: Fixture): string =>
  readlinkSync(join(fixture.editorRoot, 'tui-core'))

const recordPath = (fixture: Fixture, target = currentTarget(fixture)): string =>
  join(fixture.editorRoot, target, 'editor-view.json')

describe('editor view publisher', () => {
  it('fingerprints deterministically with byte ordering and path framing', async () => {
    const fixture = makeFixture()
    try {
      const second = join(fixture.root, 'second')
      const collisionShape = join(fixture.root, 'collision')
      mkdirSync(second)
      writeFileSync(join(second, 'z'), 'last')
      mkdirSync(join(second, 'a'))
      writeFileSync(join(second, 'a', 'bc'), 'value')
      const first = join(fixture.root, 'first')
      mkdirSync(join(first, 'a'), { recursive: true })
      writeFileSync(join(first, 'a', 'bc'), 'value')
      writeFileSync(join(first, 'z'), 'last')
      mkdirSync(join(collisionShape, 'ab'), { recursive: true })
      writeFileSync(join(collisionShape, 'ab', 'c'), 'value')
      writeFileSync(join(collisionShape, 'z'), 'last')

      const fingerprint = await canonicalTreeFingerprint(first)
      expect(await canonicalTreeFingerprint(second)).toBe(fingerprint)
      expect(await canonicalTreeFingerprint(collisionShape)).not.toBe(fingerprint)
    } finally {
      cleanup(fixture)
    }
  })

  it('exchanges a non-empty first hop, retains it, and publishes idempotently', async () => {
    const fixture = makeFixture()
    try {
      const packageManifest = join(fixture.packageDir, 'package.json')
      const manifestContent = readFileSync(packageManifest)
      const manifestIdentity = statSync(packageManifest, { bigint: true }).ino
      const record = await publishEditorView(fixture.options)
      expect(readFileSync(packageManifest)).toEqual(manifestContent)
      expect(statSync(packageManifest, { bigint: true }).ino).not.toBe(manifestIdentity)
      expect(statSync(fixture.consumerCache).mode & 0o200).not.toBe(0)
      expect(readlinkSync(join(fixture.packageDir, 'node_modules'))).toBe(
        '../../.editor-view/tui-core/node_modules',
      )
      expect(readlinkSync(join(fixture.editorRoot, 'tui-core'))).toBe(
        `.store/tui-core-${record.editorInputsFingerprint}`,
      )
      const admittedFile = join(
        fixture.nodeModules,
        '.pnpm',
        'dep@1',
        'node_modules',
        'dep',
        'index.js',
      )
      const snapshotFile = join(
        fixture.editorRoot,
        record.snapshot,
        'node_modules',
        '.pnpm',
        'dep@1',
        'node_modules',
        'dep',
        'index.js',
      )
      const admittedStatus = statSync(admittedFile, { bigint: true })
      expect(statSync(join(fixture.editorRoot, record.snapshot)).mode & 0o222).toBe(0)
      expect(statSync(join(fixture.editorRoot, record.snapshot, 'node_modules')).mode & 0o222).toBe(
        0,
      )
      expect(
        statSync(join(fixture.editorRoot, record.snapshot, 'node_modules', '.pnpm')).mode & 0o222,
      ).toBe(0)
      expect(statSync(recordPath(fixture)).mode & 0o222).toBe(0)
      const snapshotStatus = statSync(snapshotFile, { bigint: true })
      expect([snapshotStatus.dev, snapshotStatus.ino]).toEqual([
        admittedStatus.dev,
        admittedStatus.ino,
      ])
      const legacyEntries = readdirSync(join(fixture.editorRoot, '.legacy'))
      expect(legacyEntries).toHaveLength(1)
      expect(
        readFileSync(
          join(fixture.editorRoot, '.legacy', legacyEntries[0]!, 'legacy-root-install'),
          'utf8',
        ),
      ).toBe('retained')
      const before = statSync(recordPath(fixture), { bigint: true }).mtimeNs
      await publishEditorView(fixture.options)
      expect(statSync(recordPath(fixture), { bigint: true }).mtimeNs).toBe(before)
      expect(readdirSync(join(fixture.editorRoot, '.legacy'))).toEqual(legacyEntries)
      await expect(checkEditorView(fixture.options)).resolves.toEqual(record)
    } finally {
      cleanup(fixture)
    }
  })

  it('atomically flips old to new while retaining the bounded rollback snapshot', async () => {
    const fixture = makeFixture()
    try {
      const oldRecord = await publishEditorView(fixture.options)
      const oldTarget = currentTarget(fixture)
      const firstHopBefore = lstatSync(join(fixture.packageDir, 'node_modules'), { bigint: true })
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const refreshedNodeModules = join(fixture.root, 'inputs', 'node_modules-v2')
      mkdirSync(join(refreshedNodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep'), {
        recursive: true,
      })
      writeFileSync(
        join(refreshedNodeModules, '.pnpm', 'dep@1', 'node_modules', 'dep', 'index.js'),
        'export default 2\n',
      )
      symlinkSync('.pnpm/dep@1/node_modules/dep', join(refreshedNodeModules, 'dep'))
      const refreshedOptions = { ...fixture.options, nodeModules: refreshedNodeModules }
      const newRecord = await publishEditorView(refreshedOptions)
      expect(newRecord.editorInputsFingerprint).not.toBe(oldRecord.editorInputsFingerprint)
      expect(currentTarget(fixture)).not.toBe(oldTarget)
      expect(
        readFileSync(join(fixture.editorRoot, oldTarget, 'editor-view.json'), 'utf8'),
      ).toContain(oldRecord.editorInputsFingerprint)
      expect(
        readFileSync(
          join(
            fixture.editorRoot,
            oldTarget,
            'node_modules',
            '.pnpm',
            'dep@1',
            'node_modules',
            'dep',
            'index.js',
          ),
          'utf8',
        ),
      ).toBe('export default 1\n')
      const firstHopAfter = lstatSync(join(fixture.packageDir, 'node_modules'), { bigint: true })
      expect([firstHopAfter.dev, firstHopAfter.ino]).toEqual([
        firstHopBefore.dev,
        firstHopBefore.ino,
      ])
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
          name.startsWith('tui-core-'),
        ),
      ).toHaveLength(2)
    } finally {
      cleanup(fixture)
    }
  })
  it('keeps the current and previous snapshots while preserving in-flight candidates', async () => {
    const fixture = makeFixture()
    try {
      const oldest = await publishEditorView(fixture.options)
      const inFlight = join(fixture.editorRoot, '.store', '.candidate-in-flight')
      mkdirSync(inFlight)
      for (const revision of [2, 3]) {
        writeFileSync(
          join(fixture.editorInputs, 'install-descriptor.json'),
          `${JSON.stringify({ revision })}\n`,
        )
        const nodeModules = join(fixture.root, 'inputs', `node_modules-v${revision}`)
        mkdirSync(join(nodeModules, 'dep'), { recursive: true })
        writeFileSync(join(nodeModules, 'dep', 'index.js'), `export default ${revision}\n`)
        await publishEditorView({ ...fixture.options, nodeModules })
      }
      const snapshots = readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
        name.startsWith('tui-core-'),
      )
      expect(snapshots).toHaveLength(2)
      expect(snapshots).toContain(currentTarget(fixture).replace('.store/', ''))
      expect(snapshots).not.toContain(`tui-core-${oldest.editorInputsFingerprint}`)
      expect(statSync(inFlight).isDirectory()).toBe(true)
      const retention = JSON.parse(
        readFileSync(join(fixture.editorRoot, '.retention.json'), 'utf8'),
      ) as { snapshots: readonly string[] }
      expect(retention.snapshots).toHaveLength(2)
      expect(retention.snapshots[0]).toBe(currentTarget(fixture).replace('.store/', ''))
    } finally {
      cleanup(fixture)
    }
  })

  it('fails closed on incomplete whole-workspace authority and cache paths inside the package', async () => {
    const fixture = makeFixture()
    try {
      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['packages/@overeng/tui-core', 'packages/@overeng/tui-react'],
          ownedPackages: ['packages/@overeng/buck2-tools', 'packages/@overeng/tui-core'],
        })}\n`,
      )
      await expect(publishEditorView(fixture.options)).rejects.toThrow(
        'missing=["packages/@overeng/tui-react"] extra=["packages/@overeng/buck2-tools"]',
      )
      expect(() => lstatSync(fixture.editorRoot)).toThrow()

      writeFileSync(
        fixture.workspaceAuthority,
        `${JSON.stringify({
          schema: 'effect-utils/workspace-dependency-authority/v1',
          requiredPackages: ['packages/@overeng/tui-core'],
          ownedPackages: ['packages/@overeng/tui-core'],
        })}\n`,
      )
      await expect(
        publishEditorView({
          ...fixture.options,
          consumerCache: join(fixture.packageDir, '.vite'),
        }),
      ).rejects.toThrow('consumer cache must be inside the repository and outside package')
    } finally {
      cleanup(fixture)
    }
  })

  it('detects a writable published snapshot even when its content digest is unchanged', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      chmodSync(join(fixture.editorRoot, currentTarget(fixture)), 0o700)
      await expect(checkEditorView(fixture.options)).rejects.toThrow(
        'snapshot immutability violation',
      )
    } finally {
      cleanup(fixture)
    }
  })

  it('refuses garbage collection when snapshot ownership is ambiguous', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const current = currentTarget(fixture)
      mkdirSync(join(fixture.editorRoot, '.store', 'unowned'))
      await expect(publishEditorView(fixture.options)).rejects.toThrow(
        'snapshot store contains an ambiguously owned entry',
      )
      expect(currentTarget(fixture)).toBe(current)
    } finally {
      cleanup(fixture)
    }
  })

  it('leaves the old view current when hardlink snapshot creation fails before flip', async () => {
    const fixture = makeFixture()
    try {
      await publishEditorView(fixture.options)
      const oldTarget = currentTarget(fixture)
      writeFileSync(join(fixture.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      await expect(publishEditorView({ ...fixture.options, cp: falseTool })).rejects.toThrow(
        'cp -al failed',
      )
      expect(currentTarget(fixture)).toBe(oldTarget)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).filter((name) =>
          name.startsWith('tui-core-'),
        ),
      ).toHaveLength(1)
      expect(
        readdirSync(join(fixture.editorRoot, '.store')).some((name) =>
          name.startsWith('.candidate-'),
        ),
      ).toBe(false)
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects an existing lock and requires exact-token explicit recovery', async () => {
    const fixture = makeFixture()
    try {
      mkdirSync(fixture.editorRoot, { recursive: true })
      const lock = join(fixture.editorRoot, '.publish.lock')
      mkdirSync(lock)
      writeFileSync(
        join(lock, 'owner.json'),
        '{"schema":"effect-utils/editor-view-lock/v1","token":"held-token","pid":1}\n',
      )
      await expect(publishEditorView(fixture.options)).rejects.toThrow('publication lock exists')
      expect(() => recoverEditorViewLock({ options: fixture.options, token: 'wrong' })).toThrow(
        'token mismatch',
      )
      expect(() =>
        recoverEditorViewLock({ options: fixture.options, token: 'held-token' }),
      ).not.toThrow()
      await expect(publishEditorView(fixture.options)).resolves.toBeDefined()
    } finally {
      cleanup(fixture)
    }
  })

  it('rejects escaping and dangling current pointers with both fingerprints named', async () => {
    const escaping = makeFixture()
    try {
      const record = await publishEditorView(escaping.options)
      rmSync(join(escaping.editorRoot, 'tui-core'))
      symlinkSync('../../escape', join(escaping.editorRoot, 'tui-core'))
      await expect(checkEditorView(escaping.options)).rejects.toThrow(
        `recorded fingerprint=<invalid-pointer>; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(escaping)
    }

    const dangling = makeFixture()
    try {
      const record = await publishEditorView(dangling.options)
      rmSync(join(dangling.editorRoot, 'tui-core'))
      symlinkSync(
        `.store/tui-core-${record.editorInputsFingerprint}`,
        join(dangling.editorRoot, 'tui-core'),
      )
      makeWritable(
        join(dangling.editorRoot, '.store', `tui-core-${record.editorInputsFingerprint}`),
      )
      rmSync(join(dangling.editorRoot, '.store', `tui-core-${record.editorInputsFingerprint}`), {
        recursive: true,
      })
      await expect(checkEditorView(dangling.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(dangling)
    }
  })

  it('names recorded and current hashes for descriptor mismatch and incomplete snapshot', async () => {
    const mismatch = makeFixture()
    try {
      const record = await publishEditorView(mismatch.options)
      writeFileSync(join(mismatch.editorInputs, 'install-descriptor.json'), '{"revision":2}\n')
      const current = await canonicalTreeFingerprint(mismatch.editorInputs)
      await expect(checkEditorView(mismatch.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${current}`,
      )
    } finally {
      cleanup(mismatch)
    }

    const incomplete = makeFixture()
    try {
      const record = await publishEditorView(incomplete.options)
      makeWritable(join(incomplete.editorRoot, currentTarget(incomplete)))
      rmSync(join(incomplete.editorRoot, currentTarget(incomplete), 'node_modules', 'dep'))
      await expect(checkEditorView(incomplete.options)).rejects.toThrow(
        `recorded fingerprint=${record.editorInputsFingerprint}; current fingerprint=${record.editorInputsFingerprint}`,
      )
    } finally {
      cleanup(incomplete)
    }
  })

  it('rejects unknown record fields and package paths containing symlink components', async () => {
    const malformed = makeFixture()
    try {
      await publishEditorView(malformed.options)
      const path = recordPath(malformed)
      const record = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
      record.untrusted = true
      chmodSync(path, 0o600)
      writeFileSync(path, `${JSON.stringify(record)}\n`)
      await expect(checkEditorView(malformed.options)).rejects.toThrow(
        'record has unknown or missing fields',
      )
    } finally {
      cleanup(malformed)
    }

    const root = mkdtempSync(join(tmpdir(), 'editor-view-symlink-root-'))
    const outside = mkdtempSync(join(tmpdir(), 'editor-view-symlink-outside-'))
    try {
      mkdirSync(join(outside, 'packages', '@overeng', 'tui-core'), { recursive: true })
      symlinkSync(join(outside, 'packages'), join(root, 'packages'))
      const options = {
        ...malformed.options,
        repoRoot: root,
        editorInputs: join(outside, 'inputs'),
        nodeModules: join(outside, 'node_modules'),
      }
      await expect(publishEditorView(options)).rejects.toThrow(
        'package path must not contain symbolic links',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  })
})
