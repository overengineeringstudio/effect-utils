import { Schema } from 'effect'

/** Manifest permissions use GitHub's REST permission names. */
export const AppPermissions = Schema.Record(
  Schema.String,
  Schema.Literals(['read', 'write', 'admin']),
)
export type AppPermissions = typeof AppPermissions.Type

/** Declarative owner-confirmed App registration settings. */
export interface AppManifestSource {
  readonly name: string
  readonly url: string
  readonly permissions: AppPermissions
  readonly events?: readonly string[]
  readonly webhook?: { readonly url: string; readonly active?: boolean }
  readonly redirectUrl: string
  readonly public?: boolean
}

/** GitHub's manifest-flow wire payload. */
export interface AppManifest {
  readonly name: string
  readonly url: string
  readonly redirect_url: string
  readonly public: boolean
  readonly hook_attributes: { readonly url: string; readonly active: boolean }
  readonly default_permissions: AppPermissions
  readonly default_events: readonly string[]
}

/** Disabled hooks still need a URL in GitHub's manifest API. */
export const appManifest = (source: AppManifestSource): AppManifest => ({
  name: source.name,
  url: source.url,
  redirect_url: source.redirectUrl,
  public: source.public ?? false,
  hook_attributes: {
    url: source.webhook?.url ?? source.url,
    active: source.webhook?.active ?? false,
  },
  default_permissions: source.permissions,
  default_events: [...new Set(source.events ?? [])].toSorted(),
})

/** One declared versus observed permission mismatch. */
export interface AppPermissionDiff {
  readonly permission: string
  readonly desired: string | undefined
  readonly observed: string | undefined
}

/** GitHub always grants metadata:read, even when it was omitted from the manifest. */
export const appManifestDrift = ({
  desired,
  observed,
}: {
  readonly desired: Pick<AppManifestSource, 'permissions' | 'events'>
  readonly observed: {
    readonly permissions: Readonly<Record<string, string>>
    readonly events: readonly string[]
  }
}): {
  readonly permissions: readonly AppPermissionDiff[]
  readonly events:
    | { readonly desired: readonly string[]; readonly observed: readonly string[] }
    | undefined
} => {
  const permissions = [
    ...new Set([...Object.keys(desired.permissions), ...Object.keys(observed.permissions)]),
  ]
    .toSorted()
    .filter(
      (name) =>
        !(
          name === 'metadata' &&
          desired.permissions.metadata === undefined &&
          observed.permissions.metadata === 'read'
        ),
    )
    .filter((name) => desired.permissions[name] !== observed.permissions[name])
    .map((permission) => ({
      permission,
      desired: desired.permissions[permission],
      observed: observed.permissions[permission],
    }))
  const desiredEvents = [...new Set(desired.events ?? [])].toSorted()
  const observedEvents = [...new Set(observed.events)].toSorted()
  return {
    permissions,
    events:
      desiredEvents.length === observedEvents.length &&
      desiredEvents.every((event, index) => event === observedEvents[index]) === true
        ? undefined
        : { desired: desiredEvents, observed: observedEvents },
  }
}

const escapeAttribute = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')

const encodeManifest = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      name: Schema.String,
      url: Schema.String,
      redirect_url: Schema.String,
      public: Schema.Boolean,
      hook_attributes: Schema.Struct({ url: Schema.String, active: Schema.Boolean }),
      default_permissions: AppPermissions,
      default_events: Schema.Array(Schema.String),
    }),
  ),
)

/** A portable form; no local listener, browser automation, or secret-bearing URL. */
export const appManifestForm = ({
  manifest,
  formUrl,
}: {
  readonly manifest: AppManifest
  readonly formUrl: string
}): string =>
  `<form method="post" action="${escapeAttribute(formUrl)}"><input type="hidden" name="manifest" value="${escapeAttribute(encodeManifest(manifest))}"><button type="submit">Register GitHub App</button></form>`
