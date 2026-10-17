use macos_permissions_host::{Config, Host};
use std::path::PathBuf;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("serve");
    let config_path = match args.iter().position(|arg| arg == "--config") {
        Some(index) => PathBuf::from(args.get(index + 1).ok_or("--config requires a path")?),
        None => std::env::current_exe()?.parent().ok_or("Missing executable parent")?.join("../Resources/policy.json"),
    };
    let valid = match mode {
        "serve" => args.is_empty() || args == ["serve"] || (args.len() == 3 && args[1] == "--config"),
        "onboard" => args.iter().any(|arg| arg == "--human-present") && (args.len() == 2 || (args.len() == 4 && args[2] == "--config")),
        _ => false,
    };
    if !valid { return Err("Usage: macos-permissions-host serve [--config PATH] | onboard --human-present [--config PATH]".into()); }
    let config = Config::load(&config_path)?;
    if mode == "onboard" {
        println!("{}", serde_json::to_string(&macos_permissions_host::onboard(config)?)?);
    } else { Host::new(config)?.serve()?; }
    Ok(())
}
fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
