import * as stylex from '@stylexjs/stylex'
import { Effect, Exit, Metric, Scope } from 'effect'
import * as React from 'react'
import { createRoot } from 'react-dom/client'

import { darkExplorerTheme } from '@overeng/effect-rpc-explorer-react/themes'
import { darkMeterTheme, lightMeterTheme, type CanvasBlockSpec } from '@overeng/meters/canvas'
import { MeterStrip, RenderProfiler } from '@overeng/meters/react'
import { rpcExplorerPanel } from '@overeng/rpc-devtools/react'

import { Devbar, type DevbarPanel } from '../../Devbar.tsx'
import { darkDevbarTheme, lightDevbarTheme } from '../../themes.ts'
import { devbarTokens } from '../../tokens.stylex.ts'
import type { HostDiagnosticsOptions } from './boundary.ts'
import { makeHostRuntime, type HostRuntime, type HostRuntimeError } from './runtime.ts'

/** Guarded host entry: acquire one scope, mount the UI, and release both together. */
export const mountDiagnostics = async (
  options: HostDiagnosticsOptions,
): Promise<() => Promise<void>> => {
  const scope = await Effect.runPromise(Scope.make())
  const program: Effect.Effect<HostRuntime, HostRuntimeError, never> = makeHostRuntime.pipe(
    Scope.provide(scope),
    Metric.enableRuntimeMetrics,
  )
  const result = await Effect.runPromiseExit(program)
  if (Exit.isFailure(result) === true) {
    await Effect.runPromise(Scope.close(scope, result))
    return Effect.runPromise(Effect.failCause(result.cause))
  }
  if (options.signal.aborted === true) {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    return async () => {}
  }
  const root = createRoot(options.node)
  root.render(<Diagnostics runtime={result.value} options={options} />)
  return async () => {
    root.unmount()
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

const styles = stylex.create({
  host: {
    position: 'relative',
    height: '36rem',
    padding: '1.5rem',
    paddingBottom: '32px',
    boxSizing: 'border-box',
    backgroundColor: devbarTokens.panel,
    color: devbarTokens.text,
    fontFamily: devbarTokens.fontUi,
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: devbarTokens.border,
  },
  controls: { display: 'flex', gap: '0.75rem', alignItems: 'center' },
  detail: { padding: '1rem', overflow: 'auto', fontFamily: devbarTokens.fontData },
  muted: { color: devbarTokens.mutedText },
  segment: { whiteSpace: 'nowrap', color: devbarTokens.mutedText },
})

const Detail = ({
  runtime,
  block,
}: {
  readonly runtime: HostRuntime
  readonly block: CanvasBlockSpec
}): React.ReactNode => {
  React.useSyncExternalStore(
    (notify) => runtime.meters.store.subscribe({ notify }),
    runtime.meters.store.getRevision,
    runtime.meters.store.getRevision,
  )
  return (
    <section {...stylex.props(styles.detail)} aria-label={`${block.label} details`}>
      <h2>{block.label}</h2>
      <output aria-label={`${block.label} current reading`}>
        {block.read(runtime.meters.store).describe()}
      </output>
      <p {...stylex.props(styles.muted)}>
        Live evidence from the same scoped session as the strip. Unsupported or unconfigured
        capabilities remain n/a; closing this panel does not stop collection.
      </p>
      {block.id === 'fibers' && (
        <p>
          Effect runtime metrics are enabled in this host scope. This is the active child-fiber
          gauge, including diagnostic child fibers, not all fibers.
        </p>
      )}
      {block.id === 'heap' && (
        <p>
          Approximate shared JS heap from the browser's non-standard memory API; not total
          application memory.
        </p>
      )}
      {block.id === 'longFrames' && (
        <p>
          Long-animation-frame entries when supported, otherwise long tasks. No synthetic frame
          durations are injected.
        </p>
      )}
      <p>
        Host observable-gauge callback:{' '}
        {runtime
          .readRetained()
          .map(
            (observation) =>
              `${observation.value} ${observation.attributes['rpc.explorer.record.kind']}`,
          )
          .join(', ')}{' '}
        RPC records retained.
      </p>
    </section>
  )
}

const SyncStatus = ({ runtime }: { readonly runtime: HostRuntime }): React.ReactNode => {
  const status = React.useSyncExternalStore(
    runtime.status.subscribe,
    runtime.status.getSnapshot,
    runtime.status.getSnapshot,
  )
  return (
    <output aria-label="Simulated host sync status" {...stylex.props(styles.segment)}>
      Sync: {status} (simulated)
    </output>
  )
}

const HostContent = ({ runtime }: { readonly runtime: HostRuntime }): React.ReactNode => {
  const [response, setResponse] = React.useState('No project loaded yet')
  return (
    <main>
      <h1>Host app workspace</h1>
      <p>
        In-memory RPC transport, real browser measurements, and a host-supplied simulated sync
        stream.
      </p>
      <div {...stylex.props(styles.controls)}>
        <button
          type="button"
          onClick={() => {
            setResponse('Loading project…')
            void Effect.runPromise(runtime.request.pipe(Metric.enableRuntimeMetrics)).then(
              (project) => setResponse(`Loaded ${project.title}`),
              () => setResponse('Unable to load project; retry the request.'),
            )
          }}
        >
          Load project via RPC
        </button>
        <button
          type="button"
          onClick={() => {
            void Effect.runPromise(runtime.toggleStatus)
          }}
        >
          Toggle simulated sync
        </button>
      </div>
      <p role="status" aria-label="Project request result">
        {response}
      </p>
      <p {...stylex.props(styles.muted)}>
        Panel selection is persisted by this host in localStorage. The shell owns neither storage
        nor enabling.
      </p>
    </main>
  )
}

const Diagnostics = ({
  runtime,
  options,
}: {
  readonly runtime: HostRuntime
  readonly options: HostDiagnosticsOptions
}): React.ReactNode => {
  const panels = React.useMemo<readonly DevbarPanel[]>(
    () => [
      rpcExplorerPanel({
        client: runtime.tools.client,
        id: 'rpc',
        label: 'RPC',
        presentation: { layout: 'wide' },
      }),
      ...runtime.blocks
        .filter((block) => block.id.startsWith('rpc.') === false)
        .map((block) => ({
          id: block.id,
          label: block.label,
          render: () => <Detail runtime={runtime} block={block} />,
        })),
    ],
    [runtime],
  )
  const [openPanel, setOpenPanel] = React.useState<string | undefined>(() => {
    try {
      const stored = localStorage.getItem(options.storageKey)
      return panels.some((panel) => panel.id === stored) === true
        ? (stored ?? undefined)
        : undefined
    } catch {
      return undefined
    }
  })
  const [frozen, setFrozen] = React.useState(false)
  const selectPanel = (id: string | undefined): void => {
    setOpenPanel(id)
    try {
      if (id === undefined) localStorage.removeItem(options.storageKey)
      else localStorage.setItem(options.storageKey, id)
    } catch {
      // Storage denial does not prevent host-controlled in-memory interaction.
    }
  }
  return (
    <div
      {...stylex.props(
        styles.host,
        options.dark === true ? darkDevbarTheme : lightDevbarTheme,
        options.dark === true && darkExplorerTheme,
      )}
    >
      <RenderProfiler
        id="host-content"
        instrumentation={runtime.instrumentation}
        counter={runtime.commitToken}
      >
        <HostContent runtime={runtime} />
      </RenderProfiler>
      <Devbar
        placement="container"
        panels={panels}
        openPanel={openPanel}
        onOpenPanelChange={selectPanel}
        strip={
          <MeterStrip
            meters={runtime.meters}
            blocks={runtime.blocks}
            theme={options.dark === true ? darkMeterTheme : lightMeterTheme}
            frozen={frozen}
            onFrozenChange={setFrozen}
            onOpenDetail={({ id }) => selectPanel(id.startsWith('rpc.') === true ? 'rpc' : id)}
          />
        }
        segments={[{ id: 'host-sync', render: () => <SyncStatus runtime={runtime} /> }]}
      />
    </div>
  )
}
