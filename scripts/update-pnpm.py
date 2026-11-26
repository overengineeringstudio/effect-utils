#!/usr/bin/env python3
"""Default-branch-only pnpm candidate writer; never executes candidate branch code."""
import base64
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import urllib.request

REPO = "overengineeringstudio/effect-utils"
NATIVE = Path("nix/pnpm.nix")
SOURCES = (
    "packages/@overeng/genie/src/runtime/package-json/mod.ts",
    "buck2-member.json.genie.ts",
    "buck2/toolchains/BUCK",
    "nix/devenv-modules/tasks/shared/pnpm.nix",
    "nix/devenv-modules/tasks/shared/tests/pnpm-source-input-refresh.integration.test.sh",
    "nix/devenv-modules/tasks/shared/tests/pnpm-task-smoke.test.sh",
    "buck2/dependencies/fixtures/pnpm-snapshot-link/package.json",
    "packages/@overeng/utils/test-fixtures/stylex-next/package.json.genie.ts",
    "nix/stylex-next-fixture.nix",
)


def run(*args, data=None):
    return subprocess.check_output(args, input=data).decode().strip()


def api(path, payload=None):
    args = ["gh", "api", f"repos/{REPO}/{path}"]
    if payload is not None:
        args += ["--method", "POST", "--input", "-"]
    return json.loads(run(*args, data=None if payload is None else json.dumps(payload).encode()))


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def version_tuple(version):
    require(re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", version),
            "Expected a stable numeric pnpm semver")
    return tuple(map(int, version.split(".")))


def latest_stable_version(release_pages):
    versions = []
    for page in release_pages:
        for release in page:
            if release["draft"] or release["prerelease"]:
                continue
            tag = release["tag_name"]
            if not re.fullmatch(r"v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", tag):
                continue
            versions.append(tag[1:])
    require(versions, "No canonical stable pnpm release found")
    return max(versions, key=version_tuple)


def replace(path, old, new):
    text = path.read_text()
    require(old in text, f"Missing expected version in {path}")
    path.write_text(text.replace(old, new))


def payload_hash(url):
    # Hash raw registry tarball bytes, not unpacked trees or HTTP content decoding.
    request = urllib.request.Request(url, headers={"Accept-Encoding": "identity"})
    digest = hashlib.sha256()
    with urllib.request.urlopen(request, timeout=120) as response:
        require(response.url.startswith("https://registry.npmjs.org/"), "Unexpected tarball host")
        require(response.headers.get("Content-Encoding", "identity") == "identity", "Encoded tarball")
        while chunk := response.read(1024 * 1024):
            digest.update(chunk)
    return "sha256-" + base64.b64encode(digest.digest()).decode()


def draft(version, branch):
    prs = api(f"pulls?state=all&head=overengineeringstudio:{branch}&per_page=100")
    require(len(prs) <= 1, "Duplicate version-specific PRs require maintainer intervention")
    if prs:
        pr = prs[0]
        print(pr["html_url"])
        return
    pr = api("pulls", {
        "title": f"chore(deps): bump pnpm to {version}", "head": branch,
        "base": os.environ["DEFAULT_BRANCH"], "draft": True,
        "body": f"Weekly pnpm candidate for https://github.com/pnpm/pnpm/releases/tag/v{version}.\n\n"
                "Native wrapper and six executable hashes measure raw registry tarballs. "
                "Generated projections come from one canonical Genie regeneration.\n\n"
                "Before readiness: review intervening release notes and store/lockfile compatibility, "
                "independent exact-head review, exact-head check:quick receipt, and all hosted checks. "
                "No automatic merge. pnpm#18433 is not assumed fixed.\n\n"
                "Acting on Johannes authority (BUCK2 tab, 2026-11-25).",
    })
    print(pr["html_url"])


def main():
    default = os.environ["DEFAULT_BRANCH"]
    require(os.environ["GITHUB_REPOSITORY"] == REPO, "Unexpected repository")
    require(os.environ["GITHUB_EVENT_NAME"] in ("schedule", "workflow_dispatch"), "Untrusted event")
    require(os.environ["GITHUB_REF"] == f"refs/heads/{default}", "Default branch only")
    require(run("git", "rev-parse", "HEAD") == os.environ["GITHUB_SHA"], "Unexpected checkout")
    text = NATIVE.read_text()
    current = re.search(r'  version = "([^"]+)";', text)[1]
    if sys.argv[1] == "prepare":
        require(not run("git", "status", "--porcelain"), "Checkout must be clean")
        releases = json.loads(run("gh", "api", "--paginate", "--slurp",
                                  "repos/pnpm/pnpm/releases?per_page=100"))
        latest = latest_stable_version(releases)
        if version_tuple(latest) <= version_tuple(current):
            return
        branch = f"automation/pnpm-{latest}"
        # Never check out or overwrite an existing candidate, including human edits.
        if run("git", "ls-remote", "origin", f"refs/heads/{branch}"):
            draft(latest, branch)
            return
        prs = api(f"pulls?state=all&head=overengineeringstudio:{branch}&per_page=100")
        if prs:
            print("Version already proposed; leaving its history untouched")
            return
        targets = re.findall(r'    "([a-z0-9-]+)" = "sha256-[^"]+";', text)
        require(len(targets) == 6 and len(set(targets)) == 6, "Expected six native targets")
        for target in targets:
            url = f"https://registry.npmjs.org/@pnpm/exe.{target}/-/exe.{target}-{latest}.tgz"
            text = re.sub(rf'("{target}" = ")[^"]+', rf'\g<1>{payload_hash(url)}', text)
        wrapper = payload_hash(f"https://registry.npmjs.org/pnpm/-/pnpm-{latest}.tgz")
        text, count = re.subn(r'(    hash = ")sha256-[^"]+', rf'\g<1>{wrapper}', text)
        require(count == 1, "Expected one wrapper hash")
        NATIVE.write_text(text.replace(f'version = "{current}"', f'version = "{latest}"'))
        for source in SOURCES:
            replace(Path(source), current, latest)
        defaults_test = Path("packages/@overeng/genie/src/runtime/package-json/package-json.unit.test.ts")
        replace(defaults_test, f"      packageManager: 'pnpm@{current}',", f"      packageManager: 'pnpm@{latest}',")
        replace(defaults_test, f"expect(parsed.packageManager).toBe('pnpm@{current}')", f"expect(parsed.packageManager).toBe('pnpm@{latest}')")
        with open(os.environ["GITHUB_OUTPUT"], "a") as output:
            output.write("changed=true\n")
    elif sys.argv[1] == "publish":
        version_tuple(current)
        branch = f"automation/pnpm-{current}"
        run("git", "add", "--all")
        paths = run("git", "diff", "--cached", "--name-only", "-z").rstrip("\0").split("\0")
        require(paths != [""], "No candidate changes")
        entries = []
        for path in paths:
            require(Path(path).is_file() and not Path(path).is_symlink(), "Unexpected non-file change")
            blob = api("git/blobs", {"encoding": "base64", "content": base64.b64encode(Path(path).read_bytes()).decode()})
            mode = run("git", "ls-files", "--stage", "--", path).split()[0]
            entries.append({"path": path, "mode": mode, "type": "blob", "sha": blob["sha"]})
        tree = api("git/trees", {"base_tree": run("git", "rev-parse", "HEAD^{tree}"), "tree": entries})
        # GitHub signs App-created commits when author/committer overrides are omitted.
        commit = api("git/commits", {"tree": tree["sha"], "parents": [os.environ["GITHUB_SHA"]],
                     "message": f"chore(deps): bump pnpm to {current}\n\nActing on Johannes authority (BUCK2 tab, 2026-11-25)."})
        require(commit["verification"]["verified"], "GitHub did not sign the candidate commit")
        api("git/refs", {"ref": f"refs/heads/{branch}", "sha": commit["sha"]})
        draft(current, branch)
    else:
        raise RuntimeError("Expected prepare or publish")


if __name__ == "__main__":
    main()
