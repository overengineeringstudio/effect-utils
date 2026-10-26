import { lstat } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'

import { Clock, Effect, Schema } from 'effect'
import * as FileSystem from 'effect/FileSystem'

import { unreleasedEditorViewRoots } from '@overeng/buck2-tools/editor-view-lifecycle'

import * as Git from '../core/git.ts'
import { withGitWriterLock } from './git-writer-lock.ts'
import { collectStoreLiveSet, isPathProtected } from './store-liveness.ts'
import type { MegarepoStore } from './store.ts'

/** Expected safety refusals and contextual I/O failures for one explicit target. */
export class StoreWorktreeRemoveError extends Schema.TaggedError<StoreWorktreeRemoveError>()(
  'StoreWorktreeRemoveError',
  {
    path: Schema.String,
    reason: Schema.Literals([
      'invalid-path',
      'protected',
      'teardown-required',
      'dirty',
      'unpushed',
      'not-found',
      'io',
    ]),
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/** Remove exactly one registered store worktree, preserving all refs and sibling registrations. */
export const removeStoreWorktree = Effect.fn('store.removeStoreWorktree')(
  function* ({
    store,
    path: input,
    discardChanges = false,
    allowUnpushed = false,
  }: {
    readonly store: MegarepoStore
    readonly path: string
    readonly discardChanges?: boolean
    readonly allowUnpushed?: boolean
  }) {
    const fs = yield* FileSystem.FileSystem
    const path = resolve(input)
    const refuse = ({
      reason,
      message,
    }: {
      readonly reason: StoreWorktreeRemoveError['reason']
      readonly message: string
    }) => new StoreWorktreeRemoveError({ path, reason, message })
    const base = yield* fs.realPath(store.basePath)
    // Inspect each existing component without following symlinks. Once a parent
    // is absent the whole remaining suffix is absent, so orphan cleanup can
    // still use its reciprocal administration record as ownership evidence.
    const validateDirectoryPath = Effect.fn('store.validateRemovalDirectory')(function* (
      target: string,
    ) {
      let current = base
      for (const component of relative(base, target).split('/')) {
        current = join(current, component)
        const info = yield* Effect.tryPromise({
          try: () =>
            lstat(current).catch((cause: NodeJS.ErrnoException) => {
              if (cause.code === 'ENOENT') return undefined
              throw cause
            }),
          catch: (cause) =>
            new StoreWorktreeRemoveError({
              path,
              reason: 'io',
              message: `Cannot inspect directory component '${current}'`,
              cause,
            }),
        })
        if (info === undefined) return
        if (info.isSymbolicLink() === true || info.isDirectory() === false)
          return yield* refuse({
            reason: 'invalid-path',
            message: `Directory component must be physical and not a symlink: '${current}'`,
          })
      }
    })
    const parts = relative(base, path).split('/')
    if (
      parts.length < 6 ||
      parts.some((part) => part === '..' || part === '') === true ||
      parts[3] !== 'refs' ||
      (parts[4] !== 'heads' && parts[4] !== 'tags' && parts[4] !== 'commits')
    )
      return yield* refuse({
        reason: 'invalid-path',
        message:
          'Expected an exact store worktree path under <host>/<owner>/<repo>/refs/{heads,tags,commits}/<ref>',
      })
    const repo = join(base, ...parts.slice(0, 3))
    const bare = join(repo, '.bare')
    if ((yield* fs.realPath(bare)) !== bare)
      return yield* refuse({
        reason: 'invalid-path',
        message: 'Store bare repository must not be a symlink',
      })

    return yield* Effect.gen(function* () {
      const adminRoot = join(bare, 'worktrees')
      yield* validateDirectoryPath(path)
      yield* validateDirectoryPath(adminRoot)
      const exists = yield* fs.exists(path)
      if (
        (yield* Git.runCommand({ cwd: bare, args: ['rev-parse', '--is-bare-repository'] })) !==
        'true'
      )
        return yield* refuse({
          reason: 'invalid-path',
          message: 'Target does not belong to a store bare repository',
        })
      const ref = parts.slice(5).join('/')
      const defaultRef = yield* Git.runCommand({ cwd: bare, args: ['symbolic-ref', 'HEAD'] }).pipe(
        Effect.option,
      )
      if (
        parts[4] === 'heads' &&
        (ref === 'main' ||
          ref === 'master' ||
          (defaultRef._tag === 'Some' && defaultRef.value === `refs/heads/${ref}`))
      )
        return yield* refuse({
          reason: 'protected',
          message: 'Canonical/default branch worktrees cannot be removed',
        })
      const liveSet = yield* collectStoreLiveSet({
        store,
        reconcileAllWorkspaces: true,
        now: yield* Clock.currentTimeMillis,
      })
      if (isPathProtected({ liveSet, path }) === true)
        return yield* refuse({
          reason: 'protected',
          message: 'Worktree is referenced by a registered workspace',
        })

      const names = (yield* fs.exists(adminRoot)) === true ? yield* fs.readDirectory(adminRoot) : []
      const matches: string[] = []
      for (const name of names) {
        const admin = join(adminRoot, name)
        if ((yield* fs.realPath(admin)) !== admin)
          return yield* refuse({
            reason: 'invalid-path',
            message: 'Symlinked worktree administration directory',
          })
        const gitdir = yield* fs.readFileString(join(admin, 'gitdir'))
        if (gitdir.trim() === join(path, '.git')) matches.push(admin)
      }
      if (matches.length > 1)
        return yield* refuse({
          reason: 'invalid-path',
          message: 'Multiple registrations point at the target',
        })
      let admin = matches[0]
      if (admin !== undefined) {
        const head = (yield* fs.readFileString(join(admin, 'HEAD'))).trim()
        if (
          head.startsWith('ref: ') === true &&
          (parts[4] !== 'heads' || head !== `ref: refs/heads/${ref}`)
        )
          return yield* refuse({
            reason: 'protected',
            message: 'Registered branch does not match its canonical store path',
          })
      }
      if (exists === false) {
        if (admin === undefined)
          return yield* refuse({ reason: 'not-found', message: 'Store worktree is already absent' })
        // Git has no path-scoped `worktree prune`. Remove only the verified orphan
        // registration rather than pruning unrelated missing/locked worktrees.
        if ((yield* fs.exists(join(admin, 'locked'))) === true)
          return yield* refuse({ reason: 'protected', message: 'Worktree registration is locked' })
        const staged = yield* Git.runCommand({
          cwd: bare,
          args: [`--git-dir=${admin}`, 'diff', '--cached', '--name-only'],
        })
        if (staged !== '' && discardChanges === false)
          return yield* refuse({
            reason: 'dirty',
            message:
              'Orphan registration retains staged changes; explicitly pass --discard-changes',
          })
        const unpushed = yield* Git.runCommand({
          cwd: bare,
          args: [`--git-dir=${admin}`, 'rev-list', '--count', 'HEAD', '--not', '--remotes', '--'],
        })
        if (Number(unpushed) > 0 && allowUnpushed === false)
          return yield* refuse({
            reason: 'unpushed',
            message:
              'Orphan registration has commits not reachable from any remote; explicitly pass --allow-unpushed',
          })
        yield* fs.remove(admin, { recursive: true })
        return { path, repaired: true }
      }
      if (admin === undefined && (yield* fs.exists(join(path, '.git'))) === false)
        return yield* refuse({
          reason: 'invalid-path',
          message: `Cannot prove worktree ownership for '${path}': both its administration entry and .git marker are absent. Editor-view GC or release must reclaim any editor-view payload; otherwise an operator must remove the remnant manually.`,
        })
      const editorRoots = yield* Effect.tryPromise({
        try: () => unreleasedEditorViewRoots(path),
        catch: (cause) =>
          new StoreWorktreeRemoveError({
            path,
            reason: 'io',
            message: 'Cannot inspect editor-view ownership',
            cause,
          }),
      })
      if (editorRoots.length > 0)
        return yield* refuse({
          reason: 'teardown-required',
          message: `Unreleased editor-view materialization: ${editorRoots.join(', ')}. Run \`devenv tasks run worktree:teardown --mode single\` in this worktree, then retry.`,
        })
      const marker = (yield* fs.readFileString(join(path, '.git'))).trim()
      if (marker.startsWith('gitdir: ') === false)
        return yield* refuse({
          reason: 'invalid-path',
          message: 'Target is not a linked Git worktree',
        })
      const pointedAdmin = resolve(path, marker.slice('gitdir: '.length))
      if (dirname(pointedAdmin) !== adminRoot)
        return yield* refuse({
          reason: 'invalid-path',
          message: 'Worktree administration pointer escapes its store bare repository',
        })
      if (admin !== undefined && pointedAdmin !== admin)
        return yield* refuse({
          reason: 'invalid-path',
          message: 'Worktree and administration pointers disagree',
        })
      const repaired = admin === undefined
      if (admin === undefined) {
        // Git can delete the admin entry after a failed recursive worktree removal,
        // leaving `.git` and a partially deleted tree. Rebuild only that entry from
        // the authoritative store ref; never infer a new branch or delete a ref.
        if ((yield* fs.exists(pointedAdmin)) === true)
          return yield* refuse({
            reason: 'invalid-path',
            message: 'Orphan pointer names an unrelated administration entry',
          })
        const head = parts[4] === 'commits' ? ref : `refs/${parts[4]}/${ref}`
        const commit = yield* Git.runCommand({
          cwd: bare,
          args: ['rev-parse', '--verify', `${head}^{commit}`],
        })
        // Recheck the complete administration chain immediately before writing,
        // including an empty or absent worktrees root.
        yield* validateDirectoryPath(pointedAdmin)
        if ((yield* fs.exists(adminRoot)) === false) yield* fs.makeDirectory(adminRoot)
        yield* fs.makeDirectory(pointedAdmin)
        admin = pointedAdmin
        yield* fs.writeFileString(join(admin, 'gitdir'), `${path}/.git\n`)
        yield* fs.writeFileString(join(admin, 'commondir'), '../..\n')
        yield* fs.writeFileString(
          join(admin, 'HEAD'),
          parts[4] === 'heads' ? `ref: ${head}\n` : `${commit}\n`,
        )
        yield* Git.runCommand({ cwd: path, args: ['read-tree', 'HEAD'] })
      }
      if ((yield* fs.exists(join(admin, 'locked'))) === true)
        return yield* refuse({ reason: 'protected', message: 'Worktree registration is locked' })
      const actualCommon = yield* Git.runCommand({
        cwd: path,
        args: ['rev-parse', '--path-format=absolute', '--git-common-dir'],
      })
      if ((yield* fs.realPath(actualCommon)) !== bare)
        return yield* refuse({
          reason: 'invalid-path',
          message: 'Worktree resolves to a different common Git directory',
        })
      const actualBranch = yield* Git.runCommand({
        cwd: path,
        args: ['symbolic-ref', '--quiet', 'HEAD'],
      }).pipe(Effect.option)
      if (
        actualBranch._tag === 'Some' &&
        (parts[4] !== 'heads' || actualBranch.value !== `refs/heads/${ref}`)
      )
        return yield* refuse({
          reason: 'protected',
          message: 'Worktree branch does not match its canonical store path',
        })
      const status = yield* Git.getWorktreeStatus({ worktreePath: path, readOnly: true })
      if (status.isDirty === true && discardChanges === false)
        return yield* refuse({
          reason: 'dirty',
          message:
            'Worktree has uncommitted or untracked changes; commit/stash them, or explicitly pass --discard-changes',
        })
      const unpushed = yield* Git.runCommand({
        cwd: path,
        args: ['rev-list', '--count', 'HEAD', '--not', '--remotes'],
      })
      if (Number(unpushed) > 0 && allowUnpushed === false)
        return yield* refuse({
          reason: 'unpushed',
          message:
            'Worktree has commits not reachable from any remote; push them, or explicitly pass --allow-unpushed',
        })
      if (discardChanges === true && status.isDirty === true) {
        yield* Git.runCommand({ cwd: path, args: ['reset', '--hard', 'HEAD'] })
        yield* Git.runCommand({ cwd: path, args: ['clean', '-fd'] })
      }
      // Teardown, not mr, owns directory permission restoration. Git must enforce
      // its ordinary dirty/submodule checks: never pass --force here.
      yield* Git.runCommand({ cwd: bare, args: ['worktree', 'remove', '--', path] })
      return { path, repaired }
    }).pipe(withGitWriterLock({ path: bare }))
  },
  (effect, { path }) =>
    effect.pipe(
      Effect.mapError((cause) =>
        cause instanceof StoreWorktreeRemoveError
          ? cause
          : new StoreWorktreeRemoveError({
              path,
              reason: 'io',
              message: `Unable to remove store worktree: ${String(cause)}`,
              cause,
            }),
      ),
    ),
)
