//! Target selection and focused inline editing, separate from timeline gestures.
use std::io;
use std::os::unix::net::UnixStream;

use crossterm::event::{
    Event, KeyCode, KeyEvent, KeyEventKind, KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};

use super::resolve::Resolver;
use super::Geometry;
use crate::prompt::{Prompt, PromptAction};
use crate::runtime::Runtime;
use crate::target::TargetId;

pub(super) struct Editor {
    selected: Option<TargetId>,
    prompt: Option<Prompt>,
    pending: Option<u64>,
    resolver: Resolver,
}

impl Editor {
    pub fn new(runtime: &Runtime) -> io::Result<Self> {
        Ok(Self {
            selected: runtime.hosts.first().map(|host| host.id),
            prompt: None,
            pending: None,
            resolver: Resolver::new(runtime.family())?,
        })
    }

    pub fn selected(&self) -> Option<TargetId> {
        self.selected
    }

    pub fn notification(&self) -> &UnixStream {
        &self.resolver.notification
    }

    pub fn footer(&self) -> Option<String> {
        self.prompt.as_ref().map(|prompt| {
            let line = prompt.line();
            if self.pending.is_some() {
                format!("Resolving… (Esc cancels) · {line}")
            } else {
                line
            }
        })
    }

    pub fn receive(&mut self, runtime: &mut Runtime) -> io::Result<bool> {
        let mut changed = false;
        while let Some(result) = self.resolver.try_result()? {
            if self.pending != Some(result.generation) {
                continue;
            }
            self.pending = None;
            changed = true;
            match result.result {
                Err(error) => {
                    if let Some(prompt) = &mut self.prompt {
                        prompt.set_error(error);
                    }
                }
                Ok(hosts) => {
                    for (name, address) in hosts {
                        self.selected = if let Some(id) = result.edit {
                            runtime.edit_resolved(id, name, address)?
                        } else {
                            Some(runtime.add_resolved(name, address)?)
                        };
                    }
                    self.prompt = None;
                }
            }
        }
        Ok(changed)
    }

    /// True consumes input; false leaves it to the shared timeline controls.
    pub fn update(&mut self, event: &Event, geometry: &Geometry, runtime: &mut Runtime) -> bool {
        if let Some(prompt) = &mut self.prompt {
            if let Event::Paste(text) = event {
                if self.pending.is_none() {
                    prompt.paste(text);
                }
                return true;
            }
            let Event::Key(key) = event else {
                return !matches!(event, Event::Resize(..));
            };
            if self.pending.is_some() {
                if key.code == KeyCode::Esc && key.kind != KeyEventKind::Release {
                    self.resolver.cancel();
                    self.pending = None;
                    self.prompt = None;
                }
                return true;
            }
            match prompt.handle(key) {
                PromptAction::None => {}
                PromptAction::Cancel => self.prompt = None,
                PromptAction::Remove(id) => {
                    let old = runtime
                        .hosts
                        .iter()
                        .position(|host| host.id == id)
                        .unwrap_or(0);
                    runtime.retire(id);
                    self.selected = runtime
                        .hosts
                        .get(old.min(runtime.hosts.len().saturating_sub(1)))
                        .map(|host| host.id);
                    self.prompt = None;
                }
                PromptAction::Submit { edit, hosts } => {
                    self.pending = Some(self.resolver.submit(edit, hosts));
                }
            }
            return true;
        }
        match event {
            Event::Key(KeyEvent {
                code,
                modifiers,
                kind: KeyEventKind::Press | KeyEventKind::Repeat,
                ..
            }) if !modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) => {
                match code {
                    KeyCode::Char('a') => self.prompt = Some(Prompt::add()),
                    KeyCode::Char('e' | 'd') => {
                        if let Some(host) = runtime
                            .hosts
                            .iter()
                            .find(|host| Some(host.id) == self.selected)
                        {
                            self.prompt = Some(if *code == KeyCode::Char('e') {
                                Prompt::edit(host.id, host.host.clone())
                            } else {
                                Prompt::remove(host.id, host.host.clone())
                            });
                        }
                    }
                    KeyCode::Up | KeyCode::Down => {
                        if !runtime.hosts.is_empty() {
                            let index = runtime
                                .hosts
                                .iter()
                                .position(|host| Some(host.id) == self.selected)
                                .unwrap_or(0);
                            let index = if *code == KeyCode::Up {
                                index.saturating_sub(1)
                            } else {
                                (index + 1).min(runtime.hosts.len() - 1)
                            };
                            self.selected = Some(runtime.hosts[index].id);
                        }
                    }
                    _ => return false,
                }
                true
            }
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                row,
                ..
            }) => {
                if let Some(id) = geometry
                    .host_at(*row)
                    .filter(|id| runtime.hosts.iter().any(|host| host.id == *id))
                {
                    self.selected = Some(id);
                }
                false // A chart click may also begin a drag or grab its overview.
            }
            _ => false,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::probe::{Family, ProbeConfig};
    use crate::stats::HostState;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    fn runtime() -> Runtime {
        let (events, _) = mpsc::channel();
        let mut runtime = Runtime::new(
            Vec::new(),
            ProbeConfig {
                interval: Duration::from_secs(1),
                timeout: Duration::from_secs(1),
                count: None,
                family: Family::Any,
                start: Instant::now(),
            },
            events,
            None,
        );
        for id in [41, 73] {
            let mut host = HostState::new(format!("host-{id}"));
            host.id = id;
            runtime.hosts.push(host);
        }
        runtime
    }

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent::new(code, KeyModifiers::NONE))
    }

    #[test]
    fn selection_and_confirmed_removal_follow_ids_not_positions() {
        let mut runtime = runtime();
        let mut editor = Editor::new(&runtime).unwrap();
        let geometry = Geometry::default();
        assert!(editor.update(&key(KeyCode::Down), &geometry, &mut runtime));
        assert_eq!(editor.selected(), Some(73));
        assert!(editor.update(&key(KeyCode::Char('d')), &geometry, &mut runtime));
        assert_eq!(runtime.hosts.len(), 2);
        editor.update(&key(KeyCode::Char('n')), &geometry, &mut runtime);
        assert_eq!(runtime.hosts.len(), 2);
        editor.update(&key(KeyCode::Char('d')), &geometry, &mut runtime);
        editor.update(&key(KeyCode::Char('y')), &geometry, &mut runtime);
        assert_eq!(runtime.hosts.len(), 1);
        assert_eq!(editor.selected(), Some(41));
        editor.update(&key(KeyCode::Char('d')), &geometry, &mut runtime);
        editor.update(&key(KeyCode::Char('y')), &geometry, &mut runtime);
        assert_eq!(runtime.hosts.len(), 0);
        assert!(!runtime.finished());
        assert_eq!(editor.selected(), None);
    }

    #[test]
    fn prompt_captures_quit_and_view_keys_until_escape() {
        let mut runtime = runtime();
        let mut editor = Editor::new(&runtime).unwrap();
        let geometry = Geometry::default();
        editor.update(&key(KeyCode::Char('a')), &geometry, &mut runtime);
        for character in ['q', '[', '+'] {
            assert!(editor.update(&key(KeyCode::Char(character)), &geometry, &mut runtime));
        }
        assert!(editor.footer().unwrap().contains("q[+"));
        editor.update(&key(KeyCode::Esc), &geometry, &mut runtime);
        assert!(editor.footer().is_none());
        assert!(!editor.update(&key(KeyCode::Char('q')), &geometry, &mut runtime));
    }

    #[test]
    fn bracketed_paste_uses_atomic_prompt_validation() {
        let mut runtime = runtime();
        let mut editor = Editor::new(&runtime).unwrap();
        let geometry = Geometry::default();
        editor.update(&key(KeyCode::Char('a')), &geometry, &mut runtime);
        assert!(editor.update(&Event::Paste("host-a host-b".into()), &geometry, &mut runtime));
        assert!(editor.footer().unwrap().contains("host-a host-b▏"));
        assert!(editor.update(&Event::Paste("cafe\u{301}".into()), &geometry, &mut runtime));
        let footer = editor.footer().unwrap();
        assert!(footer.contains("host-a host-b▏"));
        assert!(footer.contains("hostnames must be ASCII (use punycode for IDN)"));
        assert!(!footer.contains("cafe"));
        assert_eq!(runtime.hosts.len(), 2);
    }
}
