/**
 * dotdot tree command
 *
 * Show dependency tree of repos
 */

import * as Cli from '@effect/cli'
import { Effect } from 'effect'

import {
  type ConfigSource,
  CurrentWorkingDirectory,
  collectAllConfigs,
  findWorkspaceRoot,
} from '../lib/mod.ts'

/** Dependency info for a repo */
type RepoDependency = {
  name: string
  declaredIn: string[]
  rev?: string | undefined
  conflicts: boolean
  conflictingRevs?: string[] | undefined
}

/** Build dependency map from configs */
const buildDependencyMap = (configs: ConfigSource[]) => {
  const deps = new Map<string, RepoDependency>()

  for (const source of configs) {
    const sourceName = source.isRoot ? '(root)' : (source.dir.split('/').pop() ?? source.dir)

    for (const [name, config] of Object.entries(source.config.repos)) {
      const existing = deps.get(name)
      if (existing) {
        existing.declaredIn.push(sourceName)

        // Check for rev conflicts
        if (config.rev && existing.rev && config.rev !== existing.rev) {
          existing.conflicts = true
          existing.conflictingRevs = existing.conflictingRevs ?? [existing.rev]
          if (!existing.conflictingRevs.includes(config.rev)) {
            existing.conflictingRevs.push(config.rev)
          }
        }
      } else {
        deps.set(name, {
          name,
          declaredIn: [sourceName],
          rev: config.rev,
          conflicts: false,
        })
      }
    }
  }

  return deps
}

/** Format the tree output */
const formatTree = (configs: ConfigSource[], deps: Map<string, RepoDependency>) =>
  Effect.gen(function* () {
    yield* Effect.log('Dependency tree:')
    yield* Effect.log('')

    // Group by declaring config
    const byConfig = new Map<string, string[]>()
    byConfig.set('(root)', [])

    for (const source of configs) {
      if (!source.isRoot) {
        const sourceName = source.dir.split('/').pop() ?? source.dir
        byConfig.set(sourceName, [])
      }
    }

    for (const [name, dep] of deps.entries()) {
      for (const declarer of dep.declaredIn) {
        const list = byConfig.get(declarer)
        if (list && !list.includes(name)) {
          list.push(name)
        }
      }
    }

    // Print root config deps
    const rootDeps = byConfig.get('(root)') ?? []
    if (rootDeps.length > 0) {
      yield* Effect.log('(root config)')
      for (let i = 0; i < rootDeps.length; i++) {
        const name = rootDeps[i]!
        const dep = deps.get(name)!
        const isLast = i === rootDeps.length - 1
        const prefix = isLast ? '└── ' : '├── '
        const revInfo = dep.rev ? ` @ ${dep.rev.slice(0, 7)}` : ''
        const conflictWarning = dep.conflicts ? ' [CONFLICT]' : ''
        yield* Effect.log(`${prefix}${name}${revInfo}${conflictWarning}`)
      }
      yield* Effect.log('')
    }

    // Print each repo's deps
    for (const source of configs) {
      if (source.isRoot) continue

      const sourceName = source.dir.split('/').pop() ?? source.dir
      const repoDeps = byConfig.get(sourceName) ?? []

      if (repoDeps.length > 0) {
        yield* Effect.log(`${sourceName}/`)
        for (let i = 0; i < repoDeps.length; i++) {
          const name = repoDeps[i]!
          const dep = deps.get(name)!
          const isLast = i === repoDeps.length - 1
          const prefix = isLast ? '└── ' : '├── '
          const revInfo = dep.rev ? ` @ ${dep.rev.slice(0, 7)}` : ''
          const conflictWarning = dep.conflicts ? ' [CONFLICT]' : ''
          yield* Effect.log(`${prefix}${name}${revInfo}${conflictWarning}`)
        }
        yield* Effect.log('')
      }
    }
  })

/** Tree command implementation */
export const treeCommand = Cli.Command.make(
  'tree',
  {
    showConflicts: Cli.Options.boolean('conflicts').pipe(
      Cli.Options.withDescription('Only show repos with conflicts'),
      Cli.Options.withDefault(false),
    ),
  },
  ({ showConflicts }) =>
    Effect.gen(function* () {
      const cwd = yield* CurrentWorkingDirectory

      // Find workspace root
      const workspaceRoot = yield* findWorkspaceRoot(cwd)

      yield* Effect.log(`dotdot workspace: ${workspaceRoot}`)
      yield* Effect.log('')

      // Collect all configs
      const configs = yield* collectAllConfigs(workspaceRoot)

      // Build dependency map
      const deps = buildDependencyMap(configs)

      if (deps.size === 0) {
        yield* Effect.log('No repos declared in any config')
        return
      }

      // Check for conflicts
      const conflicts = Array.from(deps.values()).filter((d) => d.conflicts)

      if (showConflicts) {
        if (conflicts.length === 0) {
          yield* Effect.log('No revision conflicts found')
          return
        }

        yield* Effect.log(`Found ${conflicts.length} repo(s) with revision conflicts:`)
        yield* Effect.log('')

        for (const conflict of conflicts) {
          yield* Effect.log(`${conflict.name}:`)
          yield* Effect.log(`  Declared in: ${conflict.declaredIn.join(', ')}`)
          yield* Effect.log(`  Conflicting revisions:`)
          for (const rev of conflict.conflictingRevs ?? []) {
            yield* Effect.log(`    - ${rev.slice(0, 7)}`)
          }
          yield* Effect.log('')
        }
        return
      }

      // Show full tree
      yield* formatTree(configs, deps)

      // Summary
      const multiDeclared = Array.from(deps.values()).filter((d) => d.declaredIn.length > 1)
      if (multiDeclared.length > 0) {
        yield* Effect.log(`${multiDeclared.length} repo(s) declared in multiple configs`)
      }

      if (conflicts.length > 0) {
        yield* Effect.log('')
        yield* Effect.log(`Warning: ${conflicts.length} repo(s) have revision conflicts!`)
        yield* Effect.log('Run `dotdot tree --conflicts` to see details')
      }
    }).pipe(Effect.withSpan('dotdot/tree')),
)
