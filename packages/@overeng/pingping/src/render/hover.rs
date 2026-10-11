use super::{span, Line, Role, Span};
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// Appends a cursor-local readout without changing any fixed identity spans.
///
/// The caller must first remove the path note and drop notice (including their
/// padding). `pointer_col` is a zero-based terminal column, not a chart cell;
/// passing `width` requests right alignment, as for a path-note hover.
/// The pill keeps a two-cell gap after the prefix and stays inside `width`.
/// If even one description cell plus pill padding cannot fit, nothing is added.
pub(super) fn append(line: &mut Line, description: &str, width: usize, pointer_col: usize) {
    let used: usize = line.iter().map(|part| part.text.width()).sum();
    let available = width.saturating_sub(used).saturating_sub(2);
    if available < 3 {
        return;
    }
    let description = cell_prefix(description, available - 2);
    if description.width() == 0 {
        return;
    }
    let pill: Span = span(Role::Tooltip, format!(" {description} "));
    let start = pointer_col.clamp(used + 2, width - pill.text.width());
    line.extend([span(Role::Plain, " ".repeat(start - used)), pill]);
}

/// Keeps whole Unicode scalars, including zero-width combining marks after a
/// retained character, while counting terminal cells rather than UTF-8 bytes.
fn cell_prefix(text: &str, limit: usize) -> &str {
    if text.width() <= limit {
        return text;
    }
    let mut cells = 0;
    let end = text
        .char_indices()
        .find_map(|(byte, ch)| {
            cells += ch.width().unwrap_or(0);
            (cells > limit).then_some(byte)
        })
        .unwrap_or(text.len());
    let mut prefix = &text[..end];
    // Presentation selectors can make a sequence wider than the sum of its
    // scalar widths. Recheck only this truncated candidate.
    while prefix.width() > limit {
        let Some((last, _)) = prefix.char_indices().next_back() else {
            break;
        };
        prefix = &prefix[..last];
    }
    prefix
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> Line {
        vec![span(Role::Host, "host"), span(Role::Label, " 127.0.0.1")]
    }

    fn pill(line: &Line) -> (usize, &str) {
        let index = line
            .iter()
            .position(|part| part.role == Role::Tooltip)
            .unwrap();
        let start = line[..index].iter().map(|part| part.text.width()).sum();
        (start, &line[index].text)
    }

    #[test]
    fn follows_pointer_until_prefix_or_right_edge_requires_clamping() {
        let fixed = identity();
        let used: usize = fixed.iter().map(|part| part.text.width()).sum();
        let width = 80;
        for pointer in [0, 35, width, usize::MAX] {
            let mut line = fixed.clone();
            append(&mut line, "readout", width, pointer);
            assert_eq!(&line[..fixed.len()], &fixed);
            let (start, text) = pill(&line);
            assert_eq!(start, pointer.clamp(used + 2, width - text.width()));
            assert!(start + text.width() <= width);
        }
    }

    #[test]
    fn narrow_width_never_overwrites_identity() {
        let fixed = identity();
        let used: usize = fixed.iter().map(|part| part.text.width()).sum();
        for width in 0..used + 5 {
            let mut line = fixed.clone();
            append(&mut line, "readout", width, 0);
            assert_eq!(line, fixed);
        }
        let mut line = fixed.clone();
        append(&mut line, "readout", used + 5, 0);
        assert_eq!(&line[..fixed.len()], &fixed);
        let (start, text) = pill(&line);
        assert_eq!(start, used + 2);
        assert_eq!(text.trim(), "r");
        assert_eq!(start + text.width(), used + 5);
    }

    #[test]
    fn truncation_counts_wide_cells_and_keeps_combining_marks() {
        let fixed = vec![span(Role::Host, "界")];
        let mut line = fixed.clone();
        append(&mut line, "界e\u{301}界tail", 11, usize::MAX);
        assert_eq!(&line[..fixed.len()], &fixed);
        let (start, text) = pill(&line);
        assert_eq!(text.trim(), "界e\u{301}界");
        assert_eq!(text.width(), 7);
        assert_eq!(start + text.width(), 11);

        let mut too_narrow = fixed.clone();
        append(&mut too_narrow, "界", 7, 0);
        assert_eq!(too_narrow, fixed);
    }

    #[test]
    fn emoji_presentation_sequence_cannot_exceed_the_terminal_edge() {
        for description in ["❤\u{fe0f}", "❤\u{fe0f}tail"] {
            let mut line = vec![];
            append(&mut line, description, 5, usize::MAX);
            let (start, text) = pill(&line);
            assert_eq!(text.trim(), "❤");
            assert_eq!(start + text.width(), 5);
        }
    }
}
