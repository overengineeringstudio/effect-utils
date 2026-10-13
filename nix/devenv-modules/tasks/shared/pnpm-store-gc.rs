//! Opt-in retirement of historical worktree-owned pnpm stores, not host CAS GC.
#![forbid(unsafe_code)]

#[cfg(all(target_os = "linux", not(pnpm_gc_unsupported_test)))]
mod linux {
    use std::collections::BTreeMap;
    use std::env;
    use std::fs;
    use std::hash::{DefaultHasher, Hash, Hasher};
    use std::io;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::process::{Command, ExitCode};
    use std::time::{SystemTime, UNIX_EPOCH};

    const GRACE_SECONDS: u64 = 24 * 60 * 60;
    const STORE_NAME: &str = "pnpm-store-pure-v1";
    const LEASE_NAME: &str = ".effect-utils-pnpm-store-cache-maintenance.lock";

    type Result<T, E = String> = std::result::Result<T, E>;

    #[derive(Clone, Copy, PartialEq, Eq)]
    enum Mode {
        DryRun,
        Observe,
        Apply,
    }

    struct Options {
        git_dir: PathBuf,
        roots: Vec<PathBuf>,
        mode: Mode,
    }

    fn options() -> Result<Options> {
        let mut args = env::args().skip(1);
        let mut git_dir = None;
        let mut roots = Vec::new();
        let mut mode = Mode::DryRun;
        while let Some(arg) = args.next() {
            match arg.as_str() {
                "--git-dir" => {
                    git_dir = Some(PathBuf::from(args.next().ok_or("--git-dir needs a path")?))
                }
                "--root" => roots.push(PathBuf::from(args.next().ok_or("--root needs a path")?)),
                "--observe" | "--apply" if mode == Mode::DryRun => {
                    mode = if arg == "--apply" {
                        Mode::Apply
                    } else {
                        Mode::Observe
                    };
                }
                "--help" => {
                    println!(
                        "usage: pnpm-store-gc --git-dir REPO/.bare --root WORKTREE [--root WORKTREE ...] [--observe | --apply]\nDefault: read-only dry-run. --observe records eligibility; --apply rechecks it and requires 24 hours of unchanged eligibility. Never collects the shared host store."
                    );
                    std::process::exit(0);
                }
                _ => return Err(format!("unknown or conflicting argument: {arg}")),
            }
        }
        let git_dir =
            fs::canonicalize(git_dir.ok_or("--git-dir is required")?).map_err(|e| e.to_string())?;
        if roots.is_empty() {
            return Err("at least one explicit --root is required".into());
        }
        for root in &mut roots {
            *root = fs::canonicalize(&*root).map_err(|e| e.to_string())?;
            if root.to_string_lossy().contains(['\n', '\r']) {
                return Err("worktree paths containing newlines are unsupported".into());
            }
        }
        roots.sort();
        roots.dedup();
        Ok(Options {
            git_dir,
            roots,
            mode,
        })
    }

    fn command(program: &str, args: &[&str]) -> Result<String> {
        let output = Command::new(program)
            .args(args)
            .output()
            .map_err(|e| format!("{program}: {e}"))?;
        if !output.status.success() {
            return Err(format!(
                "{program} failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        String::from_utf8(output.stdout).map_err(|e| e.to_string())
    }

    fn text(path: &Path) -> Result<&str> {
        path.to_str()
            .ok_or_else(|| format!("non-UTF8 path: {}", path.display()))
    }

    fn checkout_store_references(root: &Path, historical_store: &Path) -> Result<Vec<PathBuf>> {
        let mut stores = Vec::new();
        let mut pending = vec![root.to_path_buf()];
        while let Some(directory) = pending.pop() {
            for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                let name = entry.file_name();
                if name == "node_modules" {
                    let metadata = entry.path().join(".modules.yaml");
                    if metadata.try_exists().map_err(|error| error.to_string())? {
                        // pnpm 12 writes JSON to this historical filename. Unknown
                        // older formats fail closed rather than guessing a store.
                        let store = command(
                            "node",
                            &[
                                "-e",
                                "const fs=require('node:fs');const value=JSON.parse(fs.readFileSync(process.argv[1],'utf8'));if(typeof value.storeDir!=='string')throw Error('missing storeDir');process.stdout.write(value.storeDir)",
                                text(&metadata)?,
                            ],
                        )?;
                        let selected = fs::canonicalize(&store).map_err(|error| {
                            format!("cannot resolve projection store {store}: {error}")
                        })?;
                        if selected.starts_with(historical_store)
                            || selected
                                .components()
                                .any(|part| part.as_os_str() == STORE_NAME)
                        {
                            return Err(format!(
                                "checkout still references a worktree-local store: {}",
                                selected.display()
                            ));
                        }
                        stores.push(selected);
                    }
                    continue;
                }
                if [
                    ".git",
                    ".devenv",
                    "buck-out",
                    "target",
                    "tmp",
                    ".direnv",
                    ".cache",
                    ".pnpm-home",
                ]
                .iter()
                .any(|skip| name == *skip)
                {
                    continue;
                }
                if entry
                    .file_type()
                    .map_err(|error| error.to_string())?
                    .is_dir()
                {
                    pending.push(entry.path());
                }
            }
        }
        stores.sort();
        stores.dedup();
        Ok(stores)
    }

    fn shared_receipt_proof(
        root: &Path,
        historical_store: &Path,
        projections: &[PathBuf],
    ) -> Result<String> {
        let home = PathBuf::from(env::var_os("HOME").ok_or("HOME is required")?);
        let mut allowed = vec![
            home.join(".local/share/pnpm/store-shared-v1"),
            home.join(".local/share/pnpm/store"),
        ];
        if let Some(custom) = env::var_os("PNPM_SHARED_STORE_DIR") {
            allowed.push(PathBuf::from(custom));
        }
        let allowed: Vec<_> = allowed
            .iter()
            .filter_map(|path| fs::canonicalize(path).ok())
            .collect();
        let mut selected = Vec::new();
        let mut pending = vec![root.join(".devenv/task-cache/pnpm-install")];
        while let Some(directory) = pending.pop() {
            let entries = match fs::read_dir(directory) {
                Ok(entries) => entries,
                Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.to_string()),
            };
            for entry in entries {
                let entry = entry.map_err(|error| error.to_string())?;
                let kind = entry.file_type().map_err(|error| error.to_string())?;
                if kind.is_dir() {
                    pending.push(entry.path());
                }
                if entry.file_name() != "pnpm-storage-state" {
                    continue;
                }
                if !kind.is_file() {
                    return Err("pnpm storage receipt is not a regular file".into());
                }
                let receipt =
                    fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
                let selected_path =
                    fs::canonicalize(receipt.lines().next().ok_or("empty pnpm storage receipt")?)
                        .map_err(|error| error.to_string())?;
                if selected_path.starts_with(historical_store) || !allowed.contains(&selected_path)
                {
                    return Err(format!(
                        "pnpm storage receipt is not the selected host/user shared store: {}",
                        selected_path.display()
                    ));
                }
                selected.push(selected_path.join("v11"));
            }
        }
        selected.sort();
        selected.dedup();
        if projections.is_empty()
            || selected.is_empty()
            || projections.iter().any(|path| !selected.contains(path))
        {
            return Err(
            "checkout lacks matching shared-store selection receipts and pnpm projection metadata"
                .into(),
        );
        }
        Ok(format!("resolved-shared-store:{selected:?}"))
    }

    fn checkout_ownership_proof(git_dir: &Path, root: &Path) -> Result<String> {
        let listing = command(
            "git",
            &[
                "--git-dir",
                text(git_dir)?,
                "worktree",
                "list",
                "--porcelain",
            ],
        )?;
        let mut registered = false;
        for record in listing.split("\n\n") {
            let Some(path) = record
                .lines()
                .next()
                .and_then(|line| line.strip_prefix("worktree "))
            else {
                continue;
            };
            if Path::new(path) != root && fs::canonicalize(path).ok().as_deref() != Some(root) {
                continue;
            }
            registered = true;
            if record.lines().any(|line| line.starts_with("locked")) {
                return Err("git worktree is explicitly locked/pinned".into());
            }
        }
        let git_marker_absent = match fs::symlink_metadata(root.join(".git")) {
            Ok(_) => false,
            Err(error) if error.kind() == io::ErrorKind::NotFound => true,
            Err(error) => return Err(error.to_string()),
        };
        if !registered && git_marker_absent {
            return Ok("worktree-gone".into());
        }
        if !registered {
            return Err("checkout is not registered in the supplied repository".into());
        }
        if env::var("GITHUB_ACTIONS").ok().as_deref() == Some("true")
            || env::var("PNPM_JOB_LOCAL_STORE").ok().as_deref() == Some("1")
        {
            return Err("current context explicitly selects job-local pnpm storage".into());
        }
        let historical_store = fs::canonicalize(root.join(".devenv").join(STORE_NAME))
            .map_err(|error| error.to_string())?;
        let projections = checkout_store_references(root, &historical_store)?;
        let head = command("git", &["-C", text(root)?, "rev-parse", "HEAD"])?;
        let shared_head = Command::new("git")
            .args([
                "-C",
                text(root)?,
                "merge-base",
                "--is-ancestor",
                "727cb7544bea32ec031c9f6e5e840cbe717e772a",
                "HEAD",
            ])
            .output()
            .map_err(|error| error.to_string())?
            .status
            .success();
        if shared_head {
            return Ok(format!(
                "shared-selection-head:{}:{projections:?}",
                head.trim()
            ));
        }
        let resolved = shared_receipt_proof(root, &historical_store, &projections)?;
        Ok(format!("{}:{resolved}", head.trim()))
    }

    fn own_uid() -> Result<u32> {
        if Path::new("/proc/self").exists() {
            return fs::metadata("/proc/self")
                .map(|metadata| metadata.uid())
                .map_err(|error| error.to_string());
        }
        command("id", &["-u"])?
            .trim()
            .parse()
            .map_err(|error: std::num::ParseIntError| error.to_string())
    }

    fn reference_under(target: &Path, root: &Path) -> bool {
        // Linux exposes unlinked open files with this suffix; they still protect the root.
        let target = target.to_string_lossy();
        let target = target.strip_suffix(" (deleted)").unwrap_or(&target);
        Path::new(target).starts_with(root)
    }

    fn broker_exception_allowed(uid: u32, fd_owner: u32, comm: &str, exe: Option<&Path>) -> bool {
        // Explicitly approved privilege-separated brokers only. Root ownership of
        // an own-UID process's fd directory is the kernel's non-dumpable boundary.
        const BROKER_COMMS: &[&str] = &["sshd-session", ".tailscaled-wra"];
        const BROKER_EXES: &[&str] = &["sshd-session", ".tailscaled-wrapped"];
        uid != 0
            && fd_owner == 0
            && (BROKER_COMMS.contains(&comm)
                || exe
                    .and_then(Path::file_name)
                    .is_some_and(|name| BROKER_EXES.iter().any(|broker| name == *broker)))
    }

    fn user_manager_exception_allowed(
        comm: &str,
        exe: Option<&Path>,
        parent: u32,
        permitted: u64,
    ) -> bool {
        parent == 1
            && permitted != 0
            && (comm == "systemd"
                || exe
                    .and_then(Path::file_name)
                    .is_some_and(|name| name == "systemd"))
    }

    fn process_gone(pid_dir: &Path, error: &io::Error) -> bool {
        error.raw_os_error() == Some(3)
            || fs::metadata(pid_dir).is_err_and(|error| {
                error.kind() == io::ErrorKind::NotFound || error.raw_os_error() == Some(3)
            })
    }

    fn status_parent_and_permitted(status: &str) -> (u32, u64) {
        let parent = status
            .lines()
            .find_map(|line| line.strip_prefix("PPid:"))
            .and_then(|value| value.trim().parse::<u32>().ok())
            .unwrap_or(0);
        let permitted = status
            .lines()
            .find_map(|line| line.strip_prefix("CapPrm:"))
            .and_then(|value| u64::from_str_radix(value.trim(), 16).ok())
            .unwrap_or(0);
        (parent, permitted)
    }

    fn pam_broker_exception_allowed(
        proc_root: &Path,
        uid: u32,
        comm: &str,
        parent: u32,
    ) -> Result<bool> {
        if comm != "(sd-pam)" || parent == 0 {
            return Ok(false);
        }
        let manager = proc_root.join(parent.to_string());
        let status = match fs::read_to_string(manager.join("status")) {
            Ok(status) => status,
            Err(error) if process_gone(&manager, &error) => return Ok(false),
            Err(error) => return Err(format!("cannot classify PAM broker parent: {error}")),
        };
        let uids = status
            .lines()
            .find_map(|line| line.strip_prefix("Uid:"))
            .unwrap_or_default();
        if uids.split_whitespace().count() != 4
            || !uids
                .split_whitespace()
                .all(|value| value.parse::<u32>() == Ok(uid))
        {
            return Ok(false);
        }
        let comm = fs::read_to_string(manager.join("comm")).unwrap_or_default();
        let exe = fs::read_link(manager.join("exe")).ok();
        let (parent, permitted) = status_parent_and_permitted(&status);
        Ok(user_manager_exception_allowed(
            comm.trim(),
            exe.as_deref(),
            parent,
            permitted,
        ))
    }

    fn exclude_privileged_broker(pid_dir: &Path, uid: u32, status: &str) -> Result<bool> {
        let fd_owner = match fs::metadata(pid_dir.join("fd")) {
            Ok(metadata) => metadata.uid(),
            Err(error) if process_gone(pid_dir, &error) => return Ok(true),
            Err(error) => return Err(error.to_string()),
        };
        let comm = fs::read_to_string(pid_dir.join("comm")).unwrap_or_default();
        let exe = fs::read_link(pid_dir.join("exe"));
        let executable = exe.as_ref().ok().map(PathBuf::as_path);
        let (parent, permitted) = status_parent_and_permitted(status);
        let ssh_broker = broker_exception_allowed(uid, fd_owner, comm.trim(), executable);
        let user_manager =
            user_manager_exception_allowed(comm.trim(), executable, parent, permitted);
        let pam_broker = pam_broker_exception_allowed(
            pid_dir.parent().ok_or("process has no census parent")?,
            uid,
            comm.trim(),
            parent,
        )?;
        if !ssh_broker && !user_manager && !pam_broker {
            return Ok(false);
        }
        let exe = match exe {
            Ok(path) => path.display().to_string(),
            Err(error) => format!("<unreadable: {error}>"),
        };
        println!(
            "excluded-broker\tpid={}\tcomm={}\texe={exe}\tfd-owner={fd_owner}\tparent={parent}\tcapPrm=0x{permitted:x}\tassumption=privileged broker does not use user pnpm stores",
            pid_dir.file_name().unwrap_or_default().to_string_lossy(),
            comm.trim()
        );
        Ok(true)
    }

    fn process_directory_proof(
        pid_dir: &Path,
        directory: &Path,
        root: &Path,
        uid: u32,
        status: &str,
        ignored_directory: Option<i32>,
    ) -> Result<bool> {
        let cwd = directory.join("cwd");
        match fs::read_link(&cwd) {
            Ok(target) if reference_under(&target, root) => {
                return Err(format!(
                    "live process reference: {} -> {}",
                    cwd.display(),
                    target.display()
                ));
            }
            Ok(_) => {}
            Err(error) if process_gone(pid_dir, &error) => return Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    && exclude_privileged_broker(pid_dir, uid, status)? =>
            {
                return Ok(true);
            }
            Err(error) => {
                return Err(format!(
                    "process visibility incomplete at {}: {error}",
                    cwd.display()
                ));
            }
        }
        let fd_dir = directory.join("fd");
        let descriptors = match fs::read_dir(&fd_dir) {
            Ok(descriptors) => descriptors,
            Err(error) if process_gone(pid_dir, &error) => return Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(false),
            Err(error)
                if error.kind() == io::ErrorKind::PermissionDenied
                    && exclude_privileged_broker(pid_dir, uid, status)? =>
            {
                return Ok(true);
            }
            Err(error) => {
                return Err(format!(
                    "process visibility incomplete at {}: {error}",
                    fd_dir.display()
                ));
            }
        };
        for descriptor in descriptors {
            let path = match descriptor {
                Ok(descriptor) => descriptor.path(),
                Err(error) if process_gone(pid_dir, &error) => return Ok(true),
                Err(error) => return Err(error.to_string()),
            };
            if ignored_directory.is_some()
                && path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .and_then(|name| name.parse::<i32>().ok())
                    == ignored_directory
            {
                continue;
            }
            match fs::read_link(&path) {
                Ok(target) => {
                    if target == root.join(LEASE_NAME) {
                        continue;
                    }
                    if reference_under(&target, root) {
                        return Err(format!(
                            "live process reference: {} -> {}",
                            path.display(),
                            target.display()
                        ));
                    }
                }
                Err(error) if process_gone(pid_dir, &error) => return Ok(true),
                // A descriptor can close while its process remains live.
                Err(error) if error.kind() == io::ErrorKind::NotFound => {}
                Err(error)
                    if error.kind() == io::ErrorKind::PermissionDenied
                        && exclude_privileged_broker(pid_dir, uid, status)? =>
                {
                    return Ok(true);
                }
                Err(error) => {
                    return Err(format!(
                        "process visibility incomplete at {}: {error}",
                        path.display()
                    ));
                }
            }
        }
        Ok(true)
    }

    #[cfg(test)]
    fn process_proof(proc_root: &Path, root: &Path) -> Result<()> {
        process_proof_ignoring_directory(proc_root, root, None)
    }

    fn process_proof_ignoring_directory(
        proc_root: &Path,
        root: &Path,
        admitted_directory: Option<i32>,
    ) -> Result<()> {
        let entries =
            fs::read_dir(proc_root).map_err(|e| format!("cannot inventory processes: {e}"))?;
        let uid = own_uid()?;
        for entry in entries {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry
                .file_name()
                .to_string_lossy()
                .chars()
                .all(|c| c.is_ascii_digit())
            {
                continue;
            }
            let pid_dir = entry.path();
            let status = match fs::read_to_string(pid_dir.join("status")) {
                Ok(status) => status,
                Err(error) if process_gone(&pid_dir, &error) => continue,
                Err(error) => return Err(format!("cannot classify process ownership: {error}")),
            };
            let fields = status
                .lines()
                .find_map(|line| line.strip_prefix("Uid:"))
                .ok_or("process status has no UID evidence")?;
            let mut owned = false;
            let mut count = 0;
            for field in fields.split_whitespace() {
                owned |= field.parse::<u32>().map_err(|error| error.to_string())? == uid;
                count += 1;
            }
            if count != 4 {
                return Err("process status has incomplete UID evidence".into());
            }
            let ignored = if pid_dir
                .file_name()
                .and_then(|name| name.to_str())
                .and_then(|name| name.parse::<u32>().ok())
                == Some(std::process::id())
            {
                admitted_directory
            } else {
                None
            };
            if !owned || process_directory_proof(&pid_dir, &pid_dir, root, uid, &status, ignored)? {
                continue;
            }
            // A leader can exit while worker threads retain cwd and open files.
            let tasks = match fs::read_dir(pid_dir.join("task")) {
                Ok(tasks) => tasks,
                Err(error) if process_gone(&pid_dir, &error) => continue,
                Err(error) => {
                    return Err(format!(
                        "process task visibility incomplete at {}: {error}",
                        pid_dir.display()
                    ));
                }
            };
            let mut observed = false;
            for task in tasks {
                let task = task.map_err(|error| error.to_string())?.path();
                if process_directory_proof(&pid_dir, &task, root, uid, &status, ignored)? {
                    observed = true;
                } else if task.try_exists().map_err(|error| error.to_string())? {
                    return Err(format!(
                        "process task visibility incomplete at {}",
                        task.display()
                    ));
                }
            }
            if !observed && !process_gone(&pid_dir, &io::Error::from_raw_os_error(2)) {
                return Err(format!(
                    "process has no observable tasks: {}",
                    pid_dir.display()
                ));
            }
        }
        Ok(())
    }

    fn liveness(root: &Path, admitted_directory: &fs::File) -> Result<()> {
        use std::os::fd::AsRawFd;
        let ignored = Some(admitted_directory.as_raw_fd());
        // Only the explicitly test-compiled CLI accepts this fixture. Production
        // packages contain no environment/argument bypass of the real census.
        #[cfg(pnpm_gc_test)]
        if let Some(proc_root) = env::var_os("PNPM_GC_TEST_PROC_ROOT") {
            return process_proof_ignoring_directory(Path::new(&proc_root), root, ignored);
        }
        process_proof_ignoring_directory(Path::new("/proc"), root, ignored)
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Footprint {
        fingerprint: String,
        allocated: u64,
        reclaimable: u64,
    }

    #[derive(Hash)]
    struct InodeFootprint {
        allocated: u64,
        links: u64,
        references: u64,
        directory: bool,
        size: u64,
        modified: (i64, i64),
        changed: (i64, i64),
    }

    fn resolved_path(path: &Path) -> Result<PathBuf> {
        let absolute = std::path::absolute(path).map_err(|error| error.to_string())?;
        let mut ancestor = absolute.as_path();
        let mut missing = Vec::new();
        loop {
            match fs::canonicalize(ancestor) {
                Ok(mut resolved) => {
                    for component in missing.iter().rev() {
                        resolved.push(component);
                    }
                    return Ok(resolved);
                }
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    missing.push(
                        ancestor
                            .file_name()
                            .ok_or("shared store has no resolvable ancestor")?,
                    );
                    ancestor = ancestor.parent().ok_or("shared store has no parent")?;
                }
                Err(error) => return Err(format!("cannot resolve shared store path: {error}")),
            }
        }
    }

    fn reject_shared_store(store: &Path) -> Result<()> {
        let home = PathBuf::from(
            env::var_os("HOME").ok_or("HOME is required to protect default shared stores")?,
        );
        let defaults = [
            home.join(".local/share/pnpm/store"),
            home.join(".local/share/pnpm/store-shared-v1"),
        ];
        let configured = env::var_os("PNPM_SHARED_STORE_DIR")
            .filter(|path| !path.is_empty())
            .map(PathBuf::from);
        let candidate = fs::canonicalize(store).map_err(|error| error.to_string())?;
        let candidate_stat = fs::metadata(&candidate).map_err(|error| error.to_string())?;
        for shared in defaults.iter().chain(configured.iter()) {
            let resolved = resolved_path(shared)?;
            let same_inode = fs::metadata(&resolved).is_ok_and(|stat| {
                (stat.dev(), stat.ino()) == (candidate_stat.dev(), candidate_stat.ino())
            });
            if candidate.starts_with(&resolved) || resolved.starts_with(&candidate) || same_inode {
                return Err(format!(
                    "historical candidate overlaps a protected shared store: {}",
                    resolved.display()
                ));
            }
        }
        Ok(())
    }

    #[cfg(target_os = "linux")]
    fn mount_path(field: &str) -> Result<PathBuf> {
        use std::os::unix::ffi::OsStringExt;
        let mut bytes = Vec::with_capacity(field.len());
        let mut input = field.bytes();
        while let Some(byte) = input.next() {
            if byte != b'\\' {
                bytes.push(byte);
                continue;
            }
            let mut decoded = 0u16;
            for _ in 0..3 {
                let digit = input.next().ok_or("truncated mountinfo escape")?;
                if !(b'0'..=b'7').contains(&digit) {
                    return Err("invalid mountinfo escape".into());
                }
                decoded = decoded * 8 + u16::from(digit - b'0');
            }
            bytes.push(u8::try_from(decoded).map_err(|error| error.to_string())?);
        }
        Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
    }

    fn reject_mounts(store: &Path) -> Result<()> {
        let store = fs::canonicalize(store).map_err(|error| error.to_string())?;
        #[cfg(target_os = "linux")]
        {
            let mounts = fs::read_to_string("/proc/self/mountinfo")
                .map_err(|error| format!("cannot inventory mounts: {error}"))?;
            for line in mounts.lines() {
                let mount = mount_path(
                    line.split_ascii_whitespace()
                        .nth(4)
                        .ok_or("incomplete mountinfo record")?,
                )?;
                if mount.starts_with(&store) {
                    return Err(format!("store contains a mount point: {}", mount.display()));
                }
            }
            Ok(())
        }
    }

    fn descriptor_path(file: &fs::File) -> PathBuf {
        use std::os::fd::AsRawFd;
        #[cfg(target_os = "linux")]
        let namespace = "/proc/self/fd";
        PathBuf::from(namespace).join(file.as_raw_fd().to_string())
    }

    fn open_directory(path: &Path) -> Result<fs::File> {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "linux")]
        let flags = 0x10000 | 0x20000; // O_DIRECTORY | O_NOFOLLOW
        fs::OpenOptions::new()
            .read(true)
            .custom_flags(flags)
            .open(path)
            .map_err(|error| error.to_string())
    }

    #[cfg(target_os = "linux")]
    fn mount_id(directory: &fs::File) -> Result<u64> {
        use std::os::fd::AsRawFd;
        fs::read_to_string(format!("/proc/self/fdinfo/{}", directory.as_raw_fd()))
            .map_err(|error| error.to_string())?
            .lines()
            .find_map(|line| line.strip_prefix("mnt_id:"))
            .ok_or("held directory has no mount identity")?
            .trim()
            .parse()
            .map_err(|error: std::num::ParseIntError| error.to_string())
    }

    struct AdmittedStore {
        path: PathBuf,
        directory: fs::File,
        identity: (u64, u64),
        #[cfg(target_os = "linux")]
        mount: u64,
    }

    impl AdmittedStore {
        fn open(path: &Path) -> Result<Self> {
            reject_shared_store(path)?;
            reject_mounts(path)?;
            let parent = open_directory(path.parent().ok_or("store has no parent")?)?;
            let directory = open_directory(
                &descriptor_path(&parent).join(path.file_name().ok_or("store has no name")?),
            )?;
            let stat = directory.metadata().map_err(|error| error.to_string())?;
            if stat.uid() != own_uid()? {
                return Err("historical store is not owned by the invoking UID".into());
            }
            #[cfg(target_os = "linux")]
            let mount = {
                let mount = mount_id(&directory)?;
                if mount != mount_id(&parent)? {
                    return Err("store root is a mount point".into());
                }
                mount
            };
            let admitted = Self {
                path: path.to_path_buf(),
                directory,
                identity: (stat.dev(), stat.ino()),
                #[cfg(target_os = "linux")]
                mount,
            };
            admitted.assert_identity()?;
            Ok(admitted)
        }

        fn assert_identity(&self) -> Result<()> {
            let stat = fs::symlink_metadata(&self.path)
                .map_err(|error| format!("admitted store path disappeared: {error}"))?;
            if !stat.is_dir() || (stat.dev(), stat.ino()) != self.identity {
                return Err(
                    "historical store path no longer identifies the admitted directory".into(),
                );
            }
            #[cfg(target_os = "linux")]
            if mount_id(&self.directory)? != self.mount {
                return Err("admitted store mount identity changed".into());
            }
            Ok(())
        }

        fn lease(&self, mode: Mode) -> Result<Option<fs::File>> {
            use std::os::unix::fs::OpenOptionsExt;
            if mode == Mode::DryRun {
                return Ok(None);
            }
            #[cfg(target_os = "linux")]
            let nofollow = 0x20000;
            let lease = fs::OpenOptions::new()
                .append(true)
                .create(true)
                .mode(0o600)
                .custom_flags(nofollow)
                .open(descriptor_path(&self.directory).join(LEASE_NAME))
                .map_err(|error| error.to_string())?;
            if !lease
                .metadata()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("maintenance lease is not a regular file".into());
            }
            // stdin duplicates this same open-file description. The lock remains
            // held by our original File after flock exits; no pathname re-exec.
            let status = Command::new("flock")
                .args(["--exclusive", "--nonblock", "0"])
                .stdin(std::process::Stdio::from(
                    lease.try_clone().map_err(|error| error.to_string())?,
                ))
                .status()
                .map_err(|error| error.to_string())?;
            if !status.success() {
                return Err("Store Cache maintenance lease busy".into());
            }
            self.assert_identity()?;
            Ok(Some(lease))
        }

        fn prove(&self, git_dir: &Path, root: &Path) -> Result<(String, Footprint)> {
            self.assert_identity()?;
            reject_shared_store(&self.path)?;
            reject_mounts(&self.path)?;
            let ownership = checkout_ownership_proof(git_dir, root)?;
            liveness(&self.path, &self.directory)?;
            let footprint = footprint_held(self)?;
            self.assert_identity()?;
            Ok((
                format!("{}\n{ownership}\n{}", root.display(), footprint.fingerprint),
                footprint,
            ))
        }
    }

    #[cfg(target_os = "linux")]
    fn retire_payloads(store: &AdmittedStore) -> Result<()> {
        fn walk(
            held_directory: &fs::File,
            expected_mount: u64,
            preserve_lease: bool,
        ) -> Result<()> {
            if mount_id(held_directory)? != expected_mount {
                return Err("retirement crossed a mount boundary".into());
            }
            let held = descriptor_path(held_directory);
            for entry in fs::read_dir(&held).map_err(|error| error.to_string())? {
                let entry = entry.map_err(|error| error.to_string())?;
                if preserve_lease && entry.file_name() == LEASE_NAME {
                    continue;
                }
                let path = held.join(entry.file_name());
                let kind = fs::symlink_metadata(&path)
                    .map_err(|error| error.to_string())?
                    .file_type();
                if kind.is_symlink() {
                    return Err("retirement encountered a replacement bridge".into());
                }
                if kind.is_dir() {
                    let child = open_directory(&path)?;
                    walk(&child, expected_mount, false)?;
                    fs::remove_dir(&path).map_err(|error| error.to_string())?;
                } else if kind.is_file() {
                    fs::remove_file(&path).map_err(|error| error.to_string())?;
                } else {
                    return Err("retirement encountered a non-file payload".into());
                }
            }
            Ok(())
        }
        store.assert_identity()?;
        reject_shared_store(&store.path)?;
        reject_mounts(&store.path)?;
        walk(&store.directory, store.mount, true)?;
        store.assert_identity()
    }

    #[cfg(test)]
    fn footprint(store: &Path) -> Result<Footprint> {
        footprint_held(&AdmittedStore::open(store)?)
    }

    fn footprint_held(admitted: &AdmittedStore) -> Result<Footprint> {
        let store = descriptor_path(&admitted.directory);
        let metadata = admitted
            .directory
            .metadata()
            .map_err(|error| error.to_string())?;
        let mut inodes: BTreeMap<(u64, u64), InodeFootprint> = BTreeMap::new();
        let mut stack = vec![store.to_path_buf()];
        while let Some(path) = stack.pop() {
            let stat = if path == store {
                admitted.directory.metadata()
            } else {
                fs::symlink_metadata(&path)
            }
            .map_err(|e| format!("{}: {e}", path.display()))?;
            if stat.file_type().is_symlink() {
                return Err(format!("store contains a bridge: {}", path.display()));
            }
            if stat.dev() != metadata.dev() {
                return Err("store contains a filesystem mount boundary".into());
            }
            let inode = inodes
                .entry((stat.dev(), stat.ino()))
                .or_insert(InodeFootprint {
                    allocated: if path == store {
                        0
                    } else {
                        stat.blocks() * 512
                    },
                    links: stat.nlink(),
                    references: 0,
                    directory: stat.is_dir(),
                    size: stat.size(),
                    modified: (stat.mtime(), stat.mtime_nsec()),
                    changed: (stat.ctime(), stat.ctime_nsec()),
                });
            inode.references += 1;
            if stat.is_dir() {
                for entry in fs::read_dir(&path).map_err(|e| e.to_string())? {
                    let entry = entry.map_err(|e| e.to_string())?;
                    if entry.path() == store.join(LEASE_NAME) {
                        continue;
                    }
                    stack.push(entry.path());
                }
            } else if !stat.is_file() {
                return Err(format!(
                    "store contains a non-file payload: {}",
                    path.display()
                ));
            }
        }
        let allocated = inodes.values().map(|inode| inode.allocated).sum();
        let reclaimable = inodes
            .values()
            .filter(|inode| inode.directory || inode.links <= inode.references)
            .map(|inode| inode.allocated)
            .sum();
        let mut signature = DefaultHasher::new();
        for inode in &inodes {
            inode.hash(&mut signature);
        }
        Ok(Footprint {
            fingerprint: format!(
                "{}:{}:{:x}",
                metadata.dev(),
                metadata.ino(),
                signature.finish()
            ),
            allocated,
            reclaimable,
        })
    }

    fn observation_matches(record: &str, proof: &str, now: u64) -> bool {
        let Some((timestamp, recorded_proof)) = record.split_once('\n') else {
            return false;
        };
        timestamp.parse::<u64>().is_ok_and(|start| {
            now.checked_sub(start)
                .is_some_and(|age| age >= GRACE_SECONDS)
        }) && recorded_proof == proof
    }

    fn collect(options: &Options, root: &Path) -> Result<u64> {
        let store = root.join(".devenv").join(STORE_NAME);
        if !store.try_exists().map_err(|e| e.to_string())? {
            println!("absent\t0\t{}", store.display());
            return Ok(0);
        }
        reject_shared_store(&store)?;
        reject_mounts(&store)?;
        // Refuse bridges before even creating a maintenance lease inside a store.
        if !fs::symlink_metadata(&store)
            .map_err(|e| e.to_string())?
            .is_dir()
            || fs::symlink_metadata(root.join(".devenv"))
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            || fs::symlink_metadata(store.join(LEASE_NAME)).is_ok_and(|stat| !stat.is_file())
        {
            return Err("store, .devenv, and lease must not be bridges".into());
        }
        let admitted = AdmittedStore::open(&store)?;
        let _lease = admitted.lease(options.mode)?;
        let state_base = env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
            .ok_or("HOME or XDG_STATE_HOME is required")?
            .join("effect-utils/pnpm-store-gc");
        let state = state_base.join(format!(
            "{}-{}.observation",
            admitted.identity.0, admitted.identity.1
        ));
        let proof = admitted.prove(&options.git_dir, root);
        let (proof, footprint) = match proof {
            Ok(value) => value,
            Err(error) => {
                if options.mode != Mode::DryRun && state.try_exists().map_err(|e| e.to_string())? {
                    fs::write(&state, "protected").map_err(|e| e.to_string())?;
                }
                println!("protected\t0\t{}\t{error}", store.display());
                return Ok(0);
            }
        };
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_secs();
        let previous = match fs::read_to_string(&state) {
            Ok(record) => record,
            Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(format!("cannot read observation: {e}")),
        };
        if !observation_matches(&previous, &proof, now) {
            if options.mode != Mode::DryRun {
                fs::create_dir_all(&state_base).map_err(|e| e.to_string())?;
                // Preserve the first observation while grace is still running.
                if previous
                    .split_once('\n')
                    .is_none_or(|(_, recorded)| recorded != proof)
                {
                    fs::write(&state, format!("{now}\n{proof}")).map_err(|e| e.to_string())?;
                }
            }
            println!(
                "grace\t{}\t{}\tallocated={} needs unchanged --observe proof for 24h",
                footprint.reclaimable,
                store.display(),
                footprint.allocated
            );
            return Ok(0);
        }
        if options.mode == Mode::Apply {
            // Hold the same exclusive lease used by managed pnpm maintenance, then
            // repeat both proofs immediately before unlinking. The lock inode/root
            // stay in place so late cooperating installs cannot acquire a new inode.
            let recheck = (|| {
                let (current, _) = admitted.prove(&options.git_dir, root)?;
                if current != proof {
                    return Err("eligibility changed before retirement".into());
                }
                Ok::<_, String>(())
            })();
            if let Err(error) = recheck {
                fs::write(&state, "protected").map_err(|e| e.to_string())?;
                return Err(error);
            }
            #[cfg(pnpm_gc_test)]
            if let Some(replacement) = env::var_os("PNPM_GC_TEST_SWAP_WITH") {
                fs::rename(&store, store.with_extension("proved"))
                    .map_err(|error| error.to_string())?;
                fs::rename(replacement, &store).map_err(|error| error.to_string())?;
            }
            retire_payloads(&admitted)?;
            fs::write(&state, "retired").map_err(|e| e.to_string())?;
        }
        println!(
            "{}\t{}\t{}\tallocated={}",
            if options.mode == Mode::Apply {
                "retired"
            } else {
                "would-free"
            },
            footprint.reclaimable,
            store.display(),
            footprint.allocated
        );
        Ok(footprint.reclaimable)
    }

    fn run() -> Result<()> {
        let options = options()?;
        println!(
            "assumption: own-uid={} census only; other-uid processes do not use user-owned historical .devenv stores in normal flow",
            own_uid()?
        );
        let mut total = 0;
        for root in &options.roots {
            total += collect(&options, root)?;
        }
        if options.mode == Mode::DryRun {
            println!("would-free-total\t{total}");
        }
        Ok(())
    }

    pub fn main() -> ExitCode {
        match run() {
            Ok(()) => ExitCode::SUCCESS,
            Err(error) => {
                eprintln!("pnpm-store-gc: {error}");
                ExitCode::FAILURE
            }
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        fn fixture(label: &str) -> PathBuf {
            let parent = env::var_os("PNPM_GC_TEST_ROOT")
                .expect("PNPM_GC_TEST_ROOT must name a disposable fixture directory");
            let root = PathBuf::from(parent).join(format!("{label}-{}", std::process::id()));
            fs::create_dir_all(&root).unwrap();
            root
        }

        #[test]
        fn present_pid_without_cwd_requires_task_inventory() {
            use std::os::unix::fs::symlink;
            let root = fixture("missing-leader");
            let census = root.join("proc");
            let pid = census.join("123");
            let task = pid.join("task/456");
            let store = root.join("store");
            fs::create_dir_all(task.join("fd")).unwrap();
            fs::write(
                pid.join("status"),
                format!("Uid:\t{0}\t{0}\t{0}\t{0}\n", own_uid().unwrap()),
            )
            .unwrap();
            symlink(&store, task.join("cwd")).unwrap();
            assert!(
                process_proof(&census, &store)
                    .unwrap_err()
                    .contains("live process reference")
            );
            assert!(!process_gone(&pid, &io::Error::from_raw_os_error(2)));
            assert!(!process_gone(&pid, &io::Error::from_raw_os_error(13)));
        }

        #[test]
        fn configured_shared_store_is_never_a_candidate() {
            if let Some(store) = env::var_os("PNPM_GC_SHARED_CANDIDATE") {
                let store = PathBuf::from(store);
                let root = store.parent().unwrap().parent().unwrap();
                let options = Options {
                    git_dir: root.join("repo.git"),
                    roots: vec![root.to_path_buf()],
                    mode: Mode::DryRun,
                };
                assert!(
                    collect(&options, root)
                        .unwrap_err()
                        .contains("shared store")
                );
                return;
            }
            let root = fixture("shared-candidate");
            let store = root.join(".devenv").join(STORE_NAME);
            fs::create_dir_all(&store).unwrap();
            command(
                "git",
                &["init", "--bare", text(&root.join("repo.git")).unwrap()],
            )
            .unwrap();
            let status = Command::new(env::current_exe().unwrap())
                .args([
                    "--exact",
                    "linux::tests::configured_shared_store_is_never_a_candidate",
                    "--nocapture",
                ])
                .env("PNPM_GC_SHARED_CANDIDATE", &store)
                .env("PNPM_SHARED_STORE_DIR", &store)
                .status()
                .unwrap();
            assert!(status.success());
        }

        #[test]
        #[cfg(target_os = "linux")]
        fn bind_mounts_are_refused_even_on_the_same_device() {
            if let Some(store) = env::var_os("PNPM_GC_MOUNTED_CANDIDATE") {
                assert!(footprint(Path::new(&store)).unwrap_err().contains("mount"));
                return;
            }
            let probe = Command::new("unshare").args(["-rm", "true"]).output();
            if !probe.as_ref().is_ok_and(|output| output.status.success()) {
                eprintln!(
                    "SKIP bind-mount integration: user/mount namespaces unavailable: {}",
                    probe
                        .map(|output| String::from_utf8_lossy(&output.stderr).into_owned())
                        .unwrap_or_else(|error| error.to_string())
                );
                return;
            }
            let root = fixture("bind-mount");
            let source = root.join("shared-cas");
            let store = root.join("store");
            fs::create_dir_all(&source).unwrap();
            fs::create_dir_all(store.join("v11/files")).unwrap();
            fs::write(source.join("sentinel"), "preserve").unwrap();
            for target in [&store, &store.join("v11/files")] {
                let status = Command::new("unshare").args(["-rm", "bash", "-c", r#"mount --bind "$1" "$2" && exec "$3" --exact linux::tests::bind_mounts_are_refused_even_on_the_same_device --nocapture"#, "bind-test"])
                .arg(&source).arg(target).arg(env::current_exe().unwrap()).env("PNPM_GC_MOUNTED_CANDIDATE", &store).status().unwrap();
                assert!(status.success());
            }
            assert_eq!(
                fs::read_to_string(source.join("sentinel")).unwrap(),
                "preserve"
            );
        }

        #[test]
        fn exited_processes_are_gone_not_unobservable() {
            let root = fixture("exited-process");
            let live = root.join("123");
            fs::create_dir_all(&live).unwrap();
            assert!(process_gone(&live, &io::Error::from_raw_os_error(3)));
            assert!(!process_gone(&live, &io::Error::from_raw_os_error(2)));
            assert!(!process_gone(&live, &io::Error::from_raw_os_error(13)));
            assert!(process_gone(
                &root.join("gone"),
                &io::Error::from_raw_os_error(13)
            ));
        }

        #[test]
        fn pam_exception_requires_the_same_approved_user_manager() {
            let root = fixture("pam-parent");
            let manager = root.join("123");
            fs::create_dir_all(&manager).unwrap();
            fs::write(manager.join("comm"), "systemd\n").unwrap();
            let uid = own_uid().unwrap();
            fs::write(
                manager.join("status"),
                format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nPPid:\t1\nCapPrm:\t0000000800000000\n"),
            )
            .unwrap();
            assert!(pam_broker_exception_allowed(&root, uid, "(sd-pam)", 123).unwrap());
            assert!(!pam_broker_exception_allowed(&root, uid, "pnpm", 123).unwrap());
            assert!(!pam_broker_exception_allowed(&root, uid, "(sd-pam)", 456).unwrap());
            fs::write(
                manager.join("status"),
                format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nPPid:\t1\nCapPrm:\t0000000000000000\n"),
            )
            .unwrap();
            assert!(!pam_broker_exception_allowed(&root, uid, "(sd-pam)", 123).unwrap());
            fs::write(
                manager.join("status"),
                format!("Uid:\t{uid}\t{uid}\t{uid}\t{uid}\nPPid:\t2\nCapPrm:\t0000000800000000\n"),
            )
            .unwrap();
            assert!(!pam_broker_exception_allowed(&root, uid, "(sd-pam)", 123).unwrap());
        }

        #[test]
        #[cfg(target_os = "linux")]
        fn real_open_descriptor_protects_a_root() {
            use std::os::unix::fs::symlink;
            let root = fixture("real-fd");
            let census = root.join("census");
            let worktree = root.join("worktree");
            fs::create_dir_all(&census).unwrap();
            fs::create_dir_all(&worktree).unwrap();
            fs::write(worktree.join("payload"), "live").unwrap();
            let descriptor = fs::File::open(worktree.join("payload")).unwrap();
            symlink("/proc/self", census.join(std::process::id().to_string())).unwrap();
            assert!(
                process_proof(&census, &worktree)
                    .unwrap_err()
                    .contains("/fd/")
            );
            drop(descriptor);
            assert!(process_proof(&census, &worktree).is_ok());
        }

        #[test]
        fn proc_census_protects_cwd_and_open_descriptors() {
            use std::os::unix::fs::symlink;
            let root = fixture("proc");
            let proc_root = root.join("proc");
            let worktree = root.join("worktree");
            fs::create_dir_all(proc_root.join("123/fd")).unwrap();
            fs::write(
                proc_root.join("123/status"),
                format!("Uid:\t{0}\t{0}\t{0}\t{0}\n", own_uid().unwrap()),
            )
            .unwrap();
            symlink(&worktree, proc_root.join("123/cwd")).unwrap();
            assert!(
                process_proof(&proc_root, &worktree)
                    .unwrap_err()
                    .contains("live process")
            );
            let sibling = root.join("sibling");
            // Another process holds an fd, while its cwd is outside the root.
            fs::create_dir_all(proc_root.join("456/fd")).unwrap();
            fs::write(
                proc_root.join("456/status"),
                format!("Uid:\t{0}\t{0}\t{0}\t{0}\n", own_uid().unwrap()),
            )
            .unwrap();
            symlink(&sibling, proc_root.join("456/cwd")).unwrap();
            symlink(worktree.join("dependency"), proc_root.join("456/fd/4")).unwrap();
            assert!(process_proof(&proc_root, &sibling).is_err());
            let only_fd = root.join("fd-only");
            fs::create_dir_all(only_fd.join("789/fd")).unwrap();
            fs::write(
                only_fd.join("789/status"),
                format!("Uid:\t{0}\t{0}\t{0}\t{0}\n", own_uid().unwrap()),
            )
            .unwrap();
            symlink(&sibling, only_fd.join("789/cwd")).unwrap();
            symlink(worktree.join("dependency"), only_fd.join("789/fd/4")).unwrap();
            assert!(
                process_proof(&only_fd, &worktree)
                    .unwrap_err()
                    .contains("/fd/4")
            );
            assert!(process_proof(&only_fd, &root.join("unrelated")).is_ok());
        }

        #[test]
        fn footprint_excludes_external_hardlink_bytes_and_refuses_bridges() {
            use std::os::unix::fs::symlink;
            let root = fixture("footprint");
            let store = root.join(".devenv").join(STORE_NAME);
            fs::create_dir_all(store.join("v11/files")).unwrap();
            let content = store.join("v11/files/payload");
            fs::write(&content, vec![42; 8192]).unwrap();
            let before = footprint(&store).unwrap();
            fs::hard_link(&content, root.join("imported-payload")).unwrap();
            let after = footprint(&store).unwrap();
            assert_eq!(before.allocated, after.allocated);
            assert_eq!(
                before.reclaimable - after.reclaimable,
                fs::metadata(&content).unwrap().blocks() * 512
            );
            assert_ne!(before.fingerprint, after.fingerprint);
            symlink(root.join("shared-store"), store.join("bridge")).unwrap();
            assert!(footprint(&store).unwrap_err().contains("bridge"));
        }

        #[test]
        fn ownership_proof_admits_only_gone_unregistered_roots() {
            let root = fixture("git");
            let repo = root.join("repo.git");
            let orphan = root.join("orphan");
            fs::create_dir_all(&orphan).unwrap();
            command("git", &["init", "--bare", text(&repo).unwrap()]).unwrap();
            assert_eq!(
                checkout_ownership_proof(&repo, &orphan).unwrap(),
                "worktree-gone"
            );
            fs::write(orphan.join(".git"), "gitdir: /unavailable").unwrap();
            assert!(checkout_ownership_proof(&repo, &orphan).is_err());
        }
        #[test]
        fn resolved_shared_receipts_do_not_admit_legacy_projection_references() {
            let root = fixture("resolved-selection");
            let historical = root.join(".devenv").join(STORE_NAME);
            let shared = PathBuf::from(env::var_os("HOME").unwrap())
                .join(".local/share/pnpm/store-shared-v1");
            fs::create_dir_all(historical.join("v11/files")).unwrap();
            fs::create_dir_all(shared.join("v11/files")).unwrap();
            fs::create_dir_all(root.join("node_modules")).unwrap();
            fs::create_dir_all(root.join(".devenv/task-cache/pnpm-install")).unwrap();
            let modules = root.join("node_modules/.modules.yaml");
            let receipt = root.join(".devenv/task-cache/pnpm-install/pnpm-storage-state");
            fs::write(
                &modules,
                format!(r#"{{"storeDir":"{}"}}"#, shared.join("v11").display()),
            )
            .unwrap();
            fs::write(&receipt, format!("{}\nauto\nfalse\n", shared.display())).unwrap();
            let projections = checkout_store_references(&root, &historical).unwrap();
            assert!(
                shared_receipt_proof(&root, &historical, &projections)
                    .unwrap()
                    .contains("resolved-shared-store")
            );
            fs::write(&receipt, format!("{}\nauto\nfalse\n", historical.display())).unwrap();
            assert!(shared_receipt_proof(&root, &historical, &projections).is_err());
            fs::write(&receipt, format!("{}\nauto\nfalse\n", shared.display())).unwrap();
            fs::create_dir_all(root.join("packages/app/node_modules")).unwrap();
            fs::write(
                root.join("packages/app/node_modules/.modules.yaml"),
                format!(r#"{{"storeDir":"{}"}}"#, historical.join("v11").display()),
            )
            .unwrap();
            assert!(
                checkout_store_references(&root, &historical)
                    .unwrap_err()
                    .contains("still references")
            );
            // Unknown metadata is not an alternative ownership proof.
            fs::write(&modules, "storeDir: unknown-yaml-format\n").unwrap();
            assert!(checkout_store_references(&root, &historical).is_err());
        }

        #[test]
        fn checkout_cwd_does_not_pin_an_unreferenced_historical_store() {
            use std::os::unix::fs::symlink;
            let root = fixture("store-census-scope");
            let census = root.join("proc");
            let checkout = root.join("checkout");
            let store = checkout.join(".devenv").join(STORE_NAME);
            fs::create_dir_all(census.join("123/fd")).unwrap();
            fs::write(
                census.join("123/status"),
                format!("Uid:\t{0}\t{0}\t{0}\t{0}\n", own_uid().unwrap()),
            )
            .unwrap();
            symlink(&checkout, census.join("123/cwd")).unwrap();
            assert!(process_proof(&census, &store).is_ok());
            fs::create_dir_all(census.join("456/fd")).unwrap();
            fs::write(
                census.join("456/status"),
                format!("Uid:\t{0}\t{0}\t{0}\t{0}\n", own_uid().unwrap()),
            )
            .unwrap();
            symlink(store.join("v11"), census.join("456/cwd")).unwrap();
            assert!(process_proof(&census, &store).is_err());
        }
        #[test]
        fn other_uid_processes_are_outside_the_declared_cache_workflow() {
            let root = fixture("uid-scope");
            let census = root.join("proc");
            fs::create_dir_all(census.join("123")).unwrap();
            let other = if own_uid().unwrap() == 0 { 1 } else { 0 };
            fs::write(
                census.join("123/status"),
                format!("Uid:\t{other}\t{other}\t{other}\t{other}\n"),
            )
            .unwrap();
            // There is deliberately no observable fd directory for this other UID.
            assert!(process_proof(&census, &root.join("store")).is_ok());
            fs::write(census.join("123/status"), "Uid:\tunknown\n").unwrap();
            assert!(process_proof(&census, &root.join("store")).is_err());
        }
        #[test]
        fn only_allowlisted_kernel_protected_brokers_can_be_excluded() {
            assert!(broker_exception_allowed(1000, 0, "sshd-session", None));
            assert!(broker_exception_allowed(
                1000,
                0,
                "hidden-name",
                Some(Path::new("/nix/store/openssh/bin/sshd-session"))
            ));
            assert!(broker_exception_allowed(1000, 0, ".tailscaled-wra", None));
            assert!(broker_exception_allowed(
                1000,
                0,
                "hidden-name",
                Some(Path::new("/nix/store/tailscale/bin/.tailscaled-wrapped"))
            ));
            assert!(!broker_exception_allowed(1000, 1000, "sshd-session", None));
            assert!(!broker_exception_allowed(1000, 0, "pnpm", None));
            assert!(!broker_exception_allowed(0, 0, "sshd-session", None));
            assert!(user_manager_exception_allowed(
                "systemd",
                None,
                1,
                0x0000000800000000
            ));
            assert!(!user_manager_exception_allowed(
                "systemd",
                None,
                2,
                0x0000000800000000
            ));
            assert!(!user_manager_exception_allowed("systemd", None, 1, 0));
            assert!(!user_manager_exception_allowed(
                "pnpm",
                None,
                1,
                0x0000000800000000
            ));
        }

        #[test]
        fn default_collection_never_changes_a_store_or_creates_a_lease() {
            let root = fixture("dry-run");
            let repo = root.join("repo.git");
            let orphan = root.join("orphan");
            let store = orphan.join(".devenv").join(STORE_NAME);
            fs::create_dir_all(store.join("v11/files")).unwrap();
            fs::write(store.join("v11/files/sentinel"), "preserve").unwrap();
            command("git", &["init", "--bare", text(&repo).unwrap()]).unwrap();
            let before = footprint(&store).unwrap();
            let options = Options {
                git_dir: repo,
                roots: vec![orphan.clone()],
                mode: Mode::DryRun,
            };
            // A fresh candidate is either census-protected or awaiting observation.
            assert_eq!(collect(&options, &orphan).unwrap(), 0);
            assert_eq!(footprint(&store).unwrap(), before);
            assert!(!store.join(LEASE_NAME).exists());
            assert_eq!(
                fs::read_to_string(store.join("v11/files/sentinel")).unwrap(),
                "preserve"
            );
        }

        #[test]
        fn component_aware_process_references_include_deleted_files() {
            let root = Path::new("/work/tree");
            assert!(reference_under(Path::new("/work/tree/file"), root));
            assert!(reference_under(
                Path::new("/work/tree/file (deleted)"),
                root
            ));
            assert!(!reference_under(Path::new("/work/tree-other/file"), root));
        }

        #[test]
        fn grace_requires_matching_proof_and_full_day() {
            assert!(!observation_matches(
                "100\nproof",
                "proof",
                100 + GRACE_SECONDS - 1
            ));
            assert!(observation_matches(
                "100\nproof",
                "proof",
                100 + GRACE_SECONDS
            ));
            assert!(!observation_matches(
                "100\nold",
                "proof",
                100 + GRACE_SECONDS
            ));
            assert!(!observation_matches("100\nproof", "proof", 99));
            assert!(!observation_matches(
                "protected",
                "proof",
                100 + GRACE_SECONDS
            ));
            assert!(!observation_matches(
                "bad\nproof",
                "proof",
                100 + GRACE_SECONDS
            ));
        }
    }
}

#[cfg(all(target_os = "linux", not(pnpm_gc_unsupported_test)))]
fn main() -> std::process::ExitCode {
    linux::main()
}

#[cfg(any(not(target_os = "linux"), pnpm_gc_unsupported_test))]
fn main() -> std::process::ExitCode {
    eprintln!("pnpm-store-gc: unsupported platform (Linux only; Darwin census not implemented)");
    std::process::ExitCode::FAILURE
}
