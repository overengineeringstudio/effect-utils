import type { CandidateNode, CandidateTree, DiffOp } from './sync-diff.ts'

/**
 * Page-lifecycle mode for `sync()` / `plan()` (#1124).
 *
 * - `'managed'` (default): the full existing contract — JSX drives page
 *   create/update/archive/move/reorder.
 * - `'append-only'`: for consumers managing an IRREPLACEABLE live tree
 *   (e.g. agent-parented pages whose grants bind to page identity and which
 *   cannot be recreated through the public API). Block ops stay fully
 *   managed and page *content* (`updatePage` title/icon/cover) stays
 *   allowed, but page *lifecycle* is constrained: `createPage` is legal
 *   only at the tail of its parent's page-sibling run; any `archivePage`,
 *   `movePage`, `reorderPages`, or out-of-tail `createPage` fails the whole
 *   sync BEFORE any op applies.
 *
 * Fail, not skip: JSX implying page destruction under `'append-only'` is a
 * caller bug — skipping the op would silently diverge server from cache.
 */
export type PageLifecycle = 'managed' | 'append-only'

/**
 * A candidate page is a create when the diff left it holding a placeholder
 * id (retained / moved pages get their server id bound during `diff()`).
 */
const isCreatedPage = (node: CandidateNode): boolean =>
  node.blockId === undefined || node.blockId.startsWith('tmp-')

/**
 * Collect the `tmpPageId`s of page candidates that sit BEFORE a retained page
 * in their parent's page-sibling run — i.e. creates that cannot land in JSX
 * order, because Notion only creates children at the tail. Walks every
 * sibling scope (root and nested) of the diffed candidate tree.
 */
const collectOutOfTailCreates = (nodes: readonly CandidateNode[], out: Set<string>): void => {
  const pages = nodes.filter((n) => n.nodeKind === 'page')
  let lastRetained = -1
  for (const [i, page] of pages.entries()) {
    if (!isCreatedPage(page)) lastRetained = i
  }
  for (const [i, page] of pages.entries()) {
    if (i < lastRetained && isCreatedPage(page) && page.blockId !== undefined) {
      out.add(page.blockId)
    }
  }
  for (const node of nodes) collectOutOfTailCreates(node.children, out)
}

/**
 * The single `'append-only'` enforcement predicate: a pure function of the
 * computed plan plus the diffed candidate tree (needed for tail-position
 * context — the ops alone cannot tell a tail create from a mid-run create).
 *
 * Returns the offending ops, in plan order:
 *
 * - every `archivePage` / `movePage` / `reorderPages` — page destruction,
 *   reparenting, and reordering are categorically illegal;
 * - every `createPage` whose page sits before a retained page sibling in
 *   candidate order (an out-of-tail create would silently land at the tail,
 *   diverging server order from JSX order — see #1124: a reorder is a
 *   second, non-atomic lifecycle op on an irreplaceable tree, so tail
 *   placement must be accepted or the sync must fail).
 *
 * Both `sync()` (which fails on a non-empty result before applying anything)
 * and `plan()` (which reports it without failing) evaluate this immediately
 * after `diff()`, so the two cannot disagree. Block ops and `updatePage`
 * (page content) are never violations. #1100 pending-adoption runs before
 * the diff and is read + cache-save only, so crash recovery stays legal — a
 * checkpointed page that *moved* in the retry JSX is adopted first
 * (harmless) and its move then correctly rejected here.
 */
export const pageLifecycleViolations = ({
  ops,
  candidate,
}: {
  readonly ops: readonly DiffOp[]
  readonly candidate: CandidateTree
}): readonly DiffOp[] => {
  const outOfTail = new Set<string>()
  collectOutOfTailCreates(candidate.children, outOfTail)
  return ops.filter(
    (op) =>
      op.kind === 'archivePage' ||
      op.kind === 'movePage' ||
      op.kind === 'reorderPages' ||
      (op.kind === 'createPage' && outOfTail.has(op.tmpPageId)),
  )
}
