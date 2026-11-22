import {
  createGenieOutput,
  type GenieOutput,
} from '../../packages/@overeng/genie/src/runtime/core.ts'

/** One package boundary's conservative compiler/source-asset closure, never ambient installs. */
export const workspaceSourceSet = ({
  packagePath,
  rulesCell = '',
}: {
  readonly packagePath: string
  readonly rulesCell?: string
}): string => `load("${rulesCell}//buck2:static_checks.bzl", strict_source_excludes = "STATIC_SOURCE_EXCLUDES", strict_source_globs = "WORKSPACE_SOURCE_GLOBS", strict_source_set = "static_source_set")
strict_source_set(name = "strict-inputs", prefix = ${JSON.stringify(packagePath)}, srcs = glob(strict_source_globs, exclude = strict_source_excludes), visibility = ["PUBLIC"])
`

/** Preserve each existing generator's authority while exposing its source package to workspace checks. */
export const withWorkspaceSourceSet = <T>({
  projection,
  packagePath,
  rulesCell,
}: {
  readonly projection: GenieOutput<T>
  readonly packagePath: string
  readonly rulesCell?: string
}): GenieOutput<T> =>
  createGenieOutput({
    ...projection,
    stringify: (context) =>
      `${workspaceSourceSet({ packagePath, ...(rulesCell === undefined ? {} : { rulesCell }) })}\n${projection.stringify(context)}`,
  })
