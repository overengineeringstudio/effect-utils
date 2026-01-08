/**
 * @overeng/pnpm-compose
 *
 * CLI for composing pnpm workspaces with git submodules.
 *
 * Design principles:
 * - Zero-config: auto-detects composed repos from .gitmodules
 * - Strict alignment: catalog versions must match, error on mismatch
 * - Genie-native: reads catalog from genie/repo.ts
 * - Suggest highest: on conflict, suggest updating to highest version
 */

export * from './config.ts'
export * from './catalog.ts'
