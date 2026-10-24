//! Following a window's screen rectangle for `record --window` and `watch-window`: which
//! observations become `window` events. Portable; the Windows queries are in win/window.rs.

/// Screen rectangle in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowRect {
    pub x: i32,
    pub y: i32,
    pub width: i32,
    pub height: i32,
}

impl WindowRect {
    pub fn from_edges(left: i32, top: i32, right: i32, bottom: i32) -> Self {
        Self { x: left, y: top, width: right.saturating_sub(left).max(0), height: bottom.saturating_sub(top).max(0) }
    }
}

/// What a `window` event reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WindowState {
    pub rect: WindowRect,
    /// Minimised (or hidden or cloaked): not on screen, and Windows.Graphics.Capture delivers
    /// no frames for it.
    pub minimized: bool,
}

/// One look at the window.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Observation {
    /// The window no longer exists.
    Gone,
    /// Not on screen (minimised, hidden, cloaked), with the rectangle the system reports for it
    /// (a minimised window sits at -32000,-32000), if any.
    Hidden(Option<WindowRect>),
    Shown(WindowRect),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Change {
    Unchanged,
    /// Report this state (the first observation, or something changed).
    Changed(WindowState),
    /// The window closed (reported once).
    Closed,
}

/// Turns polled observations into changes. While the window is not on screen it keeps
/// reporting the rectangle the window last had on screen, flagged `minimized`, so a
/// minimise/restore pair does not look like a move to -32000,-32000 and back.
#[derive(Debug, Default)]
pub struct WindowTracker {
    last: Option<WindowState>,
    last_shown: Option<WindowRect>,
    closed: bool,
}

impl WindowTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn update(&mut self, observation: Observation) -> Change {
        if self.closed {
            return Change::Unchanged;
        }
        let state = match observation {
            Observation::Gone => {
                self.closed = true;
                return Change::Closed;
            }
            Observation::Shown(rect) => {
                self.last_shown = Some(rect);
                WindowState { rect, minimized: false }
            }
            Observation::Hidden(reported) => {
                let rect = self.last_shown.or(reported).or(self.last.map(|s| s.rect));
                WindowState { rect: rect.unwrap_or(WindowRect { x: 0, y: 0, width: 0, height: 0 }), minimized: true }
            }
        };
        if self.last == Some(state) {
            return Change::Unchanged;
        }
        self.last = Some(state);
        Change::Changed(state)
    }

    /// The state last reported, if any.
    #[cfg(test)]
    pub fn current(&self) -> Option<WindowState> {
        self.last
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rect(x: i32, y: i32, width: i32, height: i32) -> WindowRect {
        WindowRect { x, y, width, height }
    }

    #[test]
    fn reports_the_first_observation_then_changes_only() {
        let mut t = WindowTracker::new();
        let a = rect(100, 50, 1280, 720);
        assert_eq!(t.update(Observation::Shown(a)), Change::Changed(WindowState { rect: a, minimized: false }));
        assert_eq!(t.update(Observation::Shown(a)), Change::Unchanged);
        let moved = rect(140, 60, 1280, 720);
        assert_eq!(t.update(Observation::Shown(moved)), Change::Changed(WindowState { rect: moved, minimized: false }));
        let resized = rect(140, 60, 1600, 900);
        assert_eq!(
            t.update(Observation::Shown(resized)),
            Change::Changed(WindowState { rect: resized, minimized: false })
        );
        assert_eq!(t.current(), Some(WindowState { rect: resized, minimized: false }));
    }

    #[test]
    fn minimised_keeps_the_last_on_screen_rectangle() {
        let mut t = WindowTracker::new();
        let a = rect(100, 50, 1280, 720);
        t.update(Observation::Shown(a));
        let iconic = Some(rect(-32000, -32000, 160, 28));
        assert_eq!(t.update(Observation::Hidden(iconic)), Change::Changed(WindowState { rect: a, minimized: true }));
        assert_eq!(t.update(Observation::Hidden(iconic)), Change::Unchanged);
        assert_eq!(t.update(Observation::Shown(a)), Change::Changed(WindowState { rect: a, minimized: false }));
    }

    #[test]
    fn a_window_minimised_from_the_start_reports_what_the_system_says() {
        let mut t = WindowTracker::new();
        let iconic = rect(-32000, -32000, 160, 28);
        assert_eq!(
            t.update(Observation::Hidden(Some(iconic))),
            Change::Changed(WindowState { rect: iconic, minimized: true })
        );
        let mut t = WindowTracker::new();
        assert_eq!(
            t.update(Observation::Hidden(None)),
            Change::Changed(WindowState { rect: rect(0, 0, 0, 0), minimized: true })
        );
    }

    #[test]
    fn closing_is_reported_once() {
        let mut t = WindowTracker::new();
        t.update(Observation::Shown(rect(0, 0, 10, 10)));
        assert_eq!(t.update(Observation::Gone), Change::Closed);
        assert_eq!(t.update(Observation::Gone), Change::Unchanged);
        assert_eq!(t.update(Observation::Shown(rect(1, 1, 10, 10))), Change::Unchanged);
    }

    #[test]
    fn rect_from_edges() {
        assert_eq!(WindowRect::from_edges(-7, 10, 1913, 1050), rect(-7, 10, 1920, 1040));
        assert_eq!(WindowRect::from_edges(10, 10, 5, 5), rect(10, 10, 0, 0));
    }
}
