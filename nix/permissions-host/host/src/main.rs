use macos_permissions_host::{Config, Host};
use std::path::PathBuf;
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("serve");
    if !["serve", "onboard"].contains(&mode) { return Err("Expected serve or onboard".into()); }
    let mut config_path = None;
    let mut socket = None;
    let mut generation_pointer = None;
    let mut human_present = false;
    let mut index = 1;
    while index < args.len() {
        let option = args[index].as_str();
        if option == "--human-present" {
            if human_present { return Err("Duplicate --human-present".into()); }
            human_present = true;
            index += 1;
            continue;
        }
        let destination = match option {
            "--config" => &mut config_path,
            "--socket" => &mut socket,
            "--generation-pointer" => &mut generation_pointer,
            _ => return Err("Unknown host argument".into()),
        };
        if destination.is_some() { return Err("Duplicate host argument".into()); }
        *destination = Some(PathBuf::from(args.get(index + 1).ok_or("Host option requires a path")?));
        index += 2;
    }
    if mode == "onboard" && (!human_present || socket.is_some() || generation_pointer.is_some()) {
        return Err("Onboarding requires --human-present and does not accept service endpoints".into());
    }
    if mode == "serve" && human_present { return Err("Human-present consent is available only through onboard".into()); }
    let config_path = match config_path {
        Some(path) => path,
        None => std::env::current_exe()?.parent().ok_or("Missing executable parent")?.join("../Resources/policy.json"),
    };
    let config = Config::load(&config_path)?;
    if mode == "onboard" {
        println!("{}", serde_json::to_string(&macos_permissions_host::onboard(config)?)?);
    } else {
        let _control = match (socket, generation_pointer) {
            (Some(socket), Some(pointer)) => Some(macos_permissions_host::control::serve(socket, pointer, &config)?),
            (None, None) => None,
            _ => return Err("--socket and --generation-pointer must be supplied together".into()),
        };
        Host::new(config)?.serve()?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
