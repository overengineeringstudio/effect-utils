#!/usr/bin/env bash
set -euo pipefail

TESTS_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$TESTS_DIR/../../../../.." && pwd)"

assert_contains() {
  local haystack="$1"
  local needle="$2"
  local label="$3"

  if ! printf '%s' "$haystack" | grep -qF -- "$needle"; then
    echo "FAIL: $label"
    echo "  expected to contain: $needle"
    echo "  actual output:"
    printf '%s\n' "$haystack" | sed 's/^/    /'
    exit 1
  fi
}

assert_exit_code() {
  local expected="$1"
  local actual="$2"
  local label="$3"

  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected exit code: $expected"
    echo "  actual exit code:   $actual"
    exit 1
  fi
}

assert_json_field() {
  local expected="$1"
  local file="$2"
  local expression="$3"
  local label="$4"

  local actual
  actual="$(node -e "const fs = require('node:fs'); const value = JSON.parse(fs.readFileSync(process.argv[1], 'utf8')); const out = (${expression})(value); process.stdout.write(String(out))" "$file")"
  if [ "$expected" != "$actual" ]; then
    echo "FAIL: $label"
    echo "  expected: $expected"
    echo "  actual:   $actual"
    exit 1
  fi
}

extract_netlify_task_script() {
  local static_dir="$1"
  local output_path="$2"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        netlify-cli = \"$tmpdir/fake-netlify-pkg\";
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/netlify.nix {
            siteName = \"fake-site\";
            siteId = \"fake-site-id\";
            deployments = [
              {
                name = \"storybook\";
                staticDir = \"$static_dir\";
                afterTask = null;
              }
            ];
          }) {
            pkgs = pkgsForTest;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"netlify:deploy:storybook\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

extract_vercel_task_script() {
  local static_dir="$1"
  local output_path="$2"

  nix-instantiate --eval --strict --json --expr "
    let
      flake = builtins.getFlake (toString $ROOT);
      pkgs = import flake.inputs.nixpkgs { system = builtins.currentSystem; };
      pkgsForTest = pkgs // {
        bun = \"$tmpdir/fake-bun-pkg\";
      };
      evaluated = pkgs.lib.evalModules {
        modules = [
          ({ ... }: {
            options.tasks = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.processes = pkgs.lib.mkOption { type = pkgs.lib.types.attrsOf pkgs.lib.types.anything; default = { }; };
            options.packages = pkgs.lib.mkOption { type = pkgs.lib.types.listOf pkgs.lib.types.anything; default = [ ]; };
          })
          ((import $ROOT/nix/devenv-modules/tasks/shared/vercel.nix {
            aliasSuffix = \"team\";
            deployments = [
              {
                name = \"web\";
                staticDir = \"$static_dir\";
                projectIdEnv = \"VERCEL_PROJECT_ID_WEB\";
                aliasPrefix = \"web\";
                afterTask = null;
              }
            ];
          }) {
            pkgs = pkgsForTest;
            lib = pkgs.lib;
            config = { };
          })
        ];
      };
    in evaluated.config.tasks.\"vercel:deploy:web\".exec
  " | jq -r . > "$output_path"
  chmod +x "$output_path"
}

echo "Running deploy task E2E tests..."
echo ""

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT

workspace="$tmpdir/workspace"
mkdir -p \
  "$workspace/storybook-static" \
  "$workspace/static" \
  "$tmpdir/fake-netlify-pkg/bin" \
  "$tmpdir/fake-bun-pkg/bin"

echo "storybook marker" > "$workspace/storybook-static/index.html"
echo "vercel marker" > "$workspace/static/index.html"

cat > "$tmpdir/fake-netlify-pkg/bin/netlify" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "${FAKE_NETLIFY_LOG:?}"

if [ "${1:-}" = "api" ] && [ "${2:-}" = "getCurrentUser" ]; then
  printf '{"email":"fake@example.invalid","slug":"fake-user"}\n'
  exit 0
fi

if [ "${1:-}" = "api" ] && [ "${2:-}" = "getSite" ]; then
  printf '{"name":"fake-site","account_slug":"fake-account"}\n'
  exit 0
fi

if [ "${1:-}" = "deploy" ]; then
  if [ "${FAKE_NETLIFY_MODE:-success}" = "unauthorized" ]; then
    echo 'Unauthorized: could not retrieve project' >&2
    exit 9
  fi

  printf '{"deploy_id":"deploy123","site_name":"fake-site","deploy_url":"https://deploy123--fake-site.netlify.app"}\n'
  exit 0
fi

echo "unexpected fake netlify invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/fake-netlify-pkg/bin/netlify"

cat > "$tmpdir/fake-bun-pkg/bin/bunx" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'cwd=%s args=%s\n' "$PWD" "$*" >> "${FAKE_BUNX_LOG:?}"

if [ "${1:-}" = "vercel" ] && [ "${2:-}" = "deploy" ]; then
  test -f .vercel/output/static/index.html
  printf 'https://deploy-web.vercel.app\n'
  exit 0
fi

if [ "${1:-}" = "vercel" ] && [ "${2:-}" = "alias" ]; then
  printf 'Aliased %s to %s\n' "${3:-}" "${4:-}"
  exit 0
fi

echo "unexpected fake bunx invocation: $*" >&2
exit 1
EOF
chmod +x "$tmpdir/fake-bun-pkg/bin/bunx"

extract_netlify_task_script "$workspace/storybook-static" "$tmpdir/netlify-deploy.sh"
extract_vercel_task_script "$workspace/static" "$tmpdir/vercel-deploy.sh"

echo "Test 1: Netlify PR deploy emits task output and workflow report records"
netlify_output_file="$tmpdir/netlify-task-output.json"
netlify_report_file="$tmpdir/netlify-report.jsonl"
netlify_output="$(
  cd "$workspace"
  export FAKE_NETLIFY_LOG="$tmpdir/netlify.log"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"pr","pr":42}'
  export DEVENV_TASK_OUTPUT_FILE="$netlify_output_file"
  export WORKFLOW_REPORT_OUTPUT_FILE="$netlify_report_file"
  bash "$tmpdir/netlify-deploy.sh" 2>&1
)"

assert_contains "$netlify_output" "Netlify deploy URL: https://storybook-pr-42--fake-site.netlify.app" "Netlify final URL should use PR alias"
assert_contains "$netlify_output" "WORKFLOW_REPORT_V1:" "Netlify output should include marked workflow-report record"
assert_contains "$(cat "$tmpdir/netlify.log")" "--alias=storybook-pr-42" "Netlify CLI should receive PR alias"
assert_json_field "https://storybook-pr-42--fake-site.netlify.app" "$netlify_output_file" "value => value.devenv.env.NETLIFY_DEPLOY_URL_STORYBOOK" "Netlify task output should include scoped URL"
assert_json_field "netlify" "$netlify_report_file" "value => value.data.provider" "Netlify report record should include provider"
assert_json_field "storybook" "$netlify_report_file" "value => value.data.target" "Netlify report record should include target"

echo "Test 2: Netlify lookup failure emits diagnostics without leaking token"
set +e
netlify_failure_output="$(
  cd "$workspace"
  export FAKE_NETLIFY_LOG="$tmpdir/netlify-failure.log"
  export FAKE_NETLIFY_MODE="unauthorized"
  export NETLIFY_AUTH_TOKEN="fake-token"
  export DEVENV_TASK_INPUT='{"type":"prod"}'
  bash "$tmpdir/netlify-deploy.sh" 2>&1
)"
netlify_failure_status=$?
set -e

assert_exit_code 9 "$netlify_failure_status" "Netlify unauthorized path should preserve provider exit code"
assert_contains "$netlify_failure_output" "Netlify auth diagnostics for storybook:" "Netlify failure should print diagnostics header"
assert_contains "$netlify_failure_output" "getCurrentUser: ok" "Netlify failure should diagnose current user"
assert_contains "$netlify_failure_output" "getSite(fake-site-id): ok" "Netlify failure should diagnose configured site"
if printf '%s' "$netlify_failure_output" | grep -qF 'fake-token'; then
  echo "FAIL: Netlify diagnostics leaked token"
  exit 1
fi

echo "Test 3: Vercel static PR deploy packages local output, aliases, and emits records"
vercel_output_file="$tmpdir/vercel-task-output.json"
vercel_report_file="$tmpdir/vercel-report.jsonl"
vercel_output="$(
  cd "$workspace"
  export FAKE_BUNX_LOG="$tmpdir/bunx.log"
  export VERCEL_TOKEN="fake-token"
  export VERCEL_ORG_ID="fake-org"
  export VERCEL_PROJECT_ID_WEB="fake-project"
  export DEVENV_TASK_INPUT='{"type":"pr","pr":123}'
  export DEVENV_TASK_OUTPUT_FILE="$vercel_output_file"
  export WORKFLOW_REPORT_OUTPUT_FILE="$vercel_report_file"
  bash "$tmpdir/vercel-deploy.sh" 2>&1
)"

assert_contains "$vercel_output" "Vercel deploy URL: https://web-pr-123-team.vercel.app" "Vercel final URL should use PR alias"
assert_contains "$vercel_output" "WORKFLOW_REPORT_V1:" "Vercel output should include marked workflow-report record"
assert_contains "$(cat "$tmpdir/bunx.log")" "args=vercel deploy --prebuilt --yes --token fake-token" "Vercel deploy should use prebuilt local upload"
assert_contains "$(cat "$tmpdir/bunx.log")" "args=vercel alias https://deploy-web.vercel.app web-pr-123-team.vercel.app --token fake-token" "Vercel alias command should receive PR alias"
assert_json_field "https://web-pr-123-team.vercel.app" "$vercel_output_file" "value => value.devenv.env.VERCEL_DEPLOY_URL_WEB" "Vercel task output should include scoped URL"
assert_json_field "vercel" "$vercel_report_file" "value => value.data.provider" "Vercel report record should include provider"
assert_json_field "web" "$vercel_report_file" "value => value.data.target" "Vercel report record should include target"

echo ""
echo "Deploy task E2E tests passed."
