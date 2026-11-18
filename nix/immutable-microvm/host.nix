{ config, lib, pkgs, ... }:
let
  cfg = config.services.immutableAuthorityHost;
  control = "/var/lib/${cfg.name}-release";
  roots = "/nix/var/nix/gcroots/${cfg.name}";
  unit = "${cfg.name}-vm.service";
  transaction = pkgs.writeShellApplication {
    name = "authority-transaction";
    runtimeInputs = [ pkgs.coreutils pkgs.util-linux pkgs.jq pkgs.curl pkgs.systemd ];
    text = ''
      export CONTROL=${lib.escapeShellArg control} ROOTS=${lib.escapeShellArg roots}
      export VM_UNIT=${lib.escapeShellArg unit} READY_URL=${lib.escapeShellArg cfg.readyUrl}
      export INITIAL_RELEASE=${cfg.initialRelease} HEALTH_TIMEOUT=${toString cfg.healthTimeout}
    '' + builtins.readFile ./transaction.sh;
  };
  activate = pkgs.writeShellApplication {
    name = "activate";
    runtimeInputs = [ pkgs.systemd ];
    text = ''
      test "$#" -eq 1
      exec systemd-run --unit=${cfg.name}-update --collect --wait \
        --property=Type=exec --property=OnFailure=${cfg.name}-rescue.service \
        --property=RuntimeMaxSec=${toString (2 * cfg.healthTimeout + 100)} \
        ${transaction}/bin/authority-transaction "$1"
    '';
  };
in
{
  options.services.immutableAuthorityHost = {
    enable = lib.mkEnableOption "single-writer immutable authority VM";
    name = lib.mkOption { type = lib.types.strMatching "[a-z][a-z0-9-]*"; default = "authority"; };
    user = lib.mkOption { type = lib.types.str; default = "authority-vmm"; };
    stateDirectory = lib.mkOption { type = lib.types.str; default = "/var/lib/authority"; };
    initialRelease = lib.mkOption { type = lib.types.package; };
    tap = lib.mkOption { type = lib.types.str; default = "authority-tap"; };
    hostAddress = lib.mkOption { type = lib.types.str; default = "192.0.2.1/30"; };
    readyUrl = lib.mkOption { type = lib.types.str; default = "http://192.0.2.2:8080/health"; };
    healthTimeout = lib.mkOption { type = lib.types.ints.positive; default = 60; };
    slice = lib.mkOption { type = lib.types.str; default = "system.slice"; };
    activationPackage = lib.mkOption { type = lib.types.package; readOnly = true; };
  };
  config = lib.mkIf cfg.enable {
    services.immutableAuthorityHost.activationPackage = activate;
    users.groups.${cfg.user} = { };
    users.users.${cfg.user} = {
      isSystemUser = true;
      group = cfg.user;
      extraGroups = [ "kvm" ];
    };
    boot.kernelModules = [ "kvm" "tun" "vhost_net" ];
    systemd.network.enable = true;
    systemd.network.netdevs."30-authority" = {
      netdevConfig = { Kind = "tap"; Name = cfg.tap; };
      tapConfig.User = cfg.user;
    };
    systemd.network.networks."30-authority" = {
      matchConfig.Name = cfg.tap;
      address = [ cfg.hostAddress ];
      networkConfig.ConfigureWithoutCarrier = true;
    };
    systemd.tmpfiles.rules = [
      "d ${cfg.stateDirectory} 0700 ${cfg.user} ${cfg.user} -"
      "d ${control} 0700 root root -"
      "d ${roots} 0755 root root -"
    ];
    systemd.services."${cfg.name}-recover" = {
      before = [ unit ];
      requiredBy = [ unit ];
      after = [ "systemd-tmpfiles-setup.service" ];
      serviceConfig.Type = "oneshot";
      serviceConfig.RemainAfterExit = true;
      serviceConfig.ExecStart = "${transaction}/bin/authority-transaction recover";
    };
    systemd.services."${cfg.name}-vm" = {
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" "systemd-networkd.service" ];
      requires = [ "systemd-networkd.service" ];
      serviceConfig = {
        User = cfg.user;
        Group = cfg.user;
        Slice = cfg.slice;
        WorkingDirectory = cfg.stateDirectory;
        ExecStart = "${roots}/current/runner/bin/microvm-run";
        KillMode = "control-group";
        TimeoutStopSec = 20;
        SendSIGKILL = true;
        Restart = "no";
        UMask = "0077";
        NoNewPrivileges = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        PrivateTmp = true;
        ReadWritePaths = [ cfg.stateDirectory ];
        DevicePolicy = "closed";
        DeviceAllow = [ "/dev/kvm rw" "/dev/net/tun rw" "/dev/vhost-net rw" ];
        LimitMEMLOCK = "infinity";
      };
    };
    systemd.services."${cfg.name}-ready" = {
      wantedBy = [ "multi-user.target" ];
      after = [ unit ];
      requires = [ unit ];
      serviceConfig.Type = "oneshot";
      serviceConfig.RemainAfterExit = true;
      serviceConfig.ExecStart = "${transaction}/bin/authority-transaction verify";
      serviceConfig.TimeoutStartSec = cfg.healthTimeout + 5;
    };
    systemd.services."${cfg.name}-rescue" = {
      serviceConfig.Type = "oneshot";
      serviceConfig.ExecStart = "${transaction}/bin/authority-transaction rescue";
      serviceConfig.TimeoutStartSec = cfg.healthTimeout + 60;
    };
  };
}
