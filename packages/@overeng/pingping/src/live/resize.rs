//! Reflow accounting is only needed on resize; the normal path remains row-diffed.
use unicode_width::UnicodeWidthChar;

use crate::render::Line;

/// A width decrease can reflow the frame while leaving a bottom-clamped
/// cursor unchanged. Its reply then cannot distinguish reflow from no reflow.
/// Remember intermediate decreases even when a resize burst grows back.
/// Later grows can bring displaced fragments back from scrollback, so all
/// subsequent resizes need the same visible-pane reset, not ordinary draws.
#[derive(Default)]
pub(super) struct Damage {
    drawn_width: usize,
    shrunk: bool,
    reflowed: bool,
}

impl Damage {
    pub(super) fn observe(&mut self, width: usize) {
        self.shrunk |= width < self.drawn_width;
    }

    pub(super) fn take(&mut self, width: usize, resized: bool) -> bool {
        self.observe(width);
        self.drawn_width = width;
        let shrunk = std::mem::take(&mut self.shrunk);
        self.reflowed |= shrunk;
        shrunk || (resized && self.reflowed)
    }
}

pub(super) fn rows(lines: &[Line], width: usize) -> usize {
    let width = width.max(1);
    lines
        .iter()
        .map(|line| {
            let mut rows = 1;
            let mut column = 0;
            for ch in line.iter().flat_map(|span| span.text.chars()) {
                let cells = ch.width().unwrap_or(0).min(width);
                if cells == 0 {
                    continue;
                }
                if column + cells > width {
                    rows += 1;
                    column = 0;
                }
                column += cells;
            }
            rows
        })
        .sum()
}

pub(super) fn top(
    lines: &[Line],
    width: usize,
    cursor_row: usize,
    previous_top: Option<usize>,
) -> usize {
    // A non-reflowing terminal leaves the cursor directly below the same rows.
    // Do not erase pre-existing output above the frame in that case.
    if let Some(top) = previous_top.filter(|top| top + lines.len() == cursor_row) {
        return top;
    }
    cursor_row.saturating_sub(rows(lines, width))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::render::{Role, Span, Tint};
    fn lines(text: &[&str]) -> Vec<Line> {
        text.iter()
            .map(|text| {
                vec![Span {
                    role: Role::Plain,
                    text: (*text).into(),
                    tint: Tint::None,
                }]
            })
            .collect()
    }
    #[test]
    fn shrink_damage_survives_a_grow_back_burst_until_redrawn() {
        let mut damage = Damage::default();
        assert!(!damage.take(200, false));
        damage.observe(120);
        damage.observe(220);
        assert!(damage.take(220, true));
        assert!(!damage.take(220, false));
        assert!(
            damage.take(240, true),
            "grows can restore stale history rows"
        );
        assert!(
            !damage.take(240, false),
            "ordinary row diffs retain the pane"
        );
        assert!(damage.take(80, true));
    }

    #[test]
    fn shrunk_rows_include_wraps_and_empty_lines() {
        let lines = lines(&["abcdefghij", "", "abcd"]);
        assert_eq!(rows(&lines, 4), 5);
        assert_eq!(rows(&lines, 12), 3);
        assert_eq!(top(&lines, 4, 12, Some(4)), 7);
        assert_eq!(top(&lines, 4, 3, Some(0)), 0);
    }
    #[test]
    fn wide_characters_wrap_before_the_last_column() {
        assert_eq!(rows(&lines(&["aaaa界aa界aa界"]), 5), 4);
        assert_eq!(rows(&lines(&["界界", "e\u{301}"]), 4), 2);
    }
    #[test]
    fn non_reflowing_terminal_preserves_output_above_frame() {
        let lines = lines(&["abcdefghij", "second"]);
        assert_eq!(top(&lines, 4, 10, Some(8)), 8);
    }
}
