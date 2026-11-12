# Preserve history anchors when a short window underfills the viewport

An earlier history page can retain every visible node yet move the reader because its original window underfilled the viewport. The required anchor position exceeds the new natural scroll floor, so a normal clamped scroll write cannot restore it.

Reuse Chat's existing end spacer only when paging or an opted-in history correction needs additional range. Reserve the measured deficit and let the existing reclaim policy remove room as scrolling or content growth permits. Default restore and explicit navigation retain their prior clamp behavior. Reachable positions take the existing path without extra room or layout reads.

Tests use the real ChatViewport with an explicitly clamping scroll geometry boundary and verify both short-window cases, repeated resize, and unchanged explicit navigation. Continuous-reading browser acceptance retains the 2 px physical-anchor and 80 ms frame-gap gates.
