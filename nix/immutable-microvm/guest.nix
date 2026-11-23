{
  config,
  lib,
  pkgs,
  modulesPath,
  ...
}:
let
  cfg = config.services.immutableAuthority;
in
{
  imports = [ (modulesPath + "/profiles/perlless.nix") ];
  options.services.immutableAuthority = {
    package = lib.mkOption {
      type = lib.types.package;
      description = "Immutable authority executable package.";
    };
    executable = lib.mkOption {
      type = lib.types.str;
      default = "authority";
    };
    environment = lib.mkOption {
      type = lib.types.attrsOf lib.types.str;
      default = { };
    };
    tap = lib.mkOption {
      type = lib.types.str;
      default = "authority-tap";
    };
    mac = lib.mkOption {
      type = lib.types.str;
      default = "02:00:00:00:01:02";
    };
    address = lib.mkOption {
      type = lib.types.str;
      default = "192.0.2.2/30";
    };
    gateway = lib.mkOption {
      type = lib.types.str;
      default = "192.0.2.1";
    };
    port = lib.mkOption {
      type = lib.types.port;
      default = 8080;
    };
  };
  config = {
    networking.hostName = "immutable-authority";
    networking.useDHCP = false;
    networking.useNetworkd = true;
    systemd.network.networks."20-authority" = {
      matchConfig.MACAddress = cfg.mac;
      address = [ cfg.address ];
      routes = [ { Gateway = cfg.gateway; } ];
      networkConfig.DHCP = "no";
    };
    networking.firewall.allowedTCPPorts = [ cfg.port ];
    services.tailscale.enable = true;
    # Enrollment and identity live only on the private /var disk. No auth key,
    # host identity, daemon socket, or auto-enrollment is part of the image.
    nix.enable = false;
    documentation.enable = false;
    # The pinned nixpkgs exclusively uses systemd stage 1; no opt-in is needed.
    microvm = {
      hypervisor = "cloud-hypervisor";
      optimize.enable = true;
      vcpu = 2;
      mem = 2048;
      storeOnDisk = true;
      storeDiskType = "erofs";
      shares = lib.mkForce [ ];
      interfaces = [
        {
          type = "tap";
          id = cfg.tap;
          inherit (cfg) mac;
        }
      ];
      volumes = [
        {
          image = "state.img";
          mountPoint = "/var";
          size = 8192;
        }
      ];
    };
    users.groups.authority = { };
    users.users.authority = {
      isSystemUser = true;
      group = "authority";
      uid = 991;
    };
    systemd.services.authority = {
      wantedBy = [ "multi-user.target" ];
      after = [ "network.target" ];
      environment = cfg.environment // {
        STATE_DIRECTORY = "/var/lib/authority";
      };
      serviceConfig = {
        User = "authority";
        Group = "authority";
        StateDirectory = "authority";
        StateDirectoryMode = "0700";
        ExecStart = "${cfg.package}/bin/${cfg.executable}";
        Restart = "on-failure";
        NoNewPrivileges = true;
        PrivateTmp = true;
        ProtectSystem = "strict";
        ProtectHome = true;
        ProtectKernelTunables = true;
        ProtectKernelModules = true;
        ProtectControlGroups = true;
        RestrictSUIDSGID = true;
        UMask = "0077";
      };
    };
  };
}
