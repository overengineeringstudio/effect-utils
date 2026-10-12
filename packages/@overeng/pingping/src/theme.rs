//! Light/dark palettes modelled on the reference screenshot, plus terminal
//! background detection (OSC 11) to pick between them.

use std::fs::{File, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::os::fd::{AsFd, AsRawFd};
use std::os::unix::fs::OpenOptionsExt;
use std::time::{Duration, Instant};

use crossterm::style::{Attribute, Color, ContentStyle, Stylize};
use nix::errno::Errno;
use nix::sys::select::{select, FdSet, FD_SETSIZE};
use nix::sys::time::{TimeVal, TimeValLike};

use crate::render::{Role, Tint};

#[derive(Debug, Clone, Copy, PartialEq, Eq, clap::ValueEnum)]
pub enum ThemeChoice {
    /// Detect from the terminal background color.
    Auto,
    Light,
    Dark,
}

#[derive(Debug, Clone, Copy)]
struct Palette {
    rule: (u8, u8, u8),
    label: (u8, u8, u8),
    /// Label and faint colors blended 55% toward the loss color.
    minimap_loss: (u8, u8, u8),
    minimap_loss_faint: (u8, u8, u8),
    pill_bg: (u8, u8, u8),
    pill_fg: (u8, u8, u8),
    spark: (u8, u8, u8),
    value: (u8, u8, u8),
    /// Value blended halfway toward (value red, bad green, zero blue).
    rtt_high: (u8, u8, u8),
    good: (u8, u8, u8),
    bad: (u8, u8, u8),
    /// Background behind the hovered cell; the bar keeps its own color.
    hover_bg: (u8, u8, u8),
    /// Background of the visible window on an overview.
    window_bg: (u8, u8, u8),
    path_change: (u8, u8, u8),
}

// Sampled from the reference screenshot and corrected for its JPEG contrast loss.
const LIGHT: Palette = Palette {
    rule: (0xb4, 0xb9, 0xc7),
    label: (0xa3, 0xa7, 0xb0),
    minimap_loss: (0xbb, 0x78, 0x77),
    minimap_loss_faint: (0xc3, 0x80, 0x81),
    pill_bg: (0xe7, 0xe9, 0xef),
    pill_fg: (0x55, 0x5a, 0x66),
    spark: (0x5d, 0x6b, 0x8a),
    value: (0xb8, 0x84, 0x4a),
    rtt_high: (0xb8, 0x6b, 0x25),
    good: (0x5e, 0x9a, 0x66),
    bad: (0xcf, 0x52, 0x48),
    hover_bg: (0xd6, 0xdd, 0xee),
    window_bg: (0xdc, 0xe2, 0xed),
    path_change: (0xf2, 0xe2, 0xc5),
};

const DARK: Palette = Palette {
    rule: (0x3e, 0x44, 0x4f),
    label: (0x70, 0x78, 0x86),
    minimap_loss: (0xb6, 0x76, 0x77),
    minimap_loss_faint: (0xa0, 0x5e, 0x5e),
    pill_bg: (0x2b, 0x30, 0x3a),
    pill_fg: (0xc6, 0xcc, 0xd8),
    spark: (0x8a, 0x9b, 0xc4),
    value: (0xe0, 0xa8, 0x6a),
    rtt_high: (0xe0, 0x8e, 0x35),
    good: (0x86, 0xc0, 0x86),
    bad: (0xf0, 0x74, 0x6a),
    hover_bg: (0x3a, 0x44, 0x5a),
    window_bg: (0x35, 0x3d, 0x4b),
    path_change: (0x4d, 0x40, 0x2a),
};

pub struct Theme {
    palette: Palette,
    truecolor: bool,
}

impl Theme {
    pub fn new(dark: bool) -> Self {
        let truecolor = std::env::var("COLORTERM").is_ok_and(|v| v == "truecolor" || v == "24bit");
        Self {
            palette: if dark { DARK } else { LIGHT },
            truecolor,
        }
    }

    fn color(&self, (r, g, b): (u8, u8, u8)) -> Color {
        if self.truecolor {
            Color::Rgb { r, g, b }
        } else {
            Color::AnsiValue(ansi256(r, g, b))
        }
    }

    pub fn style(&self, role: Role, tint: Tint) -> ContentStyle {
        let style = self.role_style(role);
        match tint {
            Tint::None => style,
            Tint::Hover => style.on(self.color(self.palette.hover_bg)),
            Tint::Window => style.on(self.color(self.palette.window_bg)),
            Tint::PathChange => style.on(self.color(self.palette.path_change)),
        }
    }

    fn role_style(&self, role: Role) -> ContentStyle {
        let p = &self.palette;
        let base = ContentStyle::new();
        match role {
            Role::Rule | Role::Faint => base.with(self.color(p.rule)),
            Role::Label | Role::PathNote | Role::Dim | Role::Baseline => {
                base.with(self.color(p.label))
            }
            Role::MinimapLoss => base.with(self.color(p.minimap_loss)),
            Role::MinimapLossFaint => base.with(self.color(p.minimap_loss_faint)),
            Role::Host => base.attribute(Attribute::Bold),
            Role::Pill | Role::Tooltip => {
                base.with(self.color(p.pill_fg)).on(self.color(p.pill_bg))
            }
            Role::Spark => base.with(self.color(p.spark)),
            Role::RttElevated | Role::Value => base.with(self.color(p.value)),
            Role::RttHigh => base.with(self.color(p.rtt_high)),
            Role::Good => base.with(self.color(p.good)),
            Role::Bad => base.with(self.color(p.bad)),
            Role::Plain => base,
        }
    }
}

/// Nearest xterm-256 color: the 6x6x6 cube or the 24-step gray ramp.
fn ansi256(r: u8, g: u8, b: u8) -> u8 {
    let cube = |v: u8| -> u8 {
        if v < 48 {
            0
        } else if v < 115 {
            1
        } else {
            (v - 35) / 40
        }
    };
    let level = |i: u8| if i == 0 { 0 } else { 55 + 40 * u16::from(i) };
    let (cr, cg, cb) = (cube(r), cube(g), cube(b));
    let dist = |x: u16, y: u16, z: u16| {
        let d = |a: u16, b: u8| (i32::from(a) - i32::from(b)).pow(2);
        d(x, r) + d(y, g) + d(z, b)
    };
    let cube_dist = dist(level(cr), level(cg), level(cb));
    let avg = (u16::from(r) + u16::from(g) + u16::from(b)) / 3;
    let gray_index = if avg < 8 { 0 } else { ((avg - 8) / 10).min(23) };
    let gray = 8 + 10 * gray_index;
    if dist(gray, gray, gray) < cube_dist {
        #[allow(clippy::cast_possible_truncation, reason = "gray_index <= 23")]
        return 232 + gray_index as u8;
    }
    16 + 36 * cr + 6 * cg + cb
}

/// Queries OSC 11 synchronously through the controlling terminal in raw mode.
/// A nonblocking descriptor and an absolute deadline keep unsupported terminals
/// from leaving a reader behind to compete with subsequent keyboard input.
pub fn detect_dark_background() -> Option<bool> {
    let mut tty = OpenOptions::new()
        .read(true)
        .write(true)
        .custom_flags(nix::libc::O_NONBLOCK | nix::libc::O_NOCTTY)
        .open("/dev/tty")
        .ok()?;
    // Avoid consuming input already queued before the query. Once querying, a
    // terminal reply cannot be distinguished from interleaved typed input without
    // consuming it; read one byte at a time to leave trailing keypresses alone.
    if terminal_readable(&tty, Duration::ZERO).ok()? {
        return None;
    }
    let deadline = Instant::now() + Duration::from_millis(300);
    tty.write_all(b"\x1b]11;?\x1b\\").ok()?;
    let mut response = [0u8; 128];
    let mut length = 0;
    while length < response.len() {
        let remaining = deadline.checked_duration_since(Instant::now())?;
        match terminal_readable(&tty, remaining) {
            Ok(true) => {}
            Err(Errno::EINTR) => continue,
            Ok(false) | Err(_) => return None,
        }
        match tty.read(&mut response[length..=length]) {
            Ok(1) => length += 1,
            Err(error)
                if matches!(error.kind(), ErrorKind::WouldBlock | ErrorKind::Interrupted) =>
            {
                continue;
            }
            Ok(_) | Err(_) => return None,
        }
        let reply = &response[..length];
        let prefix = b"\x1b]11;";
        if reply[..length.min(prefix.len())] != prefix[..length.min(prefix.len())] {
            return None;
        }
        if reply.ends_with(b"\x07") || reply.ends_with(b"\x1b\\") {
            return parse_osc11(reply).map(|(r, g, b)| luminance(r, g, b) < 0.5);
        }
    }
    None
}

/// `select` works on `/dev/tty` on both Linux and macOS, unlike macOS `poll`.
fn terminal_readable(tty: &File, timeout: Duration) -> nix::Result<bool> {
    if usize::try_from(tty.as_raw_fd()).map_or(true, |fd| fd >= FD_SETSIZE) {
        return Err(Errno::EINVAL);
    }
    let mut descriptors = FdSet::new();
    descriptors.insert(tty.as_fd());
    let mut timeout =
        TimeVal::microseconds(i64::try_from(timeout.as_micros()).map_err(|_| Errno::EINVAL)?);
    select(None, &mut descriptors, None, None, &mut timeout).map(|ready| ready > 0)
}

fn parse_osc11(response: &[u8]) -> Option<(f64, f64, f64)> {
    let text = String::from_utf8_lossy(response);
    let rgb = text.split("rgb:").nth(1)?;
    let mut parts = rgb.split(['/', '\x1b', '\x07']).take(3).map(|hex| {
        let hex = hex.get(..hex.len().min(4))?;
        let max = 16f64.powi(i32::try_from(hex.len()).ok()?) - 1.0;
        u32::from_str_radix(hex, 16)
            .ok()
            .map(|v| f64::from(v) / max)
    });
    Some((parts.next()??, parts.next()??, parts.next()??))
}

fn luminance(r: f64, g: f64, b: f64) -> f64 {
    0.2126 * r + 0.7152 * g + 0.0722 * b
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rtt_roles_use_amber_and_orange_with_ansi256_fallback() {
        for (palette, amber, orange, orange_ansi) in [
            (DARK, (224, 168, 106), (224, 142, 53), 173),
            (LIGHT, (184, 132, 74), (184, 107, 37), 130),
        ] {
            assert_eq!(palette.value, amber);
            assert_eq!(palette.rtt_high, orange);
            let fallback = Theme {
                palette,
                truecolor: false,
            };
            for (role, (r, g, b), expected) in [
                (
                    Role::RttElevated,
                    amber,
                    fallback.style(Role::Value, Tint::None).foreground_color,
                ),
                (Role::RttHigh, orange, Some(Color::AnsiValue(orange_ansi))),
            ] {
                let theme = Theme {
                    palette,
                    truecolor: true,
                };
                let style = theme.style(role, Tint::Hover);
                assert_eq!(style.foreground_color, Some(Color::Rgb { r, g, b }));
                assert_eq!(style.background_color, Some(theme.color(palette.hover_bg)));
                assert_eq!(fallback.style(role, Tint::None).foreground_color, expected);
            }
        }
    }

    #[test]
    fn parses_osc11_replies() {
        let light = parse_osc11(b"\x1b]11;rgb:f4f4/f6f6/fafa\x1b\\\x1b[?62;22c").unwrap();
        assert!(luminance(light.0, light.1, light.2) > 0.5);
        let dark = parse_osc11(b"\x1b]11;rgb:1e/1e/2e\x07\x1b[?1;2c").unwrap();
        assert!(luminance(dark.0, dark.1, dark.2) < 0.5);
        assert_eq!(parse_osc11(b"\x1b[?1;2c"), None);
    }

    #[test]
    fn maps_to_ansi256() {
        assert_eq!(ansi256(0, 0, 0), 16);
        assert_eq!(ansi256(255, 0, 0), 196);
        assert_eq!(ansi256(0x80, 0x80, 0x80), 244);
    }
}
