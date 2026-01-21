{ ... }:
{
  tasks = {
    # Main check task - replaces `mono check`
    # Runs: genie -> (typecheck + lint in parallel) -> test
    "check:all" = {
      description = "Run all checks (genie, typecheck, lint, test)";
      after = [ "ts:check" "lint:check" "test:run" ];
    };

    # CI-friendly check that skips tests (for faster feedback)
    "check:quick" = {
      description = "Run quick checks (genie, typecheck, lint) without tests";
      after = [ "ts:check" "lint:check" ];
    };
  };
}
