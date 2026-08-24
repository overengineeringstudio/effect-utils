path: _type:
let
  name = builtins.baseNameOf (toString path);
in
builtins.match "([.]oxlint-with-plugins[.].*[.]json|[.][0-9a-f]+-[0-9a-f]+[.]bun-build)" name
== null
