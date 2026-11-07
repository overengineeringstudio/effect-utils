use macos_permissions_host::{Host, transport::Role};
use std::path::PathBuf;

/// launchd supplies stdio only. Do not let an unexpected inherited descriptor
/// escape into a declared helper; this runs before any worker threads exist.
fn protect_inherited_descriptors() -> Result<(), Box<dyn std::error::Error>> {
    // SAFETY: getdtablesize has no pointer arguments or retained state.
    let bound = unsafe { libc::getdtablesize() };
    if bound < 0 { return Err("Cannot inspect inherited descriptors".into()); }
    for fd in 3..bound {
        // SAFETY: fcntl operates on a descriptor number, accepting closed descriptors.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFD) };
        if flags < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EBADF) { continue; }
            return Err("Cannot inspect inherited descriptor".into());
        }
        if unsafe { libc::fcntl(fd, libc::F_SETFD, flags | libc::FD_CLOEXEC) } < 0 {
            return Err("Cannot protect inherited descriptor".into());
        }
    }
    Ok(())
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    protect_inherited_descriptors()?;
    let args: Vec<String> = std::env::args().skip(1).collect();
    let mode = args.first().map(String::as_str).unwrap_or("serve");
    if !["serve", "onboard"].contains(&mode) { return Err("Expected serve or onboard".into()); }
    let mut config_path = None;
    let mut socket = None;
    let mut generation_pointer = None;
    let mut gui_socket = None;
    let mut role = None;
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
        if option == "--role" {
            if role.is_some() { return Err("Duplicate --role".into()); }
            role = Some(match args.get(index + 1).map(String::as_str) {
                Some("supervisor") => Role::Supervisor,
                Some("gui-agent") => Role::GuiAgent,
                _ => return Err("Expected supervisor or gui-agent role".into()),
            });
            index += 2;
            continue;
        }
        let destination = match option {
            "--config" => &mut config_path,
            "--socket" => &mut socket,
            "--generation-pointer" => &mut generation_pointer,
            "--gui-socket" => &mut gui_socket,
            _ => return Err("Unknown host argument".into()),
        };
        if destination.is_some() { return Err("Duplicate host argument".into()); }
        *destination = Some(PathBuf::from(args.get(index + 1).ok_or("Host option requires a path")?));
        index += 2;
    }
    if mode == "onboard" && (!human_present || config_path.is_none() || socket.is_some() || generation_pointer.is_some() || gui_socket.is_some() || role.is_some()) {
        return Err("Onboarding requires --human-present --config PATH and does not accept service endpoints or roles".into());
    }
    if mode == "serve" && human_present { return Err("Human-present consent is available only through onboard".into()); }
    let config_path = match config_path {
        Some(path) => path,
        None => std::env::current_exe()?.parent().ok_or("Missing executable parent")?.join("../Resources/policy.json"),
    };
    let config = macos_permissions_host::transport::load_sealed_config(&config_path)?;
    if mode == "onboard" {
        println!("{}", serde_json::to_string(&macos_permissions_host::onboard(config)?)?);
    } else {
        let role = role.unwrap_or(Role::Supervisor);
        macos_permissions_host::transport::verify_managed_role(role)?;
        if role == Role::GuiAgent {
            if socket.is_some() || generation_pointer.is_some() { return Err("GUI agent cannot expose a controller endpoint".into()); }
            macos_permissions_host::native::require_gui_session()?;
        }
        let gui_socket = gui_socket.unwrap_or_else(|| config.socket.with_extension("gui.sock"));
        if socket.as_ref().is_some_and(|path| path == &gui_socket) { return Err("Controller and private sockets must differ".into()); }
        if socket.is_some() != generation_pointer.is_some() {
            return Err("--socket and --generation-pointer must be supplied together".into());
        }
        let host = std::sync::Arc::new(Host::new_with_role(config, role, gui_socket)?);
        let _control = match (socket, generation_pointer) {
            (Some(socket), Some(pointer)) => Some(macos_permissions_host::control::serve(socket, pointer, std::sync::Arc::clone(&host))?),
            (None, None) => None,
            _ => return Err("--socket and --generation-pointer must be supplied together".into()),
        };
        macos_permissions_host::transport::serve(host)?;
    }
    Ok(())
}
fn main() {
    if let Err(error) = run() { eprintln!("{error}"); std::process::exit(1); }
}
