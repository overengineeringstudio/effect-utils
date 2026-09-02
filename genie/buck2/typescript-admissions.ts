import { Buffer } from 'node:buffer'

import { buck2TypeScriptAdmission as contentAddressAdmission } from '../../packages/@overeng/content-address/BUCK.genie.ts'
import { buck2TypeScriptAdmission as effectDistributedLockAdmission } from '../../packages/@overeng/effect-distributed-lock/BUCK.genie.ts'
import { buck2TypeScriptAdmission as otelContractAdmission } from '../../packages/@overeng/otel-contract/BUCK.genie.ts'
import { buck2TypeScriptAdmission as stylexPresetAdmission } from '../../packages/@overeng/stylex-preset/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiCoreAdmission } from '../../packages/@overeng/tui-core/BUCK.genie.ts'
import { buck2TypeScriptAdmission as tuiReactAdmission } from '../../packages/@overeng/tui-react/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsAdmission } from '../../packages/@overeng/utils/BUCK.genie.ts'
import { buck2TypeScriptAdmission as utilsDevAdmission } from '../../packages/@overeng/utils-dev/BUCK.genie.ts'
import type {
  Buck2TypeScriptAuthorityMetadata,
  Buck2TypeScriptPackageProjection,
} from './typescript-package-projection.ts'

export type { Buck2TypeScriptAuthorityMetadata } from './typescript-package-projection.ts'

/** Buck TypeScript projection input plus editor publication and optional authority admission. */
export type Buck2TypeScriptAdmission = Buck2TypeScriptPackageProjection & {
  readonly editorViewConsumer: boolean
  readonly authority?: Buck2TypeScriptAuthorityMetadata
}

/** Derived command and manifest data for a Buck-authoritative TypeScript package. */
export type AuthoritativeBuck2TypeScriptAdmission = Buck2TypeScriptAuthorityMetadata & {
  readonly packagePath: string
  readonly typecheckTarget: `//${string}:typecheck`
  readonly distTarget: `//${string}:dist`
}

/** Semantic registry for every package admitted to the Buck TypeScript projection. */
export const buck2TypeScriptAdmissions = {
  contentAddress: contentAddressAdmission,
  effectDistributedLock: effectDistributedLockAdmission,
  otelContract: otelContractAdmission,
  tuiCore: tuiCoreAdmission,
  tuiReact: tuiReactAdmission,
  stylexPreset: stylexPresetAdmission,
  utils: utilsAdmission,
  utilsDev: utilsDevAdmission,
} as const satisfies Record<string, Buck2TypeScriptAdmission>

/** Derives labels rather than duplicating them in package-local authority metadata. */
export const deriveBuck2TypeScriptAuthority = ({
  authority,
  packagePath,
}: Buck2TypeScriptAdmission & {
  readonly authority: Buck2TypeScriptAuthorityMetadata
}): AuthoritativeBuck2TypeScriptAdmission => ({
  declarationEntrypoint: authority.declarationEntrypoint,
  distTarget: `//${packagePath}:dist`,
  packagePath,
  projectFile: authority.projectFile,
  typecheckTarget: `//${packagePath}:typecheck`,
})

/** Registry-ordered packages whose TypeScript checking and declarations are Buck-owned. */
export const authoritativeBuck2TypeScriptAdmissions = Object.values(
  buck2TypeScriptAdmissions,
).flatMap(
  (admission: Buck2TypeScriptAdmission): readonly AuthoritativeBuck2TypeScriptAdmission[] =>
    admission.authority === undefined
      ? []
      : [
          deriveBuck2TypeScriptAuthority({
            ...admission,
            authority: admission.authority,
          }),
        ],
)

/** Dist overlays derived from the same package-local authority declarations. */
export const buck2TypeScriptDistOverlays = authoritativeBuck2TypeScriptAdmissions.map(
  ({ distTarget, packagePath }) => ({
    target: distTarget,
    destination: `${packagePath}/dist`,
  }),
)

/** Byte-sorted package paths whose editor dependency surface is currently admitted. */
export const editorViewConsumerPackagePaths = Object.values(buck2TypeScriptAdmissions)
  .filter((admission) => admission.editorViewConsumer === true)
  .map((admission) => admission.packagePath)
  .toSorted((left, right) => Buffer.from(left).compare(Buffer.from(right)))
