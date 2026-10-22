# Workspace presentation and official UI composition

The workspace owns pane geometry, its title bar, the unified session list, and
window navigation. The complete official DSH Conversation continues to own the
session header, lineage, actions, utilities, view tabs, history, and composer.
No official Conversation header is hidden to make the workspace appear smaller.

## Compact navigation without losing plugin actions

Each pane has a persistent title bar, including empty, loading, and failed
panes. Its buttons add a split beside that pane, zoom or restore that pane,
open files using that pane's source session, close that pane, and open its own
actions menu. These controls remain available on the visible mobile pane.
Closing uses the existing view close guards and does not stop source execution.
The 2026-10-22 restoration was checked with TypeScript, existing layout/controller
logic tests, and a client build; UI acceptance belongs to the user this stage.

Each pane's existing actions menu contains its Host's Conversation, contributed
main panels, original Settings launcher, and plugin-view guide. The separate
always-visible Host navigation row has been removed. The menu also retains the
workspace actions: open a plugin view beside the current pane, Files, Terminal,
source session tools, choose a conversation, split, zoom, move, and close.

`src/client/remote-pane.tsx` places the graph's tools into a workspace-owned menu
outlet. The buttons retain their original graph's public layout/sidebar APIs;
Settings still uses the official settings owner's callback and modal. This does
not transfer a SessionReference to another graph or duplicate the settings UI.
On a narrow viewport, the same tools move to the focused pane's bottom menu.
Inactive panes keep their plugin graph and state but do not add another visible
tools menu.

The outer pane title remains the drag handle on desktop. Mobile also retains
the pane switcher below the conversation. Menus remain keyboard accessible and use the existing outside-click
and Escape dismissal behavior. Touch menu actions have a minimum 44px height.

## Text, source status, and installation

Workspace-owned text explicitly inherits the public DSH font family, with a
system sans-serif fallback. Main list text defaults to 14px, pane/control text
to at least 13px, and source-header metadata to 12px. Monospace is reserved for
content that needs it. These styles do not replace the official chat renderer
or terminal renderer.

The source actions dock can scroll rather than consuming unlimited conversation
height. Ordinary source notices start collapsed; source errors remain visible
and their diagnostic details can be expanded. The original source-session
resolver distinguishes loading, not found, removed, denied, transport,
not-ready, ambiguous, and identity failures. Workspace messages describe those
states in Chinese or English, keep the original resource reference, and place
raw diagnostic identifiers under technical details. Retry continues to resolve
the exact original source identity.

Source agents no longer advertise a DSH agent preset that does not actually
exist. Their real engine remains visible through the source-header contribution.
DSH's source model tuple receives a readable label without changing its stored
model identity; other engines retain their own model contracts.

Installation is an explicit action in the official Settings section
**Notifications and installation**. A browser install offer no longer creates
an unsolicited card over conversation content. Real task notifications and
workspace-update handling remain available.

## Validation and its limits

`e2e/workspace-chrome.spec.ts` runs the unchanged pinned official DSH Web with
synthetic HAPI protocol fixtures. The desktop case uses 2048×1088 pixels and
opens a native Codex history with 180 turns / 4,500 steps next to a DSH source
conversation. It checks actual rendered answers and chat geometry, complete
official headers, readable computed type, formatted model labels, pane Settings,
plugin-page navigation, and deliberate installation from Settings. The 420×900
touch case checks pane switching, original headers, the focused-pane menu,
Settings, conversation height, and horizontal overflow.

The desktop and mobile cases both passed on 2026-10-21 using Chrome for Testing
156.0.8078.4. Both produced zero browser page errors. Their synthetic screenshots
were inspected at the actual viewport sizes. Chinese glyphs were supplied by an
unmodified Noto Sans CJK SC font through a test-only Fontconfig directory; no
font was injected into the application or added to the production bundle.

The subsequent single-line fix for the mobile **Park draft** label also passed
in the coordinated build. The targeted case fills the original editor, saves
the draft to the correct source scratchlist, verifies that no chat message was
sent, and checks that the button and page remain within the viewport. The latest
desktop and mobile screenshots were inspected after this test; the label stays
on one line and the conversation retains more than 400px of height on mobile.
The same mobile case also verifies that the source engine label fits its own
visible box. Keeping that small label from shrinking preserves the full `DSH`
name when a long machine name shares the narrow header; the complete official
header and the remaining plugin contributions are still present.

These tests do not establish that a particular private deployment has been
updated, nor do they reproduce every historical source payload. They verify
the official component composition and the stated synthetic protocol cases;
they do not substitute for inspecting a failing source transcript or connection
when its body is still unavailable. Private screenshots and private session
data are not included in this repository.
