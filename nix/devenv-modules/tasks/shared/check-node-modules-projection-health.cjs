const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

/**
 * GVS can leave package symlinks present while still dropping transitive
 * projections after config/path changes. Checking only for broken symlinks
 * misses that failure mode, so this helper resolves each symlinked package's
 * declared runtime deps from the package's real path.
 */
const moduleDirs = (process.env.NODE_MODULES_DIRS || "")
  .split("\n")
  .map((value) => value.trim())
  .filter(Boolean)
  .filter((value, index, values) => values.indexOf(value) === index)
  .filter((value) => fs.existsSync(value));

const dependencyProjectionFailures = [];

const collectEntryPaths = (nodeModulesDir) => {
  const result = [];
  for (const entry of fs.readdirSync(nodeModulesDir, { withFileTypes: true })) {
    if (entry.name === ".bin" || entry.name === ".pnpm") continue;

    const entryPath = path.join(nodeModulesDir, entry.name);
    if (entry.name.startsWith("@") && entry.isDirectory()) {
      for (const scopedEntry of fs.readdirSync(entryPath, { withFileTypes: true })) {
        result.push(path.join(entryPath, scopedEntry.name));
      }
      continue;
    }

    result.push(entryPath);
  }
  return result;
};

for (const nodeModulesDir of moduleDirs) {
  for (const entryPath of collectEntryPaths(nodeModulesDir)) {
    let stat;
    try {
      stat = fs.lstatSync(entryPath);
    } catch {
      continue;
    }

    if (!stat.isSymbolicLink()) continue;

    let realPath;
    try {
      realPath = fs.realpathSync(entryPath);
    } catch {
      continue;
    }

    const packageJsonPath = path.join(realPath, "package.json");
    if (!fs.existsSync(packageJsonPath)) continue;

    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    const dependencyNames = Object.keys(pkg.dependencies ?? {});
    if (dependencyNames.length === 0) continue;

    const requireFromPkg = createRequire(packageJsonPath);
    for (const dependencyName of dependencyNames) {
      try {
        requireFromPkg.resolve(`${dependencyName}/package.json`);
      } catch {
        dependencyProjectionFailures.push(
          `${pkg.name ?? entryPath} -> ${dependencyName} (from ${nodeModulesDir})`
        );
      }
    }
  }
}

if (dependencyProjectionFailures.length > 0) {
  for (const failure of dependencyProjectionFailures) {
    console.error(`[pnpm] Missing dependency projection: ${failure}`);
  }
  process.exit(1);
}
