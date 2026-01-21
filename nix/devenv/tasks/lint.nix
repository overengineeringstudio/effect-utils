{ ... }:
{
  tasks = {
    # Lint check tasks
    "lint:check:format" = {
      exec = ''oxfmt -c ./fmt.jsonc --check . '!**/package.json' '!**/tsconfig.json' '!**/tsconfig.*.json' '!.github/workflows/*.yml' '!packages/@overeng/oxc-config/*.jsonc' '';
      execIfModified = [ "**/*.ts" "**/*.tsx" "**/*.js" "**/*.jsx" "oxfmt.json" ];
    };
    "lint:check:oxlint" = {
      exec = "oxlint -c ./lint.jsonc --import-plugin --deny-warnings";
      execIfModified = [ "**/*.ts" "**/*.tsx" "**/*.js" "**/*.jsx" "oxlint.json" ];
    };
    "lint:check:genie" = {
      exec = "genie --check";
      execIfModified = [ "**/*.genie.ts" ];
    };
    "lint:check:genie:coverage" = {
      description = "Check all config files have .genie.ts sources";
      exec = ''
        missing=$(find packages scripts context \
          -type f \( -name "package.json" -o -name "tsconfig.json" \) \
          -not -path "*/node_modules/*" \
          -not -path "*/dist/*" \
          -not -path "*/.git/*" \
          -not -path "*/.direnv/*" \
          -not -path "*/.devenv/*" \
          -not -path "*/tmp/*" \
          | while read -r f; do
              [ ! -f "$f.genie.ts" ] && echo "$f"
            done | sort)
        if [ -n "$missing" ]; then
          echo "Missing .genie.ts sources for:"
          echo "$missing"
          exit 1
        fi
        echo "All config files have .genie.ts sources"
      '';
      execIfModified = [ "packages/**/package.json" "packages/**/tsconfig.json" "scripts/**/package.json" "context/**/package.json" "**/*.genie.ts" ];
    };
    "lint:check" = {
      description = "Run all lint checks";
      after = [ "lint:check:format" "lint:check:oxlint" "lint:check:genie" "lint:check:genie:coverage" ];
    };

    # Lint fix tasks
    "lint:fix:format" = {
      exec = ''oxfmt -c ./fmt.jsonc . '!**/package.json' '!**/tsconfig.json' '!**/tsconfig.*.json' '!.github/workflows/*.yml' '!packages/@overeng/oxc-config/*.jsonc' '';
    };
    "lint:fix:oxlint" = {
      exec = "oxlint -c ./lint.jsonc --import-plugin --deny-warnings --fix";
    };
    "lint:fix" = {
      description = "Fix all lint issues";
      after = [ "lint:fix:format" "lint:fix:oxlint" ];
    };
  };
}
