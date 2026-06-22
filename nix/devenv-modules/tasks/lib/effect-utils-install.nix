# Shared pnpm install command for the cross-repo effect-utils source relink.
#
# Repos that compose effect-utils as a linked pnpm source workspace must
# pre-warm `repos/effect-utils`'s own node_modules so TypeScript resolves
# imports through the cross-repo symlinks. Centralizing the command here keeps
# the pnpm store-dir resolution in one place: it is sourced from the
# CI-exported env (PNPM_CONFIG_STORE_DIR / PNPM_STORE_DIR) so the relink shares
# one store with the root install, falling back to the workspace store locally.
#
# A hardcoded CLI `--config.store-dir` has the highest pnpm precedence and would
# override the CI env, splitting a single deploy job across two stores and
# desyncing the root node_modules projection (the `next: command not found`
# class of failure). `--force` performs the GVS relink. `--frozen-lockfile` is
# explicit (not relying on pnpm's CI-only default for frozen) so a drifted
# effect-utils lockfile fails loudly in both local and CI runs rather than being
# silently rewritten.
{ root, dir ? "repos/effect-utils" }:
''DT_PASSTHROUGH=1 pnpm install --force --frozen-lockfile --ignore-scripts --config.confirmModulesPurge=false --config.store-dir="''${PNPM_CONFIG_STORE_DIR:-''${PNPM_STORE_DIR:-${root}/.devenv/pnpm-store-pure-v1}}" --dir ${dir}''
