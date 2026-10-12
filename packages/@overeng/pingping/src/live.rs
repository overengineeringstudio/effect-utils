//! Inline live view: updates changed rows below the prompt and leaves the last
//! frame in scrollback. Input and probes wake a blocked UI; dirty bursts render
//! at most once per 16 ms, with no periodic redraws or idle input wakeups.
mod resize;

use std::io::{self, Read, Write};
use std::os::fd::AsFd;
use std::os::unix::net::UnixStream;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, TryRecvError};
use std::time::{Duration, Instant, SystemTime};

use crossterm::event::{
    self, DisableMouseCapture, EnableMouseCapture, Event, KeyCode, KeyEvent, KeyEventKind,
    KeyModifiers, MouseButton, MouseEvent, MouseEventKind,
};
use crossterm::style::{PrintStyledContent, StyledContent};
use crossterm::terminal::{self, BeginSynchronizedUpdate, ClearType, EndSynchronizedUpdate};
use crossterm::{cursor, queue};

use crate::probe::ProbeEvent;
use crate::render::{self, Hover, Layout, Line, StatsScope, Timeline};
use crate::stats::HostState;
use crate::theme::{self, Theme, ThemeChoice};
use crate::timeline::{Extent, Grid, View};
use nix::errno::Errno;
use nix::poll::{poll, PollFd, PollFlags, PollTimeout};

/// Restores the terminal even when the loop returns early.
struct RawGuard;

impl Drop for RawGuard {
    fn drop(&mut self) {
        let mut out = io::stdout();
        let _ = queue!(out, DisableMouseCapture, cursor::Show);
        let _ = out.flush();
        let _ = terminal::disable_raw_mode();
        let _ = out.flush();
    }
}

#[allow(
    clippy::too_many_arguments,
    clippy::too_many_lines,
    reason = "shared path monitor uses the existing UI event channel"
)]
pub fn run(
    hosts: &mut [HostState],
    rx: &Receiver<(usize, ProbeEvent)>,
    notification: &UnixStream,
    stop: &AtomicBool,
    mut layout: Layout,
    theme_choice: ThemeChoice,
    interval: Duration,
    paths: &crate::path::Monitor,
    schedule: &crate::probe::Schedule,
) -> io::Result<()> {
    terminal::enable_raw_mode()?;
    for host in &mut *hosts {
        host.set_interval(interval);
    }
    let _guard = RawGuard;
    let theme = choose_theme(theme_choice);
    let stdout = io::stdout();
    let mut out = stdout.lock();
    // Captured after the background query so mouse reports cannot interleave
    // with its reply. Capture routes the wheel to pingping instead of the
    // terminal scrollback while the view is live.
    queue!(out, cursor::Hide, EnableMouseCapture)?;

    let mut controls = Controls::default();
    let mut geometry = Geometry::default();
    let mut hover = None;
    let mut resized = false;
    let mut resize_damage = resize::Damage::default();
    let mut drawn = 0usize;
    let mut previous_lines = Vec::new();
    let mut input = None;
    let mut input_pending = false;
    let mut dirty = true;
    let mut deferred_input = None;
    let mut done = false;
    let mut next_draw = Instant::now();
    let mut marker_expiry = None;
    while !done {
        // The reader is parked after Resize; coalesce queued SIGWINCH events
        // before querying the resized cursor, preserving any other input.
        if resized && deferred_input.is_none() && Instant::now() >= next_draw {
            while event::poll(Duration::ZERO)? {
                let event = event::read()?;
                if let Event::Resize(width, _) = event {
                    resize_damage.observe(usize::from(width));
                    next_draw = Instant::now() + Duration::from_millis(16);
                } else {
                    deferred_input = Some(event);
                    break;
                }
            }
        }
        if marker_expiry.is_some_and(|deadline| Instant::now() >= deadline) {
            marker_expiry = None;
            dirty = true;
        }
        if dirty && Instant::now() >= next_draw {
            let timeline = Timeline {
                view: controls.display_view(),
                stats_scope: controls.stats_scope,
                interval,
                current_interval: schedule.interval(),
                hover,
                now: SystemTime::now(),
                hover_now: controls.frozen.map(|frozen| frozen.now),
                overview_end: controls.frozen.map(|frozen| frozen.end),
            };
            let previous = drawn;
            let frame;
            (drawn, frame) = draw(
                &mut out,
                &theme,
                hosts,
                layout,
                &timeline,
                &mut previous_lines,
                true,
                resized,
                geometry.top,
                &mut resize_damage,
            )?;
            // The initial query precedes the blocking input reader. On resize,
            // that reader is parked waiting for our post-draw acknowledgement.
            geometry.locate(drawn, previous, resized || input.is_none())?;
            resized = false;
            geometry.set_frame(frame);
            dirty = false;
            next_draw = Instant::now() + Duration::from_millis(16);
            marker_expiry = hosts
                .iter()
                .filter_map(|host| host.path.marker_remaining(timeline.now))
                .min()
                .map(|remaining| Instant::now() + remaining);
        }
        if input.is_none() {
            input = Some(InputWake::new()?);
        }
        let input = input
            .as_ref()
            .expect("reader initialized after the first frame");
        if input_pending && !dirty {
            input.acknowledge();
            input_pending = false;
        }
        // Crossterm's wake thread watches terminal input and SIGWINCH; workers
        // notify separately. Both wake the UI without polling probe outcomes.
        let mut terminal_event = if resized { None } else { deferred_input.take() };
        if terminal_event.is_none() {
            terminal_event = input.try_event()?;
        }
        if terminal_event.is_none() {
            wait_for_activity(
                notification,
                &input.notification,
                dirty.then_some(next_draw).or(marker_expiry),
            )?;
            terminal_event = input.try_event()?;
        }
        if let Some(event) = terminal_event {
            if let Event::Key(KeyEvent {
                code: KeyCode::Char(key @ ('[' | ']')),
                kind: KeyEventKind::Press,
                ..
            }) = &event
            {
                let interval = crate::probe::step_interval(schedule.interval(), *key == ']');
                if interval != schedule.interval() {
                    schedule.change(interval, Instant::now());
                    dirty = true;
                }
            }
            input_pending = matches!(event, Event::Resize(..));
            if let Event::Resize(width, _) = event {
                resize_damage.observe(usize::from(width));
            }
            resized |= input_pending;
            if input_pending {
                next_draw = Instant::now() + Duration::from_millis(16);
            }
            let (redraw, quit) = controls.update(
                &event,
                &geometry,
                Extent::of(hosts),
                &mut layout,
                &mut hover,
            );
            dirty |= redraw;
            done |= quit;
            if !input_pending {
                input.acknowledge();
            }
        }
        done |= receive_probes(hosts, rx, &mut dirty, paths);
    }
    stop.store(true, Ordering::Relaxed);
    let timeline = Timeline {
        view: controls.view,
        stats_scope: StatsScope::Run,
        interval,
        current_interval: schedule.interval(),
        hover: None,
        now: SystemTime::now(),
        hover_now: None,
        overview_end: None,
    };
    draw(
        &mut out,
        &theme,
        hosts,
        layout,
        &timeline,
        &mut previous_lines,
        false,
        false,
        geometry.top,
        &mut resize_damage,
    )?;
    Ok(())
}

fn choose_theme(choice: ThemeChoice) -> Theme {
    Theme::new(match choice {
        ThemeChoice::Light => false,
        ThemeChoice::Dark => true,
        // Unknown backgrounds get the dark palette, the more common default.
        ThemeChoice::Auto => theme::detect_dark_background().unwrap_or(true),
    })
}

/// Drains one ready probe burst; returns true once every worker has finished.
fn receive_probes(
    hosts: &mut [HostState],
    rx: &Receiver<(usize, ProbeEvent)>,
    dirty: &mut bool,
    paths: &crate::path::Monitor,
) -> bool {
    loop {
        match rx.try_recv() {
            Ok((index, event)) => {
                match &event {
                    ProbeEvent::Resolved(address) => paths.resolved(index, *address),
                    ProbeEvent::Finished | ProbeEvent::Failed { .. } => paths.finished(index),
                    _ => {}
                }
                hosts[index].apply(event);
                *dirty = true;
            }
            Err(TryRecvError::Empty) => return hosts.iter().all(|host| host.finished),
            Err(TryRecvError::Disconnected) => return true,
        }
    }
}

fn wait_for_activity(
    notification: &UnixStream,
    input: &UnixStream,
    redraw: Option<Instant>,
) -> io::Result<()> {
    let mut descriptors = [
        PollFd::new(input.as_fd(), PollFlags::POLLIN),
        PollFd::new(notification.as_fd(), PollFlags::POLLIN),
    ];
    let timeout = redraw.map_or(PollTimeout::NONE, |deadline| {
        let wait = deadline.saturating_duration_since(Instant::now());
        PollTimeout::try_from(wait.as_nanos().div_ceil(1_000_000)).unwrap_or(PollTimeout::MAX)
    });
    match poll(&mut descriptors, timeout) {
        Ok(_) | Err(Errno::EINTR) => {}
        Err(err) => return Err(io::Error::from_raw_os_error(err as i32)),
    }
    drain_notification(notification)?;
    drain_notification(input)
}

fn drain_notification(mut notification: &UnixStream) -> io::Result<()> {
    let mut bytes = [0; 256];
    loop {
        match notification.read(&mut bytes) {
            Ok(0) => break,
            Ok(_) => {}
            Err(err) if err.kind() == io::ErrorKind::WouldBlock => break,
            Err(err) if err.kind() == io::ErrorKind::Interrupted => {}
            Err(err) => return Err(err),
        }
    }
    Ok(())
}

/// Crossterm owns terminal input and its SIGWINCH pipe. Block there without
/// idle wakeups. Resize events park until the UI finishes its cursor query;
/// other inputs are acknowledged immediately so bursts can be coalesced.
/// The reader is deliberately detached: process exit ends a blocked read,
/// while joining it would require polling or synthetic terminal input.
struct InputWake {
    notification: UnixStream,
    events: Receiver<io::Result<Event>>,
    acknowledge: mpsc::SyncSender<()>,
}

impl InputWake {
    fn new() -> io::Result<Self> {
        let (notification, mut sender) = UnixStream::pair()?;
        notification.set_nonblocking(true)?;
        sender.set_nonblocking(true)?;
        let (acknowledge, acknowledgements) = mpsc::sync_channel(1);
        let (events, receiver) = mpsc::channel();
        std::thread::spawn(move || loop {
            let event = event::read();
            if events.send(event).is_err() {
                break;
            }
            let _ = sender.write_all(&[1]);
            if acknowledgements.recv().is_err() {
                break;
            }
        });
        Ok(Self {
            notification,
            events: receiver,
            acknowledge,
        })
    }

    fn try_event(&self) -> io::Result<Option<Event>> {
        match self.events.try_recv() {
            Ok(event) => event.map(Some),
            Err(TryRecvError::Empty) => Ok(None),
            Err(TryRecvError::Disconnected) => {
                Err(io::Error::other("terminal input worker disconnected"))
            }
        }
    }

    fn acknowledge(&self) {
        let _ = self.acknowledge.try_send(());
    }
}

#[derive(Debug, PartialEq, Eq)]
enum Action {
    None,
    Redraw,
    ToggleLayout,
    Quit,
}

/// Maps terminal input to view changes. Wheel up/down zooms around the
/// pointer, dragging or horizontal scrolling pans (dragging right reveals
/// older samples), `+`/`-` zoom, arrows pan, `0` returns to the live view.
#[derive(Debug, Default)]
struct Controls {
    view: View,
    stats_scope: StatsScope,
    /// Capture the overview scale and window at mouse-down, not on redraw.
    drag: Option<Drag>,
    /// Last pointer position (column, row) reported by the terminal.
    pointer: Option<(u16, u16)>,
    /// Temporary display freeze; the user's view remains live underneath it.
    frozen: Option<HoverFreeze>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Drag {
    Timeline { column: u16 },
    Overview { column: u16, grid: Grid, view: View },
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct HoverFreeze {
    view: View,
    end: f64,
    now: SystemTime,
}

/// Where the last frame's timelines are on screen.
#[derive(Debug, Default)]
struct Geometry {
    /// Screen row of the frame's first line.
    top: Option<usize>,
    /// Physical terminal-column (origin, width), never raster subcells.
    timeline: (usize, usize),
    /// `(line, host, is_overview)` of each timeline/overview line.
    lines: Vec<(usize, usize, bool)>,
    /// Per host, the overview grid when its overview is drawn.
    overviews: Vec<Option<Grid>>,
    notes: Vec<(usize, usize, usize, usize)>,
}

impl Geometry {
    fn set_frame(&mut self, frame: render::Frame) {
        self.timeline = frame.timeline;
        self.lines = frame.timeline_lines;
        self.overviews = frame.overviews;
        self.notes = frame.notes;
    }

    fn locate(&mut self, drawn: usize, previous: usize, query: bool) -> io::Result<()> {
        if query {
            self.top = cursor::position()
                .ok()
                .and_then(|(_, row)| usize::from(row).checked_sub(drawn));
        } else if drawn > previous {
            // Growing a frame can scroll its top upward. Shrinking cannot:
            // drawing starts at the old top and clears the removed rows.
            let height = usize::from(terminal::size()?.1);
            self.top = self
                .top
                .map(|top| top.min(height.saturating_sub(drawn + 1)));
        }
        Ok(())
    }

    fn hover_at(&self, column: u16, row: u16) -> Option<Hover> {
        let line = usize::from(row).checked_sub(self.top?)?;
        if let Some(&(_, host, _, _)) = self.notes.iter().find(|(at, _, start, end)| {
            *at == line && (*start..*end).contains(&usize::from(column))
        }) {
            return Some(Hover {
                host,
                cell: render::NOTE_CELL,
                overview: false,
            });
        }
        let &(_, host, overview) = self.lines.iter().find(|(at, _, _)| *at == line)?;
        let cell = usize::from(column).checked_sub(self.timeline.0)?;
        (cell < self.timeline.1).then_some(Hover {
            host,
            cell,
            overview,
        })
    }

    fn overview(&self, host: usize) -> Option<Grid> {
        self.overviews.get(host).copied().flatten()
    }
}

impl Controls {
    fn display_view(&self) -> View {
        self.frozen.map_or(self.view, |frozen| frozen.view)
    }

    fn wheel_zoom(&mut self, zoom_in: bool, anchor: Option<usize>, width: usize, extent: Extent) {
        if let Some(frozen) = &mut self.frozen {
            let end = frozen.view.end.unwrap_or(frozen.end);
            frozen.view.zoom(
                zoom_in,
                anchor,
                width,
                Extent {
                    latest: frozen.end,
                    ..extent
                },
            );
            frozen.view.end.get_or_insert(end);
            self.view.level = frozen.view.level;
        } else {
            self.view.zoom(zoom_in, anchor, width, extent);
        }
    }

    /// Applies an input event, returning `(redraw, quit)`.
    fn update(
        &mut self,
        event: &Event,
        geometry: &Geometry,
        extent: Extent,
        layout: &mut Layout,
        hover: &mut Option<Hover>,
    ) -> (bool, bool) {
        let previous_freeze = self.frozen;
        let retains_freeze = match event {
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Moved,
                ..
            })
            | Event::Resize(..) => true,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::ScrollUp | MouseEventKind::ScrollDown,
                column,
                row,
                ..
            }) => geometry
                .hover_at(*column, *row)
                .is_some_and(|hover| hover.cell != render::NOTE_CELL),
            _ => false,
        };
        let grabs_overview = matches!(
            event,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Down(MouseButton::Left),
                column,
                row,
                ..
            }) if geometry.hover_at(*column, *row).is_some_and(|hover| hover.overview)
        );
        if !retains_freeze && !grabs_overview {
            self.frozen = None;
        }
        if matches!(
            event,
            Event::Key(KeyEvent {
                kind: KeyEventKind::Press,
                ..
            })
        ) {
            self.pointer = None;
        }
        let action = self.handle(event, geometry, extent);
        if grabs_overview {
            self.frozen = None;
        }
        let pointed = self
            .pointer
            .and_then(|(column, row)| geometry.hover_at(column, row));
        if matches!(
            event,
            Event::Mouse(MouseEvent {
                kind: MouseEventKind::Moved,
                ..
            })
        ) {
            if pointed.is_some_and(|hover| hover.cell != render::NOTE_CELL)
                && self.drag.is_none()
                && self.view.end.is_none()
            {
                self.frozen.get_or_insert_with(|| HoverFreeze {
                    view: View {
                        end: Some(extent.latest),
                        ..self.view
                    },
                    end: extent.latest,
                    now: SystemTime::now(),
                });
            } else {
                self.frozen = None;
            }
        }
        let moved = pointed != *hover || previous_freeze != self.frozen;
        *hover = pointed;
        match action {
            Action::None => (moved, false),
            Action::Redraw => (true, false),
            Action::ToggleLayout => {
                *layout = layout.toggled();
                (true, false)
            }
            Action::Quit => (moved, true),
        }
    }

    fn start_drag(&mut self, column: u16, row: u16, geometry: &Geometry, extent: Extent) {
        let width = geometry.timeline.1.max(1);
        // Grab the tinted window; only clicks outside it recenter.
        let on_overview = geometry
            .hover_at(column, row)
            .filter(|hover| hover.overview)
            .and_then(|hover| Some((hover, geometry.overview(hover.host)?)));
        self.drag = Some(if let Some((hover, grid)) = on_overview {
            let displayed = Grid::for_view(self.display_view(), width, grid.end);
            let bounds = crate::timeline::window_cells(grid, (displayed.start, displayed.end));
            self.view = View {
                end: Some(displayed.end),
                ..self.display_view()
            };
            if !(bounds.0..bounds.1).contains(&hover.cell) {
                self.view
                    .center_on(grid.center_of(hover.cell), width, extent);
            }
            Drag::Overview {
                column,
                grid,
                view: View {
                    end: Some(self.view.end.unwrap_or(extent.latest)),
                    ..self.view
                },
            }
        } else {
            Drag::Timeline { column }
        });
    }

    /// `region` is the timeline's (column, width) in the last frame.
    fn handle(&mut self, event: &Event, geometry: &Geometry, extent: Extent) -> Action {
        let region = geometry.timeline;
        let width = region.1.max(1);
        let before = self.view;
        match *event {
            Event::Key(KeyEvent {
                code,
                modifiers,
                kind: KeyEventKind::Press,
                ..
            }) => match code {
                KeyCode::Char('c' | 'd') if modifiers.contains(KeyModifiers::CONTROL) => {
                    return Action::Quit;
                }
                KeyCode::Char('q') | KeyCode::Esc => return Action::Quit,
                KeyCode::Char('l') => return Action::ToggleLayout,
                KeyCode::Char('s') => {
                    self.stats_scope = self.stats_scope.toggled();
                    return Action::Redraw;
                }
                KeyCode::Char('+' | '=') | KeyCode::Up => self.view.zoom(true, None, width, extent),
                KeyCode::Char('-' | '_') | KeyCode::Down => {
                    self.view.zoom(false, None, width, extent);
                }
                KeyCode::Left => self.view.pan(step(width), width, extent),
                KeyCode::Right => self.view.pan(-step(width), width, extent),
                KeyCode::Char('0') | KeyCode::End => self.view.reset(),
                _ => {}
            },
            Event::Mouse(MouseEvent {
                kind, column, row, ..
            }) => {
                self.pointer = Some((column, row));
                let anchor = usize::from(column)
                    .checked_sub(region.0)
                    .filter(|cell| *cell <= width);
                match kind {
                    MouseEventKind::ScrollUp => self.wheel_zoom(true, anchor, width, extent),
                    MouseEventKind::ScrollDown => self.wheel_zoom(false, anchor, width, extent),
                    MouseEventKind::ScrollLeft => self.view.pan(2, width, extent),
                    MouseEventKind::ScrollRight => self.view.pan(-2, width, extent),
                    MouseEventKind::Down(MouseButton::Left) => {
                        self.start_drag(column, row, geometry, extent);
                    }
                    MouseEventKind::Drag(MouseButton::Left) => {
                        match self.drag {
                            Some(Drag::Overview {
                                column: origin,
                                grid,
                                view,
                            }) => {
                                let moved = i64::from(column) - i64::from(origin);
                                self.view = view;
                                // The grabbed window moves right toward newer time.
                                #[allow(
                                    clippy::cast_precision_loss,
                                    reason = "small column deltas"
                                )]
                                self.view.shift(moved as f64 * grid.per_cell, width, extent);
                            }
                            Some(Drag::Timeline { column: previous }) => {
                                self.drag = Some(Drag::Timeline { column });
                                let moved = i64::from(column) - i64::from(previous);
                                if moved != 0 {
                                    self.view.pan(moved, width, extent);
                                }
                            }
                            None => {}
                        }
                    }
                    MouseEventKind::Up(_) => self.drag = None,
                    _ => {}
                }
            }
            Event::Resize(..) => return Action::Redraw,
            _ => {}
        }
        if self.view == before {
            Action::None
        } else {
            Action::Redraw
        }
    }
}

/// Arrow-key pan distance: an eighth of the timeline.
fn step(width: usize) -> i64 {
    i64::try_from(width / 8).unwrap_or(i64::MAX).max(1)
}

/// Draws a frame over the previous one (`previous` lines tall) and returns
/// the new height. Lines are clipped to the width so nothing wraps, which
/// keeps the cursor arithmetic exact.
#[allow(
    clippy::too_many_arguments,
    reason = "draw inputs include resize invalidation"
)]
fn draw(
    out: &mut impl Write,
    theme: &Theme,
    hosts: &[HostState],
    layout: Layout,
    timeline: &Timeline,
    previous: &mut Vec<Line>,
    footer: bool,
    force: bool,
    previous_top: Option<usize>,
    resize_damage: &mut resize::Damage,
) -> io::Result<(usize, render::Frame)> {
    let (width, height) = terminal::size()?;
    let (width, height) = (usize::from(width), usize::from(height));
    let frame = render::frame(
        hosts,
        layout,
        timeline,
        width.saturating_sub(1),
        height,
        footer,
    );
    let lines: Vec<Line> = frame
        .lines
        .iter()
        .map(|line| render::clip(line, width.saturating_sub(1)))
        .collect();

    let clear_screen = resize_damage.take(width, force) && !previous.is_empty();
    let origin = if clear_screen {
        Some(0)
    } else if force && !previous.is_empty() {
        cursor::position().ok().map(|(_, row)| {
            frame_height(resize::top(previous, width, usize::from(row), previous_top))
        })
    } else {
        None
    };
    write_frame(out, theme, &lines, previous, force, origin, clear_screen)?;
    let height = lines.len();
    *previous = lines;
    Ok((height, frame))
}

/// The cursor always starts and ends directly below the frame. A height
/// change or resize rewrites everything because terminal scrolling may have
/// moved the old rows; otherwise unchanged rows need no terminal bytes.
fn write_frame(
    out: &mut impl Write,
    theme: &Theme,
    lines: &[Line],
    previous: &[Line],
    force: bool,
    origin: Option<u16>,
    clear_screen: bool,
) -> io::Result<()> {
    let full = force || clear_screen || lines.len() != previous.len();
    if !full && lines == previous {
        return Ok(());
    }
    queue!(out, BeginSynchronizedUpdate, cursor::MoveToColumn(0))?;
    if clear_screen {
        clear_resized_screen(out)?;
    } else if let Some(row) = origin {
        queue!(
            out,
            cursor::MoveTo(0, row),
            terminal::Clear(ClearType::FromCursorDown)
        )?;
    } else if !previous.is_empty() {
        queue!(out, cursor::MoveUp(frame_height(previous.len())))?;
    }
    for (index, line) in lines.iter().enumerate() {
        if full || previous.get(index) != Some(line) {
            for span in line {
                queue!(
                    out,
                    PrintStyledContent(StyledContent::new(
                        theme.style(span.role, span.tint),
                        span.text.as_str()
                    ))
                )?;
            }
            queue!(out, terminal::Clear(ClearType::UntilNewLine))?;
        }
        // MoveDown rather than newline for retained rows: it cannot scroll.
        // New rows still need newline to reserve their place in scrollback.
        if full {
            out.write_all(b"\r\n")?;
        } else {
            queue!(out, cursor::MoveDown(1), cursor::MoveToColumn(0))?;
        }
    }
    if full {
        queue!(out, terminal::Clear(ClearType::FromCursorDown))?;
    }
    queue!(out, EndSynchronizedUpdate)?;
    out.flush()
}

/// Reflow at a bottom-clamped cursor has no unambiguous frame origin.
/// Erase only the visible pane on width shrink; never erase scrollback (3J)
/// or enter the alternate screen. Keep this tradeoff off the row-diff path.
fn clear_resized_screen(out: &mut impl Write) -> io::Result<()> {
    queue!(out, terminal::Clear(ClearType::All), cursor::MoveTo(0, 0))
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "frames are shorter than the terminal"
)]
fn frame_height(height: usize) -> u16 {
    height as u16
}

#[cfg(test)]
mod tests {
    use super::*;
    use crossterm::event::KeyEventState;

    #[test]
    fn frame_updates_preserve_rows_and_clear_removed_text() {
        fn lines(text: &[&str]) -> Vec<Line> {
            text.iter()
                .map(|text| {
                    vec![render::Span {
                        role: render::Role::Label,
                        text: (*text).to_owned(),
                        tint: render::Tint::None,
                    }]
                })
                .collect()
        }
        let theme = Theme::new(true);
        let mut screen = TestScreen::default();
        let mut previous = Vec::new();
        for text in [
            vec!["first", "long second", "third"],
            vec!["first", "short", "third"],
            vec!["first", "short", "third", "fourth"],
            vec!["first", "last"],
        ] {
            let next = lines(&text);
            let mut bytes = Vec::new();
            write_frame(&mut bytes, &theme, &next, &previous, false, None, false).unwrap();
            screen.apply(&bytes);
            assert_eq!(screen.visible(), text);
            assert_eq!((screen.column, screen.row), (0, next.len()));
            previous = next;
        }
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &theme, &previous, &previous, false, None, false).unwrap();
        assert!(
            bytes.is_empty(),
            "identical frames must not write terminal bytes"
        );
        write_frame(&mut bytes, &theme, &previous, &previous, true, None, false).unwrap();
        screen.apply(&bytes);
        assert_eq!(screen.visible(), ["first", "last"]);
    }

    #[test]
    fn width_shrink_erases_fragments_above_the_frame_without_erasing_history() {
        let theme = Theme::new(true);
        let mut screen = TestScreen {
            rows: vec![
                "stale identity".chars().collect(),
                "half chart".chars().collect(),
                "old frame".chars().collect(),
            ],
            row: 3,
            column: 0,
        };
        let next = vec![vec![render::Span {
            role: render::Role::Label,
            text: "current frame".into(),
            tint: render::Tint::None,
        }]];
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &theme, &next, &next, true, Some(0), true).unwrap();
        screen.apply(&bytes);
        assert_eq!(screen.visible(), ["current frame"]);
        assert_eq!((screen.column, screen.row), (0, 1));
        assert!(!bytes.windows(4).any(|bytes| bytes == b"\x1b[3J"));
    }

    #[derive(Default)]
    struct TestScreen {
        rows: Vec<Vec<char>>,
        row: usize,
        column: usize,
    }

    impl TestScreen {
        fn visible(&self) -> Vec<String> {
            let mut rows: Vec<_> = self
                .rows
                .iter()
                .map(|row| row.iter().collect::<String>().trim_end().to_owned())
                .collect();
            while rows.last().is_some_and(String::is_empty) {
                rows.pop();
            }
            rows
        }

        fn apply(&mut self, bytes: &[u8]) {
            let text = std::str::from_utf8(bytes).unwrap();
            let mut chars = text.chars();
            while let Some(ch) = chars.next() {
                if ch == '\x1b' {
                    assert_eq!(chars.next(), Some('['));
                    let mut parameters = String::new();
                    let command = loop {
                        let next = chars.next().unwrap();
                        if next.is_ascii_alphabetic() {
                            break next;
                        }
                        parameters.push(next);
                    };
                    let amount = parameters.parse::<usize>().unwrap_or(1);
                    match command {
                        'A' => self.row -= amount,
                        'B' => self.row += amount,
                        'G' => self.column = amount - 1,
                        'K' => self.rows[self.row].truncate(self.column),
                        'J' if amount == 2 => self.rows.clear(),
                        'J' => self.rows.truncate(self.row),
                        'H' => {
                            let (row, column) = parameters.split_once(';').unwrap();
                            self.row = row.parse::<usize>().unwrap() - 1;
                            self.column = column.parse::<usize>().unwrap() - 1;
                        }
                        _ => {}
                    }
                } else if ch == '\r' {
                    self.column = 0;
                } else if ch == '\n' {
                    self.row += 1;
                } else {
                    if self.rows.len() <= self.row {
                        self.rows.resize_with(self.row + 1, Vec::new);
                    }
                    if self.rows[self.row].len() <= self.column {
                        self.rows[self.row].resize(self.column + 1, ' ');
                    }
                    self.rows[self.row][self.column] = ch;
                    self.column += 1;
                }
            }
        }
    }

    const EXTENT: Extent = Extent {
        oldest: 0.0,
        latest: 1000.0,
    };
    fn geometry() -> Geometry {
        Geometry {
            top: Some(0),
            timeline: (2, 100),
            // Timeline on row 3 (where `mouse` points), overview on row 4.
            lines: vec![(3, 0, false), (4, 0, true)],
            overviews: vec![Some(Grid {
                per_cell: 10.0,
                start: 0.0,
                end: 1000.0,
                width: 100,
            })],
            notes: Vec::new(),
        }
    }

    fn mouse(kind: MouseEventKind, column: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column,
            row: 3,
            modifiers: KeyModifiers::NONE,
        })
    }

    fn mouse_at(kind: MouseEventKind, column: u16, row: u16) -> Event {
        Event::Mouse(MouseEvent {
            kind,
            column,
            row,
            modifiers: KeyModifiers::NONE,
        })
    }

    fn key(code: KeyCode) -> Event {
        Event::Key(KeyEvent {
            code,
            modifiers: KeyModifiers::NONE,
            kind: KeyEventKind::Press,
            state: KeyEventState::NONE,
        })
    }

    #[test]
    fn braille_frame_hit_testing_keeps_terminal_columns_and_full_overview_width() {
        let mut host = HostState::new("h".into());
        host.set_interval(Duration::from_secs(1));
        host.apply(ProbeEvent::Resolved("127.0.0.1".parse().unwrap()));
        for slot in 0..4 {
            let position = Duration::from_millis(slot * 500);
            host.apply(ProbeEvent::Scheduled {
                slot,
                position,
                interval: Duration::from_millis(500),
            });
            host.apply(ProbeEvent::Reply {
                seq: 0,
                slot,
                sent: SystemTime::UNIX_EPOCH + position,
                rtt: Duration::from_millis(if slot == 1 { 90 } else { 10 }),
            });
        }
        let timeline = Timeline {
            view: View::default(),
            interval: Duration::from_secs(1),
            current_interval: Duration::from_millis(500),
            stats_scope: StatsScope::Window,
            hover: None,
            now: SystemTime::UNIX_EPOCH + Duration::from_secs(2),
            hover_now: None,
            overview_end: None,
        };
        let frame = render::frame(
            std::slice::from_ref(&host),
            Layout::Stacked,
            &timeline,
            199,
            40,
            true,
        );
        let mut geometry = Geometry {
            top: Some(10),
            ..Geometry::default()
        };
        geometry.set_frame(frame);
        let chart_row = geometry
            .lines
            .iter()
            .find(|(_, _, overview)| !overview)
            .unwrap()
            .0;
        let row = u16::try_from(10 + chart_row).unwrap();
        for column in 0..2 {
            let pointer = u16::try_from(geometry.timeline.0 + column).unwrap();
            let hover = geometry.hover_at(pointer, row).unwrap();
            assert_eq!(
                hover.cell, column,
                "terminal input has no half-cell precision"
            );
            let bucket = crate::timeline::cell_bucket(
                &host,
                Grid::of(&host, timeline.view, geometry.timeline.1),
                hover.cell,
            )
            .unwrap();
            assert_eq!(bucket.samples, 2);
            assert_eq!(
                bucket.slowest,
                Some(Duration::from_millis(if column == 0 { 90 } else { 10 }))
            );
        }
        let edge = u16::try_from(geometry.timeline.0 + geometry.timeline.1).unwrap();
        assert!(geometry.hover_at(edge, row).is_none());
        let overview = geometry.overview(0).unwrap();
        assert_eq!(overview.width, geometry.timeline.1);
        assert!(
            (overview.range_of(overview.width - 1).1 - host.latest_position()).abs() < f64::EPSILON
        );
        let width = f64::from(u16::try_from(geometry.timeline.1).unwrap());
        assert!((overview.per_cell * width - 2.0).abs() < 1e-9);
    }

    #[test]
    fn hover_freezes_live_cells_until_pointer_leaves() {
        let mut controls = Controls::default();
        let mut layout = Layout::Stacked;
        let mut hover = None;
        controls.update(
            &mouse(MouseEventKind::Moved, 50),
            &geometry(),
            EXTENT,
            &mut layout,
            &mut hover,
        );
        assert_eq!(controls.display_view().end, Some(1000.0));
        assert_eq!(controls.view.end, None);
        let frozen = controls.frozen;
        controls.update(
            &mouse(MouseEventKind::Moved, 51),
            &geometry(),
            Extent {
                latest: 1003.0,
                ..EXTENT
            },
            &mut layout,
            &mut hover,
        );
        assert_eq!(
            controls.frozen, frozen,
            "moving within charts keeps the endpoint and clock"
        );
        controls.update(
            &mouse_at(MouseEventKind::Moved, 51, 0),
            &geometry(),
            EXTENT,
            &mut layout,
            &mut hover,
        );
        assert_eq!(controls.display_view().end, None);
        assert!(controls.frozen.is_none());
        assert!(hover.is_none());
    }

    #[test]
    fn hover_freezes_minimap_but_never_changes_user_paused_view() {
        let mut controls = Controls::default();
        let mut layout = Layout::Stacked;
        let mut hover = None;
        controls.update(
            &mouse_at(MouseEventKind::Moved, 30, 4),
            &geometry(),
            EXTENT,
            &mut layout,
            &mut hover,
        );
        assert_eq!(controls.display_view().end, Some(1000.0));
        assert!(hover.unwrap().overview);
        controls.frozen = None;
        controls.view = View {
            level: -2,
            end: Some(900.0),
        };
        let paused = controls.view;
        for event in [
            mouse(MouseEventKind::Moved, 50),
            mouse_at(MouseEventKind::Moved, 50, 0),
        ] {
            controls.update(&event, &geometry(), EXTENT, &mut layout, &mut hover);
            assert_eq!(controls.display_view(), paused);
            assert!(controls.frozen.is_none());
        }
    }

    #[test]
    fn wheel_zoom_keeps_hover_freeze_and_pointer_time_anchor() {
        let mut controls = Controls::default();
        let mut layout = Layout::Stacked;
        let mut hover = None;
        controls.update(
            &mouse(MouseEventKind::Moved, 52),
            &geometry(),
            EXTENT,
            &mut layout,
            &mut hover,
        );
        let clock = controls.frozen.unwrap().now;
        let before = controls.display_view();
        let pivot = before.end.unwrap() - 50.0 * before.per_cell();
        controls.update(
            &mouse(MouseEventKind::ScrollUp, 52),
            &geometry(),
            Extent {
                latest: 1003.0,
                ..EXTENT
            },
            &mut layout,
            &mut hover,
        );
        let after = controls.display_view();
        assert_eq!(after.level, -1);
        assert!((after.end.unwrap() - 50.0 * after.per_cell() - pivot).abs() < 1e-9);
        assert_eq!(controls.frozen.unwrap().now, clock);
        assert!((controls.frozen.unwrap().end - 1000.0).abs() < f64::EPSILON);
        controls.update(
            &mouse_at(MouseEventKind::Moved, 52, 0),
            &geometry(),
            EXTENT,
            &mut layout,
            &mut hover,
        );
        assert_eq!(
            controls.view,
            View {
                level: -1,
                end: None
            }
        );
        assert_eq!(controls.display_view(), controls.view);
    }

    #[test]
    fn keys_and_clicks_resume_hover_frozen_view() {
        let mut controls = Controls::default();
        let mut layout = Layout::Stacked;
        let mut hover = None;
        for event in [
            key(KeyCode::Char('s')),
            mouse(MouseEventKind::Down(MouseButton::Left), 50),
        ] {
            controls.update(
                &mouse(MouseEventKind::Moved, 50),
                &geometry(),
                EXTENT,
                &mut layout,
                &mut hover,
            );
            assert!(controls.frozen.is_some());
            controls.update(&event, &geometry(), EXTENT, &mut layout, &mut hover);
            assert!(controls.frozen.is_none());
            assert_eq!(controls.display_view().end, None);
        }
    }

    #[test]
    fn drag_right_pans_to_older_samples_and_back_to_live() {
        let mut controls = Controls::default();
        controls.handle(
            &mouse(MouseEventKind::Down(MouseButton::Left), 50),
            &geometry(),
            EXTENT,
        );
        let action = controls.handle(
            &mouse(MouseEventKind::Drag(MouseButton::Left), 60),
            &geometry(),
            EXTENT,
        );
        assert_eq!(action, Action::Redraw);
        assert_eq!(controls.view.end, Some(990.0));
        controls.handle(
            &mouse(MouseEventKind::Drag(MouseButton::Left), 40),
            &geometry(),
            EXTENT,
        );
        assert_eq!(controls.view.end, None, "dragging past now resumes live");
        controls.handle(
            &mouse(MouseEventKind::Up(MouseButton::Left), 40),
            &geometry(),
            EXTENT,
        );
        assert_eq!(controls.drag, None);
    }

    #[test]
    fn wheel_zooms_and_zero_resets() {
        let mut controls = Controls::default();
        controls.handle(&mouse(MouseEventKind::ScrollDown, 30), &geometry(), EXTENT);
        controls.handle(&mouse(MouseEventKind::ScrollDown, 30), &geometry(), EXTENT);
        assert_eq!(controls.view.level, 2);
        controls.handle(&mouse(MouseEventKind::ScrollUp, 30), &geometry(), EXTENT);
        assert_eq!(controls.view.level, 1);
        controls.handle(&key(KeyCode::Left), &geometry(), EXTENT);
        assert!(controls.view.end.is_some());
        controls.handle(&key(KeyCode::Char('0')), &geometry(), EXTENT);
        assert!(controls.view.is_default());
        assert_eq!(
            controls.handle(&key(KeyCode::Char('q')), &geometry(), EXTENT),
            Action::Quit
        );
    }

    #[test]
    fn arrow_zoom_preserves_live_and_paused_keyboard_anchor() {
        let mut controls = Controls::default();
        controls.handle(&key(KeyCode::Up), &geometry(), EXTENT);
        assert_eq!(controls.view.level, -1);
        assert_eq!(controls.view.end, None);
        controls.handle(&key(KeyCode::Down), &geometry(), EXTENT);
        assert_eq!(controls.view.level, 0);
        controls.handle(&key(KeyCode::Left), &geometry(), EXTENT);
        let end = controls.view.end;
        controls.handle(&key(KeyCode::Up), &geometry(), EXTENT);
        assert_eq!(controls.view.end, end);
        controls.handle(&key(KeyCode::Down), &geometry(), EXTENT);
        assert_eq!(controls.view.end, end);
        controls.handle(&key(KeyCode::Right), &geometry(), EXTENT);
        assert_eq!(controls.view.end, None);
    }

    #[test]
    fn pointer_maps_to_host_timeline_cell() {
        let geometry = Geometry {
            top: Some(10),
            timeline: (2, 50),
            lines: vec![(2, 0, false), (12, 1, false), (13, 1, true)],
            overviews: vec![None, None],
            notes: Vec::new(),
        };
        assert_eq!(
            geometry.hover_at(7, 12),
            Some(Hover {
                host: 0,
                cell: 5,
                overview: false
            })
        );
        assert_eq!(
            geometry.hover_at(2, 22),
            Some(Hover {
                host: 1,
                cell: 0,
                overview: false
            })
        );
        assert_eq!(geometry.hover_at(7, 13), None, "stats row");
        assert!(geometry.hover_at(7, 23).is_some_and(|hover| hover.overview));
        assert_eq!(geometry.hover_at(60, 12), None, "right of the timeline");
        assert_eq!(geometry.hover_at(1, 12), None, "on the rule");
    }

    #[test]
    fn overview_click_jumps_and_drag_moves_window_toward_newer() {
        let mut controls = Controls::default();
        // Overview line is row 4; cell 20 of a 10-samples-per-cell grid
        // centers on sample 205: window end 255.
        controls.handle(
            &mouse_at(MouseEventKind::Down(MouseButton::Left), 22, 4),
            &geometry(),
            EXTENT,
        );
        assert_eq!(controls.view.end, Some(255.0));
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 25, 4),
            &geometry(),
            EXTENT,
        );
        assert_eq!(
            controls.view.end,
            Some(285.0),
            "drag right moves toward newer"
        );
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 125, 4),
            &geometry(),
            EXTENT,
        );
        assert_eq!(
            controls.view.end, None,
            "reaching the newest end resumes live"
        );
    }

    #[test]
    fn overview_grabs_preserve_left_middle_and_right_offsets() {
        // Window [400, 500) is tinted in overview cells [40, 50).
        for column in [42, 46, 51] {
            let original = View {
                end: Some(500.0),
                ..View::default()
            };
            let mut controls = Controls {
                view: original,
                ..Controls::default()
            };
            controls.handle(
                &mouse_at(MouseEventKind::Down(MouseButton::Left), column, 4),
                &geometry(),
                EXTENT,
            );
            assert_eq!(controls.view, original);
            controls.handle(
                &mouse_at(MouseEventKind::Drag(MouseButton::Left), column + 3, 4),
                &geometry(),
                EXTENT,
            );
            assert_eq!(controls.view.end, Some(530.0));
            controls.handle(
                &mouse_at(MouseEventKind::Drag(MouseButton::Left), column - 2, 4),
                &geometry(),
                EXTENT,
            );
            assert_eq!(controls.view.end, Some(480.0));
        }
    }

    #[test]
    fn overview_grab_uses_displayed_live_and_hover_frozen_ranges() {
        for frozen in [false, true] {
            let mut controls = Controls::default();
            let mut layout = Layout::Stacked;
            let mut hover = None;
            if frozen {
                controls.update(
                    &mouse_at(MouseEventKind::Moved, 97, 4),
                    &geometry(),
                    EXTENT,
                    &mut layout,
                    &mut hover,
                );
                // Hover zoom must also survive the transition to an actual grab.
                controls.update(
                    &mouse_at(MouseEventKind::ScrollUp, 97, 4),
                    &geometry(),
                    EXTENT,
                    &mut layout,
                    &mut hover,
                );
            }
            let displayed = controls.display_view();
            let before = Grid::for_view(displayed, 100, 1000.0);
            let overview = geometry().overview(0).unwrap();
            let before_bounds = crate::timeline::window_cells(overview, (before.start, before.end));
            let advancing = Extent {
                latest: 1100.0,
                ..EXTENT
            };
            controls.update(
                &mouse_at(MouseEventKind::Down(MouseButton::Left), 97, 4),
                &geometry(),
                advancing,
                &mut layout,
                &mut hover,
            );
            assert_eq!(
                Grid::for_view(controls.display_view(), 100, advancing.latest),
                before
            );
            let grabbed = Grid::for_view(controls.display_view(), 100, advancing.latest);
            assert_eq!(
                crate::timeline::window_cells(overview, (grabbed.start, grabbed.end)),
                before_bounds
            );
            assert!(controls.frozen.is_none());
            assert_eq!(controls.view.level, displayed.level);
            controls.update(
                &mouse_at(MouseEventKind::Drag(MouseButton::Left), 96, 3),
                &geometry(),
                advancing,
                &mut layout,
                &mut hover,
            );
            let dragged = Grid::for_view(controls.display_view(), 100, advancing.latest);
            assert!((dragged.end - before.end + overview.per_cell).abs() < 1e-9);
        }
    }

    #[test]
    fn overview_capture_survives_redraw_host_crossing_bounds_and_release() {
        let mut controls = Controls {
            view: View {
                end: Some(500.0),
                ..View::default()
            },
            ..Controls::default()
        };
        controls.handle(
            &mouse_at(MouseEventKind::Down(MouseButton::Left), 43, 4),
            &geometry(),
            EXTENT,
        );
        let advancing = Extent {
            oldest: 100.0,
            latest: 1200.0,
        };
        let mut changed = geometry();
        changed.timeline = (2, 80);
        changed.lines.push((5, 1, true));
        changed.overviews = vec![
            Some(Grid {
                start: 100.0,
                end: 1200.0,
                per_cell: 13.75,
                width: 80,
            }),
            Some(Grid {
                start: 100.0,
                end: 1200.0,
                per_cell: 27.5,
                width: 40,
            }),
        ];
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 46, 5),
            &changed,
            advancing,
        );
        assert_eq!(controls.view.end, Some(530.0));
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 0, 3),
            &changed,
            advancing,
        );
        assert_eq!(controls.view.end, Some(180.0));
        // Reversing to the original grab restores the range, not a clamped anchor.
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 43, 3),
            &changed,
            advancing,
        );
        assert_eq!(controls.view.end, Some(500.0));
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 113, 5),
            &changed,
            advancing,
        );
        assert_eq!(controls.view.end, None);
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 42, 3),
            &changed,
            advancing,
        );
        assert_eq!(controls.view.end, Some(490.0));
        controls.handle(
            &mouse_at(MouseEventKind::Up(MouseButton::Left), 42, 3),
            &changed,
            advancing,
        );
        let released = controls.view;
        controls.handle(
            &mouse_at(MouseEventKind::Drag(MouseButton::Left), 60, 4),
            &changed,
            advancing,
        );
        assert_eq!(controls.view, released);
        assert!(controls.drag.is_none());
    }

    #[test]
    fn overview_drag_clamps_to_current_width_after_shrink_and_grow() {
        let extent = Extent {
            oldest: 100.0,
            ..EXTENT
        };
        for width in [80_u16, 120] {
            let mut controls = Controls {
                view: View {
                    end: Some(500.0),
                    ..View::default()
                },
                ..Controls::default()
            };
            controls.handle(
                &mouse_at(MouseEventKind::Down(MouseButton::Left), 43, 4),
                &geometry(),
                extent,
            );
            let mut resized = geometry();
            resized.timeline.1 = usize::from(width);
            resized.overviews = vec![Some(Grid {
                per_cell: 900.0 / f64::from(width),
                start: extent.oldest,
                end: extent.latest,
                width: usize::from(width),
            })];
            controls.handle(
                &mouse_at(MouseEventKind::Drag(MouseButton::Left), 46, 4),
                &resized,
                extent,
            );
            // Resizing does not replace the captured pointer-to-time scale.
            assert_eq!(controls.view.end, Some(530.0));
            controls.handle(
                &mouse_at(MouseEventKind::Drag(MouseButton::Left), 0, 4),
                &resized,
                extent,
            );
            let displayed = Grid::for_view(controls.view, usize::from(width), extent.latest);
            assert!((displayed.start - extent.oldest).abs() < f64::EPSILON);
            assert!(displayed.start >= extent.oldest);
            assert_eq!(controls.view.end, Some(extent.oldest + f64::from(width)));
        }
    }

    #[test]
    fn overview_clicks_just_outside_tint_recenter() {
        for (column, end) in [(41, 445.0), (52, 555.0)] {
            let mut controls = Controls {
                view: View {
                    end: Some(500.0),
                    ..View::default()
                },
                ..Controls::default()
            };
            controls.handle(
                &mouse_at(MouseEventKind::Down(MouseButton::Left), column, 4),
                &geometry(),
                EXTENT,
            );
            assert_eq!(controls.view.end, Some(end));
        }
    }

    #[test]
    fn overview_grab_includes_expanded_two_cell_tint() {
        let mut controls = Controls {
            view: View {
                level: -16,
                end: Some(500.0),
            },
            ..Controls::default()
        };
        let original = controls.view;
        // The left tinted cap (cell 48) lies outside the actual [493.75, 500) range.
        controls.handle(
            &mouse_at(MouseEventKind::Down(MouseButton::Left), 50, 4),
            &geometry(),
            EXTENT,
        );
        assert_eq!(controls.view, original);
    }

    #[test]
    fn stats_key_toggles_scope_without_changing_view_or_layout() {
        let mut controls = Controls {
            view: View {
                level: -4,
                end: Some(300.0),
            },
            ..Controls::default()
        };
        let view = controls.view;
        let mut layout = Layout::Stacked;
        let mut hover = None;
        for scope in [StatsScope::Run, StatsScope::Window] {
            assert_eq!(
                controls.update(
                    &key(KeyCode::Char('s')),
                    &geometry(),
                    EXTENT,
                    &mut layout,
                    &mut hover
                ),
                (true, false)
            );
            assert_eq!(controls.stats_scope, scope);
            assert_eq!(controls.view, view);
            assert_eq!(layout, Layout::Stacked);
        }
    }
}
