import packageJson from '../package.json' with { type: 'json' }

/** Base package version used by the CLI build-version resolver. */
export const NOTION_MD_VERSION = packageJson.version
