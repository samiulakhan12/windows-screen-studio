// Editing polish (wave 10), end to end in the built app (docs/design/editing-polish.md §19.3):
// smooth cuts, the magnifier, animated callouts and the progress bar, colour and looks, the music
// and sound-effects library, Polish's Smooth cuts step and Review mode, keyboard and versions.
// Steps E1 to E18 are written by the parts (P1 to P5, §17) on this file.
//
// The data-testid values of §2 (frozen by the contracts commit; the UI parts use exactly these):
//
//   Clip tab, Cuts and Cut style (§2.1, part P1)
//     cuts-section            the section "Cuts" (shown when the video has a cut); its count line "37 cuts. …"
//     cut-every               select "Every cut": Hard cut, Smooth, Crossfade, Dip to colour, Slide, Punch-in
//     cut-smooth-all          button "Smooth all cuts" (disabled with its hint when nothing would change)
//     cut-same-style          button "Give them the same style" (with "3 cuts have their own style.")
//     cut-style-section       the section "Cut style" of a selected cut
//     cut-number              "Cut 5 of 37"
//     cut-prev / cut-next / cut-play   buttons Previous cut, Next cut, Play this cut
//     cut-style               radiogroup "Cut style"; each radio data-kind="same|cut|smooth|crossfade|dip|slide|punch"
//     cut-length              slider Length / Crossfade length ("0.15 seconds")
//     cut-punch-size          slider Punch-in size ("110 percent")
//     cut-dip-colour          radiogroup of swatches (Black, White, the brand colours, Other…)
//     cut-slide-from          radiogroup "Comes in from"
//     cut-here                the line "Here: a crossfade (…)" / "Here: a punch-in (…)"
//     cut-note                "(Crossfade while Calm motion is on)", "Shown as a crossfade so dips don't flash too often."
//   Timeline (§2.1, part P1)
//     cut-marker              each cut's 24 × 24 px button on the clip track; data-index, data-kind, aria-label "Cut 5 of 37: …"
//   Polish and Review (§2.7, part P1 and P4)
//     polish-row-smoothCuts   the Polish dialog's row (the dialog's polish-row-<step> pattern)
//     review chips            the Review panel's kinds 'join' ("Cuts") and 'colour' ("Colour")
//   Shapes and Zoom tabs, the magnifier (§2.2, part P2)
//     magnifier-add           button "Add magnifier"
//     magnifier-add-cursor    button "Add magnifier on the cursor"
//     zoom-add-magnifier      the Zoom tab's row "Show a detail larger without zooming:" with Add magnifier
//     magnifier-section       a selected magnifier's panel
//     magnifier-zoom          slider "Zoom" ("2 times")
//     magnifier-shape         chips Round, Rounded rectangle
//     magnifier-follows       chips A place on the screen, The cursor
//     magnifier-darkness      slider "Darkness"
//     magnifier-soft          the note "Shown larger than the recording's pixels: it may look soft."
//   Text tab, Chapters and Effects tab, the progress bar (§2.4, part P2)
//     progress-bar-toggle     switch "Progress bar on the video"
//     progress-bar-place      radiogroup Auto, Top, Bottom
//     progress-bar-look       radiogroup Floating, Edge
//     progress-bar-labels     radiogroup Current chapter, All chapters, None
//     progress-bar-colour     the colour swatches
//     progress-bar-only       switch "Show only when a chapter starts"
//     progress-bar-link       the Effects tab's row "Progress bar…"
//   Text and Shapes tabs, animated callouts (§2.3, part P3)
//     callout-section         the section "Animation"
//     callout-enter / callout-exit / callout-speed / callout-sound   Comes in, Goes out, Speed, Sound
//     callout-sound-play      the Sound row's Play toggle
//     add-step-badge          button "Add step badge"
//     add-speech-bubble       button "Add speech bubble"
//     badge-section           a selected badge's options
//     badge-number            radiogroup Automatic, Your own text; badge-text its field, badge-text-error its error
//     badge-count-with        radiogroup 1 2 3, A B C, ১ ২ ৩ (Bangla digits)…
//     badge-restart           switch "Restart at each chapter"; badge-start-from the number field
//     badge-colour            the swatches; badge-follows-zoom the switch "Follows the zoom"
//     bubble-section          a selected bubble's options; bubble-colour, bubble-tail
//     badge-handle / tail-handle   the preview's focusable handles ("Badge 3 on 52 %, 40 %", "Tail points to …")
//     calm-motion             the Effects tab's switch "Calm motion"
//   Effects and Camera tabs, colour (§2.5, part P4)
//     screen-colour-section   Effects tab "Screen colour"; camera-colour-section Camera tab "Colour"
//     colour-look             radiogroup of look chips; each chip data-look="none|natural|…"
//     colour-look-strength    slider Strength of the look
//     colour-slider-<key>     sliders temperature, tint, brightness, contrast, saturation, highlights, shadows, vibrance, exposure
//     colour-reset-<key>      each slider's Reset button ("Reset Temperature")
//     colour-more             the More disclosure
//     lut-import              button "Import a LUT (.cube)…"; lut-title, lut-size, lut-strength, lut-remove, lut-problem
//     colour-compare          toggle "Compare" (aria-pressed)
//     colour-reset            button "Reset colour"
//     auto-colour             button "Auto colour"
//     colour-cpu-note         the note shown without WebGL2
//   Audio tab and Settings › Downloads, music and effects (§2.6, part P5)
//     music-library           the Library list (role="list"); music-mood the mood radiogroup
//     music-row               each bed's row, data-bed=<catalogue id>; music-play, music-use, music-download, music-progress in it
//     music-credit            "Music: Sweet Sun by Loyalty Freak Music (CC0)"
//     music-own-file          button "Your own file…" (today's Choose music…)
//     sfx-section             the section "Sound effects"; sfx-volume its Volume slider
//     sfx-rule-<rule>         selects Zooming in, Zooming out, Title cards appear, Texts and shapes appear (zoomIn, zoomOut, titles, callouts)
//     sfx-play-<rule>, sfx-count-<rule>   each rule's Play button and "Plays 24 times"
//     sfx-soft-whoosh         the link "Soft whoosh when zooming in"
//     music-downloads         Settings › Downloads › More music; music-download-all, music-downloads-remove
//
// Commands (§2.8; no default keys): smoothAllCuts, hardCutsEverywhere, nextCut, previousCut, playCut,
// addMagnifier, addMagnifierCursor, addStepBadge, addSpeechBubble, toggleProgressBar, compareColour,
// autoColour, musicLibrary.

console.log('editing-polish e2e: the steps E1 to E18 are written with the parts (docs/design/editing-polish.md §19.3).')
