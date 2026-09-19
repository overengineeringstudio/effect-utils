# Generated file - DO NOT EDIT
# Source: from-source-products.nix.genie.ts

{
  mkBuckProductFromSource,
  preparedDeps,
  producerCommit,
  repositoryRoot ? ../..,
}:

{
  "@overeng/content-address" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/content-address";
      outputName = "overeng-content-address.tgz";
      packagePath = "packages/@overeng/content-address";
      packageTreePath = "packages/@overeng/content-address";
      target = "effect_utils//packages/@overeng/content-address:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/effect-distributed-lock" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/effect-distributed-lock";
      outputName = "overeng-effect-distributed-lock.tgz";
      packagePath = "packages/@overeng/effect-distributed-lock";
      packageTreePath = "packages/@overeng/effect-distributed-lock";
      target = "effect_utils//packages/@overeng/effect-distributed-lock:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/notion-core" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/notion-core";
      outputName = "overeng-notion-core.tgz";
      packagePath = "packages/@overeng/notion-core";
      packageTreePath = "packages/@overeng/notion-core";
      target = "effect_utils//packages/@overeng/notion-core:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/notion-effect-client" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/notion-effect-client";
      outputName = "overeng-notion-effect-client.tgz";
      packagePath = "packages/@overeng/notion-effect-client";
      packageTreePath = "packages/@overeng/notion-effect-client";
      target = "effect_utils//packages/@overeng/notion-effect-client:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/notion-effect-schema" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/notion-effect-schema";
      outputName = "overeng-notion-effect-schema.tgz";
      packagePath = "packages/@overeng/notion-effect-schema";
      packageTreePath = "packages/@overeng/notion-effect-schema";
      target = "effect_utils//packages/@overeng/notion-effect-schema:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/otel-contract" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/otel-contract";
      outputName = "overeng-otel-contract.tgz";
      packagePath = "packages/@overeng/otel-contract";
      packageTreePath = "packages/@overeng/otel-contract";
      target = "effect_utils//packages/@overeng/otel-contract:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/tui-core" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/tui-core";
      outputName = "overeng-tui-core.tgz";
      packagePath = "packages/@overeng/tui-core";
      packageTreePath = "packages/@overeng/tui-core";
      target = "effect_utils//packages/@overeng/tui-core:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/tui-react" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/tui-react";
      outputName = "overeng-tui-react.tgz";
      packagePath = "packages/@overeng/tui-react";
      packageTreePath = "packages/@overeng/tui-react";
      target = "effect_utils//packages/@overeng/tui-react:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/utils" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/utils";
      outputName = "overeng-utils.tgz";
      packagePath = "packages/@overeng/utils";
      packageTreePath = "packages/@overeng/utils";
      target = "effect_utils//packages/@overeng/utils:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "@overeng/utils-dev" = mkBuckProductFromSource {
    product = {
      kind = "package";
      name = "@overeng/utils-dev";
      outputName = "overeng-utils-dev.tgz";
      packagePath = "packages/@overeng/utils-dev";
      packageTreePath = "packages/@overeng/utils-dev";
      target = "effect_utils//packages/@overeng/utils-dev:dist-package";
      version = "0.1.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "ci-tools" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "ci-tools";
      outputName = "ci-tools.js";
      packagePath = "packages/@overeng/ci-tools";
      packageTreePath = "packages/@overeng/ci-tools";
      target = "effect_utils//packages/@overeng/ci-tools:ci-tools-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "genie" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "genie";
      outputName = "genie.js";
      packagePath = "packages/@overeng/genie";
      packageTreePath = "packages/@overeng/genie";
      target = "effect_utils//packages/@overeng/genie:genie-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "genie-bootstrap-closure-check" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "genie-bootstrap-closure-check";
      outputName = "genie-bootstrap-closure-check.js";
      packagePath = "packages/@overeng/genie";
      packageTreePath = "packages/@overeng/genie";
      target = "effect_utils//packages/@overeng/genie:genie-bootstrap-closure-check-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "megarepo" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "megarepo";
      outputName = "mr.js";
      packagePath = "packages/@overeng/megarepo";
      packageTreePath = "packages/@overeng/megarepo";
      target = "effect_utils//packages/@overeng/megarepo:megarepo-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "notion-cli" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "notion-cli";
      outputName = "notion.js";
      packagePath = "packages/@overeng/notion-cli";
      packageTreePath = "packages/@overeng/notion-cli";
      target = "effect_utils//packages/@overeng/notion-cli:notion-cli-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "notion-db-runtime" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "notion-db-runtime";
      outputName = "notion-db.js";
      packagePath = "packages/@overeng/notion-cli";
      packageTreePath = "packages/@overeng/notion-datasource-sync";
      target = "effect_utils//packages/@overeng/notion-cli:notion-db-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "notion-md" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "notion-md";
      outputName = "notion-md.js";
      packagePath = "packages/@overeng/notion-md";
      packageTreePath = "packages/@overeng/notion-md";
      target = "effect_utils//packages/@overeng/notion-md:notion-md-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "npm-release" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "npm-release";
      outputName = "npm-release.js";
      packagePath = "packages/@overeng/npm-release";
      packageTreePath = "packages/@overeng/npm-release";
      target = "effect_utils//packages/@overeng/npm-release:npm-release-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "oxc-config" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "oxc-config";
      outputName = "oxc-config.js";
      packagePath = "packages/@overeng/oxc-config";
      packageTreePath = "packages/@overeng/oxc-config";
      target = "effect_utils//packages/@overeng/oxc-config:oxc-config-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
  "tui-stories" = mkBuckProductFromSource {
    product = {
      kind = "javascript";
      name = "tui-stories";
      outputName = "tui-stories.js";
      packagePath = "packages/@overeng/tui-stories";
      packageTreePath = "packages/@overeng/tui-stories";
      target = "effect_utils//packages/@overeng/tui-stories:tui-stories-candidate";
      version = "0.0.0";
    };
    inherit preparedDeps;
    inherit producerCommit repositoryRoot;
  };
}
