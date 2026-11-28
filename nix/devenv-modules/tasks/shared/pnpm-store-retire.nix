{ pkgs }:
pkgs.writeShellApplication {
  name = "pnpm-store-retire";
  runtimeInputs = [
    pkgs.bash
    pkgs.git
    pkgs.flock
    pkgs.coreutils
    pkgs.nodejs
    pkgs.python3
  ];
  text = ''
    umask 077
    exec ${pkgs.python3}/bin/python3 -P ${./pnpm-store-retire.py} \
      ${../../../../pnpm-install-contract.json} ${./pnpm-task-helpers.sh} "$@"
  '';
}
