import assert from 'node:assert/strict'

import { rewritePackageTree } from './rewrite-package-tree.mjs'

const generatedBuck = `load("//buck2:materialization.bzl", "export_materialization_inputs", "package_view")

package_view(
    name = "package_tree",
    dependency_view = "//buck2/dependencies:view_packages_overeng_megarepo_b89b4c18f380",
    files = {
        "src/a.ts": "src/a.ts",
    },
    workspace_dist = {
        "node_modules/@overeng/effect-path/dist": "//packages/@overeng/effect-path:dist",
        "node_modules/@overeng/kdl/dist": "//packages/@overeng/kdl:dist",
    },
    workspace_dependency_views = {
        "node_modules/@overeng/effect-path/node_modules": "//packages/@overeng/effect-path:package_tree",
        "node_modules/@overeng/kdl/node_modules": "//packages/@overeng/kdl:package_tree",
    },
)

package_view(
    name = "test_package_tree",
    dependency_view = "//buck2/dependencies:view_packages_overeng_megarepo_b89b4c18f380",
)
`

const rewritten = rewritePackageTree(generatedBuck)
assert.match(
  rewritten,
  /load\("\/\/buck2:materialization\.bzl", "export_materialization_inputs", "package_tree", "package_view"\)/u,
)
assert.match(rewritten, /package_tree\(\n    name = "package_tree",/u)
assert.match(rewritten, /    node_modules = "\/\/:nix_prepared_node_modules",/u)
assert.doesNotMatch(rewritten, /workspace_dist = \{/u)
assert.doesNotMatch(rewritten, /workspace_dependency_views = \{/u)
assert.match(rewritten, /package_view\(\n    name = "test_package_tree",/u)
assert.equal(rewritePackageTree(rewritten), rewritten)
assert.throws(
  () => rewritePackageTree(generatedBuck.replace('package_view(\n', 'unknown_view(\n')),
  /Expected exactly one package_tree declaration/u,
)

console.log('package tree rewrite contract passed')
