//! Read-only proof for one fixed, downstream-declared managed runtime.
use std::collections::{BTreeMap, BTreeSet};
use std::ffi::CString;
use std::fs::File;
use std::io;
use std::os::fd::{AsRawFd, OwnedFd};
use std::os::unix::fs::MetadataExt;
use std::path::{Path, Component};
use std::time::Instant;
use super::{client, daemon, decode, host_ipc, linux, mounts, objects};

// Nix supplies fixed policy only. Identifiers are validated before jq or HTTP
// use; bind tuples are JSON [type, source, destination, writable].
const CONTAINER: &str = concat!(
    "if .Name != \"/", env!("HOLDER_EVIDENCE_MANAGED_CONTAINER"),
    "\" or .Config.Image != \"", env!("HOLDER_EVIDENCE_MANAGED_IMAGE"), r#"" or
.State.Running != true or .State.Paused != false or .State.Restarting != false or
.HostConfig.Privileged != false or .HostConfig.PidMode != "" or .HostConfig.IpcMode != "private" or
.HostConfig.NetworkMode != "bridge" or .HostConfig.CapAdd != null or .HostConfig.CapDrop != null or
.HostConfig.SecurityOpt != null or .HostConfig.Devices != [] or .HostConfig.VolumesFrom != null or
.HostConfig.UsernsMode != "" or .HostConfig.CgroupnsMode != "private" or
.GraphDriver.Name != "overlay2" or
([.Mounts[]|[.Type,.Source,.Destination,.RW]]|sort) != ("#,
    env!("HOLDER_EVIDENCE_MANAGED_BINDS_JSON"), r#"|sort)
then error("unsupported runtime") else
[.Id,.Image,(.State.Pid|tostring),.State.StartedAt,.GraphDriver.Data.LowerDir,
.GraphDriver.Data.UpperDir,.GraphDriver.Data.WorkDir,.GraphDriver.Data.MergedDir,
.HostnamePath,.HostsPath,.ResolvConfPath]|@tsv end"#);
const IMAGE: &str = r#"if (.Id|type) != "string" then error("missing image identity") else [.Id]|@tsv end"#;
fn unknown(message: &'static str) -> io::Error { io::Error::other(message) }
fn due(deadline: Instant) -> io::Result<()> {
    if Instant::now() >= deadline { Err(unknown("runtime deadline")) } else { Ok(()) }
}
fn digest(value: &str) -> bool { value.len() == 64 && value.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()) }
fn decoded(filter: &'static str, input: Vec<u8>, deadline: Instant) -> io::Result<Vec<String>> {
    let bytes = decode::decode(env!("HOLDER_EVIDENCE_JQ"), filter, input, deadline)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| unknown("non-text runtime metadata"))?;
    let line = text.strip_suffix('\n').filter(|s| !s.contains('\n')).ok_or_else(|| unknown("ambiguous runtime record"))?;
    decode::fields(line)
}
fn rooted(root: &File, path: &Path) -> io::Result<File> {
    if !path.is_absolute() || path.components().any(|c| matches!(c, Component::ParentDir)) { return Err(unknown("unconfined runtime path")); }
    let name = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| unknown("NUL runtime path"))?;
    linux::open_path(root.as_raw_fd(), &name, 0, linux::RESOLVE_IN_ROOT | linux::RESOLVE_NO_MAGICLINKS).map(File::from)
}
fn options(value: &str) -> io::Result<BTreeMap<&str, &str>> {
    let mut result = BTreeMap::new();
    for item in value.split(',') {
        let (key, value) = item.split_once('=').unwrap_or((item, ""));
        if result.insert(key, value).is_some() { return Err(unknown("duplicate mount option")); }
    }
    Ok(result)
}
struct HeldPath { path: String, file: File }
impl HeldPath {
    fn pin(path: String, candidates: &BTreeSet<u64>) -> io::Result<Self> {
        let file = objects::pin_magic(&path)?;
        if !objects::native_filesystem(&file)? || candidates.contains(&file.metadata()?.dev()) { return Err(unknown("candidate or foreign runtime backing")); }
        Ok(Self { path, file })
    }
    fn recheck(&self) -> io::Result<()> {
        let actual = objects::pin_magic(&self.path)?;
        if objects::identity(&actual)? != objects::identity(&self.file)? || objects::mount_id(&actual)? != objects::mount_id(&self.file)? {
            return Err(unknown("runtime backing changed"));
        }
        Ok(())
    }
}
pub struct Runtime {
    candidates: BTreeSet<u64>,
    activation: daemon::Activation,
    responses: std::cell::RefCell<Vec<daemon::Response>>,
    metadata: Vec<String>,
    init: client::Process,
    _pidfd: OwnedFd,
    root: File,
    namespaces: Vec<File>,
    snapshot: String,
    host_snapshot: String,
    unit_snapshot: Vec<u8>,
    backings: Vec<HeldPath>,
    mount_objects: Vec<(u64, File)>,
    ipc: host_ipc::Proof,
    receipt: Vec<u8>,
}
impl Runtime {
    pub fn attest(candidate_devices: &BTreeSet<u64>, deadline: Instant) -> io::Result<Self> {
        managed_enabled()?;
        daemon::validate_policy()?;
        due(deadline)?;
        let activation = daemon::Activation::attest(deadline)?;
        let mut container = daemon::get(&activation, daemon::Resource::Container, deadline)?;
        let mut image = daemon::get(&activation, daemon::Resource::Image, deadline)?;
        let metadata = decoded(CONTAINER, std::mem::take(&mut container.body), deadline)?;
        let image_id = decoded(IMAGE, std::mem::take(&mut image.body), deadline)?;
        if metadata.len() != 11 || image_id.len() != 1 || !digest(&metadata[0])
            || metadata[1].strip_prefix("sha256:").is_none_or(|s| !digest(s)) || image_id[0] != metadata[1] {
            return Err(unknown("runtime image/content identity mismatch"));
        }
        let pid = metadata[2].parse::<u32>().ok().filter(|p| *p > 1).ok_or_else(|| unknown("invalid runtime init"))?;
        let init = client::process(pid)?;
        let pidfd = linux::pin_process(pid)?;
        let root = objects::pin_magic(format!("/proc/{pid}/root"))?;
        if linux::filesystem_type(&root)? != 0x794c7630 || candidate_devices.contains(&root.metadata()?.dev()) { return Err(unknown("unadmitted actual runtime root")); }
        let mut namespaces = Vec::new();
        for name in ["user", "pid", "mnt", "net", "ipc", "cgroup"] {
            let actual = objects::pin_magic(format!("/proc/{pid}/ns/{name}"))?;
            let host = objects::pin_magic(format!("/proc/1/ns/{name}"))?;
            if (objects::identity(&actual)? == objects::identity(&host)?) != (name == "user") { return Err(unknown("runtime namespace isolation mismatch")); }
            namespaces.push(actual);
        }
        let snapshot = objects::bounded_text(format!("/proc/{pid}/mountinfo"), 1048576)?;
        let graph = mounts::parse(&snapshot).map_err(unknown)?;
        let root_id = objects::mount_id(&root)?;
        let root_mount = graph.get(&root_id).ok_or_else(|| unknown("runtime root mount absent"))?;
        if root_mount.point != Path::new("/") || root_mount.root != Path::new("/") || root_mount.kind != "overlay" { return Err(unknown("actual overlay root mismatch")); }
        let docker = objects::pin_magic("/var/lib/docker/overlay2")?;
        if !objects::native_filesystem(&docker)? || docker.metadata()?.uid() != 0 || docker.metadata()?.mode() & 0o022 != 0 { return Err(unknown("unsafe Docker backing root")); }
        let overlay = options(&root_mount.super_options)?;
        if overlay.keys().any(|key| !["rw","lowerdir","upperdir","workdir"].contains(key)) {
            return Err(unknown("unsupported overlay semantics"));
        }
        let mut backings = Vec::new();
        for (key, index) in [("lowerdir", 4), ("upperdir", 5), ("workdir", 6)] {
            let raw = overlay.get(key).ok_or_else(|| unknown("missing actual overlay edge"))?;
            let actual: Vec<_> = raw.split(':').collect();
            let declared: Vec<_> = metadata[index].split(':').collect();
            if actual.len() != declared.len() || actual.is_empty() || actual.len() > 128 { return Err(unknown("overlay edge cardinality mismatch")); }
            for (actual, declared) in actual.into_iter().zip(declared) {
                due(deadline)?;
                // Both edges resolve only inside the held trusted Docker root.
                // Short l/ links are allowed, but neither '..' escape nor a
                // proc magic-link can grant arbitrary host path authority.
                let a = overlay_edge(&docker, actual)?;
                let d = overlay_edge(&docker, declared)?;
                if objects::identity(&a)? != objects::identity(&d)? || objects::mount_id(&a)? != objects::mount_id(&d)? { return Err(unknown("actual/declared overlay backing differs")); }
                let backing = HeldPath::pin(declared.to_owned(), candidate_devices)?;
                if objects::identity(&backing.file)? != objects::identity(&d)? || objects::mount_id(&backing.file)? != objects::mount_id(&d)? {
                    return Err(unknown("overlay backing changed while pinning"));
                }
                backings.push(backing);
            }
        }
        let merged_relative = metadata[7].strip_prefix("/var/lib/docker/overlay2/").ok_or_else(|| unknown("merged path outside Docker root"))?;
        let merged_name = CString::new(merged_relative).map_err(|_| unknown("NUL merged path"))?;
        let merged = File::from(linux::open_path(docker.as_raw_fd(), &merged_name, 0, linux::RESOLVE_BENEATH | linux::RESOLVE_NO_MAGICLINKS)?);
        if objects::identity(&merged)? != objects::identity(&root)? { return Err(unknown("daemon merged root differs from actual root")); }
        let declared_binds = declared_binds(deadline)?;
        let mut binds: BTreeMap<String, String> = declared_binds.iter()
            .map(|(point, (source, _))| (point.clone(), source.clone())).collect();
        for (point, index, basename) in [("/etc/hostname",8,"hostname"),("/etc/hosts",9,"hosts"),("/etc/resolv.conf",10,"resolv.conf")] {
            let expected = format!("/var/lib/docker/containers/{}/{basename}", metadata[0]);
            if metadata[index] != expected { return Err(unknown("unconfined generated Docker source")); }
            binds.insert(point.to_owned(), expected);
        }
        let host_snapshot = objects::bounded_text("/proc/1/mountinfo",1048576)?;
        let host_graph = mounts::parse(&host_snapshot).map_err(unknown)?;
        // procfs is tied to a PID namespace at mount time, not to the
        // namespace of the task reading it. Authenticate its actual PID 1.
        let proc_init_namespace = objects::pin_magic(format!("/proc/self/fd/{}/proc/1/ns/pid", root.as_raw_fd()))?;
        if objects::identity(&proc_init_namespace)? != objects::identity(&namespaces[1])? {
            return Err(unknown("runtime procfs belongs to a foreign PID namespace"));
        }
        for mount in graph.values().filter(|m| matches!(m.kind.as_str(),"proc"|"tmpfs"|"devpts"|"mqueue")) {
            let shared: Vec<_> = host_graph.values().filter(|h| (h.device_major,h.device_minor) == (mount.device_major,mount.device_minor)).collect();
            if !shared.is_empty() {
                let source = format!("/var/lib/docker/containers/{}/mounts/shm", metadata[0]);
                if mount.point != Path::new("/dev/shm") || shared.len() != 1 || shared[0].point != Path::new(&source) || shared[0].kind != "tmpfs" {
                    return Err(unknown("runtime private pseudo filesystem shares an undeclared host superblock"));
                }
                let backing = HeldPath::pin(source,candidate_devices)?;
                let actual = rooted(&root,Path::new("/dev/shm"))?;
                if objects::identity(&backing.file)? != objects::identity(&actual)? {
                    return Err(unknown("Docker private shared memory source differs"));
                }
                backings.push(backing);
            }
        }
        let mut expected_points: BTreeSet<&str> = ["/", "/proc", "/dev", "/dev/pts", "/sys", "/sys/fs/cgroup", "/dev/mqueue", "/dev/shm", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf", "/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger", "/proc/acpi", "/proc/asound", "/proc/interrupts", "/proc/kcore", "/proc/keys", "/proc/scsi", "/proc/timer_list", "/sys/devices/virtual/powercap", "/sys/firmware"].into_iter().collect();
        expected_points.extend(declared_binds.keys().map(String::as_str));
        let actual_points: BTreeSet<&str> = graph.values().map(|m| m.point.to_str().ok_or_else(|| unknown("non-text mount point"))).collect::<io::Result<_>>()?;
        if actual_points != expected_points || graph.len() != expected_points.len() { return Err(unknown("unsupported or duplicate actual mount topology")); }
        let mut mount_objects = Vec::new();
        for mount in graph.values() {
            due(deadline)?;
            if mount.id != root_id && !graph.contains_key(&mount.parent) { return Err(unknown("detached runtime mount")); }
            let point = mount.point.to_str().ok_or_else(|| unknown("non-text mount point"))?;
            let object = rooted(&root, &mount.point)?;
            if objects::mount_id(&object)? != mount.id || candidate_devices.contains(&object.metadata()?.dev()) { return Err(unknown("actual mount object mismatch")); }
            if let Some(source) = binds.get(point) {
                let backing = HeldPath::pin(source.clone(), candidate_devices)?;
                if objects::identity(&object)? != objects::identity(&backing.file)? { return Err(unknown("bind source actual inode mismatch")); }
                if host_graph.values().any(|m| m.point != Path::new(source) && m.point.starts_with(source)) { return Err(unknown("source bind contains host submount")); }
                if let Some((_, writable)) = declared_binds.get(point) {
                    let read_only = options(&mount.options)?.contains_key("ro");
                    if read_only == *writable { return Err(unknown("bind access policy differs")); }
                }
                backings.push(backing);
            } else if point != "/" {
                qualify_pseudo(mount, &object, &metadata[0], &graph, &root)?;
            }
            mount_objects.push((mount.id, object));
        }
        // A backing directory cannot hide a native candidate bridge below it.
        for backing in &backings {
            if host_graph.values().any(|m| m.point != Path::new(&backing.path) && m.point.starts_with(&backing.path)) { return Err(unknown("overlay backing contains host submount")); }
        }
        let ipc = host_ipc::Proof::attest(deadline)?;
        let unit_snapshot = runtime_unit(deadline)?;
        let receipt = format!("runtime=managed\ncontainer={}\nimage={}\ninit={}:{}\nmounts={}\n", metadata[0],metadata[1],pid,init.start,graph.len()).into_bytes();
        let proof = Self { candidates: candidate_devices.clone(), activation, responses: std::cell::RefCell::new(vec![container,image]), metadata, init, _pidfd: pidfd, root, namespaces, snapshot, host_snapshot, unit_snapshot, backings, mount_objects, ipc, receipt };
        proof.recheck(deadline)?;
        Ok(proof)
    }
    fn cgroup_scope(&self, prefix: &str) -> io::Result<bool> {
        let text = objects::bounded_text(format!("{prefix}/cgroup"), 65536)?;
        let path = text.trim().strip_prefix("0::/").filter(|path| !path.contains('\n'))
            .ok_or_else(|| unknown("unsupported task cgroup hierarchy"))?;
        let scope = format!("system.slice/docker-{}.scope", self.metadata[0]);
        Ok(path == scope || path.strip_prefix(&scope).is_some_and(|suffix| suffix.starts_with('/')))
    }
    /// Discover runtime scope for every UID. A live PID namespace participant
    /// outside the Docker cgroup is an unqualified capability route, not an
    /// unrelated task. Namespace ancestry uses actual NSFS descriptors.
    pub fn scoped_task(&self, pid: u32, tid: u32, terminal: bool, deadline: Instant) -> io::Result<bool> {
        due(deadline)?;
        let prefix = format!("/proc/{pid}/task/{tid}");
        if self.cgroup_scope(&prefix)? { return Ok(true); }
        // Only this exact task's captured Z/X state permits missing namespace
        // metadata. A zombie leader never exempts its still-live siblings.
        if terminal { return Ok(false); }
        let expected = objects::identity(&self.namespaces[1])?;
        let mut chain = vec![File::open(format!("{prefix}/ns/pid"))?];
        let mut visited = BTreeSet::new();
        for _ in 0..64 {
            due(deadline)?;
            let namespace = chain.last().ok_or_else(|| unknown("missing PID namespace"))?;
            let identity = objects::identity(namespace)?;
            if identity == expected { return Err(unknown("runtime PID namespace participant outside Docker cgroup")); }
            if !visited.insert(identity) { return Err(unknown("cyclic PID namespace ancestry")); }
            match linux::pid_namespace_parent(namespace)? {
                Some(parent) => chain.push(parent),
                None => return Ok(false),
            }
        }
        Err(unknown("PID namespace ancestry bound"))
    }
    pub fn admits(&self, pid: u32, tid: u32, root: &File, deadline: Instant) -> io::Result<()> {
        due(deadline)?;
        if objects::identity(root)? != objects::identity(&self.root)? || objects::mount_id(root)? != objects::mount_id(&self.root)? { return Err(unknown("foreign process root")); }
        let prefix = format!("/proc/{pid}/task/{tid}");
        for (name, held) in ["user","pid","mnt","net","ipc","cgroup"].iter().zip(&self.namespaces) {
            if objects::identity(&objects::pin_magic(format!("{prefix}/ns/{name}"))?)? != objects::identity(held)? { return Err(unknown("foreign process namespace")); }
        }
        if !self.cgroup_scope(&prefix)?
            || objects::bounded_text(format!("{prefix}/mountinfo"),1048576)? != self.snapshot { return Err(unknown("process runtime membership changed")); }
        Ok(())
    }
    pub fn recheck(&self, deadline: Instant) -> io::Result<()> {
        due(deadline)?;
        if !client::process(self.init.pid)?.same_identity(&self.init)
            || objects::identity(&objects::pin_magic(format!("/proc/{}/root",self.init.pid))?)? != objects::identity(&self.root)?
            || objects::bounded_text(format!("/proc/{}/mountinfo",self.init.pid),1048576)? != self.snapshot
            || objects::bounded_text("/proc/1/mountinfo",1048576)? != self.host_snapshot { return Err(unknown("runtime generation or graph changed")); }
        self.admits(self.init.pid,self.init.pid,&self.root,deadline)?;
        for backing in &self.backings { due(deadline)?; backing.recheck()?; }
        for (id, object) in &self.mount_objects {
            if objects::mount_id(object)? != *id || self.candidates.contains(&object.metadata()?.dev()) { return Err(unknown("held mount changed")); }
        }
        for response in self.responses.borrow().iter() { response.recheck(&self.activation,deadline)?; }
        if runtime_unit(deadline)? != self.unit_snapshot { return Err(unknown("managed unit generation changed")); }
        if self.responses.borrow().len() >= 16 { return Err(unknown("runtime response retention bound")); }
        let mut current = daemon::get(&self.activation,daemon::Resource::Container,deadline)?;
        let mut image = daemon::get(&self.activation,daemon::Resource::Image,deadline)?;
        let metadata = decoded(CONTAINER, std::mem::take(&mut current.body), deadline)?;
        let image_metadata = decoded(IMAGE, std::mem::take(&mut image.body), deadline)?;
        if metadata != self.metadata || image_metadata.len() != 1 || image_metadata[0] != self.metadata[1] { return Err(unknown("Docker runtime/image generation changed")); }
        self.ipc.recheck(deadline)?;
        current.recheck(&self.activation,deadline)?;
        image.recheck(&self.activation,deadline)?;
        self.responses.borrow_mut().extend([current, image]);
        Ok(())
    }
    pub fn receipt(&self) -> &[u8] { &self.receipt }
}
fn overlay_edge(docker: &File, path: &str) -> io::Result<File> {
    let relative = path.strip_prefix("/var/lib/docker/overlay2/").filter(|s| !s.is_empty()).ok_or_else(|| unknown("overlay edge outside fixed Docker root"))?;
    let name = CString::new(relative).map_err(|_| unknown("NUL overlay edge"))?;
    let file = File::from(linux::open_path(docker.as_raw_fd(),&name,0,linux::RESOLVE_BENEATH | linux::RESOLVE_NO_MAGICLINKS)?);
    if !file.metadata()?.is_dir() || !objects::native_filesystem(&file)? { return Err(unknown("foreign overlay backing edge")); }
    Ok(file)
}
fn qualify_pseudo(mount: &mounts::Mount, object: &File, container: &str, graph: &BTreeMap<u64,mounts::Mount>, root: &File) -> io::Result<()> {
    let point = mount.point.to_str().ok_or_else(|| unknown("non-text pseudo point"))?;
    let (kind, magic) = match point {
        "/proc" | "/proc/bus" | "/proc/fs" | "/proc/irq" | "/proc/sys" | "/proc/sysrq-trigger" => ("proc",0x9fa0),
        "/sys" => ("sysfs",0x62656572),
        "/sys/fs/cgroup" => ("cgroup2",0x63677270),
        "/dev/pts" => ("devpts",0x1cd1),
        "/dev/mqueue" => ("mqueue",0x19800202),
        _ => ("tmpfs",0x01021994),
    };
    if mount.kind != kind || linux::filesystem_type(object)? != magic || !mount.optional.is_empty() { return Err(unknown("unsupported pseudo mount provenance")); }
    if point == "/sys/fs/cgroup" && mount.root != Path::new(&format!("/system.slice/docker-{container}.scope")) { return Err(unknown("foreign cgroup mount root")); }
    if ["/proc/interrupts","/proc/kcore","/proc/keys","/proc/timer_list"].contains(&point) {
        let null = rooted(root,Path::new("/dev/null"))?;
        if objects::identity(object)? != objects::identity(&null)? || mount.root != Path::new("/null") { return Err(unknown("masked proc device differs from private dev/null")); }
    } else if point.starts_with("/proc/") && kind == "proc" {
        let proc_mount = graph.values().find(|m| m.point == Path::new("/proc")).ok_or_else(|| unknown("missing proc parent"))?;
        if (mount.device_major,mount.device_minor) != (proc_mount.device_major,proc_mount.device_minor)
            || mount.root != Path::new(point.strip_prefix("/proc").ok_or_else(|| unknown("bad proc point"))?) { return Err(unknown("proc submount origin differs")); }
    } else if point != "/sys/fs/cgroup" && mount.root != Path::new("/") { return Err(unknown("unexpected pseudo mount root")); }
    if point.starts_with("/sys") || (point.starts_with("/proc/") && !["/proc/interrupts","/proc/kcore","/proc/keys","/proc/timer_list"].contains(&point)) {
        if !options(&mount.options)?.contains_key("ro") { return Err(unknown("unmasked writable kernel interface")); }
    }
    Ok(())
}

fn runtime_unit(deadline: Instant) -> io::Result<Vec<u8>> {
    let bytes = decode::metadata(env!("HOLDER_EVIDENCE_SYSTEMCTL"),
        &["--no-pager","show","--property","ActiveState,InvocationID,ControlGroup,ExecStart,FragmentPath","--",env!("HOLDER_EVIDENCE_MANAGED_UNIT")], deadline)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| unknown("non-text managed unit"))?;
    let mut fields = BTreeMap::new();
    for line in text.lines() {
        let (key,value) = line.split_once('=').ok_or_else(|| unknown("malformed managed unit"))?;
        if fields.insert(key,value).is_some() { return Err(unknown("duplicate managed unit field")); }
    }
    if fields.get("ActiveState") != Some(&"active")
        || fields.get("ControlGroup") != Some(&env!("HOLDER_EVIDENCE_MANAGED_CGROUP"))
        || !fields.get("InvocationID").is_some_and(|id| id.len() == 32 && id.bytes().all(|c| c.is_ascii_hexdigit()))
        || !fields.get("ExecStart").is_some_and(|v| v.contains("path=/nix/store/")) {
        return Err(unknown("unbound managed unit generation"));
    }
    let fragment = fields.get("FragmentPath").ok_or_else(|| unknown("missing managed unit fragment"))?;
    host_ipc::same_immutable_bytes(fragment, env!("HOLDER_EVIDENCE_MANAGED_UNIT_SOURCE"), deadline)?;
    host_ipc::same_immutable_bytes(env!("HOLDER_EVIDENCE_MANAGED_CURRENT_MANIFEST"),
        env!("HOLDER_EVIDENCE_MANAGED_DESIRED_MANIFEST"), deadline)?;
    Ok(bytes)
}

fn managed_enabled() -> io::Result<()> {
    match env!("HOLDER_EVIDENCE_MANAGED_ENABLED") {
        "1" => Ok(()),
        "0" => Err(io::Error::new(io::ErrorKind::Unsupported, "managed proxy policy disabled")),
        _ => Err(io::Error::new(io::ErrorKind::Unsupported, "invalid compiled managed proxy policy")),
    }
}

fn declared_binds(deadline: Instant) -> io::Result<BTreeMap<String, (String, bool)>> {
    let bytes = decode::decode(env!("HOLDER_EVIDENCE_JQ"), ".[] | @tsv",
        env!("HOLDER_EVIDENCE_MANAGED_BINDS_JSON").as_bytes().to_vec(), deadline)?;
    let text = std::str::from_utf8(&bytes).map_err(|_| unknown("non-text compiled bind policy"))?;
    let mut binds = BTreeMap::new();
    for line in text.lines() {
        let fields = decode::fields(line)?;
        if fields.len() != 4 || fields[0] != "bind"
            || !canonical_absolute(&fields[1]) || !canonical_absolute(&fields[2])
            || reserved_mount(&fields[2]) || !matches!(fields[3].as_str(), "true" | "false")
            || binds.insert(fields[2].clone(), (fields[1].clone(), fields[3] == "true")).is_some()
        { return Err(unknown("invalid compiled managed bind policy")); }
    }
    if binds.is_empty() || binds.len() > 64 { return Err(unknown("managed bind policy bound")); }
    Ok(binds)
}

fn canonical_absolute(path: &str) -> bool {
    path.starts_with('/') && path != "/" && !path.ends_with('/')
        && path.split('/').skip(1).all(|part| !part.is_empty() && part != "." && part != "..")
        && !path.bytes().any(|byte| matches!(byte, 0 | b'\r' | b'\n'))
}

fn reserved_mount(point: &str) -> bool {
    ["/proc", "/sys", "/dev"].iter().any(|prefix| point == *prefix
        || point.strip_prefix(*prefix).is_some_and(|tail| tail.starts_with('/')))
        || ["/", "/etc/hostname", "/etc/hosts", "/etc/resolv.conf"].contains(&point)
}

#[cfg(test)]
mod tests {
    use super::{canonical_absolute, reserved_mount, Runtime};
    use std::collections::BTreeSet;
    use std::io::ErrorKind;
    use std::time::Instant;

    #[test]
    fn managed_disabled_refuses_before_deadline_or_host_access() {
        if env!("HOLDER_EVIDENCE_MANAGED_ENABLED") == "0" {
            let result = Runtime::attest(&BTreeSet::new(), Instant::now());
            assert!(matches!(result, Err(error) if error.kind() == ErrorKind::Unsupported));
        }
    }

    #[test]
    fn bind_paths_cannot_hide_controlled_mounts() {
        assert!(canonical_absolute("/state/managed"));
        for value in ["/", "state", "/state/", "/state//x", "/state/../x", "/state/./x", "/state\nx"] {
            assert!(!canonical_absolute(value));
        }
        for value in ["/proc", "/proc/sys", "/sys", "/dev/shm", "/etc/hostname"] {
            assert!(reserved_mount(value));
        }
        assert!(!reserved_mount("/state/managed"));
        assert!(!reserved_mount("/device"));
    }
}
