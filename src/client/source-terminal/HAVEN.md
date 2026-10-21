# Haven toolbar port

Source: https://github.com/GlassHaven/Haven

The pinned HAPI source identifies revision `95f7da1e6aec862740916e6f65940877a190c985`.
This integration adapts that HAPI browser port; it does not bundle JVM code.
Haven is AGPL-3.0, as is HAPI. TermBeam's MIT notices remain for its independent
key-combo encoder, selectable output and touch gestures.

The browser toolbar follows these Haven sources:

- `core/toolbar/src/main/kotlin/sh/haven/core/toolbar/KeyboardToolbar.kt`:
  `ToolbarKeyButton`, `ToolbarKeyText`, `ToolbarKeyIcon`, `KeyColumn`,
  `AlignedToolbarContent`, `ReorderToolbarContent` and `DraggableSegment`.
- `core/data/src/main/kotlin/sh/haven/core/data/preferences/ToolbarLayout.kt`:
  row assignments, order-preserving placement, custom macros, snippet library,
  macro presets and JSON layout.
- `core/data/src/main/kotlin/sh/haven/core/data/preferences/ToolbarKey.kt`:
  key catalog and external JSON IDs.
- `feature/settings/src/main/kotlin/sh/haven/feature/settings/SettingsScreen.kt`:
  simple toolbar settings, minimum width, uniform grid and raw JSON editor.

Long-pressing the keyboard key opens an action menu containing editing, copy,
paste and auxiliary input. Right-click and Shift+F10 also open it. Add and menu
buttons do not occupy permanent toolbar cells. Ctrl/Alt long-press locks the
modifier until a second tap; a tap arms it for one key.

The shared keycap is 32 CSS pixels high, has 8px corners and 8px content padding,
12px text, 16px glyphs and 18px icons. Paired columns use the wider of the two
keys. Default widths follow content; the two rows scroll together. Navigation
pairs are Home/Left, Up/Down, End/Right and PageUp/PageDown. Users can choose
inline navigation or a uniform grid, set minimum width from 0 to 64px, while configuration controls remain in the long-press menu.

The saved HAPI default layout is retained here. Keys can be
assigned to either row or kept off the toolbar. Off-toolbar custom macros remain
in the snippets sheet. The editor supports pointer dragging and keyboard move
buttons, preset/control macros, literal text and escaped sequences, and Haven's
nested row JSON structure. Export/import excludes the off-toolbar library, as
Haven's layout JSON does. Copy is a HAPI action extension to Haven's key catalog.

Haven's Compose/Android IME, native desktop, attachment and voice controls are
not browser toolbar components. The original DSH plugin keeps its xterm and authenticated transport; this
accessory provides clipboard handling and a local command editor. No native JVM code is bundled.
