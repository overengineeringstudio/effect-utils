let
  select = import ./quick-contracts-sequence.nix;
  host = select { ci = false; };
  ci = select { ci = true; };
  actual = select { };
  fullPosture = "buck2:cache-posture:test";
  ciPosture = "buck2:cache-posture:ci-test";
  hostOnly = "test:notion-integration:ci-skip";
in
assert builtins.elem fullPosture host && !(builtins.elem ciPosture host);
assert builtins.elem ciPosture ci && !(builtins.elem fullPosture ci);
assert builtins.elem hostOnly host && !(builtins.elem hostOnly ci);
assert
  map (task: if task == ciPosture then fullPosture else task) ci
  == builtins.filter (task: task != hostOnly) host;
assert actual == (if builtins.getEnv "EFFECT_UTILS_CI_TEST" == "1" then ci else host);
true
