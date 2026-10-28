// Vertical video that follows the action (NW-05) and Duplicate (X-04): the end-to-end test of
// docs/design/vertical-video.md §11.3, written by part P4. Until then this file only holds the
// contract below and fails, so an unwritten test is never counted as passing.
//
// The data-testid values of §2 (frozen by the contracts commit; the UI parts use exactly these):
//
//   Title bar (§2.2, part P4: CopyMenu in the editor's title bar)
//     copy-menu              the copy button right of the name field (icon copy, title and aria-label
//                            "Duplicate or make a vertical version", aria-haspopup="menu"); its menu has role="menu"
//     copy-vertical          menu item "Make a vertical version" (aria-disabled with its reason when unavailable)
//     copy-square            menu item "Make a square version"
//     copy-duplicate         menu item "Duplicate"
//   Making the copy (§2.3, part P4)
//     copy-progress          the progress modal (role="dialog"), shown when a copy runs longer than 0.5 s
//   Style › Vertical framing (§2.2, §2.5, part P3)
//     framing-section        the section "Vertical framing"
//     vertical-callout       "Making a Short?" with the button Make a vertical version
//     follow-toggle          toggle "Follow the action"
//     follow-status          status line; data-state="following" or "no-input"
//     follow-level           slider "How close"
//     follow-pace            chips "Movement": Calm, Balanced, Lively
//     follow-camera          chips "Camera": Band on top, Band at the bottom, Bubble
//     follow-band            slider "Camera size"
//     follow-rest-x          slider "Where the view rests": Left to right
//     follow-rest-y          slider "Where the view rests": Top to bottom
//     follow-hold            button "Hold the view here" (R)
//     follow-view-x          slider "View at the playhead": Left to right
//     follow-view-y          slider "View at the playhead": Top to bottom
//     app-safe-toggle        toggle "Keep text clear of app buttons"
//   Safe-zone preview (§2.8, part P3)
//     safe-zones-toggle      the transport row's "Safe zones" toggle (aria-pressed; G)
//     safe-zones-platform    select: All three, TikTok, Instagram Reels, YouTube Shorts
//     safe-zones             the overlay over the preview (data-platform="all" | "tiktok" | "reels" | "shorts")
//     safe-zones-legend      the legend under the preview while the overlay is on
//   Export dialog (§2.2, §2.9, part P3)
//     export-follow-note     "Your whole screen is shrunk to fit 9:16 …" with Make a vertical version (or square)
//     export-follow-on       "The view follows the action: it crops in on your cursor, clicks and typing."
//     export-magnify         "Shows your 1920×1080 recording at 1.6× its size …"

console.error('vertical-video.e2e.cjs: not written yet (part P4, docs/design/vertical-video.md §11.3)')
process.exitCode = 1
