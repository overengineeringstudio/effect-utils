/**
 * Resolve the CLI version with an optional runtime stamp.
 *
 * baseVersion - The package.json version (always present at build time).
 * buildVersion - The build-time injected version or the placeholder.
 * runtimeStampEnvVar - Environment variable that provides a runtime stamp.
 */
export const resolveCliVersion = (options: {
  baseVersion: string
  buildVersion: string
  runtimeStampEnvVar: string
}): string => {
  const { baseVersion, buildVersion, runtimeStampEnvVar } = options
  const isPlaceholder = buildVersion === '__CLI_VERSION__' || buildVersion === baseVersion
  if (!isPlaceholder) {
    return buildVersion
  }

  const stamp = process.env[runtimeStampEnvVar]
  if (stamp && stamp.trim() !== '') {
    return `${baseVersion}+${stamp}`
  }

  return baseVersion
}
