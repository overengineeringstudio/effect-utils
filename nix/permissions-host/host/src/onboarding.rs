//! Same-process Swift presentation; policy, probes and evidence remain in Rust.
//!
//! The sealed executable exposes the panel only through `onboard --human-present
//! --config PATH`. There is no IPC operation or product preview argument.
//! Swift/AppKit supplies native accessibility, materials, file dragging and
//! window placement without introducing another permission-bearing executable.
//! The Rust callback alone interprets policy and runs positive checks.
//!
//! There is no documented cross-category TCC change notification (FDA has no
//! authorization API). The panel observes application activation and uses a
//! conservative bounded retry interval only for the selected unfinished row.
//! Automatic retries cannot request authorization. Automation and system-audio
//! require another explicit click, rather than polling Apple events/process taps.
//! Existing fixture checks are synchronous/main-thread-bound; their existing
//! native deadlines bound each callback. Closing persists unchecked/failed rows.
use crate::{Config, onboarding_state::Row};
use serde_json::{Value, json};
use std::ffi::{CString, c_char, c_void};

unsafe extern "C" {
    fn permissions_onboarding_run(rows: *const c_char, app: *const c_char, context: *mut c_void,
        check: extern "C" fn(*mut c_void, i32) -> *const c_char);
}
struct Session<'a> {
    config: &'a Config,
    rows: Vec<Row>,
    response: CString,
}
extern "C" fn check(context: *mut c_void, action: i32) -> *const c_char {
    // Swift invokes this synchronously on the main thread, never after run returns.
    // It cannot retain Rust references or mutate the sealed policy.
    let session = unsafe { &mut *context.cast::<Session<'_>>() };
    let prompt = action < 10_000;
    let index = if prompt { action } else { action - 10_000 };
    let Some(row) = usize::try_from(index).ok().and_then(|index| session.rows.get_mut(index)) else { return std::ptr::null(); };
    if let Some(result) = crate::native::check(session.config, &row.category, row.target.as_deref(), prompt) {
        row.observe(result["status"].as_str().unwrap_or("failed"), result["detail"].as_str().unwrap_or("Check returned no evidence").into());
    }
    session.response = CString::new(json!({"status":row.state.status(),"detail":row.detail}).to_string()).expect("JSON escapes NUL");
    session.response.as_ptr()
}
pub(crate) fn run(config: &Config) -> Vec<Value> {
    let rows = Row::enabled(&config.enabled_grants, &config.automation_targets);
    let presentation: Vec<Value> = rows.iter().map(|row| {
        let (_, explanation, _) = row.presentation();
        json!({"category":row.category,"target":row.target,"title":row.title(),"explanation":explanation,"pane":row.pane(),"state":row.state.status(),"detail":row.detail})
    }).collect();
    let encoded = CString::new(serde_json::to_string(&presentation).expect("Presentation JSON")).expect("JSON escapes NUL");
    // Only the actual enclosing .app is a drag source, never a configurable URL.
    let app = std::env::current_exe().ok().and_then(|exe| exe.parent()?.parent()?.parent().map(std::path::Path::to_path_buf))
        .filter(|path| path.extension().is_some_and(|extension| extension == "app"));
    let app = CString::new(app.as_ref().map(|path| path.to_string_lossy().into_owned()).unwrap_or_default()).expect("Executable path cannot contain NUL");
    let mut session = Session { config, rows, response: CString::default() };
    // All arguments and callback storage outlive the synchronous AppKit loop.
    unsafe { permissions_onboarding_run(encoded.as_ptr(), app.as_ptr(), (&mut session as *mut Session<'_>).cast(), check); }
    session.rows.into_iter().map(|row| {
        let mut value = json!({"category":row.category,"status":row.state.status(),"detail":row.detail});
        if let Some(target) = row.target { value["target"] = json!(target); }
        value
    }).collect()
}
