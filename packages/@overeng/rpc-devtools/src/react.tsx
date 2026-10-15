import * as stylex from '@stylexjs/stylex'
import * as React from 'react'

import type { ExplorerClient } from '@overeng/effect-rpc-explorer'
import type {
  ExplorerInitialFilters,
  RpcExplorerPresentation,
} from '@overeng/effect-rpc-explorer-react'

type TraceHref = React.ComponentProps<typeof Explorer>['traceHref']

/** Structural devbar panel contract, with no shell dependency. */
export interface RpcExplorerPanel {
  readonly id: string
  readonly label: string
  readonly badge?: React.ReactNode
  readonly render: () => React.ReactNode
}
/** Builds a stable descriptor; the explorer chunk loads only when render mounts. */
export const rpcExplorerPanel = (options: {
  readonly client: ExplorerClient
  readonly id: string
  readonly label: string
  readonly badge?: React.ReactNode
  readonly initialFilters?: ExplorerInitialFilters
  readonly presentation?: RpcExplorerPresentation
  readonly traceHref?: TraceHref
}): RpcExplorerPanel => ({
  id: options.id,
  label: options.label,
  badge: options.badge,
  render: () => (
    <div {...stylex.props(styles.body)}>
      <ExplorerBoundary label={options.label}>
        <React.Suspense fallback={<div role="status">Loading {options.label} explorer…</div>}>
          <Explorer
            client={options.client}
            {...(options.initialFilters === undefined
              ? {}
              : { initialFilters: options.initialFilters })}
            {...(options.traceHref === undefined ? {} : { traceHref: options.traceHref })}
            presentation={{
              ...options.presentation,
              style: [options.presentation?.style, styles.explorer],
            }}
          />
        </React.Suspense>
      </ExplorerBoundary>
    </div>
  ),
})
const Explorer = React.lazy(() =>
  import('@overeng/effect-rpc-explorer-react').then((module) => ({ default: module.RpcExplorer })),
)
const styles = stylex.create({
  body: {
    height: '100%',
    minHeight: 0,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    flexGrow: 1,
  },
  explorer: { height: '100%', minHeight: 0, minWidth: 0, flexGrow: 1 },
})
type ErrorState = { readonly _tag: 'Ready' } | { readonly _tag: 'Failed' }
class ExplorerBoundary extends React.Component<
  { readonly label: string; readonly children: React.ReactNode },
  ErrorState
> {
  override state: ErrorState = { _tag: 'Ready' }
  static getDerivedStateFromError(): ErrorState {
    return { _tag: 'Failed' }
  }
  override render() {
    return this.state._tag === 'Failed' ? (
      <div role="alert">Unable to load {this.props.label} explorer.</div>
    ) : (
      this.props.children
    )
  }
}
