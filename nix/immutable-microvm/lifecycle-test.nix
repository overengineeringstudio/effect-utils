{ pkgs, releases }:
pkgs.testers.runNixOSTest {
  name = "immutable-authority-lifecycle";
  nodes.host = { config, ... }: {
    imports = [ ./host.nix ];
    virtualisation = {
      memorySize = 4096;
      cores = 4;
      qemu.options = [ "-cpu host" ];
    };
    boot.kernelModules = [
      "kvm-amd"
      "kvm-intel"
    ];
    services.immutableAuthorityHost = {
      enable = true;
      initialRelease = releases.a;
      healthTimeout = 30;
    };
    environment.systemPackages = [
      pkgs.curl
      pkgs.jq
      pkgs.util-linux
      config.services.immutableAuthorityHost.activationPackage
    ];
  };
  testScript = ''
    import json, uuid

    # The driver defaults to QEMU -no-reboot; this suite proves real host reboot.
    host.start(allow_reboot=True)
    host.wait_for_unit("authority-ready.service")
    control = "/var/lib/authority-release"
    roots = "/nix/var/nix/gcroots/authority"

    def health():
        nonce = str(uuid.uuid4())
        host.wait_until_succeeds("curl --fail --silent 'http://192.0.2.2:8080/health?nonce=" + nonce + "'")
        result = json.loads(host.succeed("curl --fail --silent 'http://192.0.2.2:8080/health?nonce=" + nonce + "'"))
        assert result["nonce"] == nonce
        assert result["ready"] is True
        assert result["epoch"] == "reference-v1"
        return result

    def receipt(outcome):
        result = json.loads(host.succeed("cat " + control + "/receipt.json"))
        assert result["outcome"] == outcome, result

    initial = health()
    assert initial["release"] == "a"
    host.fail("runuser -u nobody -- test -r /var/lib/authority/state.img")
    host.succeed("test $(systemctl show -p User --value authority-vm) = authority-vmm")
    host.succeed("test $(stat -c %a /var/lib/authority/state.img) = 600")

    host.succeed("activate ${releases.b}")
    receipt("committed")
    updated = health()
    assert updated["release"] == "b"
    assert updated["bootNonce"] != initial["bootNonce"]
    assert updated["stateIdentity"] == initial["stateIdentity"]

    for candidate in ["${releases.badCatalog}", "${releases.badRelease}"]:
        before = health()
        host.fail("activate " + candidate)
        receipt("rolled-back")
        after = health()
        assert after["release"] == "b"
        assert after["bootNonce"] != before["bootNonce"]
        assert after["stateIdentity"] == initial["stateIdentity"]

    # State-incompatible candidates are rejected before a restart or disk access.
    before = health()
    host.fail("activate ${releases.badEpoch}")
    assert health()["bootNonce"] == before["bootNonce"]

    # Losing the requesting client does not own or cancel the transaction.
    host.succeed("systemd-run --unit=lost-client $(command -v activate) ${releases.badCatalog}")
    host.wait_until_succeeds("test -e " + control + "/pending.json")
    host.fail("activate ${releases.a}")  # Concurrent release admission is refused.
    host.succeed("systemctl stop lost-client.service")
    host.wait_until_succeeds("test ! -e " + control + "/pending.json")
    receipt("rolled-back")
    assert health()["stateIdentity"] == initial["stateIdentity"]

    # Kill the target-local controller during a real update; OnFailure restores
    # the prior image even without a connected deployment client.
    host.succeed("systemd-run --unit=detached-client $(command -v activate) ${releases.badCatalog}")
    host.wait_until_succeeds("test -e " + control + "/pending.json")
    host.succeed("systemctl kill --signal=KILL authority-update.service")
    host.wait_until_succeeds("jq -e '.outcome == \"recovered\"' " + control + "/receipt.json")
    assert health()["stateIdentity"] == initial["stateIdentity"]

    host.succeed("systemctl stop authority-vm; systemctl start authority-vm")
    restarted = health()
    assert restarted["bootNonce"] != before["bootNonce"]
    assert restarted["stateIdentity"] == initial["stateIdentity"]
    # Reboot with a durable in-progress candidate, not merely a clean release.
    host.succeed("systemd-run --unit=reboot-client $(command -v activate) ${releases.badCatalog}")
    host.wait_until_succeeds("test -e " + control + "/pending.json")
    host.reboot()
    host.wait_for_unit("authority-ready.service")
    assert health()["release"] == "b"
    assert health()["stateIdentity"] == initial["stateIdentity"]
    host.succeed("test -L " + roots + "/prior; test ! -e " + control + "/pending.json")
  '';
}
