//! One-line target editor for the live view. The caller keeps the prompt open
//! until it accepts an action; resolution failures come back through
//! `set_error` without losing the typed input.
//!
//! Printable ASCII and space only; IDNs must use punycode.
//! Control/Alt shortcuts never edit or submit; removal needs an unmodified
//! `y` (or Shift-Y), and Escape cancels without changing targets.

use std::borrow::Cow;

use crossterm::event::{KeyCode, KeyEvent, KeyEventKind, KeyModifiers};

use crate::{completion, target::TargetId};

const ASCII_ERROR: &str = "hostnames must be ASCII (use punycode for IDN)";

#[derive(Debug, PartialEq, Eq)]
pub enum PromptAction {
    None,
    Cancel,
    /// `edit` is the target to replace; `None` adds every host.
    Submit {
        edit: Option<TargetId>,
        hosts: Vec<String>,
    },
    Remove(TargetId),
}

enum Mode {
    Add,
    Edit(TargetId),
    Remove(TargetId, String),
}

/// Tab cycling state: the word span currently holding a candidate.
struct Completion {
    start: usize,
    end: usize,
    names: Vec<String>,
    next: usize,
}

pub struct Prompt {
    mode: Mode,
    input: String,
    /// Byte offset; accepted input is ASCII, so every byte is one character.
    cursor: usize,
    error: Option<Cow<'static, str>>,
    completion: Option<Completion>,
}

impl Prompt {
    #[must_use]
    pub fn add() -> Self {
        Self::new(Mode::Add, String::new())
    }

    #[must_use]
    pub fn edit(id: TargetId, name: impl Into<String>) -> Self {
        Self::new(Mode::Edit(id), name.into())
    }

    #[must_use]
    pub fn remove(id: TargetId, name: impl Into<String>) -> Self {
        Self::new(Mode::Remove(id, name.into()), String::new())
    }

    fn new(mode: Mode, input: String) -> Self {
        let valid = input.bytes().all(|byte| (b' '..=b'~').contains(&byte));
        let input = if valid { input } else { String::new() };
        Self {
            mode,
            cursor: input.len(),
            input,
            error: (!valid).then_some(Cow::Borrowed(ASCII_ERROR)),
            completion: None,
        }
    }

    pub fn set_error(&mut self, error: String) {
        self.error = Some(Cow::Owned(error));
    }

    fn fail(&mut self, error: &'static str) {
        self.error = Some(Cow::Borrowed(error));
    }

    /// The footer line with a visible insertion caret. Any error precedes the
    /// key hints so it stays within an ordinary 80-column terminal.
    #[must_use]
    pub fn line(&self) -> String {
        let mut line = String::with_capacity(self.input.len() + 80);
        match &self.mode {
            Mode::Add | Mode::Edit(_) => {
                line.push_str(if matches!(self.mode, Mode::Add) {
                    "Add hosts: "
                } else {
                    "Edit host: "
                });
                line.push_str(&self.input[..self.cursor]);
                line.push('▏');
                line.push_str(&self.input[self.cursor..]);
            }
            Mode::Remove(_, name) => {
                line.push_str("Remove ");
                line.push_str(name);
                line.push_str("? [y remove · n/Esc cancel]");
            }
        }
        match (&self.error, &self.mode) {
            (Some(error), mode) => {
                line.push_str(" — ");
                line.push_str(error);
                if !matches!(mode, Mode::Remove(..)) {
                    line.push_str(" [Esc cancel]");
                }
            }
            (None, Mode::Add) => line.push_str("  [Enter add · Tab complete · Esc cancel]"),
            (None, Mode::Edit(_)) => line.push_str("  [Enter save · Tab complete · Esc cancel]"),
            (None, Mode::Remove(..)) => {}
        }
        // Host names and resolver errors must not inject terminal controls.
        line.retain(|c| !c.is_control());
        line
    }

    pub fn handle(&mut self, key: &KeyEvent) -> PromptAction {
        self.handle_with(key, completion::host_names)
    }

    /// A paste is one operation: never insert a valid prefix of invalid text.
    pub fn paste(&mut self, text: &str) {
        if !text.bytes().all(|byte| (b' '..=b'~').contains(&byte)) {
            self.fail(ASCII_ERROR);
        } else if matches!(self.mode, Mode::Remove(..)) {
            self.fail("press y or n");
        } else {
            self.input.insert_str(self.cursor, text);
            self.cursor += text.len();
            self.error = None;
            self.completion = None;
        }
    }

    fn handle_with(
        &mut self,
        key: &KeyEvent,
        candidates: impl FnOnce(&str) -> Vec<String>,
    ) -> PromptAction {
        if key.kind == KeyEventKind::Release {
            return PromptAction::None;
        }
        if key.code == KeyCode::Esc {
            return PromptAction::Cancel;
        }
        if key
            .modifiers
            .intersects(KeyModifiers::CONTROL | KeyModifiers::ALT)
        {
            return PromptAction::None;
        }
        let edit = match self.mode {
            Mode::Add => None,
            Mode::Edit(id) => Some(id),
            Mode::Remove(id, _) => {
                return match key.code {
                    KeyCode::Char('y' | 'Y') => PromptAction::Remove(id),
                    KeyCode::Char('n' | 'N') => PromptAction::Cancel,
                    _ => {
                        self.fail("press y or n");
                        PromptAction::None
                    }
                };
            }
        };
        if key.code == KeyCode::Tab {
            self.complete(candidates);
            return PromptAction::None;
        }
        self.completion = None;
        match key.code {
            KeyCode::Enter => return self.submit(edit),
            KeyCode::Left => self.cursor = self.cursor.saturating_sub(1),
            KeyCode::Right => self.cursor = (self.cursor + 1).min(self.input.len()),
            KeyCode::Home => self.cursor = 0,
            KeyCode::End => self.cursor = self.input.len(),
            KeyCode::Backspace => {
                if self.cursor > 0 {
                    self.cursor -= 1;
                    self.input.remove(self.cursor);
                    self.error = None;
                }
            }
            KeyCode::Delete => {
                if self.cursor < self.input.len() {
                    self.input.remove(self.cursor);
                    self.error = None;
                }
            }
            KeyCode::Char(c) => {
                if (' '..='~').contains(&c) {
                    self.input.insert(self.cursor, c);
                    self.cursor += 1;
                    self.error = None;
                } else {
                    self.fail(ASCII_ERROR);
                }
            }
            _ => {}
        }
        PromptAction::None
    }

    fn submit(&mut self, edit: Option<TargetId>) -> PromptAction {
        let count = self.input.split_whitespace().count();
        if count == 0 {
            self.fail("enter at least one host");
            return PromptAction::None;
        }
        if edit.is_some() && count != 1 {
            self.fail("edit takes exactly one host");
            return PromptAction::None;
        }
        PromptAction::Submit {
            edit,
            hosts: self.input.split_whitespace().map(str::to_owned).collect(),
        }
    }

    /// The first Tab queries candidates for the word prefix before the cursor
    /// and replaces the whole word; further Tabs cycle without querying again.
    fn complete(&mut self, candidates: impl FnOnce(&str) -> Vec<String>) {
        if self.completion.is_none() {
            let start = self.input[..self.cursor]
                .char_indices()
                .rev()
                .find(|(_, c)| c.is_whitespace())
                .map_or(0, |(index, c)| index + c.len_utf8());
            let end = self.input[self.cursor..]
                .find(char::is_whitespace)
                .map_or(self.input.len(), |index| self.cursor + index);
            let names = candidates(&self.input[start..self.cursor]);
            if names.is_empty() {
                self.fail("no matching tailnet hosts");
                return;
            }
            self.completion = Some(Completion {
                start,
                end,
                names,
                next: 0,
            });
        }
        if let Some(completion) = &mut self.completion {
            let name = &completion.names[completion.next];
            self.input
                .replace_range(completion.start..completion.end, name);
            self.cursor = completion.start + name.len();
            completion.end = self.cursor;
            completion.next = (completion.next + 1) % completion.names.len();
            self.error = None;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    fn type_text(prompt: &mut Prompt, text: &str) {
        for c in text.chars() {
            assert_eq!(prompt.handle(&key(KeyCode::Char(c))), PromptAction::None);
        }
    }

    fn visible(prompt: &Prompt) -> String {
        prompt.line().chars().take(80).collect()
    }

    fn submit(edit: Option<TargetId>, hosts: &[&str]) -> PromptAction {
        PromptAction::Submit {
            edit,
            hosts: hosts.iter().map(|host| (*host).to_owned()).collect(),
        }
    }

    #[test]
    fn q_is_text_and_escape_cancels() {
        let mut prompt = Prompt::add();
        type_text(&mut prompt, "q");
        assert_eq!(prompt.handle(&key(KeyCode::Enter)), submit(None, &["q"]));
        assert_eq!(prompt.handle(&key(KeyCode::Esc)), PromptAction::Cancel);
    }

    #[test]
    fn add_accepts_multiple_hosts_and_retains_resolver_errors() {
        let mut prompt = Prompt::add();
        type_text(&mut prompt, "one  two three");
        prompt.set_error("could not resolve two".to_owned());
        assert!(visible(&prompt).contains("three▏ — could not resolve two"));
        assert_eq!(
            prompt.handle(&key(KeyCode::Enter)),
            submit(None, &["one", "two", "three"])
        );
    }

    #[test]
    fn edit_requires_exactly_one_host() {
        let mut prompt = Prompt::edit(7, "one");
        type_text(&mut prompt, " two");
        assert_eq!(prompt.handle(&key(KeyCode::Enter)), PromptAction::None);
        assert!(visible(&prompt).contains("exactly one host"));
        for _ in 0..4 {
            prompt.handle(&key(KeyCode::Backspace));
        }
        assert_eq!(
            prompt.handle(&key(KeyCode::Enter)),
            submit(Some(7), &["one"])
        );
    }

    #[test]
    fn empty_and_control_input_stay_open() {
        let mut prompt = Prompt::add();
        type_text(&mut prompt, "  ");
        assert_eq!(prompt.handle(&key(KeyCode::Enter)), PromptAction::None);
        assert!(prompt.line().contains("at least one"));
        prompt.handle(&key(KeyCode::Char('\n')));
        assert!(prompt.line().contains(ASCII_ERROR));
        assert!(!prompt.line().contains('\n'));
        let mut ctrl = KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL);
        assert_eq!(prompt.handle(&ctrl), PromptAction::None);
        ctrl.kind = KeyEventKind::Release;
        assert_eq!(prompt.handle(&ctrl), PromptAction::None);
        assert_eq!(prompt.handle(&key(KeyCode::Enter)), PromptAction::None);
        let mut invalid = Prompt::edit(1, "host\u{7}");
        assert!(!invalid.line().contains('\u{7}'));
        assert_eq!(invalid.input, "");
        assert!(invalid.line().contains(ASCII_ERROR));
        assert_eq!(invalid.handle(&key(KeyCode::Enter)), PromptAction::None);
    }

    #[test]
    fn non_ascii_keys_and_pastes_leave_the_buffer_unchanged() {
        for character in ['é', '\u{301}', '猫'] {
            let mut prompt = Prompt::edit(7, "cafe");
            assert_eq!(
                prompt.handle(&key(KeyCode::Char(character))),
                PromptAction::None
            );
            assert_eq!(prompt.input, "cafe");
            assert_eq!(prompt.cursor, 4);
            assert!(prompt.line().contains(ASCII_ERROR));
        }
        for text in [
            "café",
            "cafe\u{301}",
            "猫",
            "host-a\nhost-b",
            "host-a\thost-b",
        ] {
            let mut prompt = Prompt::edit(7, "original");
            prompt.paste(text);
            assert_eq!(prompt.input, "original");
            assert_eq!(prompt.cursor, 8);
            assert!(prompt.line().contains(ASCII_ERROR));
        }
        let invalid_prefill = Prompt::edit(7, "café");
        assert_eq!(invalid_prefill.input, "");
        assert!(invalid_prefill.line().contains(ASCII_ERROR));
    }

    #[test]
    fn ascii_cursor_edits_and_paste_preserve_expected_boundaries() {
        let mut prompt = Prompt::add();
        prompt.paste("abcd");
        prompt.handle(&key(KeyCode::Left));
        prompt.handle(&key(KeyCode::Backspace));
        prompt.handle(&key(KeyCode::Left));
        prompt.handle(&key(KeyCode::Delete));
        prompt.handle(&key(KeyCode::Home));
        prompt.handle(&key(KeyCode::Right));
        type_text(&mut prompt, "x");
        assert!(prompt.line().starts_with("Add hosts: ax▏d"));
        prompt.handle(&key(KeyCode::End));
        assert_eq!(prompt.handle(&key(KeyCode::Enter)), submit(None, &["axd"]));
    }

    #[test]
    fn completion_replaces_current_word_and_cycles_without_querying_again() {
        let mut prompt = Prompt::add();
        type_text(&mut prompt, "one hoZZ three");
        prompt.handle(&key(KeyCode::Home));
        for _ in 0..6 {
            prompt.handle(&key(KeyCode::Right));
        }
        prompt.handle_with(&key(KeyCode::Tab), |prefix| {
            assert_eq!(prefix, "ho");
            vec!["host-a".to_owned(), "host-b".to_owned()]
        });
        prompt.handle_with(&key(KeyCode::Tab), |_| panic!("must reuse candidates"));
        assert_eq!(
            prompt.handle(&key(KeyCode::Enter)),
            submit(None, &["one", "host-b", "three"])
        );
        prompt.handle_with(&key(KeyCode::Tab), |_| Vec::new());
        assert!(visible(&prompt).contains("no matching tailnet hosts"));
    }

    #[test]
    fn remove_requires_explicit_confirmation() {
        let mut prompt = Prompt::remove(9, "host");
        assert_eq!(prompt.handle(&key(KeyCode::Enter)), PromptAction::None);
        assert_eq!(prompt.handle(&key(KeyCode::Char('q'))), PromptAction::None);
        assert!(prompt.line().ends_with("— press y or n"));
        for c in ['y', 'Y'] {
            assert_eq!(
                prompt.handle(&key(KeyCode::Char(c))),
                PromptAction::Remove(9)
            );
        }
        for c in ['n', 'N'] {
            assert_eq!(prompt.handle(&key(KeyCode::Char(c))), PromptAction::Cancel);
        }
        assert_eq!(prompt.handle(&key(KeyCode::Esc)), PromptAction::Cancel);
    }

    #[test]
    fn modified_shortcuts_cannot_confirm_removal() {
        let mut prompt = Prompt::remove(9, "host");
        for modifiers in [
            KeyModifiers::CONTROL,
            KeyModifiers::ALT,
            KeyModifiers::CONTROL | KeyModifiers::ALT,
            KeyModifiers::CONTROL | KeyModifiers::SHIFT,
            KeyModifiers::ALT | KeyModifiers::SHIFT,
        ] {
            for c in ['y', 'Y', 'n', 'N'] {
                assert_eq!(
                    prompt.handle(&KeyEvent::new(KeyCode::Char(c), modifiers)),
                    PromptAction::None
                );
            }
        }
        assert_eq!(
            prompt.handle(&KeyEvent::new(KeyCode::Char('Y'), KeyModifiers::SHIFT)),
            PromptAction::Remove(9)
        );
    }
}
