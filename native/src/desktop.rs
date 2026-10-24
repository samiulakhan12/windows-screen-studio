//! `desktop-icons hide|show|hold|status`: the desktop's icon view, found and decided here,
//! portably (and unit-tested); the Win32 calls are in `win::desktop`.
//!
//! Only the icon list view's own visibility is changed (`ShowWindowAsync`), never Explorer's
//! "Show desktop icons" setting (which is saved in the registry): an Explorer restart or a
//! sign-out always brings the icons back, whatever happens to the app.

use std::io::Read;

use crate::protocol::JsonObject;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IconsAction {
    Hide,
    Show,
    /// Hides, then waits until stdin closes (the app released it, or exited or died) and
    /// shows the icons again if it hid them.
    Hold,
    Status,
}

impl IconsAction {
    pub fn parse(value: &str) -> Result<Self, String> {
        match value {
            "hide" => Ok(Self::Hide),
            "show" => Ok(Self::Show),
            "hold" => Ok(Self::Hold),
            "status" => Ok(Self::Status),
            other => Err(format!("desktop-icons takes hide, show, hold or status, got '{other}'")),
        }
    }

    /// The visibility to set, or None to only report it.
    pub fn target(self) -> Option<bool> {
        match self {
            Self::Hide | Self::Hold => Some(false),
            Self::Show => Some(true),
            Self::Status => None,
        }
    }
}

/// The top-level window class of the desktop (Program Manager).
pub const PROGMAN: &str = "Progman";
/// Where Explorer moves the desktop view once a wallpaper slideshow or animation ran.
pub const WORKER_W: &str = "WorkerW";
pub const DEF_VIEW: &str = "SHELLDLL_DefView";
pub const LIST_VIEW: &str = "SysListView32";

/// Window lookups the search needs; implemented with user32 on Windows and faked in tests.
pub trait DesktopWindows {
    type Handle: Copy;
    /// The first top-level window of `class`.
    fn top_level(&self, class: &str) -> Option<Self::Handle>;
    /// Every top-level window of `class`, front to back.
    fn top_levels(&self, class: &str) -> Vec<Self::Handle>;
    /// The first direct child of `parent` of `class`.
    fn child(&self, parent: Self::Handle, class: &str) -> Option<Self::Handle>;
}

/// The icon list view (`SysListView32` in `SHELLDLL_DefView`). The view sits in `Progman`, or in
/// one of the top-level `WorkerW` windows after Explorer moved it there (wallpaper slideshow,
/// some animated wallpapers); Windows 11 24H2 keeps it in `Progman`. None when Explorer is not
/// the shell (or not running).
pub fn find_icon_view<W: DesktopWindows>(w: &W) -> Option<W::Handle> {
    let in_progman = w.top_level(PROGMAN).and_then(|p| w.child(p, DEF_VIEW));
    let def_view = in_progman.or_else(|| w.top_levels(WORKER_W).into_iter().find_map(|worker| w.child(worker, DEF_VIEW)))?;
    w.child(def_view, LIST_VIEW)
}

/// What a call does given the view's visibility `before`: the visibility to request, and
/// whether that is a change (`changed` in the reply). The request is posted even when the view
/// already reads as wanted: a hide posted moments ago may not be applied yet (Explorer busy),
/// and a show skipped then would let that hide land afterwards and keep the icons hidden.
pub fn plan(action: IconsAction, before: bool) -> (Option<bool>, bool) {
    let target = action.target();
    (target, target.is_some_and(|t| t != before))
}

/// `hold`: blocks until `input` (stdin) is closed, whatever is written to it.
pub fn wait_for_eof(mut input: impl Read) {
    let mut buf = [0u8; 256];
    while matches!(input.read(&mut buf), Ok(n) if n > 0) {}
}

/// What to print: whether the icons are visible now, and whether this call asked to change it.
/// `changed` is what the app relies on to restore only icons it hid itself: icons the user had
/// already hidden report `changed: false` on `hide`.
pub fn result_json(visible: bool, changed: bool) -> String {
    JsonObject::new().bool("visible", visible).bool("changed", changed).finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A window tree: handle -> (class, parent; 0 = top level), in creation (Z) order.
    struct Fake(Vec<(u32, &'static str, u32)>);

    impl DesktopWindows for Fake {
        type Handle = u32;
        fn top_level(&self, class: &str) -> Option<u32> {
            self.top_levels(class).first().copied()
        }
        fn top_levels(&self, class: &str) -> Vec<u32> {
            self.0.iter().filter(|(_, c, p)| *p == 0 && *c == class).map(|(h, _, _)| *h).collect()
        }
        fn child(&self, parent: u32, class: &str) -> Option<u32> {
            self.0.iter().find(|(_, c, p)| *p == parent && *c == class).map(|(h, _, _)| *h)
        }
    }

    #[test]
    fn parses_actions() {
        assert_eq!(IconsAction::parse("hide"), Ok(IconsAction::Hide));
        assert_eq!(IconsAction::parse("show"), Ok(IconsAction::Show));
        assert_eq!(IconsAction::parse("status"), Ok(IconsAction::Status));
        assert_eq!(IconsAction::parse("hold"), Ok(IconsAction::Hold));
        assert!(IconsAction::parse("Hide").is_err());
        assert!(IconsAction::parse("").is_err());
        assert_eq!(IconsAction::Hide.target(), Some(false));
        assert_eq!(IconsAction::Hold.target(), Some(false));
        assert_eq!(IconsAction::Show.target(), Some(true));
        assert_eq!(IconsAction::Status.target(), None);
    }

    #[test]
    fn finds_the_view_in_progman() {
        let tree = Fake(vec![(1, PROGMAN, 0), (2, DEF_VIEW, 1), (3, LIST_VIEW, 2), (4, WORKER_W, 0)]);
        assert_eq!(find_icon_view(&tree), Some(3));
    }

    #[test]
    fn finds_the_view_moved_into_a_worker_w() {
        // After a wallpaper slideshow: Progman is empty; the view is in the second WorkerW.
        let tree = Fake(vec![(1, PROGMAN, 0), (4, WORKER_W, 0), (5, WORKER_W, 0), (6, DEF_VIEW, 5), (7, LIST_VIEW, 6)]);
        assert_eq!(find_icon_view(&tree), Some(7));
    }

    #[test]
    fn windows_11_24h2_layout() {
        // Progman holds the view and a WorkerW child (no top-level WorkerW).
        let tree = Fake(vec![(1, PROGMAN, 0), (2, DEF_VIEW, 1), (3, LIST_VIEW, 2), (8, WORKER_W, 1)]);
        assert_eq!(find_icon_view(&tree), Some(3));
    }

    #[test]
    fn none_without_explorer_or_its_list_view() {
        assert_eq!(find_icon_view(&Fake(vec![])), None);
        assert_eq!(find_icon_view(&Fake(vec![(1, PROGMAN, 0), (2, DEF_VIEW, 1)])), None);
        // A DefView that is not a child of Progman/WorkerW is not the desktop's.
        assert_eq!(find_icon_view(&Fake(vec![(1, "CabinetWClass", 0), (2, DEF_VIEW, 1), (3, LIST_VIEW, 2)])), None);
    }

    #[test]
    fn requests_are_posted_even_when_the_view_already_reads_as_wanted() {
        // Audit R-6: a show right after a hide Explorer has not applied yet must still be posted.
        assert_eq!(plan(IconsAction::Show, true), (Some(true), false));
        assert_eq!(plan(IconsAction::Show, false), (Some(true), true));
        assert_eq!(plan(IconsAction::Hide, true), (Some(false), true));
        // Icons the user hid: hidden again (harmless), but not ours to restore.
        assert_eq!(plan(IconsAction::Hide, false), (Some(false), false));
        assert_eq!(plan(IconsAction::Hold, false), (Some(false), false));
        assert_eq!(plan(IconsAction::Status, true), (None, false));
    }

    #[test]
    fn hold_waits_for_the_end_of_its_input() {
        wait_for_eof(std::io::Cursor::new(b"anything\nat all\n".to_vec()));
        wait_for_eof(std::io::empty());
    }

    #[test]
    fn json_output() {
        assert_eq!(result_json(false, true), r#"{"visible":false,"changed":true}"#);
        assert_eq!(result_json(true, false), r#"{"visible":true,"changed":false}"#);
    }
}
