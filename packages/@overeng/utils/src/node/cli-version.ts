/**
 * Resolve the CLI version with an optional runtime stamp.
 *
 * baseVersion - The package.json version (always present at build time).
 * buildVersion - The build-time injected version or the placeholder.
 * runtimeStampEnvVar - Environment variable that provides a runtime stamp.
 */
export const resolveCliVersion: (options: {
  baseVersion: string
  buildVersion: string
  runtimeStampEnvVar: string
}) => string = ({ baseVersion, buildVersion, runtimeStampEnvVar }) => {
  const isPlaceholder = buildVersion === '__CLI_VERSION__' || buildVersion === baseVersion
  const stamp = process.env[runtimeStampEnvVar]?.trim()
  const hasStamp = stamp !== undefined && stamp !== ''

  if (!isPlaceholder) {
    return hasStamp ? `${buildVersion} (stamp ${stamp})` : buildVersion
  }

  if (hasStamp) {
    return `${baseVersion}+${stamp}`
  }

  return baseVersion
}
