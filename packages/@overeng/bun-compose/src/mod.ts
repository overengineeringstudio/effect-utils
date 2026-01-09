/**
 * bun-compose: CLI for composing bun workspaces with git submodules
 *
 * Key differences from pnpm-compose:
 * - No symlink dance needed (bun handles workspace packages correctly)
 * - No node_modules corruption cleanup (bun's isolated linker is safe)
 * - Catalogs are read from package.json (workspaces.catalog or top-level catalog)
 *
 * Design principles:
 * 1. Zero-config: Auto-detects composed repos from .gitmodules
 * 2. Strict alignment: Catalog versions must match, error on mismatch
 * 3. Genie-native: Reads catalog from genie/repo.ts (with fallback to package.json)
 * 4. Suggest highest: On conflict, suggests updating to highest version
 */

export { BunComposeConfig, detectComposedRepos, loadConfig, parseGitmodules } from './config.ts'
export type { ComposedRepo } from './config.ts'

export {
  findCatalogConflicts,
  readGenieRepoCatalog,
  readPackageJsonCatalog,
  readRepoCatalog,
} from './catalog.ts'
export type { Catalog, CatalogConflict, RepoCatalog } from './catalog.ts'
