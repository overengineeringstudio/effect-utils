//! Opt-in retirement of historical worktree-owned pnpm stores, not host CAS GC.
#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::env;
use std::fs;
use std::io;
use std::hash::{DefaultHasher, Hash, Hasher};
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
    locked: bool,
}

fn options() -> Result<Options> {
    let mut args = env::args().skip(1);
    let mut git_dir = None;
    let mut roots = Vec::new();
    let mut mode = Mode::DryRun;
    let mut locked = false;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--git-dir" => git_dir = Some(PathBuf::from(args.next().ok_or("--git-dir needs a path")?)),
            "--root" => roots.push(PathBuf::from(args.next().ok_or("--root needs a path")?)),
            "--observe" | "--apply" if mode == Mode::DryRun => {
                mode = if arg == "--apply" { Mode::Apply } else { Mode::Observe };
            }
            "--locked" => locked = true,
            "--help" => {
                println!("usage: pnpm-store-gc --git-dir REPO/.bare --root WORKTREE [--root WORKTREE ...] [--observe | --apply]\nDefault: read-only dry-run. --observe records eligibility; --apply rechecks it and requires 24 hours of unchanged eligibility. Never collects the shared host store.");
                std::process::exit(0);
            }
            _ => return Err(format!("unknown or conflicting argument: {arg}")),
        }
    }
    let git_dir = fs::canonicalize(git_dir.ok_or("--git-dir is required")?).map_err(|e| e.to_string())?;
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
    Ok(Options { git_dir, roots, mode, locked })
}

fn command(program: &str, args: &[&str]) -> Result<String> {
    let output = Command::new(program).args(args).output().map_err(|e| format!("{program}: {e}"))?;
    if !output.status.success() {
        return Err(format!("{program} failed: {}", String::from_utf8_lossy(&output.stderr).trim()));
    }
    String::from_utf8(output.stdout).map_err(|e| e.to_string())
}

fn text(path: &Path) -> Result<&str> {
    path.to_str().ok_or_else(|| format!("non-UTF8 path: {}", path.display()))
}

fn terminal_root_proof(git_dir: &Path, root: &Path) -> Result<String> {
    let listing = command("git", &["--git-dir", text(git_dir)?, "worktree", "list", "--porcelain"])?;
    let mut registered_branch = None;
    let mut registered = false;
    for record in listing.split("\n\n") {
        let mut lines = record.lines();
        let Some(path) = lines.next().and_then(|line| line.strip_prefix("worktree ")) else { continue };
        if Path::new(path) != root && fs::canonicalize(path).ok().as_deref() != Some(root) {
            continue;
        }
        registered = true;
        if record.lines().any(|line| line.starts_with("locked")) {
            return Err("git worktree is explicitly locked/pinned".into());
        }
        registered_branch = lines.find_map(|line| line.strip_prefix("branch refs/heads/")).map(str::to_owned);
    }
    let git_marker_absent = match fs::symlink_metadata(root.join(".git")) {
        Ok(_) => false,
        Err(error) if error.kind() == io::ErrorKind::NotFound => true,
        Err(error) => return Err(error.to_string()),
    };
    if !registered && git_marker_absent {
        return Ok("worktree-gone".into());
    }
    let branch = registered_branch.ok_or("worktree is detached or not registered in the supplied repository")?;
    let remote = command("git", &["--git-dir", text(git_dir)?, "remote", "get-url", "origin"])?;
    let remote = remote.trim().trim_end_matches(".git");
    let repo = remote.strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .ok_or("origin is not an unambiguous GitHub repository")?;
    if repo.split('/').count() != 2 || repo.contains(char::is_whitespace) {
        return Err("invalid GitHub origin".into());
    }
    let states = command("gh", &["pr", "list", "--repo", repo, "--head", &branch, "--state", "all", "--limit", "100", "--json", "state,number,isCrossRepository", "--jq", "if length == 100 then \"protected\" else map(select(.isCrossRepository == false)) | if length == 0 or any(.[]; .state == \"OPEN\") then \"protected\" else map((.number|tostring) + \"=\" + .state) | sort | join(\",\") end end"])?;
    let states = states.trim();
    if states.is_empty() || states == "protected" {
        return Err("branch has an open PR, no PR, or an incomplete PR inventory".into());
    }
    if !states.split(',').all(|state| state.ends_with("=MERGED") || state.ends_with("=CLOSED")) {
        return Err("unrecognized PR state".into());
    }
    let head = command("git", &["--git-dir", text(git_dir)?, "rev-parse", &format!("refs/heads/{branch}")])?;
    Ok(format!("{repo}:{branch}:{}:{states}", head.trim()))
}

fn reference_under(target: &Path, root: &Path) -> bool {
    // Linux exposes unlinked open files with this suffix; they still protect the root.
    let target = target.to_string_lossy();
    let target = target.strip_suffix(" (deleted)").unwrap_or(&target);
    Path::new(target).starts_with(root)
}

fn process_proof(proc_root: &Path, root: &Path) -> Result<()> {
    let entries = fs::read_dir(proc_root).map_err(|e| format!("cannot inventory processes: {e}"))?;
    for entry in entries {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_name().to_string_lossy().chars().all(|c| c.is_ascii_digit()) { continue; }
        let pid_dir = entry.path();
        let cwd = pid_dir.join("cwd");
        let fd_dir = pid_dir.join("fd");
        let mut paths = vec![cwd];
        match fs::read_dir(&fd_dir) {
            Ok(fds) => {
                for fd in fds { paths.push(fd.map_err(|e| e.to_string())?.path()); }
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => continue,
            Err(e) => return Err(format!("process visibility incomplete at {}: {e}", fd_dir.display())),
        }
        for path in paths {
            match fs::read_link(&path) {
                Ok(target) => {
                    // The collector/its flock parent may hold precisely this lease,
                    // never a dependency payload. It is retained during retirement.
                    if target == root.join(".devenv").join(STORE_NAME).join(LEASE_NAME) { continue; }
                    if reference_under(&target, root) {
                        return Err(format!("live process reference: {} -> {}", path.display(), target.display()));
                    }
                }
                Err(e) if e.kind() == io::ErrorKind::NotFound => {}
                Err(e) => return Err(format!("process visibility incomplete at {}: {e}", path.display())),
            }
        }
    }
    Ok(())
}

fn liveness(root: &Path) -> Result<()> {
    if Path::new("/proc/self/fd").is_dir() {
        return process_proof(Path::new("/proc"), root);
    }
    if env::consts::OS != "macos" {
        return Err("no supported process census (Linux /proc or Darwin lsof)".into());
    }
    let output = Command::new("lsof").args(["-nP", "-Fpn"]).output().map_err(|e| e.to_string())?;
    // Warnings mean visibility is incomplete, not proof of an idle root.
    if !output.status.success() || !output.stderr.is_empty() {
        return Err(format!("lsof process visibility incomplete: {}", String::from_utf8_lossy(&output.stderr)));
    }
    let mut observed_pids = std::collections::BTreeSet::new();
    for line in String::from_utf8_lossy(&output.stdout).lines() {
        if let Some(pid) = line.strip_prefix('p').and_then(|pid| pid.parse::<u32>().ok()) {
            observed_pids.insert(pid);
        }
        if let Some(name) = line.strip_prefix('n') {
            if Path::new(name) == root.join(".devenv").join(STORE_NAME).join(LEASE_NAME) { continue; }
            if reference_under(Path::new(name), root) {
                return Err(format!("live lsof reference: {name}"));
            }
        }
    }
    // lsof can silently omit other users' processes. Compare the PID census
    // rather than interpreting that omission as evidence of an idle root.
    for pid in command("ps", &["-axo", "pid="])?.split_whitespace() {
        let number = pid.parse::<u32>().map_err(|e| e.to_string())?;
        if number == 0 || observed_pids.contains(&number) { continue; }
        let still_live = Command::new("ps").args(["-p", pid, "-o", "pid="]).output().map_err(|e| e.to_string())?;
        if !still_live.stdout.is_empty() || !still_live.stderr.is_empty() {
            return Err(format!("lsof process visibility incomplete for PID {pid}"));
        }
        if still_live.status.code() != Some(1) {
            return Err(format!("cannot prove missing PID {pid} exited"));
        }
    }
    Ok(())
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

fn footprint(store: &Path) -> Result<Footprint> {
    let metadata = fs::symlink_metadata(store).map_err(|e| e.to_string())?;
    if !metadata.is_dir() || fs::symlink_metadata(store.parent().ok_or("missing parent")?).map_err(|e| e.to_string())?.file_type().is_symlink() {
        return Err("store and .devenv must be real directories, not bridges".into());
    }
    let mut inodes: BTreeMap<(u64, u64), InodeFootprint> = BTreeMap::new();
    let mut stack = vec![store.to_path_buf()];
    while let Some(path) = stack.pop() {
        let stat = fs::symlink_metadata(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        if stat.file_type().is_symlink() { return Err(format!("store contains a bridge: {}", path.display())); }
        if stat.dev() != metadata.dev() { return Err("store contains a filesystem mount boundary".into()); }
        let inode = inodes.entry((stat.dev(), stat.ino())).or_insert(InodeFootprint {
            allocated: if path == store { 0 } else { stat.blocks() * 512 },
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
                if entry.path() == store.join(LEASE_NAME) { continue; }
                stack.push(entry.path());
            }
        } else if !stat.is_file() {
            return Err(format!("store contains a non-file payload: {}", path.display()));
        }
    }
    let allocated = inodes.values().map(|inode| inode.allocated).sum();
    let reclaimable = inodes.values().filter(|inode| inode.directory || inode.links <= inode.references).map(|inode| inode.allocated).sum();
    let mut signature = DefaultHasher::new();
    for inode in &inodes { inode.hash(&mut signature); }
    Ok(Footprint {
        fingerprint: format!("{}:{}:{:x}", metadata.dev(), metadata.ino(), signature.finish()),
        allocated,
        reclaimable,
    })
}

fn observation_matches(record: &str, proof: &str, now: u64) -> bool {
    let Some((timestamp, recorded_proof)) = record.split_once('\n') else { return false };
    timestamp.parse::<u64>().is_ok_and(|start| now.checked_sub(start).is_some_and(|age| age >= GRACE_SECONDS)) && recorded_proof == proof
}

fn verify_inherited_lease(store: &Path) -> Result<()> {
    let inherited = fs::metadata("/dev/fd/203").map_err(|e| format!("missing inherited maintenance lease: {e}"))?;
    let selected = fs::metadata(store.join(LEASE_NAME)).map_err(|e| e.to_string())?;
    if (inherited.dev(), inherited.ino()) != (selected.dev(), selected.ino()) {
        return Err("inherited maintenance lease does not own the selected store".into());
    }
    // Re-lock the inherited open-file description, not a newly opened inode.
    // This succeeds for our lease and cannot bypass another consumer's lease.
    command("flock", &["--exclusive", "--nonblock", "203"])?;
    Ok(())
}

fn collect(options: &Options, root: &Path) -> Result<u64> {
    let store = root.join(".devenv").join(STORE_NAME);
    if !store.try_exists().map_err(|e| e.to_string())? {
        println!("absent\t0\t{}", store.display());
        return Ok(0);
    }
    // Refuse bridges before even creating a maintenance lease inside a store.
    if !fs::symlink_metadata(&store).map_err(|e| e.to_string())?.is_dir()
        || fs::symlink_metadata(root.join(".devenv")).map_err(|e| e.to_string())?.file_type().is_symlink()
        || fs::symlink_metadata(store.join(LEASE_NAME)).is_ok_and(|stat| !stat.is_file())
    {
        return Err("store, .devenv, and lease must not be bridges".into());
    }
    if options.mode != Mode::DryRun && !options.locked {
        let status = Command::new("bash")
            .args(["-c", r#"exec 203>>"$1"; flock --exclusive --nonblock 203 || exit 1; exec "$2" --locked --git-dir "$3" --root "$4" "$5""#, "pnpm-store-gc-lease"])
            .arg(store.join(LEASE_NAME))
            .arg(env::current_exe().map_err(|e| e.to_string())?)
            .arg(&options.git_dir).arg(root)
            .arg(if options.mode == Mode::Apply { "--apply" } else { "--observe" })
            .status().map_err(|e| e.to_string())?;
        if !status.success() { return Err("collection refused or Store Cache maintenance lease busy".into()); }
        return Ok(0);
    }
    if options.locked { verify_inherited_lease(&store)?; }
    let state_base = env::var_os("XDG_STATE_HOME").map(PathBuf::from)
        .or_else(|| env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/state")))
        .ok_or("HOME or XDG_STATE_HOME is required")?.join("effect-utils/pnpm-store-gc");
    let stat = fs::symlink_metadata(&store).map_err(|e| e.to_string())?;
    let state = state_base.join(format!("{}-{}.observation", stat.dev(), stat.ino()));
    let proof = (|| {
        let terminal = terminal_root_proof(&options.git_dir, root)?;
        liveness(root)?;
        let footprint = footprint(&store)?;
        Ok::<_, String>((format!("{}\n{terminal}\n{}", root.display(), footprint.fingerprint), footprint))
    })();
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
    let now = SystemTime::now().duration_since(UNIX_EPOCH).map_err(|e| e.to_string())?.as_secs();
    let previous = match fs::read_to_string(&state) {
        Ok(record) => record,
        Err(e) if e.kind() == io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("cannot read observation: {e}")),
    };
    if !observation_matches(&previous, &proof, now) {
        if options.mode != Mode::DryRun {
            fs::create_dir_all(&state_base).map_err(|e| e.to_string())?;
            // Preserve the first observation while grace is still running.
            if previous.split_once('\n').is_none_or(|(_, recorded)| recorded != proof) {
                fs::write(&state, format!("{now}\n{proof}")).map_err(|e| e.to_string())?;
            }
        }
        println!("grace\t{}\t{}\tallocated={} needs unchanged --observe proof for 24h", footprint.reclaimable, store.display(), footprint.allocated);
        return Ok(0);
    }
    if options.mode == Mode::Apply {
        // Hold the same exclusive lease used by managed pnpm maintenance, then
        // repeat both proofs immediately before unlinking. The lock inode/root
        // stay in place so late cooperating installs cannot acquire a new inode.
        let recheck = (|| {
            let terminal = terminal_root_proof(&options.git_dir, root)?;
            liveness(root)?;
            let current = self::footprint(&store)?;
            if format!("{}\n{terminal}\n{}", root.display(), current.fingerprint) != proof {
                return Err("eligibility changed before retirement".into());
            }
            Ok::<_, String>(())
        })();
        if let Err(error) = recheck {
            fs::write(&state, "protected").map_err(|e| e.to_string())?;
            return Err(error);
        }
        for entry in fs::read_dir(&store).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_name() == LEASE_NAME { continue; }
            if entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                fs::remove_dir_all(entry.path()).map_err(|e| e.to_string())?;
            } else {
                fs::remove_file(entry.path()).map_err(|e| e.to_string())?;
            }
        }
        fs::write(&state, "retired").map_err(|e| e.to_string())?;
    }
    println!("{}\t{}\t{}\tallocated={}", if options.mode == Mode::Apply { "retired" } else { "would-free" }, footprint.reclaimable, store.display(), footprint.allocated);
    Ok(footprint.reclaimable)
}

fn run() -> Result<()> {
    let options = options()?;
    let mut total = 0;
    for root in &options.roots { total += collect(&options, root)?; }
    if options.mode == Mode::DryRun { println!("would-free-total\t{total}"); }
    Ok(())
}

fn main() -> ExitCode {
    match run() {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => { eprintln!("pnpm-store-gc: {error}"); ExitCode::FAILURE }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(label: &str) -> PathBuf {
        let parent = env::var_os("PNPM_GC_TEST_ROOT").expect("PNPM_GC_TEST_ROOT must name a disposable fixture directory");
        let root = PathBuf::from(parent).join(format!("{label}-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        root
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
        assert!(process_proof(&census, &worktree).unwrap_err().contains("/fd/"));
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
        symlink(&worktree, proc_root.join("123/cwd")).unwrap();
        assert!(process_proof(&proc_root, &worktree).unwrap_err().contains("live process"));
        let sibling = root.join("sibling");
        // Another process holds an fd, while its cwd is outside the root.
        fs::create_dir_all(proc_root.join("456/fd")).unwrap();
        symlink(&sibling, proc_root.join("456/cwd")).unwrap();
        symlink(worktree.join("dependency"), proc_root.join("456/fd/4")).unwrap();
        assert!(process_proof(&proc_root, &sibling).is_err());
        let only_fd = root.join("fd-only");
        fs::create_dir_all(only_fd.join("789/fd")).unwrap();
        symlink(&sibling, only_fd.join("789/cwd")).unwrap();
        symlink(worktree.join("dependency"), only_fd.join("789/fd/4")).unwrap();
        assert!(process_proof(&only_fd, &worktree).unwrap_err().contains("/fd/4"));
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
        assert_eq!(before.reclaimable - after.reclaimable, fs::metadata(&content).unwrap().blocks() * 512);
        assert_ne!(before.fingerprint, after.fingerprint);
        symlink(root.join("shared-store"), store.join("bridge")).unwrap();
        assert!(footprint(&store).unwrap_err().contains("bridge"));
    }

    #[test]
    fn terminal_proof_admits_only_gone_unregistered_roots() {
        let root = fixture("git");
        let repo = root.join("repo.git");
        let orphan = root.join("orphan");
        fs::create_dir_all(&orphan).unwrap();
        command("git", &["init", "--bare", text(&repo).unwrap()]).unwrap();
        assert_eq!(terminal_root_proof(&repo, &orphan).unwrap(), "worktree-gone");
        fs::write(orphan.join(".git"), "gitdir: /unavailable").unwrap();
        assert!(terminal_root_proof(&repo, &orphan).is_err());
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
        let options = Options { git_dir: repo, roots: vec![orphan.clone()], mode: Mode::DryRun, locked: false };
        // A fresh candidate is either census-protected or awaiting observation.
        assert_eq!(collect(&options, &orphan).unwrap(), 0);
        assert_eq!(footprint(&store).unwrap(), before);
        assert!(!store.join(LEASE_NAME).exists());
        assert_eq!(fs::read_to_string(store.join("v11/files/sentinel")).unwrap(), "preserve");
    }


    #[test]
    fn component_aware_process_references_include_deleted_files() {
        let root = Path::new("/work/tree");
        assert!(reference_under(Path::new("/work/tree/file"), root));
        assert!(reference_under(Path::new("/work/tree/file (deleted)"), root));
        assert!(!reference_under(Path::new("/work/tree-other/file"), root));
    }

    #[test]
    fn grace_requires_matching_proof_and_full_day() {
        assert!(!observation_matches("100\nproof", "proof", 100 + GRACE_SECONDS - 1));
        assert!(observation_matches("100\nproof", "proof", 100 + GRACE_SECONDS));
        assert!(!observation_matches("100\nold", "proof", 100 + GRACE_SECONDS));
        assert!(!observation_matches("100\nproof", "proof", 99));
        assert!(!observation_matches("protected", "proof", 100 + GRACE_SECONDS));
        assert!(!observation_matches("bad\nproof", "proof", 100 + GRACE_SECONDS));
    }
}
