//! Windows system cursors and the app's CursorShape names (src/shared/types.ts).

/// Standard cursor resource ids (IDC_*) with the shape the editor draws for each.
/// Cursors without a matching shape (help, no, up-arrow, pin, person) and custom
/// application cursors are drawn as the arrow.
pub const SYSTEM_CURSORS: &[(u16, &str)] = &[
    (32512, "arrow"),     // IDC_ARROW
    (32513, "text"),      // IDC_IBEAM
    (32514, "wait"),      // IDC_WAIT
    (32515, "crosshair"), // IDC_CROSS
    (32516, "arrow"),     // IDC_UPARROW
    (32642, "move"),      // IDC_SIZENWSE (no diagonal shape in the editor)
    (32643, "move"),      // IDC_SIZENESW
    (32644, "resize-ew"), // IDC_SIZEWE
    (32645, "resize-ns"), // IDC_SIZENS
    (32646, "move"),      // IDC_SIZEALL
    (32648, "arrow"),     // IDC_NO
    (32649, "pointer"),   // IDC_HAND
    (32650, "wait"),      // IDC_APPSTARTING
    (32651, "arrow"),     // IDC_HELP
    (32671, "arrow"),     // IDC_PIN
    (32672, "arrow"),     // IDC_PERSON
];

pub const FALLBACK_SHAPE: &str = "arrow";

/// Emits a shape only when it differs from the last one emitted.
#[derive(Debug, Default)]
pub struct ShapeChanges {
    last: Option<&'static str>,
}

impl ShapeChanges {
    pub fn update(&mut self, shape: &'static str) -> Option<&'static str> {
        if self.last == Some(shape) {
            None
        } else {
            self.last = Some(shape);
            Some(shape)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CursorShape in src/shared/types.ts.
    const SHAPES: &[&str] = &["arrow", "text", "pointer", "crosshair", "move", "resize-ew", "resize-ns", "wait"];

    #[test]
    fn every_mapped_shape_is_known_to_the_app() {
        for (_, shape) in SYSTEM_CURSORS {
            assert!(SHAPES.contains(shape), "{shape}");
        }
        assert!(SHAPES.contains(&FALLBACK_SHAPE));
    }

    #[test]
    fn ids_are_unique() {
        let mut ids: Vec<u16> = SYSTEM_CURSORS.iter().map(|(id, _)| *id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), SYSTEM_CURSORS.len());
    }

    #[test]
    fn reports_changes_only() {
        let mut c = ShapeChanges::default();
        assert_eq!(c.update("arrow"), Some("arrow"));
        assert_eq!(c.update("arrow"), None);
        assert_eq!(c.update("text"), Some("text"));
        assert_eq!(c.update("arrow"), Some("arrow"));
    }
}
