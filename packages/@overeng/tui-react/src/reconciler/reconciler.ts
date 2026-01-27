/**
 * TUI React Reconciler.
 *
 * Creates the React reconciler instance using our host config.
 */

import ReactReconciler from 'react-reconciler'
import { hostConfig, type TuiContainer } from './host-config.ts'

/** The reconciler instance */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const TuiReconciler = ReactReconciler(hostConfig as any)

export type { TuiContainer }
