- Pull requests record user-facing changes in separate `changelog.d` fragments
  instead of editing the shared Unreleased changelog. Release maintainers assemble
  them with `devenv tasks run changelog:assemble`; CI requires a new fragment or
  an explicit `Changelog-None: <reason>` trailer on the PR's latest commit.
