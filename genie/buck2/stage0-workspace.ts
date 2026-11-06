import { posix } from 'node:path'

import { inputReadFileSync } from '../../packages/@overeng/genie/src/runtime/node/inputs.ts'

export interface Stage0Workspace {
  package: string
  workspaceMember: string
  members: string[]
  manifest: string
}
export const stage0Tools = ['archive-tool', 'events', 'fingerprint', 'product'] as const
const object = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {}
  if (typeof value !== 'object' || value === null || Array.isArray(value) === true)
    throw new Error('Expected Cargo table')
  return value as Record<string, unknown> // Object boundary established; fields remain unknown.
}
const text = (value: unknown): string => {
  if (typeof value !== 'string') throw new Error('Expected Cargo string')
  return value
}
const parse = (value: string) => object(Bun.TOML.parse(value))

/** Keep shared workspace sections byte-identical; derive only members and their path closure. */
export const projectStage0Workspace = ({
  manifest,
  tool,
  readManifest = (member) => inputReadFileSync(`rust/${member}/Cargo.toml`, 'utf8'),
}: {
  manifest: string
  tool: string
  readManifest?: (member: string) => string
}): Stage0Workspace => {
  const workspace = object(parse(manifest).workspace)
  const members = new Set<string>()
  const visit = (member: string) => {
    if (members.has(member) === true) return
    members.add(member)
    const crate = parse(readManifest(member))
    const tables = [crate, ...Object.values(object(crate.target)).map(object)]
    for (const target of tables)
      for (const kind of ['dependencies', 'dev-dependencies', 'build-dependencies']) {
        for (const [name, request] of Object.entries(object(target[kind]))) {
          if (typeof request === 'string') continue
          const inherited = object(request).workspace === true
          const dependency = inherited === true ? object(workspace.dependencies)[name] : request
          if (typeof dependency === 'string') continue
          const path = object(dependency).path
          if (path !== undefined)
            visit(posix.normalize(posix.join(inherited === true ? '.' : member, text(path))))
        }
      }
  }
  const workspaceMember = `buck2-tools/${tool}`
  visit(workspaceMember)
  const ordered = [...members].toSorted()
  const narrowed = manifest.replace(
    /^members = \[[\s\S]*?^\]/m,
    `members = ${JSON.stringify(ordered)}`,
  )
  if (narrowed === manifest) throw new Error('Missing workspace members declaration')
  return {
    package: text(object(parse(readManifest(workspaceMember)).package).name),
    workspaceMember,
    members: ordered,
    manifest: narrowed,
  }
}
