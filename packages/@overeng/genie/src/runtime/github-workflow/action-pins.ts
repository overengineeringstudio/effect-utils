type ActionPin = {
  readonly repo: string
  readonly sha: string
  readonly version: string
}

/** Release metadata verified against upstream tags; the SHA is the executable ref. */
export const actionPins = {
  checkout: {
    repo: 'actions/checkout',
    sha: 'd23441a48e516b6c34aea4fa41551a30e30af803',
    version: 'v6.1.0',
  },
  checkoutV4: {
    repo: 'actions/checkout',
    sha: '11d5960a326750d5838078e36cf38b85af677262',
    version: 'v4.4.0',
  },
  setupNode: {
    repo: 'actions/setup-node',
    sha: '49933ea5288caeca8642d1e84afbd3f7d6820020',
    version: 'v4.4.0',
  },
  uploadArtifact: {
    repo: 'actions/upload-artifact',
    sha: 'ea165f8d65b6e75b540449e92b4886f43607fa02',
    version: 'v4.6.2',
  },
  downloadArtifact: {
    repo: 'actions/download-artifact',
    sha: 'd3f86a106a0bac45b974a628896c90dbdf5c8093',
    version: 'v4.3.0',
  },
  cache: {
    repo: 'actions/cache',
    sha: '0057852bfaa89a56745cba8c7296529d2fc39830',
    version: 'v4.3.0',
  },
  createGithubAppToken: {
    repo: 'actions/create-github-app-token',
    sha: '64ab729a6294000f5aa4a4bc0b73d1f32bc45510',
    version: 'v3.3.0',
  },
  attest: {
    repo: 'actions/attest',
    sha: '1e69f48acb82d1966a394da916b4c1698aa569d6',
    version: 'v4.2.2',
  },
  determinateNix: {
    repo: 'DeterminateSystems/determinate-nix-action',
    sha: '92957199488000b908fdad19f63711000965d8f3',
    version: 'v3.24.1',
  },
  cachix: {
    repo: 'cachix/cachix-action',
    sha: '38b082610b782e7e93e209c35fd730d399dee866',
    version: 'v17',
  },
  installNix: {
    repo: 'cachix/install-nix-action',
    sha: '75c75c31ebece974e48ebc36b4ad125bd97bd97b',
    version: 'v31.11.3',
  },
  tailscale: {
    repo: 'tailscale/github-action',
    sha: '064b10558093f38325e838ddea35486bdc6b1d5c',
    version: 'v4.4.0',
  },
  namespaceCache: {
    repo: 'namespacelabs/nscloud-cache-action',
    sha: '1124a6f3ce44e5cf84cc22111530961f4d2a15f9',
    version: 'v1.7.0',
  },
} as const satisfies Record<string, ActionPin>

/** Emit an immutable action ref and its human-readable release annotation. */
export const pinnedAction = ({
  name,
  subpath,
}: {
  name: keyof typeof actionPins
  subpath?: 'restore' | 'save'
}): { uses: string; $comment: string } => {
  const pin = actionPins[name]
  return {
    uses: `${pin.repo}${subpath === undefined ? '' : `/${subpath}`}@${pin.sha}`,
    $comment: pin.version,
  }
}

/** Resolve policy-relevant release metadata only for a registered repository/SHA pair. */
export const pinnedActionVersion = (uses: string): string | undefined => {
  const [repo, sha] = uses.split('@')
  return Object.values(actionPins).find((pin) => pin.repo === repo && pin.sha === sha)?.version
}
