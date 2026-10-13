use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::Command;

#[test]
fn absolute_invocations_register_basename_callbacks() {
    let binary = env!("CARGO_BIN_EXE_pingping");
    assert!(Path::new(binary).is_absolute());
    for invocation in [binary, "/nix/store/example/bin/alias-ping"] {
        let basename = Path::new(invocation).file_name().unwrap().to_str().unwrap();
        for shell in ["bash", "zsh", "fish"] {
            let output = Command::new(binary)
                .arg0(invocation)
                .env("COMPLETE", shell)
                .output()
                .unwrap();
            assert!(output.status.success(), "{shell}: {:?}", output.stderr);
            let registration = String::from_utf8(output.stdout).unwrap();
            let callback = match shell {
                "bash" => format!("\"{basename}\" -- "),
                "fish" => format!("COMPLETE=fish {basename} -- "),
                _ => format!("{basename} -- "),
            };
            assert!(registration.contains(&callback), "{shell}: {registration}");
            assert!(!basename.contains('/'));
            assert!(
                !registration.contains(invocation),
                "{shell}: {registration}"
            );
            assert!(
                !registration.contains("/nix/store"),
                "{shell}: {registration}"
            );
        }
    }
}
