use std::collections::BTreeMap;
use std::ffi::{c_char, c_void, CStr, CString};
use std::marker::PhantomData;
use std::os::fd::AsRawFd;
use std::panic::{catch_unwind, AssertUnwindSafe};
use std::ptr::{self, NonNull};
use std::rc::Rc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex, MutexGuard};

use block2::{Block, RcBlock, StackBlock};
use nix::fcntl::{fcntl, FcntlArg, FdFlag};
use nix::sys::socket::{socket, AddressFamily, SockFlag, SockType};
use objc2::encode::{Encode, Encoding};
use objc2::rc::autoreleasepool;
use objc2_core_foundation::{CFArray, CFString};
use objc2_core_wlan::CWWiFiClient;
use objc2_foundation::NSString;
use objc2_system_configuration::SCNetworkInterface;

use crate::{
    dbm, ethernet_rate, link_rate, medium, policy_interface, wifi_band, Medium, NetInfo, WifiLink,
};

// C typedefs use opaque pointers. Every Create/Copy result is +1 owned; Get
// results are borrowed. CF ownership is handled independently of ObjC.
type Object = *mut c_void;
type Cf = *const c_void;

#[repr(transparent)]
struct CBoolean(bool);

// SAFETY: repr(transparent) preserves Rust bool's C _Bool ABI; Encoding::Bool
// describes exactly that type. This wrapper is only used for Network's C block,
// never Objective-C BOOL (which differs on Intel Macs).
unsafe impl Encode for CBoolean {
    const ENCODING: Encoding = Encoding::Bool;
}

#[repr(C)]
struct StoreContext {
    version: isize,
    info: Object,
    retain: Option<unsafe extern "C" fn(Cf) -> Cf>,
    release: Option<unsafe extern "C" fn(Cf)>,
    copy_description: Option<unsafe extern "C" fn(Cf) -> Cf>,
}

#[link(name = "CoreFoundation", kind = "framework")]
extern "C" {
    fn CFRelease(object: Cf);
    fn CFGetTypeID(object: Cf) -> usize;
    fn CFArrayGetCount(array: Cf) -> isize;
    fn CFArrayGetValueAtIndex(array: Cf, index: isize) -> Cf;
    fn CFDictionaryGetTypeID() -> usize;
    fn CFDictionaryGetValue(dictionary: Cf, key: Cf) -> Cf;
    fn CFStringGetTypeID() -> usize;
}

#[link(name = "SystemConfiguration", kind = "framework")]
extern "C" {
    fn SCDynamicStoreCreate(
        allocator: Cf,
        name: Cf,
        callback: Option<unsafe extern "C" fn(Cf, Cf, Object)>,
        context: *mut StoreContext,
    ) -> Cf;
    fn SCDynamicStoreCopyValue(store: Cf, key: Cf) -> Cf;
    fn SCDynamicStoreSetNotificationKeys(store: Cf, keys: Cf, patterns: Cf) -> u8;
    fn SCDynamicStoreSetDispatchQueue(store: Cf, queue: Object) -> u8;
}

#[link(name = "Network", kind = "framework")]
extern "C" {
    fn nw_path_monitor_create_with_type(kind: i32) -> Object;
    fn nw_path_monitor_set_queue(monitor: Object, queue: Object);
    fn nw_path_monitor_set_update_handler(monitor: Object, handler: &Block<dyn Fn(Object)>);
    fn nw_path_monitor_set_cancel_handler(monitor: Object, handler: &Block<dyn Fn()>);
    fn nw_path_monitor_start(monitor: Object);
    fn nw_path_monitor_cancel(monitor: Object);
    fn nw_release(object: Object);
    fn nw_path_get_status(path: Object) -> i32;
    fn nw_path_is_expensive(path: Object) -> bool;
    fn nw_path_is_constrained(path: Object) -> bool;
    fn nw_path_uses_interface_type(path: Object, kind: i32) -> bool;
    fn nw_path_enumerate_interfaces(path: Object, handler: &Block<dyn Fn(Object) -> CBoolean + '_>);
    fn nw_interface_get_type(interface: Object) -> i32;
    fn nw_interface_get_name(interface: Object) -> *const c_char;
}

#[link(name = "System")]
extern "C" {
    fn dispatch_queue_create(label: *const c_char, attributes: Cf) -> Object;
    fn dispatch_sync_f(queue: Object, context: Object, work: extern "C" fn(Object));
    fn dispatch_release(object: Object);
    fn if_nametoindex(name: *const c_char) -> u32;
}

fn cf_ptr<T>(value: &T) -> Cf {
    ptr::from_ref(value).cast()
}

struct OwnedCf(NonNull<c_void>);
impl OwnedCf {
    // Only used with native Create/Copy results, transferring their +1 ownership.
    fn from_copy(value: Cf) -> Option<Self> {
        NonNull::new(value.cast_mut()).map(Self)
    }
    fn as_ptr(&self) -> Cf {
        self.0.as_ptr()
    }
}
impl Drop for OwnedCf {
    fn drop(&mut self) {
        // SAFETY: from_copy receives only +1 CF Create/Copy objects. This wrapper
        // is unique and releases that reference exactly once, after all borrows.
        unsafe { CFRelease(self.as_ptr()) };
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[derive(Clone, Copy, Default)]
struct Policy {
    expensive: bool,
    constrained: bool,
}
#[derive(Default)]
struct PolicyCache {
    by_type: BTreeMap<i32, (String, Policy)>,
}
static POLICY: Mutex<PolicyCache> = Mutex::new(PolicyCache {
    by_type: BTreeMap::new(),
});
static MONITOR_ACTIVE: AtomicBool = AtomicBool::new(false);

/// Snapshot one existing BSD interface, including OS hardware name/type and
/// native negotiated Ethernet speed. Wi-Fi measurements are deliberately absent.
/// Policy is unavailable (false) before initial events or on ambiguous paths.
#[must_use]
pub fn snapshot(ifname: &str) -> Option<NetInfo> {
    let name = CString::new(ifname).ok()?;
    // SAFETY: name is a live NUL-terminated CString; if_nametoindex retains none.
    if unsafe { if_nametoindex(name.as_ptr()) } == 0 {
        return None;
    }
    let interfaces = SCNetworkInterface::all();
    let bsd_name = CFString::from_str(ifname);
    let mut kind = String::new();
    let mut label = None;
    // SAFETY: SCNetworkInterfaceCopyAll returns a retained immutable CFArray
    // containing SCNetworkInterface objects. It stays alive for this entire loop;
    // indices are within CFArrayGetCount and borrowed elements never escape.
    unsafe {
        let array = cf_ptr(&*interfaces);
        for index in 0..CFArrayGetCount(array) {
            let interface = &*CFArrayGetValueAtIndex(array, index).cast::<SCNetworkInterface>();
            if interface.bsd_name().is_some_and(|n| *n == *bsd_name) {
                kind = interface
                    .interface_type()
                    .map(|t| t.to_string())
                    .unwrap_or_default();
                label = interface.localized_display_name().map(|n| n.to_string());
                break;
            }
        }
    }
    let medium = medium(ifname, &kind, label.as_deref());
    let speed_mbps = if medium == Medium::Ethernet {
        ethernet_speed(&name)
    } else {
        None
    };
    let policy = lock(&POLICY)
        .by_type
        .values()
        .find_map(|(name, policy)| (name == ifname).then_some(*policy))
        .unwrap_or_default();
    Some(NetInfo {
        interface: ifname.to_owned(),
        localized_name: label,
        medium,
        speed_mbps,
        wifi: None,
        expensive: policy.expensive,
        constrained: policy.constrained,
        metered: false,
    })
}

/// Read the OS primary IPv4 interface, falling back to the primary IPv6 interface.
/// This is global context; callers must use their outgoing route when available.
#[must_use]
pub fn primary_interface() -> Option<String> {
    let property = CFString::from_static_str("PrimaryInterface");
    for key in ["State:/Network/Global/IPv4", "State:/Network/Global/IPv6"] {
        let key = CFString::from_static_str(key);
        // SAFETY: SCDynamicStoreCopyValue explicitly permits a NULL session for
        // one-shot reads. key is a live CFString. The Copy result is +1 owned.
        let Some(value) =
            OwnedCf::from_copy(unsafe { SCDynamicStoreCopyValue(ptr::null(), cf_ptr(&*key)) })
        else {
            continue;
        };
        // SAFETY: value is live; dynamic-store values are CF objects. Dictionary
        // and string type IDs are checked before use. The borrowed string remains
        // alive through its conversion because its owning dictionary is retained.
        unsafe {
            if CFGetTypeID(value.as_ptr()) != CFDictionaryGetTypeID() {
                continue;
            }
            let name = CFDictionaryGetValue(value.as_ptr(), cf_ptr(&*property));
            if !name.is_null() && CFGetTypeID(name) == CFStringGetTypeID() {
                let name = (&*name.cast::<CFString>()).to_string();
                if !name.is_empty() {
                    return Some(name);
                }
            }
        }
    }
    None
}

/// Read numeric `CoreWLAN` current-link metrics for exactly the named interface.
/// Error/unassociated zero values are omitted. No identity or scan APIs are used.
#[must_use]
pub fn snapshot_wifi(ifname: &str) -> Option<WifiLink> {
    if ifname.is_empty() || ifname.contains('\0') {
        return None;
    }
    autoreleasepool(|_| {
        let name = NSString::from_str(ifname);
        // SAFETY: CoreWLAN's shared client is the documented process singleton.
        // The generated retained results keep client/interface/channel alive.
        // All receivers are genuine CoreWLAN objects; NSString is live and the
        // getters have no mutation, raw out-parameters, delegate, or scan contract.
        // The pool bounds autoreleased native temporaries to this one snapshot.
        unsafe {
            let client = CWWiFiClient::sharedWiFiClient();
            let interface = client.interfaceWithName(Some(&name))?;
            if !interface.powerOn() {
                return None;
            }
            let channel = interface.wlanChannel();
            let band = channel
                .as_ref()
                .and_then(|channel| wifi_band(channel.channelBand().0));
            let rssi_dbm = dbm(interface.rssiValue());
            let noise_dbm = dbm(interface.noiseMeasurement());
            let rate_mbps = link_rate(interface.transmitRate());
            if band.is_none() && rssi_dbm.is_none() && noise_dbm.is_none() && rate_mbps.is_none() {
                return None;
            }
            Some(WifiLink {
                band,
                rssi_dbm,
                noise_dbm,
                rate_mbps,
            })
        }
    })
}

// Darwin's net/if.h packs ifmediareq to four-byte alignment even on arm64.
// SDK C probe verified size 44, active offset 28, status 24, ulist 36.
#[repr(C, packed(4))]
struct InterfaceMedia {
    name: [u8; 16],
    current: i32,
    mask: i32,
    status: i32,
    active: i32,
    count: i32,
    list: *mut i32,
}

// SIOCGIFMEDIA rewrites extended Ethernet subtypes to IFM_OTHER. The extended
// command preserves them, with exactly the same packed ifmediareq ABI.
const SIOCGIFXMEDIA: nix::libc::c_ulong = 0xc02c_6948;

fn ethernet_speed(name: &CStr) -> Option<u64> {
    let bytes = name.to_bytes_with_nul();
    let mut request = InterfaceMedia {
        name: [0; 16],
        current: 0,
        mask: 0,
        status: 0,
        active: 0,
        count: 0,
        list: ptr::null_mut(),
    };
    request.name.get_mut(..bytes.len())?.copy_from_slice(bytes);
    let socket = socket(
        AddressFamily::Inet,
        SockType::Datagram,
        SockFlag::empty(),
        None,
    )
    .ok()?;
    // Darwin socket(2) does not support SOCK_CLOEXEC, so set FD_CLOEXEC afterward.
    fcntl(&socket, FcntlArg::F_SETFD(FdFlag::FD_CLOEXEC)).ok()?;
    // SAFETY: socket is a live datagram descriptor. SIOCGIFXMEDIA's public SDK
    // value is 0xc02c6948 (44-byte ifmediareq), preserving extended subtypes.
    // The packed(4) C layout, sizes and offsets were verified on macOS. Name is
    // bounded and NUL-terminated; count=0 and list=NULL request only metadata,
    // never a write through a list pointer. All returned fields have valid
    // integer/byte representations; the socket closes on every return.
    let result = unsafe {
        nix::libc::ioctl(
            socket.as_raw_fd(),
            SIOCGIFXMEDIA,
            ptr::from_mut(&mut request),
        )
    };
    if result != 0 {
        return None;
    }
    ethernet_rate(request.active, request.status)
}

struct CallbackState {
    on_change: Box<dyn Fn() + Send + Sync>,
    stopping: AtomicBool,
    pending_cancels: Mutex<usize>,
    cancelled: Condvar,
}
impl CallbackState {
    fn changed(&self) {
        if !self.stopping.load(Ordering::Acquire) {
            // A consumer panic must not unwind through a native callback frame.
            let _ = catch_unwind(AssertUnwindSafe(|| (self.on_change)()));
        }
    }
}

unsafe extern "C" fn retain_store_context(info: Cf) -> Cf {
    // SAFETY: info originates from Arc::into_raw. SCDynamicStoreContext's retain
    // hook receives a live context reference and must return its retained info
    // (SCDynamicStore.h:64-87). Each invocation acquires one independent SC count.
    unsafe { Arc::increment_strong_count(info.cast::<CallbackState>()) };
    info
}

unsafe extern "C" fn release_store_context(info: Cf) {
    // SAFETY: SC pairs each successful retain with one release of the same info.
    // Its count keeps this Arc allocation live until this decrement, independent
    // of queue timing or the Rust monitor owner's lifetime. A consumer capture's
    // destructor must not unwind across the native callback frame.
    let _ = catch_unwind(AssertUnwindSafe(|| unsafe {
        Arc::decrement_strong_count(info.cast::<CallbackState>());
    }));
}

unsafe extern "C" fn store_changed(_: Cf, _: Cf, info: Object) {
    // SAFETY: SC owns a strong Arc reference through its context retain/release
    // hooks for as long as it can invoke this callback. This borrow is therefore
    // live even if native reconnect work outlasts unscheduling or the Rust owner.
    let state = unsafe { &*info.cast::<CallbackState>() };
    let _ = catch_unwind(AssertUnwindSafe(|| {
        if !state.stopping.load(Ordering::Acquire) {
            state.changed();
        }
    }));
}

fn update_policy(path: Object, kind: i32, state: &CallbackState) {
    if state.stopping.load(Ordering::Acquire) {
        return;
    }
    let names = Mutex::new(Vec::<String>::new());
    let enumerate = StackBlock::new(|interface: Object| -> CBoolean {
        // SAFETY: Network passes a live borrowed interface to this synchronous,
        // noescape enumeration block. The returned C string is NUL-terminated
        // and remains live with that interface; we copy it before returning.
        unsafe {
            if nw_interface_get_type(interface) == kind {
                let name = nw_interface_get_name(interface);
                if !name.is_null() {
                    let name = CStr::from_ptr(name).to_string_lossy().into_owned();
                    let mut names = lock(&names);
                    if !names.contains(&name) {
                        names.push(name);
                    }
                }
            }
        }
        CBoolean(true)
    });
    // SAFETY: path is borrowed from the currently executing update callback.
    // Enumeration is synchronous/noescape, and the block's Mutex capture is
    // thread-safe. All snapshot getter calls finish before the callback returns.
    let (satisfied, uses_type, policy) = unsafe {
        nw_path_enumerate_interfaces(path, &enumerate);
        (
            nw_path_get_status(path) == 1,
            nw_path_uses_interface_type(path, kind),
            Policy {
                expensive: nw_path_is_expensive(path),
                constrained: nw_path_is_constrained(path),
            },
        )
    };
    let names = lock(&names);
    let mut cache = lock(&POLICY);
    cache.by_type.remove(&kind);
    if let Some(name) = policy_interface(satisfied, uses_type, &names) {
        cache.by_type.insert(kind, (name.to_owned(), policy));
    }
    drop(cache);
    drop(names);
    state.changed();
}

/// Event-driven, single-owner policy and `SystemConfiguration` subscriptions.
///
/// Start at most one monitor per process. Callbacks run on a private native
/// serial dispatch queue; they must be short and must not synchronously wait
/// for the owning thread. No dedicated Rust thread or polling timer is created.
///
/// The handle is deliberately !Send/!Sync: drop remains on its owner's thread,
/// never inside one of its Send+Sync callbacks. Drop marks callbacks inactive,
/// unschedules SC, cancels every NW monitor, waits for all native cancellation
/// completions (after which updates cannot fire), drains the dispatch queue,
/// then releases the SC store, NW objects and queue. SC owns its callback context
/// through Arc retain/release hooks, independent of drain timing. The stopping
/// flag prevents late native work from invoking the user callback.
pub struct NetInfoMonitor {
    queue: NonNull<c_void>,
    store: Option<OwnedCf>,
    monitors: Vec<NonNull<c_void>>,
    state: Arc<CallbackState>,
    _owner_thread: PhantomData<Rc<()>>,
}

impl NetInfoMonitor {
    /// Return None if already active or native subscription allocation fails.
    /// Partial startup uses the same cancellation/drain path as normal drop.
    pub fn start(on_change: impl Fn() + Send + Sync + 'static) -> Option<Self> {
        if MONITOR_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .is_err()
        {
            return None;
        }
        // SAFETY: label is static/NUL-terminated; NULL attributes select a serial
        // queue. The returned +1 dispatch object is owned by the handle.
        let queue = NonNull::new(unsafe {
            dispatch_queue_create(
                c"studio.overengineering.pingping.netinfo".as_ptr(),
                ptr::null(),
            )
        });
        let Some(queue) = queue else {
            MONITOR_ACTIVE.store(false, Ordering::Release);
            return None;
        };
        let mut monitor = Self {
            queue,
            store: None,
            monitors: Vec::with_capacity(4),
            state: Arc::new(CallbackState {
                on_change: Box::new(on_change),
                stopping: AtomicBool::new(false),
                pending_cancels: Mutex::new(0),
                cancelled: Condvar::new(),
            }),
            _owner_thread: PhantomData,
        };
        let name = CFString::from_static_str("pingping local network context");
        let context_state = Arc::into_raw(Arc::clone(&monitor.state));
        let mut context = StoreContext {
            version: 0,
            info: context_state.cast_mut().cast(),
            retain: Some(retain_store_context),
            release: Some(release_store_context),
            copy_description: None,
        };
        // SAFETY: context has the SDK's version-0 C layout and callback ABI.
        // SC copies the context and invokes its retain hook to own info; the
        // seed Arc remains live through this call. name is live, allocator default.
        monitor.store = OwnedCf::from_copy(unsafe {
            SCDynamicStoreCreate(
                ptr::null(),
                cf_ptr(&*name),
                Some(store_changed),
                ptr::from_mut(&mut context),
            )
        });
        // SAFETY: consumes exactly the seed count from Arc::into_raw above,
        // whether creation succeeds or fails. A successful store owns its own
        // count acquired by retain_store_context until its matching release.
        unsafe { drop(Arc::from_raw(context_state)) };
        let store = monitor.store.as_ref()?;
        let patterns = [
            CFString::from_static_str("State:/Network/Global/IPv[46]"),
            CFString::from_static_str("State:/Network/Interface/.*/(Link|IPv4|IPv6)"),
            CFString::from_static_str("Setup:/Network/.*"),
        ];
        let patterns = CFArray::from_retained_objects(&patterns);
        // SAFETY: store/queue are owned and live; patterns is a CFArray of live
        // CFStrings. SC copies notification keys and retains the dispatch queue.
        // Context is Send+Sync and all callbacks are serialized on this queue.
        let subscribed = unsafe {
            SCDynamicStoreSetNotificationKeys(store.as_ptr(), ptr::null(), cf_ptr(&*patterns)) != 0
                && SCDynamicStoreSetDispatchQueue(store.as_ptr(), queue.as_ptr()) != 0
        };
        if !subscribed {
            return None;
        }
        // NW interface type constants: other=0, Wi-Fi=1, cellular=2, wired=3.
        // Type-restricted paths only publish policy when exactly one interface
        // of that type is associated, avoiding unrelated/global flag leakage.
        for kind in [0, 1, 2, 3] {
            // SAFETY: kind is a public nw_interface_type_t discriminant. The
            // Create result is a +1 object; the handle adopts it before starting.
            let native = NonNull::new(unsafe { nw_path_monitor_create_with_type(kind) })?;
            let state = Arc::clone(&monitor.state);
            let update = RcBlock::new(move |path: Object| {
                let _ = catch_unwind(AssertUnwindSafe(|| update_policy(path, kind, &state)));
            });
            let state = Arc::clone(&monitor.state);
            let cancelled = RcBlock::new(move || {
                let mut pending = lock(&state.pending_cancels);
                *pending -= 1;
                state.cancelled.notify_all();
            });
            monitor.monitors.push(native);
            *lock(&monitor.state.pending_cancels) += 1;
            // SAFETY: native/queue are live owned objects, configured before start.
            // Network copies the heap blocks; each captures only a Send+Sync Arc
            // and scalars. Their original RcBlock handles remain on this thread.
            // Copied blocks live until cancellation/release, and cancellation's
            // handler establishes that no update callback can execute afterward.
            unsafe {
                nw_path_monitor_set_queue(native.as_ptr(), queue.as_ptr());
                nw_path_monitor_set_update_handler(native.as_ptr(), &update);
                nw_path_monitor_set_cancel_handler(native.as_ptr(), &cancelled);
                nw_path_monitor_start(native.as_ptr());
            }
        }
        Some(monitor)
    }
}

extern "C" fn queue_drained(_: Object) {}

impl Drop for NetInfoMonitor {
    fn drop(&mut self) {
        self.state.stopping.store(true, Ordering::Release);
        if let Some(store) = self.store.as_ref() {
            // SAFETY: store is retained. NULL removes the notification dispatch
            // queue; SC's context Arc ownership does not depend on quiescence.
            unsafe { SCDynamicStoreSetDispatchQueue(store.as_ptr(), ptr::null_mut()) };
        }
        for monitor in &self.monitors {
            // SAFETY: every entry is a live, started, owned NW monitor. Cancel is
            // asynchronous; its installed completion handler signals the waiter.
            unsafe { nw_path_monitor_cancel(monitor.as_ptr()) };
        }
        let mut pending = lock(&self.state.pending_cancels);
        while *pending != 0 {
            pending = self
                .state
                .cancelled
                .wait(pending)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        drop(pending);
        // SAFETY: queue is live and serial. !Send/!Sync prevents handle ownership
        // on its callback queue; synchronous drain cannot deadlock with self-drop.
        // All NW cancellation completions have run. This orders already queued
        // SC work, but is not an SC quiescence proof: retain/release hooks own info.
        unsafe { dispatch_sync_f(self.queue.as_ptr(), ptr::null_mut(), queue_drained) };
        self.store.take();
        for monitor in self.monitors.drain(..) {
            // SAFETY: cancellation completed and dispatch work drained. This is
            // the unique +1 Create reference and is released exactly once.
            unsafe { nw_release(monitor.as_ptr()) };
        }
        // SAFETY: releases only our owned Create reference. SC owns any queue
        // reference retained for outstanding work, as well as its context Arc.
        unsafe { dispatch_release(self.queue.as_ptr()) };
        lock(&POLICY).by_type.clear();
        MONITOR_ACTIVE.store(false, Ordering::Release);
    }
}

#[cfg(test)]
mod media_layout_tests {
    use super::{InterfaceMedia, SIOCGIFXMEDIA};
    use std::mem::{align_of, offset_of, size_of};

    #[test]
    fn media_ioctl_layout_matches_the_verified_darwin_sdk() {
        assert_eq!(size_of::<InterfaceMedia>(), 44);
        assert_eq!(SIOCGIFXMEDIA, 0xc02c_6948);
        assert_eq!(align_of::<InterfaceMedia>(), 4);
        assert_eq!(offset_of!(InterfaceMedia, status), 24);
        assert_eq!(offset_of!(InterfaceMedia, active), 28);
        assert_eq!(offset_of!(InterfaceMedia, count), 32);
        assert_eq!(offset_of!(InterfaceMedia, list), 36);
    }

    #[test]
    fn retained_store_context_survives_its_rust_owner_until_native_release() {
        use super::{release_store_context, retain_store_context, store_changed, CallbackState};
        use std::ptr;
        use std::sync::{atomic::AtomicBool, mpsc, Arc, Condvar, Mutex};

        let (tx, rx) = mpsc::channel();
        let state = Arc::new(CallbackState {
            on_change: Box::new(move || tx.send(()).unwrap()),
            stopping: AtomicBool::new(false),
            pending_cancels: Mutex::new(0),
            cancelled: Condvar::new(),
        });
        let weak = Arc::downgrade(&state);
        let raw = Arc::into_raw(state);
        // SAFETY: emulate SC's context ownership contract: retain the live seed,
        // consume the Rust seed, invoke while the retained native count is live,
        // then release that count exactly once. No pointer is used afterward.
        unsafe {
            let retained = retain_store_context(raw.cast());
            drop(Arc::from_raw(raw));
            store_changed(ptr::null(), ptr::null(), retained.cast_mut());
            release_store_context(retained);
        }
        assert_eq!(rx.try_recv(), Ok(()));
        assert!(weak.upgrade().is_none());
        assert_eq!(rx.try_recv(), Err(mpsc::TryRecvError::Disconnected));
    }
}
