import { githubAction } from '../../../packages/@overeng/genie/src/runtime/mod.ts'

export default githubAction({
  name: 'CI Bootstrap',
  description: 'Install Nix, enable Cachix, and optionally sync megarepo/install devenv',
  inputs: {
    'cache-name': {
      description: 'Cachix cache name',
      required: true,
    },
    'cachix-auth-token': {
      description: 'Optional Cachix auth token',
      required: false,
      default: '',
    },
    'extra-nix-conf': {
      description: 'Additional lines appended to Nix extra-conf',
      required: false,
      default: '',
    },
    'install-megarepo': {
      description: 'Install the megarepo CLI',
      required: false,
      default: 'false',
    },
    'sync-megarepo': {
      description: 'Run mr sync',
      required: false,
      default: 'false',
    },
    'sync-megarepo-frozen': {
      description: 'Add --frozen when syncing megarepo',
      required: false,
      default: 'true',
    },
    'sync-megarepo-skip': {
      description: 'Comma-separated member names to skip during sync',
      required: false,
      default: '',
    },
    'install-devenv': {
      description: 'Install devenv from devenv.lock',
      required: false,
      default: 'true',
    },
    'validate-nix-store': {
      description: 'Validate Nix store and repair only when probe fails',
      required: false,
      default: 'false',
    },
  },
  runs: {
    using: 'composite',
    steps: [
      {
        name: 'Install Nix',
        uses: 'DeterminateSystems/determinate-nix-action@v3',
        with: {
          'extra-conf': [
            'extra-substituters = https://devenv.cachix.org',
            'extra-trusted-public-keys = devenv.cachix.org-1:w1cLUi8dv3hnoSPGAuibQv+f9TZLr6cv/Hm9XgU50cw=',
            '${{ inputs.extra-nix-conf }}',
          ].join('\n'),
        },
      },
      {
        name: 'Enable Cachix cache',
        if: "${{ inputs.cachix-auth-token == '' }}",
        uses: 'cachix/cachix-action@v16',
        with: {
          name: '${{ inputs.cache-name }}',
        },
      },
      {
        name: 'Enable Cachix cache (auth)',
        if: "${{ inputs.cachix-auth-token != '' }}",
        uses: 'cachix/cachix-action@v16',
        with: {
          name: '${{ inputs.cache-name }}',
          authToken: '${{ inputs.cachix-auth-token }}',
        },
      },
      {
        name: 'Install megarepo CLI',
        if: "${{ inputs.install-megarepo == 'true' || inputs.sync-megarepo == 'true' }}",
        run: 'nix profile install github:overengineeringstudio/effect-utils#megarepo',
        shell: 'bash',
      },
      {
        name: 'Sync megarepo dependencies',
        if: "${{ inputs.sync-megarepo == 'true' }}",
        shell: 'bash',
        env: {
          SYNC_MEGAREPO_FROZEN: '${{ inputs.sync-megarepo-frozen }}',
          SYNC_MEGAREPO_SKIP: '${{ inputs.sync-megarepo-skip }}',
        },
        run: [
          'args=(mr sync)',
          'if [ "$SYNC_MEGAREPO_FROZEN" = "true" ]; then',
          '  args+=(--frozen)',
          'fi',
          '',
          'if [ -n "$SYNC_MEGAREPO_SKIP" ]; then',
          "  IFS=',' read -ra items <<< \"$SYNC_MEGAREPO_SKIP\"",
          '  for item in "${items[@]}"; do',
          '    skip=$(echo "$item" | xargs)',
          '    if [ -n "$skip" ]; then',
          '      args+=(--skip "$skip")',
          '    fi',
          '  done',
          'fi',
          '',
          '"${args[@]}"',
        ].join('\n'),
      },
      {
        name: 'Install devenv',
        if: "${{ inputs.install-devenv == 'true' }}",
        run: 'nix profile install github:cachix/devenv/$(jq -r ".nodes.devenv.locked.rev" devenv.lock)',
        shell: 'bash',
      },
      {
        name: 'Validate Nix store',
        if: "${{ inputs.validate-nix-store == 'true' }}",
        shell: 'bash',
        run: [
          'if devenv version > /dev/null 2>&1; then',
          '  echo "Nix store OK"',
          'else',
          '  echo "::warning::Nix store validation failed, running repair..."',
          '  nix-store --verify --repair 2>&1 | tail -20',
          '  devenv version',
          'fi',
        ].join('\n'),
      },
    ],
  },
})
