//! Permission-bearing native boundary. Only `onboard` may request authorization.
//! No shell, script evaluator, click action, or alternate application identity is used.

use crate::{Config, HostError};
use libc::{c_char, c_void};
use serde_json::{Value, json};
use std::ffi::CString;
use std::ptr::{null, null_mut};
use std::sync::{Arc, Condvar, Mutex};
use std::sync::atomic::{AtomicU8, Ordering};
use std::time::{Duration, Instant};

type Id = *mut c_void;
type Sel = *const c_void;
const WAIT: Duration = Duration::from_secs(30);

#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Id;
    fn sel_registerName(name: *const c_char) -> Sel;
    fn objc_msgSend();
    fn objc_autoreleasePoolPush() -> Id;
    fn objc_autoreleasePoolPop(pool: Id);
}
#[link(name = "Foundation", kind = "framework")]
unsafe extern "C" {}
#[link(name = "UserNotifications", kind = "framework")]
unsafe extern "C" {}
#[link(name = "AVFoundation", kind = "framework")]
unsafe extern "C" {
    static AVMediaTypeAudio: Id;
}
#[link(name = "System")]
unsafe extern "C" {
    static _NSConcreteStackBlock: c_void;
    fn _Block_copy(block: *const c_void) -> *mut c_void;
    fn _Block_release(block: *const c_void);
}

// The only Objective-C dispatch boundary. Each call below supplies the exact ABI
// of the named SDK method; all objects remain in a live autorelease pool.
unsafe fn class(name: &std::ffi::CStr) -> Id { unsafe { objc_getClass(name.as_ptr()) } }
unsafe fn selector(name: &std::ffi::CStr) -> Sel { unsafe { sel_registerName(name.as_ptr()) } }
unsafe fn send0<R>(object: Id, name: &std::ffi::CStr) -> R {
    let f: unsafe extern "C" fn(Id, Sel) -> R = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, selector(name)) }
}
unsafe fn send1<A, R>(object: Id, name: &std::ffi::CStr, a: A) -> R {
    let f: unsafe extern "C" fn(Id, Sel, A) -> R = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, selector(name), a) }
}
unsafe fn send2<A, B, R>(object: Id, name: &std::ffi::CStr, a: A, b: B) -> R {
    let f: unsafe extern "C" fn(Id, Sel, A, B) -> R = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, selector(name), a, b) }
}
unsafe fn send3<A, B, C, R>(object: Id, name: &std::ffi::CStr, a: A, b: B, c: C) -> R {
    let f: unsafe extern "C" fn(Id, Sel, A, B, C) -> R = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, selector(name), a, b, c) }
}
struct Pool(Id);
impl Pool { fn new() -> Self { Self(unsafe { objc_autoreleasePoolPush() }) } }
impl Drop for Pool { fn drop(&mut self) { unsafe { objc_autoreleasePoolPop(self.0) } } }
struct Object(Id);
impl Drop for Object { fn drop(&mut self) { unsafe { send0::<()>(self.0, c"release") } } }
fn string(text: &str) -> Object {
    // NSString copies the borrowed UTF-8 bytes before returning.
    unsafe {
        let allocated: Id = send0(class(c"NSString"), c"alloc");
        Object(send3(allocated, c"initWithBytes:length:encoding:", text.as_ptr(), text.len(), 4usize))
    }
}
fn failed(message: impl Into<String>) -> HostError { HostError::new("operation-failed", message) }
fn required(category: &str, action: &str) -> HostError { HostError::permission(category, action) }

// Frameworks may retain a completion block after our deadline. Its sole capture
// is an Arc-owned result cell (never a borrowed stack pointer or permission-bearing
// work). Late callbacks can only drop/store that result; no detached worker runs.
struct Completion { value: Mutex<Option<i64>>, ready: Condvar }
impl Completion {
    fn new() -> Arc<Self> { Arc::new(Self { value: Mutex::new(None), ready: Condvar::new() }) }
    fn finish(&self, value: i64) {
        if let Ok(mut slot) = self.value.lock() { *slot = Some(value); self.ready.notify_all(); }
    }
    fn wait(&self, duration: Duration) -> Result<i64, HostError> {
        let guard = self.value.lock().map_err(|_| failed("Native callback lock failed"))?;
        let (guard, _) = self.ready.wait_timeout_while(guard, duration, |v| v.is_none())
            .map_err(|_| failed("Native callback wait failed"))?;
        guard.ok_or_else(|| HostError::new("deadline-exceeded", "Native permission check timed out; outcome is unknown"))
    }
}
#[repr(C)]
struct BlockDescriptor {
    reserved: usize, size: usize,
    copy: unsafe extern "C" fn(*mut Block, *const Block),
    dispose: unsafe extern "C" fn(*mut Block),
}
#[repr(C)]
struct Block {
    isa: *const c_void, flags: i32, reserved: i32,
    invoke: *const c_void, descriptor: *const BlockDescriptor, state: *const Completion,
}
unsafe extern "C" fn copy_block(dst: *mut Block, src: *const Block) {
    unsafe { Arc::increment_strong_count((*src).state); (*dst).state = (*src).state; }
}
unsafe extern "C" fn dispose_block(block: *mut Block) { unsafe { Arc::decrement_strong_count((*block).state) } }
static BLOCK_DESCRIPTOR: BlockDescriptor = BlockDescriptor {
    reserved: 0, size: std::mem::size_of::<Block>(), copy: copy_block, dispose: dispose_block,
};
struct Callback(*mut c_void);
impl Callback {
    fn new(state: &Arc<Completion>, invoke: *const c_void) -> Self {
        let block = Block {
            isa: std::ptr::addr_of!(_NSConcreteStackBlock), flags: 1 << 25, reserved: 0,
            invoke, descriptor: &BLOCK_DESCRIPTOR, state: Arc::as_ptr(state),
        };
        // _Block_copy invokes copy_block while the stack block and Arc are live.
        Self(unsafe { _Block_copy((&block as *const Block).cast()) })
    }
}
impl Drop for Callback { fn drop(&mut self) { unsafe { _Block_release(self.0) } } }
unsafe extern "C" fn settings_callback(block: *const Block, settings: Id) {
    let status = if settings.is_null() { -1 } else { unsafe { send0::<i64>(settings, c"authorizationStatus") } };
    unsafe { (*(*block).state).finish(status) }
}
unsafe extern "C" fn error_callback(block: *const Block, error: Id) {
    unsafe { (*(*block).state).finish(i64::from(!error.is_null())) }
}
unsafe extern "C" fn permission_callback(block: *const Block, granted: i8, error: Id) {
    unsafe { (*(*block).state).finish(if error.is_null() { i64::from(granted != 0) } else { -1 }) }
}
unsafe extern "C" fn audio_permission_callback(block: *const Block, granted: i8) {
    unsafe { (*(*block).state).finish(i64::from(granted != 0)) }
}
#[link(name = "Security", kind = "framework")]
unsafe extern "C" {
    fn SessionGetInfo(session: u32, id: *mut u32, attributes: *mut u32) -> i32;
}
/// Inspect this process's execution session only; never request authorization.
pub fn require_gui_session() -> Result<(), HostError> {
    let (mut id, mut attributes) = (0, 0);
    // SAFETY: callerSecuritySession selects this process; both output pointers are valid.
    let status = unsafe { SessionGetInfo(u32::MAX, &mut id, &mut attributes) };
    gui_session_result(status, attributes)
}
fn gui_session_result(status: i32, attributes: u32) -> Result<(), HostError> {
    if status != 0 || attributes & 0x0001 != 0 || attributes & 0x0010 == 0 {
        Err(HostError::new("session-unavailable", "Operation requires the authenticated GUI agent session"))
    } else { Ok(()) }
}

fn notification_center() -> Result<Id, HostError> {
    let center: Id = unsafe { send0(class(c"UNUserNotificationCenter"), c"currentNotificationCenter") };
    if center.is_null() { Err(HostError::new("session-unavailable", "Host notification center is unavailable in this session")) } else { Ok(center) }
}
fn notification_settings(center: Id) -> Result<(), HostError> {
    let state = Completion::new();
    let callback = Callback::new(&state, settings_callback as *const c_void);
    unsafe { send1::<_, ()>(center, c"getNotificationSettingsWithCompletionHandler:", callback.0) };
    match state.wait(WAIT)? {
        // Authorized, provisional and ephemeral authorize submission, not visible delivery.
        2..=4 => Ok(()),
        0 | 1 => Err(required("notifications", "Allow notifications for the installed host during human-present onboarding")),
        _ => Err(failed("Host notification authorization could not be determined")),
    }
}
/// Submit through this process's own notification identity, never requesting consent.
/// The returned ID establishes OS submission only, not banner delivery or reading.
pub fn notify(product_label: &str, title: &str, body: &str, cancelled: &dyn Fn() -> bool) -> Result<String, HostError> {
    require_gui_session()?;
    if cancelled() { return Err(HostError::new("deadline-exceeded", "Notification cancelled before submission")); }
    let _pool = Pool::new();
    let center = notification_center()?;
    notification_settings(center)?;
    let id = crate::opaque_id().map_err(|_| failed("Unable to generate notification identifier"))?;
    let title = string(&format!("{product_label}: {title}"));
    let body = string(body);
    let identifier = string(&id);
    unsafe {
        let content = Object(send0(class(c"UNMutableNotificationContent"), c"new"));
        send1::<_, ()>(content.0, c"setTitle:", title.0);
        send1::<_, ()>(content.0, c"setBody:", body.0);
        // No userInfo, category action, URL, attachment, or click command is set.
        let request: Id = send3(class(c"UNNotificationRequest"), c"requestWithIdentifier:content:trigger:", identifier.0, content.0, null_mut::<c_void>());
        if request.is_null() { return Err(failed("Unable to construct host notification")); }
        let state = Completion::new();
        let callback = Callback::new(&state, error_callback as *const c_void);
        // Submission is the commit boundary. Settings may have waited for an
        // asynchronous callback; recheck disconnect/deadline immediately before
        // handing the notification to the OS, never after publishing it.
        if cancelled() { return Err(HostError::new("deadline-exceeded", "Notification cancelled before submission")); }
        send2::<_, _, ()>(center, c"addNotificationRequest:withCompletionHandler:", request, callback.0);
        if state.wait(WAIT)? != 0 {
            // Recheck revocation so a known denial retains typed permission semantics.
            notification_settings(center)?;
            return Err(failed("The OS rejected notification submission"));
        }
    }
    Ok(id)
}
fn onboard_notifications(prompt: bool) -> Result<String, HostError> {
    let center = notification_center()?;
    if prompt {
        let state = Completion::new();
        let callback = Callback::new(&state, permission_callback as *const c_void);
        unsafe { send2::<_, _, ()>(center, c"requestAuthorizationWithOptions:completionHandler:", 6usize, callback.0) };
        match state.wait(WAIT)? {
            1 => {},
            0 => return Err(required("notifications", "Allow notifications for the installed host")),
            _ => return Err(failed("Notification authorization request failed")),
        }
    } else { notification_settings(center)?; }
    notify("Permissions Host", "Onboarding check", "The host submitted this harmless permission check.", &|| false)?;
    Ok("OS accepted the host test notification; visible delivery is not established".into())
}

#[repr(C)]
struct Point { x: f64, y: f64 }
#[repr(C)]
struct Size { width: f64, height: f64 }
#[repr(C)]
struct Rect { origin: Point, size: Size }
#[link(name = "AppKit", kind = "framework")]
unsafe extern "C" {}
unsafe fn send4<A, B, C, D, R>(object: Id, name: &std::ffi::CStr, a: A, b: B, c: C, d: D) -> R {
    let f: unsafe extern "C" fn(Id, Sel, A, B, C, D) -> R = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
    unsafe { f(object, selector(name), a, b, c, d) }
}
struct ScreenFixture(Object);
impl Drop for ScreenFixture {
    fn drop(&mut self) {
        // releasedWhenClosed is disabled: close removes the window; Object then
        // releases our sole owning reference, including on every error path.
        unsafe { send0::<()>(self.0.0, c"close") };
    }
}
#[link(name = "CoreGraphics", kind = "framework")]
unsafe extern "C" {
    fn CGPreflightScreenCaptureAccess() -> bool;
    fn CGRequestScreenCaptureAccess() -> bool;
    fn CGWindowListCreateImage(bounds: Rect, options: u32, window: u32, image_options: u32) -> Id;
    fn CGImageGetWidth(image: Id) -> usize;
    fn CGImageGetHeight(image: Id) -> usize;
    fn CGImageRelease(image: Id);
    fn CGColorSpaceCreateDeviceRGB() -> Id;
    fn CGColorSpaceRelease(space: Id);
    fn CGBitmapContextCreate(data: *mut c_void, width: usize, height: usize, bits_per_component: usize, bytes_per_row: usize, space: Id, bitmap_info: u32) -> Id;
    fn CGContextDrawImage(context: Id, rect: Rect, image: Id);
    fn CGContextRelease(context: Id);
}
fn onboard_screen(prompt: bool) -> Result<String, HostError> {
    unsafe {
        if !CGPreflightScreenCaptureAccess() && (!prompt || !CGRequestScreenCaptureAccess()) {
            return Err(required("screen-recording", "Approve Screen Recording for the host; restart it if macOS requires"));
        }
        let main_thread: i8 = send0(class(c"NSThread"), c"isMainThread");
        if main_thread == 0 { return Err(failed("Synthetic screen fixture requires the onboarding command's main thread")); }
        let _application: Id = send0(class(c"NSApplication"), c"sharedApplication");
        let allocated: Id = send0(class(c"NSWindow"), c"alloc");
        let window: Id = send4(allocated, c"initWithContentRect:styleMask:backing:defer:",
            Rect { origin: Point { x: 40.0, y: 40.0 }, size: Size { width: 32.0, height: 32.0 } },
            0usize, 2usize, 0i8);
        if window.is_null() { return Err(failed("Unable to create synthetic screen fixture window")); }
        let fixture = ScreenFixture(Object(window));
        send1::<_, ()>(fixture.0.0, c"setReleasedWhenClosed:", 0i8);
        send1::<_, ()>(fixture.0.0, c"setOpaque:", 1i8);
        send1::<_, ()>(fixture.0.0, c"setHasShadow:", 0i8);
        let red: Id = send4(class(c"NSColor"), c"colorWithSRGBRed:green:blue:alpha:", 1.0f64, 0.0f64, 0.0f64, 1.0f64);
        send1::<_, ()>(fixture.0.0, c"setBackgroundColor:", red);
        send0::<()>(fixture.0.0, c"orderFrontRegardless");
        send0::<()>(fixture.0.0, c"display");
        // Give the window server a bounded turn to composite our own opaque
        // synthetic fixture. No desktop or other application's window is selected.
        CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.1, 0);
        let number: isize = send0(fixture.0.0, c"windowNumber");
        let number = u32::try_from(number).map_err(|_| failed("Synthetic screen fixture has no captureable window ID"))?;
        // CGRectNull selects the exact window bounds; including-window plus
        // ignore-framing/nominal-resolution excludes unrelated desktop pixels.
        let image = CGWindowListCreateImage(Rect { origin: Point { x: f64::INFINITY, y: f64::INFINITY }, size: Size { width: 0.0, height: 0.0 } }, 8, number, 17);
        if image.is_null() { return Err(failed("Screen capture did not produce a synthetic fixture image")); }
        let valid_size = CGImageGetWidth(image) == 32 && CGImageGetHeight(image) == 32;
        let space = CGColorSpaceCreateDeviceRGB();
        if space.is_null() { CGImageRelease(image); return Err(failed("Unable to create fixture verification color space")); }
        let mut pixel = [0u8; 4];
        // Render only the captured fixture into a disposable RGBA pixel; this
        // normalizes image provider layout before checking its deterministic red.
        let context = CGBitmapContextCreate(pixel.as_mut_ptr().cast(), 1, 1, 8, 4, space, 0x4001);
        CGColorSpaceRelease(space);
        if context.is_null() { CGImageRelease(image); return Err(failed("Unable to verify synthetic fixture capture")); }
        CGContextDrawImage(context, Rect { origin: Point { x: 0.0, y: 0.0 }, size: Size { width: 1.0, height: 1.0 } }, image);
        CGContextRelease(context);
        CGImageRelease(image);
        if !valid_size || pixel[0] < 240 || pixel[1] > 15 || pixel[2] > 15 || pixel[3] < 240 {
            return Err(failed("Captured screen image did not match the deterministic opaque-red fixture"));
        }
    }
    Ok("Captured and verified the host's synthetic opaque-red 32×32 fixture, then discarded pixels and closed the window".into())
}
#[link(name = "CoreFoundation", kind = "framework")]
unsafe extern "C" {
    fn CFRelease(value: Id);
    fn CFRunLoopRunInMode(mode: Id, seconds: f64, return_after_source: u8) -> i32;
    static kCFRunLoopDefaultMode: Id;
    fn CFDictionaryCreate(allocator: Id, keys: *const Id, values: *const Id, count: isize, key_callbacks: *const c_void, value_callbacks: *const c_void) -> Id;
    static kCFBooleanTrue: Id;
    static kCFTypeDictionaryKeyCallBacks: c_void;
    static kCFTypeDictionaryValueCallBacks: c_void;
}
#[link(name = "ApplicationServices", kind = "framework")]
unsafe extern "C" {
    static kAXTrustedCheckOptionPrompt: Id;
    fn AXIsProcessTrustedWithOptions(options: Id) -> bool;
    fn AXUIElementCreateSystemWide() -> Id;
    fn AXUIElementCopyAttributeValue(element: Id, attribute: Id, value: *mut Id) -> i32;
    fn AXUIElementSetMessagingTimeout(element: Id, timeout: f32) -> i32;
}
fn onboard_accessibility(prompt: bool) -> Result<String, HostError> {
    unsafe {
        let options = CFDictionaryCreate(null_mut(), &kAXTrustedCheckOptionPrompt, &kCFBooleanTrue, 1,
            std::ptr::addr_of!(kCFTypeDictionaryKeyCallBacks), std::ptr::addr_of!(kCFTypeDictionaryValueCallBacks));
        if options.is_null() { return Err(failed("Unable to construct AX onboarding options")); }
        let trusted = AXIsProcessTrustedWithOptions(if prompt { options } else { null_mut() });
        CFRelease(options);
        if !trusted { return Err(required("accessibility", "Approve Accessibility for the installed host and rerun human-present onboarding")); }
        let system = AXUIElementCreateSystemWide();
        if system.is_null() { return Err(failed("AX systemwide element is unavailable")); }
        let timeout = AXUIElementSetMessagingTimeout(system, 3.0);
        if timeout != 0 { CFRelease(system); return Err(failed(format!("AX timeout configuration failed ({timeout})"))); }
        let attribute = string("AXFocusedApplication");
        let mut focused = null_mut();
        let status = AXUIElementCopyAttributeValue(system, attribute.0, &mut focused);
        CFRelease(system);
        if !focused.is_null() { CFRelease(focused); }
        if status != 0 { return Err(failed(format!("AX focused-application read failed ({status}); trust alone is not a positive check"))); }
        if focused.is_null() { return Err(failed("AX focused-application read returned no application")); }
    }
    Ok("Read and discarded the AX focused-application attribute without changing UI".into())
}

#[repr(C)]
struct AudioFormat {
    sample_rate: f64, format_id: u32, flags: u32, bytes_per_packet: u32,
    frames_per_packet: u32, bytes_per_frame: u32, channels: u32, bits_per_channel: u32, reserved: u32,
}
#[repr(C)]
struct AudioBuffer {
    capacity: u32, data: *mut c_void, byte_size: u32, user_data: *mut c_void,
    packet_capacity: u32, packet_descriptions: *mut c_void, packet_count: u32,
}
type AudioQueue = *mut c_void;
#[link(name = "AudioToolbox", kind = "framework")]
unsafe extern "C" {
    fn AudioQueueNewInput(format: *const AudioFormat, callback: unsafe extern "C" fn(*mut c_void, AudioQueue, *mut AudioBuffer, *const c_void, u32, *const c_void), user: *mut c_void, run_loop: Id, mode: Id, flags: u32, queue: *mut AudioQueue) -> i32;
    fn AudioQueueAllocateBuffer(queue: AudioQueue, size: u32, buffer: *mut *mut AudioBuffer) -> i32;
    fn AudioQueueEnqueueBuffer(queue: AudioQueue, buffer: *mut AudioBuffer, count: u32, packets: *const c_void) -> i32;
    fn AudioQueueStart(queue: AudioQueue, start: *const c_void) -> i32;
    fn AudioQueueStop(queue: AudioQueue, immediate: u8) -> i32;
    fn AudioQueueDispose(queue: AudioQueue, immediate: u8) -> i32;
}
unsafe extern "C" fn input_callback(user: *mut c_void, _queue: AudioQueue, buffer: *mut AudioBuffer, _time: *const c_void, _packets: u32, _descriptions: *const c_void) {
    // The queue owns the buffer. Read only the byte count, never copy audio.
    if !buffer.is_null() && unsafe { (*buffer).byte_size } > 0 {
        unsafe { (*(user.cast::<Completion>())).finish(1) };
    }
}
fn onboard_microphone(prompt: bool) -> Result<String, HostError> {
    unsafe {
        let device = class(c"AVCaptureDevice");
        let status: i64 = send1(device, c"authorizationStatusForMediaType:", AVMediaTypeAudio);
        if status == 0 && prompt {
            let state = Completion::new();
            let callback = Callback::new(&state, audio_permission_callback as *const c_void);
            send2::<_, _, ()>(device, c"requestAccessForMediaType:completionHandler:", AVMediaTypeAudio, callback.0);
            if state.wait(WAIT)? != 1 { return Err(required("microphone", "Allow microphone access for the installed host")); }
        } else if status != 3 {
            return Err(required("microphone", "Allow microphone access for the installed host"));
        }
        // A short PCM input buffer is a real hardware input check, not merely
        // an authorization-status claim. Its bytes never leave AudioQueue memory.
        let format = AudioFormat { sample_rate: 16000.0, format_id: u32::from_be_bytes(*b"lpcm"), flags: 12,
            bytes_per_packet: 2, frames_per_packet: 1, bytes_per_frame: 2, channels: 1, bits_per_channel: 16, reserved: 0 };
        let state = Completion::new();
        let mut queue = null_mut();
        // The native queue owns a separate strong reference until successful
        // synchronous disposal. Even an exceptional disposal failure cannot
        // leave a callback pointing into freed Rust memory.
        let queue_state = Arc::into_raw(Arc::clone(&state));
        let status = AudioQueueNewInput(&format, input_callback, queue_state.cast_mut().cast(), null_mut(), null_mut(), 0, &mut queue);
        if status != 0 {
            drop(Arc::from_raw(queue_state));
            return Err(failed(format!("Microphone input queue could not open ({status})")));
        }
        let mut buffer = null_mut();
        let result = (|| {
            let status = AudioQueueAllocateBuffer(queue, 512, &mut buffer);
            if status != 0 { return Err(failed(format!("Microphone input buffer allocation failed ({status})"))); }
            let status = AudioQueueEnqueueBuffer(queue, buffer, 0, null());
            if status != 0 { return Err(failed(format!("Microphone input enqueue failed ({status})"))); }
            let status = AudioQueueStart(queue, null());
            if status != 0 { return Err(failed(format!("Microphone input start failed ({status})"))); }
            state.wait(Duration::from_secs(3))?;
            Ok("Captured and discarded one tiny microphone input buffer; no audio was retained".into())
        })();
        // Synchronous stop/disposal drains callbacks before the captured state dies.
        let stopped = AudioQueueStop(queue, 1);
        let disposed = AudioQueueDispose(queue, 1);
        if disposed == 0 { drop(Arc::from_raw(queue_state)); }
        if stopped != 0 || disposed != 0 { return Err(failed(format!("Microphone input teardown failed ({stopped}, {disposed})"))); }
        result
    }
}

// AEDataModel.h uses two-byte packing, including on 64-bit macOS.
#[repr(C, packed(2))]
struct AEDesc { kind: u32, data: *mut c_void }
impl AEDesc { fn empty() -> Self { Self { kind: 0, data: null_mut() } } }
impl Drop for AEDesc { fn drop(&mut self) { unsafe { AEDisposeDesc(self); } } }
const fn fourcc(bytes: &[u8; 4]) -> u32 { u32::from_be_bytes(*bytes) }
#[link(name = "Carbon", kind = "framework")]
unsafe extern "C" {
    fn AEDisposeDesc(desc: *mut AEDesc) -> i16;
    fn AECreateDesc(kind: u32, data: *const c_void, size: isize, result: *mut AEDesc) -> i16;
    fn AECreateList(data: *const c_void, size: isize, record: u8, result: *mut AEDesc) -> i16;
    fn AECreateAppleEvent(class: u32, id: u32, target: *const AEDesc, return_id: i16, transaction: i32, event: *mut AEDesc) -> i16;
    fn AEPutParamDesc(event: *mut AEDesc, key: u32, value: *const AEDesc) -> i16;
    fn AESendMessage(event: *const AEDesc, reply: *mut AEDesc, mode: i32, timeout_ticks: isize) -> i32;
    fn AEGetParamDesc(event: *const AEDesc, key: u32, desired: u32, result: *mut AEDesc) -> i16;
    fn AEGetDescDataSize(desc: *const AEDesc) -> isize;
    fn AEGetDescData(desc: *const AEDesc, data: *mut c_void, size: isize) -> i16;
}
fn ae_status(status: impl Into<i32>) -> Result<(), HostError> {
    let status = status.into();
    if status == 0 { Ok(()) }
    else if status == -1743 || status == -1744 { Err(required("automation", "Approve Automation for this configured application target during onboarding")) }
    else { Err(failed(format!("Harmless Automation name query failed ({status})"))) }
}
fn ae_desc(kind: u32, bytes: &[u8]) -> Result<AEDesc, HostError> {
    let mut desc = AEDesc::empty();
    ae_status(unsafe { AECreateDesc(kind, bytes.as_ptr().cast(), bytes.len() as isize, &mut desc) })?;
    Ok(desc)
}
fn onboard_automation(target_id: &str) -> Result<String, HostError> {
    // Only immutable Config bundle IDs reach this function. The event is a fixed
    // get-data/property-name object specifier; no AppleScript text is evaluated.
    if target_id.is_empty() || CString::new(target_id).is_err() { return Err(failed("Invalid configured Automation bundle identifier")); }
    let target = ae_desc(fourcc(b"bund"), target_id.as_bytes())?;
    let mut object = AEDesc::empty();
    unsafe { ae_status(AECreateList(null(), 0, 1, &mut object))?; }
    let desired = ae_desc(fourcc(b"type"), &fourcc(b"prop").to_ne_bytes())?;
    let form = ae_desc(fourcc(b"enum"), &fourcc(b"prop").to_ne_bytes())?;
    let name = ae_desc(fourcc(b"type"), &fourcc(b"pnam").to_ne_bytes())?;
    let container = ae_desc(fourcc(b"null"), &[])?;
    for (key, value) in [(fourcc(b"want"), &desired), (fourcc(b"form"), &form), (fourcc(b"seld"), &name), (fourcc(b"from"), &container)] {
        unsafe { ae_status(AEPutParamDesc(&mut object, key, value))?; }
    }
    object.kind = fourcc(b"obj ");
    let mut event = AEDesc::empty();
    unsafe {
        ae_status(AECreateAppleEvent(fourcc(b"core"), fourcc(b"getd"), &target, -1, 0, &mut event))?;
        ae_status(AEPutParamDesc(&mut event, fourcc(b"----"), &object))?;
    }
    let mut reply = AEDesc::empty();
    // Wait-reply plus interaction allowed ONLY here, with a five-second timeout.
    unsafe { ae_status(AESendMessage(&event, &mut reply, 3 | 0x20, 300))?; }
    let mut error = AEDesc::empty();
    let error_status = unsafe { AEGetParamDesc(&reply, fourcc(b"errn"), fourcc(b"long"), &mut error) };
    if error_status == 0 {
        let mut code = 0i32;
        unsafe { ae_status(AEGetDescData(&error, (&mut code as *mut i32).cast(), 4))?; }
        ae_status(code)?;
    } else if error_status != -1701 { ae_status(error_status)?; }
    let mut value = AEDesc::empty();
    unsafe { ae_status(AEGetParamDesc(&reply, fourcc(b"----"), fourcc(b"utxt"), &mut value))?; }
    let size = unsafe { AEGetDescDataSize(&value) };
    if !(2..=4096).contains(&size) { return Err(failed("Automation name query returned no bounded application name")); }
    Ok("Target replied successfully to a fixed harmless application-name query; name discarded".into())
}
#[repr(C)]
struct PropertyAddress { selector: u32, scope: u32, element: u32 }
#[repr(C)]
struct DeviceBuffer { channels: u32, byte_size: u32, data: *const c_void }
#[repr(C)]
struct DeviceBufferList { count: u32, buffers: [DeviceBuffer; 1] }
type IoProc = unsafe extern "C" fn(u32, *const c_void, *const DeviceBufferList, *const c_void, *mut c_void, *const c_void, *mut c_void) -> i32;
#[link(name = "CoreAudio", kind = "framework")]
unsafe extern "C" {
    fn AudioHardwareCreateAggregateDevice(description: Id, device: *mut u32) -> i32;
    fn AudioHardwareDestroyAggregateDevice(device: u32) -> i32;
    fn AudioObjectGetPropertyData(object: u32, address: *const PropertyAddress, qualifier_size: u32, qualifier: *const c_void, size: *mut u32, data: *mut c_void) -> i32;
    fn AudioDeviceCreateIOProcID(device: u32, callback: IoProc, context: *mut c_void, proc_id: *mut Id) -> i32;
    fn AudioDeviceDestroyIOProcID(device: u32, proc_id: Id) -> i32;
    fn AudioDeviceStart(device: u32, proc_id: Id) -> i32;
    fn AudioDeviceStop(device: u32, proc_id: Id) -> i32;
}
fn tap_failure(status: i32) -> HostError {
    if status == fourcc(b"!hog") as i32 || status == fourcc(b"perm") as i32 {
        required("system-audio", "Allow system audio recording for the installed host during human-present onboarding")
    } else { failed(format!("System-audio process-tap check failed ({status})")) }
}
fn tap_status(status: i32) -> Result<(), HostError> {
    if status == 0 { Ok(()) } else { Err(tap_failure(status)) }
}
unsafe extern "C" fn tap_input(_device: u32, _now: *const c_void, input: *const DeviceBufferList, _input_time: *const c_void, _output: *mut c_void, _output_time: *const c_void, context: *mut c_void) -> i32 {
    // Real-time callback: bounded observation only, no allocation, lock, copies
    // into retained storage, or output changes. The format was checked as f32.
    if !input.is_null() && unsafe { (*input).count } > 0 {
        let buffer = unsafe { &(*input).buffers[0] };
        if !buffer.data.is_null() && buffer.byte_size >= 4 {
            let observed = unsafe { &*context.cast::<AtomicU8>() };
            observed.fetch_max(1, Ordering::Relaxed);
            for index in 0..(buffer.byte_size as usize / 4).min(128) {
                let sample = unsafe { std::ptr::read_unaligned(buffer.data.cast::<f32>().add(index)) };
                if sample.is_finite() && sample != 0.0 { observed.store(2, Ordering::Release); break; }
            }
        }
    }
    0
}
fn dictionary<const N: usize>(entries: &[(&str, Id); N]) -> Id {
    let keys: [Object; N] = std::array::from_fn(|index| string(entries[index].0));
    let key_ids: [Id; N] = std::array::from_fn(|index| keys[index].0);
    let values: [Id; N] = std::array::from_fn(|index| entries[index].1);
    // The autoreleased dictionary retains keys/values before their owners drop.
    unsafe { send3(class(c"NSDictionary"), c"dictionaryWithObjects:forKeys:count:", values.as_ptr(), key_ids.as_ptr(), N) }
}
fn onboard_system_audio() -> Result<String, HostError> {
    unsafe {
        #[repr(C)]
        struct Version { major: isize, minor: isize, patch: isize }
        let process: Id = send0(class(c"NSProcessInfo"), c"processInfo");
        let supported: i8 = send1(process, c"isOperatingSystemAtLeastVersion:", Version { major: 14, minor: 4, patch: 0 });
        if supported == 0 { return Err(failed("System-audio process-tap onboarding requires macOS 14.4 or later")); }
        // Resolve the newer entrypoints without making older systems fail at
        // process load. Missing APIs are an honest unavailable check, not success.
        let create = libc::dlsym(libc::RTLD_DEFAULT, c"AudioHardwareCreateProcessTap".as_ptr());
        let destroy = libc::dlsym(libc::RTLD_DEFAULT, c"AudioHardwareDestroyProcessTap".as_ptr());
        let description_class = class(c"CATapDescription");
        if create.is_null() || destroy.is_null() || description_class.is_null() {
            return Err(failed("System-audio process taps require a supported macOS release (14.4 or later)"));
        }
        let create: unsafe extern "C" fn(Id, *mut u32) -> i32 = std::mem::transmute(create);
        let destroy: unsafe extern "C" fn(u32) -> i32 = std::mem::transmute(destroy);
        let excluded: Id = send0(class(c"NSArray"), c"array");
        let allocated: Id = send0(description_class, c"alloc");
        let description = Object(send1(allocated, c"initStereoGlobalTapButExcludeProcesses:", excluded));
        if description.0.is_null() { return Err(failed("Unable to construct private system-audio tap")); }
        send1::<_, ()>(description.0, c"setPrivate:", 1i8);
        send1::<_, ()>(description.0, c"setMuteBehavior:", 0i64);
        let mut tap = 0;
        tap_status(create(description.0, &mut tap))?;
        let result = (|| {
            let mut format: AudioFormat = std::mem::zeroed();
            let mut size = std::mem::size_of::<AudioFormat>() as u32;
            let address = PropertyAddress { selector: fourcc(b"tfmt"), scope: fourcc(b"glob"), element: 0 };
            tap_status(AudioObjectGetPropertyData(tap, &address, 0, null(), &mut size, (&mut format as *mut AudioFormat).cast()))?;
            if format.format_id != fourcc(b"lpcm") || format.flags & 1 == 0 || format.bits_per_channel != 32 || format.flags & 2 != 0 {
                return Err(failed("System-audio tap did not expose native-endian float32 input; no positive capture established"));
            }
            let uuid: Id = send0(description.0, c"UUID");
            let tap_uid: Id = send0(uuid, c"UUIDString");
            let tap_entry = dictionary(&[("uid", tap_uid), ("drift", kCFBooleanTrue)]);
            let taps: Id = send1(class(c"NSArray"), c"arrayWithObject:", tap_entry);
            let uid = string(&crate::opaque_id().map_err(|_| failed("Unable to generate temporary audio device ID"))?);
            let name = string("Permissions host disposable audio check");
            let composition = dictionary(&[("uid", uid.0), ("name", name.0), ("private", kCFBooleanTrue), ("taps", taps), ("tapautostart", kCFBooleanTrue)]);
            let mut device = 0;
            tap_status(AudioHardwareCreateAggregateDevice(composition, &mut device))?;
            let observed = Arc::new(AtomicU8::new(0));
            let context = Arc::into_raw(Arc::clone(&observed));
            let mut proc_id = null_mut();
            let registered = AudioDeviceCreateIOProcID(device, tap_input, context.cast_mut().cast(), &mut proc_id);
            let capture = if registered == 0 {
                let started = AudioDeviceStart(device, proc_id);
                let capture = if started == 0 {
                    let deadline = Instant::now() + Duration::from_secs(3);
                    while observed.load(Ordering::Acquire) != 2 && Instant::now() < deadline {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    if observed.load(Ordering::Acquire) == 2 {
                        Ok("Observed and discarded non-silent system-audio samples through a private process tap; no audio retained".into())
                    } else {
                        Err(failed("No non-silent system-audio sample was observed; silence cannot prove AudioCapture consent. Play harmless test audio and rerun human-present onboarding"))
                    }
                } else { Err(tap_failure(started)) };
                let stopped = AudioDeviceStop(device, proc_id);
                let removed = AudioDeviceDestroyIOProcID(device, proc_id);
                if removed == 0 { drop(Arc::from_raw(context)); }
                if stopped != 0 || removed != 0 { Err(failed(format!("System-audio callback teardown failed ({stopped}, {removed})"))) } else { capture }
            } else {
                drop(Arc::from_raw(context));
                Err(tap_failure(registered))
            };
            let removed = AudioHardwareDestroyAggregateDevice(device);
            tap_status(removed)?;
            capture
        })();
        tap_status(destroy(tap))?;
        result
    }
}


/// Called only by the explicit `onboard --human-present` command. No runtime
/// operation calls these prompt-capable checks. A successful probe is narrow
/// evidence, not a global TCC authorization oracle or production-readiness claim.
pub fn onboard(config: &Config) -> Vec<Value> {
    crate::onboarding::run(config)
}

/// Retry only after nonprompting readiness inspection. Automation and process
/// taps have no common safe change signal here and require another human click.
pub(crate) fn check(config: &Config, category: &str, target: Option<&str>, prompt: bool) -> Option<Value> {
    let _pool = Pool::new();
    if !prompt {
        let ready = unsafe {
            match category {
                "full-disk-access" => true,
                "screen-recording" => CGPreflightScreenCaptureAccess(),
                "accessibility" => AXIsProcessTrustedWithOptions(null_mut()),
                "microphone" => send1::<_, i64>(class(c"AVCaptureDevice"), c"authorizationStatusForMediaType:", AVMediaTypeAudio) == 3,
                "notifications" => notification_center().and_then(notification_settings).is_ok(),
                _ => false,
            }
        };
        if !ready { return None; }
    }
    let outcome = match category {
        "full-disk-access" => crate::documents::probe(&config.documents).map(|()| "Bounded configured protected sentinel read succeeded; not a global FDA authorization claim".into()),
        "notifications" => onboard_notifications(prompt),
        "screen-recording" => onboard_screen(prompt),
        "accessibility" => onboard_accessibility(prompt),
        "microphone" => onboard_microphone(prompt),
        "system-audio" => onboard_system_audio(),
        "automation" => match target { Some(target) => onboard_automation(target), None => Err(failed("Automation requires an explicit target")) },
        _ => Err(failed("Unknown enabled grant category")),
    };
    Some(record(category, target, outcome))
}
fn record(category: &str, target: Option<&str>, result: Result<String, HostError>) -> Value {
    let mut record = match result {
        Ok(detail) => json!({ "category": category, "status": "passed", "detail": detail }),
        Err(error) => json!({ "category": category, "status": if error.code == "permission-required" { "action-required" } else { "failed" }, "detail": error.message }),
    };
    if let Some(target) = target { record["target"] = json!(target); }
    record
}

#[cfg(test)]
mod session_tests {
    use super::*;
    #[test]
    fn only_graphical_nonroot_session_is_admitted() {
        assert!(gui_session_result(0, 0x0010).is_ok());
        for (status, attributes) in [(0, 0), (0, 0x0011), (-1, 0x0010)] {
            assert_eq!(gui_session_result(status, attributes).unwrap_err().code, "session-unavailable");
        }
    }
}
