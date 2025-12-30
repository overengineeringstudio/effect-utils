/**
 * React integration for Effect.
 *
 * Provides a context-based approach for integrating Effect runtime with React applications.
 * The pattern is:
 * 1. Wrap your app in `EffectProvider` with a Layer
 * 2. Use `useEffectRunner` to run effects with automatic error handling
 * 3. Use `useEffectCallback` to create stable callbacks that run effects
 * 4. Use `useEffectOnMount` to run effects when components mount
 *
 * @example
 * ```tsx
 * const AppLayer = Layer.mergeAll(
 *   HttpClient.layer,
 *   Logger.prettyWithThread('app'),
 * )
 *
 * const App = () => (
 *   <EffectProvider layer={AppLayer}>
 *     <MainApp />
 *   </EffectProvider>
 * )
 *
 * const MainApp = () => {
 *   const runEffect = useEffectRunner()
 *
 *   return (
 *     <button onClick={() => runEffect(doSomething())}>
 *       Do Something
 *     </button>
 *   )
 * }
 * ```
 *
 * @module
 */

export {
  type CancelFn,
  EffectProvider,
  type EffectProviderConfig,
  type ErrorHandler,
  extractErrorMessage,
  type ProviderEffect,
  useEffectCallback,
  useEffectOnMount,
  useEffectRunner,
  useRuntime,
} from './context.tsx'

export { type Cuid, cuid, isCuid, isSlug, slug } from './cuid.ts'
