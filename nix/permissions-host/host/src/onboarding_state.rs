//! Pure presentation state: opening Settings is never positive permission evidence.
use std::borrow::Cow;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State { Pending, Passed, ActionRequired, Failed }
impl State {
    pub fn status(self) -> &'static str {
        match self { Self::Pending => "pending", Self::Passed => "passed", Self::ActionRequired => "action-required", Self::Failed => "failed" }
    }
    pub fn from_check(status: &str) -> Self {
        match status { "passed" => Self::Passed, "action-required" => Self::ActionRequired, _ => Self::Failed }
    }
}
#[derive(Debug)]
pub struct Row {
    pub category: String,
    pub target: Option<String>,
    pub state: State,
    pub detail: String,
}
impl Row {
    pub fn enabled(categories: &[String], targets: &[String]) -> Vec<Self> {
        let mut rows = Vec::with_capacity(categories.len() + targets.len());
        for category in categories {
            if category == "automation" {
                for target in targets { rows.push(Self::pending(category, Some(target.clone()))); }
            } else { rows.push(Self::pending(category, None)); }
        }
        rows
    }
    fn pending(category: &str, target: Option<String>) -> Self {
        Self { category: category.into(), target, state: State::Pending, detail: "Not checked. Only a successful harmless check establishes access.".into() }
    }
    pub fn observe(&mut self, status: &str, detail: String) {
        self.state = State::from_check(status);
        self.detail = detail;
    }
    pub fn title(&self) -> Cow<'_, str> {
        let (title, _, _) = self.presentation();
        match self.target.as_deref() {
            Some(target) if self.category == "automation" => Cow::Owned(format!("{title} — {target}")),
            _ => Cow::Borrowed(title),
        }
    }
    pub fn presentation(&self) -> (&'static str, &'static str, &'static str) {
        match self.category.as_str() {
            "full-disk-access" => ("Full Disk Access", "Read the configured protected sentinel; no other files are checked.", "Privacy_AllFiles"),
            "screen-recording" => ("Screen Recording", "Capture and discard only this host’s synthetic red test window.", "Privacy_ScreenCapture"),
            "system-audio" => ("System Audio Recording", "Play harmless test audio for the three-second disposable check. Click Grant again to retry.", "Privacy_AudioCapture"),
            "accessibility" => ("Accessibility", "Read and discard the focused-application attribute without changing UI.", "Privacy_Accessibility"),
            "microphone" => ("Microphone", "Make a short disposable test capture; no recording is retained.", "Privacy_Microphone"),
            "notifications" => ("Notifications", "Submit one test notification; this does not prove visible delivery.", "NOTIFICATIONS"),
            "automation" => ("Automation", "Query only this allowlisted application’s name; the result is discarded. Click Grant again to retry.", "Privacy_Automation"),
            _ => ("Unknown permission", "Unsupported policy category.", ""),
        }
    }
    pub fn pane(&self) -> String {
        let (_, _, pane) = self.presentation();
        if pane == "NOTIFICATIONS" { "x-apple.systempreferences:com.apple.Notifications-Settings.extension".into() }
        else { format!("x-apple.systempreferences:com.apple.preference.security?{pane}") }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn only_positive_check_passes() {
        assert_eq!(State::from_check("passed"), State::Passed);
        for status in ["opened", "authorized", "unknown", "pending", "failed", ""] { assert_eq!(State::from_check(status), State::Failed); }
        assert_eq!(State::from_check("action-required"), State::ActionRequired);
    }
    #[test] fn enabled_categories_and_explicit_targets_only() {
        let rows = Row::enabled(&["full-disk-access".into(), "automation".into()], &["com.example.One".into(), "com.example.Two".into()]);
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].target, None);
        assert_eq!(rows[1].target.as_deref(), Some("com.example.One"));
        assert!(rows.iter().all(|row| row.state == State::Pending));
        assert!(Row::enabled(&["automation".into()], &[]).is_empty());
        assert!(Row::enabled(&[], &["com.example.One".into()]).is_empty());
    }
    #[test] fn automation_titles_identify_each_target() {
        let rows = Row::enabled(&["automation".into()], &["com.example.One".into(), "com.example.Two".into()]);
        assert_eq!(rows[0].title(), "Automation — com.example.One");
        assert_eq!(rows[1].title(), "Automation — com.example.Two");
        assert_ne!(rows[0].title(), rows[1].title());
        let ordinary = Row::enabled(&["microphone".into()], &[]);
        assert_eq!(ordinary[0].title(), "Microphone");
    }
    #[test] fn denial_and_revocation_replace_success() {
        let mut rows = Row::enabled(&["microphone".into()], &[]);
        rows[0].observe("passed", "Disposable capture succeeded".into());
        assert_eq!(rows[0].state, State::Passed);
        rows[0].observe("action-required", "Revoked".into());
        assert_eq!(rows[0].state, State::ActionRequired);
        assert_eq!(rows[0].detail, "Revoked");
    }
    #[test] fn categories_have_exact_distinct_panes() {
        let rows = Row::enabled(&["screen-recording".into(), "system-audio".into(), "notifications".into()], &[]);
        assert!(rows[0].pane().ends_with("?Privacy_ScreenCapture"));
        assert!(rows[1].pane().ends_with("?Privacy_AudioCapture"));
        assert_eq!(rows[2].pane(), "x-apple.systempreferences:com.apple.Notifications-Settings.extension");
    }
}
