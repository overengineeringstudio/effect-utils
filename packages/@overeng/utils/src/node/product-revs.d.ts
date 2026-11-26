/** Committed closure-revision (policy C) projection for one product. */
export interface ProductRevProjection {
  readonly product: string
  /** Sorted repository-relative closure paths; `repos/<member>/…` resolve via megarepo.lock. */
  readonly sourcePaths: readonly string[]
  /** Full revision of the earliest reachable commit producing the current closure content. */
  readonly rev: string
  /** Committer timestamp (Unix seconds) of `rev`, never a refresh or build time. */
  readonly commitTs: number
  /** Content identity of the closure at the projected snapshot. */
  readonly closureDigest: string
}

/** One product's declared source closure. */
export interface ProductRevOptions {
  /** Repository root (the Git work tree containing the paths and lock file). */
  readonly root: string
  readonly product: string
  readonly sourcePaths: readonly string[]
  /** Snapshot whose closure content is projected; defaults to HEAD. */
  readonly snapshot?: string
  /** Megarepo member checkout directory; defaults to `repos`. */
  readonly membersRoot?: string
  /** Megarepo lock binding each member to its commit; defaults to `megarepo.lock`. */
  readonly lockFile?: string
  /** Git checkout used to read a member's objects; defaults to `<root>/<membersRoot>/<name>`. */
  readonly memberCheckout?: (name: string) => string
}

/** A declared product and the committed projection file it owns (outside every closure). */
export interface ProductRevDeclaration extends Omit<ProductRevOptions, 'root'> {
  readonly output: string
}

/** Compute the projection from full, unshallow history. */
export declare const computeProductRev: (
  options: ProductRevOptions,
) => Promise<ProductRevProjection>

/** Closure digest of the checked-out sources and whether tracked closure files are modified. */
export declare const readWorkingClosure: (
  options: Omit<ProductRevOptions, 'product' | 'snapshot'> & { readonly product?: string },
) => Promise<{ readonly closureDigest: string; readonly uncommitted: boolean }>

/** Canonical committed JSON bytes. */
export declare const renderProductRev: (projection: ProductRevProjection) => string

/** Parse and validate a committed projection. */
export declare const readProductRev: (path: string) => Promise<ProductRevProjection>

/** Generated workspace closure from a package manifest plus explicit non-workspace inputs. */
export declare const manifestSourcePaths: (options: {
  readonly manifest: string
  readonly inputs?: readonly string[]
}) => Promise<readonly string[]>

/** `refresh` rewrites changed projections; `check` reports missing/stale ones. Returns messages. */
export declare const syncProductRevs: (options: {
  readonly root: string
  readonly mode: 'refresh' | 'check'
  readonly products: readonly ProductRevDeclaration[]
}) => Promise<readonly string[]>

/** Header comment written into every generated product revision projection. */
export declare const productRevComment: string
