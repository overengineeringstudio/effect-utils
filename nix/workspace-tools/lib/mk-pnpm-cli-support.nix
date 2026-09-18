{ pkgs }:

let
  sourceInputSpecifiersModule = ./pnpm-source-input-specifiers.cjs;
  alignAggregateManifestSpecifiersSource = pkgs.writeText "align-aggregate-manifest-specifiers.cjs" ''
    const fs = require("node:fs");
    const path = require("node:path");
    const specifiers = require("${sourceInputSpecifiersModule}");

    const [workspaceYamlPath, lockfilePath] = process.argv.slice(2);
    if (!workspaceYamlPath || !lockfilePath) {
      console.error(
        "usage: align-aggregate-manifest-specifiers.cjs <pnpm-workspace.yaml> <pnpm-lock.yaml>"
      );
      process.exit(1);
    }

    const parsedLockfile = Bun.YAML.parse(fs.readFileSync(lockfilePath, "utf8"));
    const documents = Array.isArray(parsedLockfile) ? parsedLockfile : [parsedLockfile];
    const importers = new Map();
    for (const document of documents) {
      if (document === null || typeof document !== "object" || Array.isArray(document)) continue;
      const documentImporters = document.importers;
      if (
        documentImporters === null ||
        typeof documentImporters !== "object" ||
        Array.isArray(documentImporters)
      ) continue;
      for (const [importerPath, importer] of Object.entries(documentImporters)) {
        if (importers.has(importerPath)) {
          throw new Error(`duplicate lockfile importer across YAML documents: ''${importerPath}`);
        }
        importers.set(importerPath, importer);
      }
    }
    const workspaceRoot = process.cwd();
    const dependencySections = ["dependencies", "devDependencies", "optionalDependencies"];

    for (const [importerPath, importer] of importers) {
      const manifestPath = path.resolve(
        importerPath === "." ? "package.json" : path.join(importerPath, "package.json")
      );
      if (!specifiers.isWithin(workspaceRoot, manifestPath)) {
        throw new Error(`lockfile importer escaped staged workspace: ''${importerPath}`);
      }
      if (!fs.existsSync(manifestPath)) continue;

      const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      let changed = false;
      for (const section of dependencySections) {
        const lockedDependencies = importer[section];
        const manifestDependencies = manifest[section];
        if (lockedDependencies === undefined || manifestDependencies === undefined) continue;

        for (const [dependencyName, lockedDependency] of Object.entries(lockedDependencies)) {
          const specifier = lockedDependency?.specifier;
          if (typeof specifier !== "string") continue;
          if (typeof manifestDependencies[dependencyName] !== "string") continue;
          if (!specifiers.targetsSourceInputStage(specifier)) continue;

          // pnpm records the specifier relative to the importer that declares
          // it, which is also the only spelling that resolves from that
          // manifest. Re-derive it rather than trusting the recorded spelling,
          // so the staged manifest and the lockfile cannot disagree and the
          // following frozen install cannot reject the pair.
          manifestDependencies[dependencyName] = specifiers.relativizeSourceInputSpecifier({
            importerPath,
            specifier,
          });
          changed = true;
        }
      }

      if (changed) fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    }

    // Drop the source-input projection from the prepared tree. The projection
    // is a live-worktree concern: the prepared tree carries the staged sources
    // themselves, so a retained override would re-point a restored workspace at
    // a `.devenv` path that the consumer does not have. Values are classified by
    // resolved target, so both the root-relative and importer-relative
    // spellings of the same dependency are removed.
    const stripSourceInputOverrides = (yamlPath) => {
      const lines = fs.readFileSync(yamlPath, "utf8").split("\n");
      let inOverrides = false;
      const filteredLines = lines.filter((line) => {
        if (line === "overrides:") {
          inOverrides = true;
          return true;
        }
        if (inOverrides && line.trim() !== "" && /^\S/.test(line)) inOverrides = false;
        if (!inOverrides) return true;
        // A YAML mapping separates key and value with a colon FOLLOWED BY a
        // space; the colon inside `file:` never is. Splitting on the first
        // `": "` therefore yields the value for any override key, including a
        // quoted scoped name carrying its own version range.
        const separator = line.indexOf(": ");
        if (separator === -1) return true;
        const value = line.slice(separator + 2).trim();
        const unquoted = value.replace(/^['"]/, "").replace(/['"]$/, "");
        return !specifiers.targetsSourceInputStage(unquoted);
      });
      fs.writeFileSync(yamlPath, filteredLines.join("\n"));
    };

    stripSourceInputOverrides(workspaceYamlPath);
    stripSourceInputOverrides(lockfilePath);
  '';
in
{
  alignAggregateManifestSpecifiersScript = pkgs.writeShellScript "align-aggregate-manifest-specifiers" ''
    exec ${pkgs.bun}/bin/bun ${alignAggregateManifestSpecifiersSource} "$@"
  '';
}
