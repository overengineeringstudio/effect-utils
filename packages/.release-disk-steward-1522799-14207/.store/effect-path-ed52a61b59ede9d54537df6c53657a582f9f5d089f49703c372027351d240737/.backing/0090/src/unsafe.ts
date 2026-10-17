/**
 * Unsafe constructors for path types.
 *
 * These constructors bypass validation and directly cast strings to branded types.
 * Use only when you are certain the path is valid and correctly formatted.
 *
 * WARNING: Using these with invalid paths will break type safety guarantees.
 */

import type {
  AbsoluteDirPath,
  AbsoluteFilePath,
  AbsolutePath,
  RelativeDirPath,
  RelativeFilePath,
  RelativePath,
} from './brands.ts'
import { ensureTrailingSlash, removeTrailingSlash } from './internal/utils.ts'

/**
 * Create an AbsolutePath without validation.
 * Use when you know the string is an absolute path.
 */
export const absolutePath = (path: string): AbsolutePath => path as AbsolutePath

/**
 * Create a RelativePath without validation.
 * Use when you know the string is a relative path.
 */
export const relativePath = (path: string): RelativePath => path as RelativePath

/**
 * Create an AbsoluteFilePath without validation.
 * Removes trailing slash if present.
 */
export const absoluteFile = (path: string): AbsoluteFilePath =>
  removeTrailingSlash(path) as AbsoluteFilePath

/**
 * Create an AbsoluteDirPath without validation.
 * Ensures trailing slash is present.
 */
export const absoluteDir = (path: string): AbsoluteDirPath =>
  ensureTrailingSlash(path) as AbsoluteDirPath

/**
 * Create a RelativeFilePath without validation.
 * Removes trailing slash if present.
 */
export const relativeFile = (path: string): RelativeFilePath =>
  removeTrailingSlash(path) as RelativeFilePath

/**
 * Create a RelativeDirPath without validation.
 * Ensures trailing slash is present.
 */
export const relativeDir = (path: string): RelativeDirPath =>
  ensureTrailingSlash(path) as RelativeDirPath
