export const deployTargetEnvSuffix = (name: string) =>
  name
    .toUpperCase()
    .replaceAll('-', '_')
    .replaceAll(/[^A-Z0-9_]/g, '')

export const deployPreviewManagedMarker = '<!-- deploy-preview-comment:managed -->'
export const deployPreviewStatePrefix = '<!-- deploy-preview-comment:state\n'
export const deployPreviewStateSuffix = '\n-->'
