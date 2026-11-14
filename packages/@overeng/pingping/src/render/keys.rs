use super::{span, Layout, Line, Role, StatsScope};

/// Dim key hint below the summary; the view status replaces the zoom/pan
/// keys once the view is zoomed or panned.
pub(super) fn key_hint(
    effective: Layout,
    requested: Layout,
    scope: StatsScope,
    view_hint: Option<&str>,
    hover_paused: bool,
) -> Line {
    let mode = if effective == requested {
        ""
    } else {
        " (terminal too short for stacked)"
    };
    let scope = scope.label();
    let frozen_hint = hover_paused.then(|| match view_hint {
        Some(hint) if hint.contains("0 live") => hint.replace("0 live", "hover paused"),
        Some(hint) => format!("hover paused · {hint}"),
        None => "hover paused".into(),
    });
    let view_hint = frozen_hint.as_deref().or(view_hint);
    let keys = view_hint.map_or_else(
        || format!("a add · e edit · d remove · ↑↓ select · q quit · l layout{mode} · s stats: {scope} · [ ] rate · +/- zoom · drag pan · 0 live"),
        |hint| format!("a add · e edit · d remove · ↑↓ select · q quit · l layout{mode} · s stats: {scope} · [ ] rate · {hint}"),
    );
    vec![span(Role::Plain, "  "), span(Role::Dim, keys)]
}
