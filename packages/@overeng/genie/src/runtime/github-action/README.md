# github-action

Generate GitHub Action metadata files (`action.yml`) with type safety.

## Usage

```ts
import { githubAction } from '@overeng/genie'

export default githubAction({
  name: 'CI bootstrap',
  description: 'Shared CI setup',
  inputs: {
    'cache-name': {
      description: 'Cachix cache name',
      required: true,
    },
  },
  runs: {
    using: 'composite',
    steps: [
      {
        name: 'Install Nix',
        uses: 'DeterminateSystems/determinate-nix-action@v3',
      },
    ],
  },
})
```
