#!/usr/bin/env bash
set -euo pipefail

if [ "$#" -ne 9 ]; then
  echo "usage: $0 <generate|check> <repository-root> <workspace-root> <third-party-buck> <reindeer> <cargo> <rustc> <bun> <foreign-fixups-script>" >&2
  exit 64
fi

mode="$1"
root="$2"
workspace_relative="$3"
third_party_buck_relative="$4"
reindeer="$5"
cargo="$6"
rustc="$7"
bun="$8"
foreign_fixups_script="$9"

case "$mode" in
  generate | check) ;;
  *)
    echo "buck2-rust-deps: unknown mode: $mode" >&2
    exit 64
    ;;
esac

cd "$root"
root="$(pwd -P)"
cd "$root/$workspace_relative"
workspace="$(pwd -P)"
case "$workspace" in
  "$root" | "$root"/*) ;;
  *)
    echo "buck2-rust-deps: workspace root escapes repository: $workspace_relative" >&2
    exit 64
    ;;
esac
case "$third_party_buck_relative" in
  /* | *\\* | ../* | */../* | */..)
    echo "buck2-rust-deps: third-party BUCK must be repository-relative: $third_party_buck_relative" >&2
    exit 64
    ;;
esac
if [ "$(basename "$third_party_buck_relative")" != BUCK ]; then
  echo "buck2-rust-deps: third-party graph path must end in BUCK: $third_party_buck_relative" >&2
  exit 64
fi
third_party="$(cd "$root/$(dirname "$third_party_buck_relative")" && pwd -P)"
case "$third_party" in
  "$root" | "$root"/*) ;;
  *)
    echo "buck2-rust-deps: third-party graph escapes repository: $third_party_buck_relative" >&2
    exit 64
    ;;
esac
third_party_buck="$third_party/BUCK"
if [ -L "$third_party_buck" ]; then
  echo "buck2-rust-deps: third-party BUCK must not be a symlink: $third_party_buck_relative" >&2
  exit 64
fi
config="$workspace/reindeer.toml"
lock="$workspace/Cargo.lock"
cargo_home="$root/.devenv/reindeer-cargo-home"
# Reindeer reads `third_party_dir` and `vendor` from the TOML root table; a
# line scan would also match keys inside other tables or miss literal strings.
# Bun's TOML parser is the one the Cargo projection uses for the same file.
if ! reindeer_third_party="$(
  "$bun" -e '
const config = Bun.TOML.parse(await Bun.file(process.argv[1]).text());
const dir = config.third_party_dir;
if (typeof dir !== "string" || dir === "") throw new Error("third_party_dir must be a non-empty root-level string");
if (/[\u0000-\u001f\u007f]/.test(dir)) throw new Error("third_party_dir must not contain control characters");
if (config.vendor !== false) throw new Error("vendor must be the root-level boolean false");
process.stdout.write(dir);
' "$config"
)"; then
  echo "buck2-rust-deps: invalid ${config#"$root"/} (must select root-level vendor = false and third_party_dir)" >&2
  exit 1
fi
configured_third_party="$(cd "$workspace/$reindeer_third_party" && pwd -P)"
if [ "$configured_third_party" != "$third_party" ]; then
  echo "buck2-rust-deps: third-party BUCK disagrees with ${config#"$root"/} third_party_dir" >&2
  exit 1
fi

fixup_violations=0
for fixup in "$third_party"/fixups/*/fixups.toml; do
  [ -f "$fixup" ] || continue
  if grep -nE '^[[:space:]]*(omit_srcs|extra_srcs)[[:space:]]*=' "$fixup"; then
    echo "buck2-rust-deps: non-vendored fixup uses a discarded source key: ${fixup#"$root"/}" >&2
    fixup_violations=1
  else
    grep_status=$?
    if [ "$grep_status" -ne 1 ]; then
      echo "buck2-rust-deps: failed to inspect fixup: ${fixup#"$root"/}" >&2
      exit "$grep_status"
    fi
  fi
done
if [ "$fixup_violations" -ne 0 ]; then
  exit 1
fi

mkdir -p "$cargo_home"
lock_before="$(mktemp "$cargo_home/Cargo.lock.before.XXXXXX")"
candidate="$(mktemp "$third_party/.BUCK.next.XXXXXX")"
foreign_fixups=""
temporary_config=""
cleanup() {
  rm -f "$lock_before" "$candidate" "$temporary_config"
  if [ -n "$foreign_fixups" ]; then rm -rf "$foreign_fixups"; fi
}
trap cleanup EXIT
cp "$lock" "$lock_before"

if [ -f "$workspace/foreign-packages.json" ]; then
  foreign_fixups="$(mktemp -d "$cargo_home/foreign-fixups.XXXXXX")"
  temporary_config="$(mktemp "$workspace/.reindeer-foreign.XXXXXX.toml")"
  "$bun" "$foreign_fixups_script" \
    "$root" "$workspace" "$config" "$third_party" "$cargo" "$cargo_home" \
    "$foreign_fixups" "$temporary_config"
  config="$temporary_config"
fi

set +e
CARGO_HOME="$cargo_home" "$reindeer" \
  --cargo-path "$cargo" \
  --rustc-path "$rustc" \
  --config "$config" \
  buckify --stdout >"$candidate"
buckify_status=$?
set -e

if ! cmp -s "$lock_before" "$lock"; then
  echo "buck2-rust-deps: Reindeer changed authoritative ${lock#"$root"/}" >&2
  exit 1
fi
if [ "$buckify_status" -ne 0 ]; then
  exit "$buckify_status"
fi
if grep -Fq 'vendor/' "$candidate"; then
  echo "buck2-rust-deps: non-vendored graph unexpectedly references vendor/" >&2
  exit 1
fi

archive_count="$(grep -Ec '^(http_archive|crate_archive)[(]$' "$candidate" || true)"
sha256_count="$(grep -Ec '^    sha256 = "[0-9a-f]{64}",$' "$candidate" || true)"
git_archive_count="$(grep -Ec '^git_archive[(]$' "$candidate" || true)"
if [ "$((archive_count + git_archive_count))" -eq 0 ] || [ "$sha256_count" -ne "$archive_count" ]; then
  echo "buck2-rust-deps: every generated crate archive must carry one sha256 pin" >&2
  exit 1
fi

# Git sources: Reindeer's `git_fetch` carries no digest. Each (repo, rev) must
# resolve through `[buck] git_fetch = "git_archive"` to a GitHub commit tarball
# whose sha256 the sidecar pins; both modes fetch the tarball and verify it.
git_archives="$third_party/git-archives.json"
git_archives_candidate="$(mktemp "$third_party/.git-archives.json.next.XXXXXX")"
trap 'cleanup; rm -f "$git_archives_candidate"' EXIT
# shellcheck disable=SC2016 # JavaScript template literals, not shell expansions.
if ! "$bun" -e '
const [candidatePath, sidecarPath, outputPath] = process.argv.slice(1);
const origin = process.env.BUCK2_RUST_DEPS_GITHUB_ORIGIN ?? "https://github.com";
const schema = "effect-utils/buck2-git-archives/v1";
const fail = (message) => {
  console.error(`buck2-rust-deps: ${message}`);
  process.exit(1);
};
const graph = await Bun.file(candidatePath).text();
if (/^git_fetch[(]$/m.test(graph))
  fail("git dependencies need [buck] git_fetch = \"git_archive\" so every git source is sha256-pinned");
const sources = new Map();
for (const [, body] of graph.matchAll(/^git_archive[(]\n([\s\S]*?)^[)]$/gm)) {
  const repo = body.match(/^    repo = "([^"]+)",$/m)?.[1];
  const rev = body.match(/^    rev = "([0-9a-f]{40})",$/m)?.[1];
  if (repo === undefined || rev === undefined) fail("git_archive needs one repo and one 40-hex rev");
  const github = repo.match(/^https:[/][/]github[.]com[/]([A-Za-z0-9_.-]+)[/]([A-Za-z0-9_.-]+?)(?:[.]git)?[/]?$/);
  if (github === null) fail(`git_archive supports only https://github.com/<owner>/<repo> sources: ${repo}`);
  sources.set(`${repo} ${rev}`, { repo, rev, owner: github[1], name: github[2] });
}
const sidecarFile = Bun.file(sidecarPath);
const pinned = (await sidecarFile.exists()) ? JSON.parse(await sidecarFile.text()) : undefined;
if (pinned !== undefined && pinned.schema !== schema) fail(`${sidecarPath} must carry schema ${schema}`);
const topLevelPrefix = (tarball) => {
  const tar = Bun.gunzipSync(tarball);
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const field = (start, length) => new TextDecoder().decode(header.subarray(start, start + length)).replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const path = [field(345, 155), field(0, 100)].filter((part) => part !== "").join("/");
    if (type !== "g" && type !== "x") return path.split("/")[0];
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  fail("git archive holds no entries");
};
const archives = [];
for (const source of [...sources.values()].toSorted((a, b) => (`${a.repo} ${a.rev}` < `${b.repo} ${b.rev}` ? -1 : 1))) {
  const url = `https://github.com/${source.owner}/${source.name}/archive/${source.rev}.tar.gz`;
  const response = await fetch(`${origin}/${source.owner}/${source.name}/archive/${source.rev}.tar.gz`);
  if (response.ok !== true) fail(`fetching ${url} failed: ${response.status}`);
  const tarball = new Uint8Array(await response.arrayBuffer());
  const sha256 = new Bun.CryptoHasher("sha256").update(tarball).digest("hex");
  const previous = pinned?.archives?.find((pin) => pin.repo === source.repo && pin.rev === source.rev);
  if (previous !== undefined && previous.sha256 !== sha256)
    fail(
      `${url} no longer matches its pinned sha256 ${previous.sha256} (fetched ${sha256}). ` +
        `GitHub re-rendered the tarball or the rev was rewritten: review the new tarball, ` +
        `delete this pin from ${sidecarPath}, then re-run generate to pin the reviewed digest`,
    );
  archives.push({ repo: source.repo, rev: source.rev, url, sha256, strip_prefix: topLevelPrefix(tarball) });
}
if (archives.length > 0)
  await Bun.write(outputPath, `${JSON.stringify({ schema, archives }, null, 2)}\n`);
' "$candidate" "$git_archives" "$git_archives_candidate"; then
  exit 1
fi

case "$mode" in
  generate)
    chmod 0644 "$candidate"
    mv "$candidate" "$third_party_buck"
    if [ -s "$git_archives_candidate" ]; then
      chmod 0644 "$git_archives_candidate"
      mv "$git_archives_candidate" "$git_archives"
    else
      rm -f "$git_archives"
    fi
    ;;
  check)
    if ! cmp -s "$third_party_buck" "$candidate"; then
      echo "buck2-rust-deps: generated Reindeer graph is stale" >&2
      exit 1
    fi
    if [ -s "$git_archives_candidate" ]; then
      if ! cmp -s "$git_archives" "$git_archives_candidate"; then
        echo "buck2-rust-deps: ${git_archives#"$root"/} is stale (run the generate task)" >&2
        exit 1
      fi
    elif [ -e "$git_archives" ]; then
      echo "buck2-rust-deps: ${git_archives#"$root"/} pins git sources the graph no longer has" >&2
      exit 1
    fi
    ;;
esac
