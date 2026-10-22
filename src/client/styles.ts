/** Scoped chrome only. Official Conversation owns every chat/composer style. */
export const workspaceStyles = String.raw`
.hapi-workspace,.hapi-session-sidebar,.hapi-session-rail,.hapi-dialog,.hapi-conversation,.hapi-remote-shell,.hapi-sidebar-context {
 --hapi-bg:var(--dsw-alias-bg-layer-1,#fff);--hapi-muted:var(--dsw-alias-bg-layer-2,#f6f7f8);
 --hapi-fg:var(--dsw-alias-label-primary,#22272c);--hapi-secondary:var(--dsw-alias-label-secondary,#65717b);
 --hapi-border:var(--dsw-alias-border-l2,#d8dedf);--hapi-hover:var(--dsw-alias-interactive-bg-hover,#eef2f1);
 --hapi-accent:var(--hapi-palette-accent,#359b6c);--hapi-danger:#d75c5c;--hapi-font-chrome:var(--dsw-font-xs-13,13px/20px var(--dsw-font-family,system-ui,sans-serif));--hapi-font-body:var(--dsw-font-s-14,14px/22px var(--dsw-font-family,system-ui,sans-serif));--hapi-font-small:var(--dsw-font-xxxs-11,11px/14px var(--dsw-font-family,system-ui,sans-serif));--hapi-font-title:var(--dsw-font-base-strong-16,500 16px/24px var(--dsw-font-family,system-ui,sans-serif));--hapi-font-section:var(--dsw-font-s-strong-14,500 14px/22px var(--dsw-font-family,system-ui,sans-serif));--hapi-radius:var(--dsw-radius-sm,8px);color:var(--hapi-fg);font:inherit;
}
.hapi-workspace {display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--hapi-bg)}
.hapi-workspace-toolbar {display:flex;align-items:center;justify-content:space-between;gap:10px;min-height:38px;padding:3px 8px 3px max(12px,var(--dsh-frame-leading-clearance,0px));border-bottom:1px solid var(--hapi-border);flex-shrink:0}
.hapi-workspace-brand {display:flex;align-items:center;gap:7px;min-width:0;font:var(--hapi-font-chrome);color:var(--hapi-secondary)}
.hapi-workspace-brand>svg {color:var(--hapi-accent)}
.hapi-workspace-brand>strong {font-weight:600;color:var(--hapi-fg)}.hapi-workspace-brand>span {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--hapi-font-small)}
.hapi-workspace-tools,.hapi-button-row {display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.hapi-workspace-tools {flex-wrap:nowrap}.hapi-icon-button {display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:29px;height:29px;padding:5px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}
.hapi-icon-button:hover,.hapi-icon-button[aria-pressed=true] {background:var(--hapi-hover)}
.hapi-icon-button:disabled {opacity:.3;cursor:default}.hapi-icon-button:focus-visible,.hapi-menu>summary:focus-visible {outline:2px solid var(--hapi-accent);outline-offset:-1px}
.hapi-workspace-stage {position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}
.hapi-window {position:absolute;inset:0;visibility:hidden;pointer-events:none}.hapi-window-active {visibility:visible;pointer-events:auto}
.hapi-pane {position:absolute;display:flex;flex-direction:column;min-width:0;min-height:0;padding:2px;box-sizing:border-box;outline:0;container-type:inline-size;container-name:hapi-pane}
.hapi-pane::after {content:"";position:absolute;inset:2px;border:1px solid transparent;border-radius:var(--hapi-radius);pointer-events:none;z-index:3}
.hapi-pane:hover::after {border-color:var(--hapi-border)}
.hapi-pane-focused::after {border-color:var(--hapi-accent)}
.hapi-pane-header {position:relative;z-index:4;display:flex;align-items:center;flex-wrap:wrap;flex:0 0 auto;gap:2px;min-width:0;min-height:34px;padding:2px 5px;border-bottom:1px solid var(--hapi-border);border-radius:var(--hapi-radius) var(--hapi-radius) 0 0;background:var(--hapi-muted);color:var(--hapi-fg);font:var(--hapi-font-chrome)}
.hapi-pane-heading {display:flex;align-items:center;gap:7px;flex:1 1 80px;min-width:0;max-width:100%;padding:3px;cursor:grab}
.hapi-pane-heading>span:last-child {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500}
.hapi-pane-heading[draggable=true]:active {cursor:grabbing}
.hapi-pane-toolbar {display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;flex:0 1 auto;gap:1px;min-width:0;margin-left:auto}
.hapi-pane-toolbar>.hapi-icon-button,.hapi-pane-toolbar>.hapi-menu>summary {width:28px;height:28px}
.hapi-pane-header:has(.hapi-menu[open]) {z-index:8}
.hapi-pane-status-slot {display:flex;flex:0 0 auto}.hapi-pane-status-slot:empty {display:none}
.hapi-pane-source-status>summary {width:28px;height:28px}
.hapi-pane-source-status[data-hapi-status-error=true]>summary {color:var(--hapi-danger)}
.hapi-pane-source-details {width:340px;max-width:min(340px,calc(100vw - 24px));padding:10px;gap:9px;white-space:normal;overflow-wrap:anywhere}
.hapi-pane-source-details p {margin:4px 0}.hapi-pane-source-details pre {white-space:pre-wrap;max-height:200px;overflow:auto}
.hapi-pane-source-details button {font:inherit;cursor:pointer}
.hapi-native-dock:empty,.hapi-native-dock:not(:has(.hapi-native-request)):not(:has(.hapi-native-plan)) {display:none}
.hapi-dot {display:inline-block;width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:var(--hapi-secondary);opacity:.45}
.hapi-dot-running {background:var(--hapi-accent);opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--hapi-accent) 12%,transparent)}
.hapi-pane-body {display:flex;flex:1;min-width:0;min-height:0;position:relative;isolation:isolate;z-index:0;overflow:hidden;border-radius:0 0 4px 4px;background:var(--hapi-bg)}
.hapi-pane-body>div {width:100%;min-height:0}.hapi-conversation {display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;height:100%;overflow:hidden}
.hapi-source-download {display:inline-flex;align-items:center;flex:0 0 auto;gap:6px;min-width:max-content;font:var(--hapi-font-small);white-space:nowrap}.hapi-source-download>button {border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:var(--hapi-fg);padding:5px 8px;font:inherit;white-space:nowrap;cursor:pointer}.hapi-source-download>button:disabled {opacity:.5;cursor:wait}.hapi-source-download>.hapi-error {max-width:220px}
.hapi-conversation-content {display:flex;flex:1;min-height:0;min-width:0;position:relative;overflow:hidden}.hapi-conversation-content>div {flex:1;min-height:0;min-width:0;width:100%}
.hapi-conversation-native [data-slot="conversation.input.model"],.hapi-conversation-native [data-slot="conversation.input.permission"],.hapi-conversation-native [data-slot="conversation.input.plan"] {display:none!important}
.hapi-remote-shell {height:100%;min-height:0;min-width:0;flex:1;display:flex;flex-direction:column;overflow:hidden;--dsh-frame-leading-clearance:0px;--dsh-frame-top-clearance:0px}
.hapi-host-frame {flex:1;min-height:0;position:relative;overflow:hidden}
.hapi-host-frame {container-type:inline-size}
/* The workspace pane header owns the single pane title. The official session
   header keeps its actions, utilities and view tabs without a second title. */
.hapi-remote-shell [data-window-drag] {min-height:0;padding:5px 10px 0}
.hapi-remote-shell [data-window-drag] [class*="_titleRow"] {min-height:0}
.hapi-remote-shell [data-window-drag] [class*="_headerUtilities"] {margin-left:8px;gap:4px}
.hapi-remote-shell [data-window-drag] [class*="_crumbs"] {display:none!important}
.hapi-remote-shell [data-window-drag] [data-conversation-header-leading]:empty {display:none}
.hapi-remote-shell [data-conversation-tabs] {margin-top:2px;gap:20px;padding-left:0;overflow-x:auto;scrollbar-width:none;white-space:nowrap}
.hapi-remote-shell [data-conversation-tabs] button {padding:0 0 5px;font-size:13px;line-height:16px}
.hapi-native-dock {min-width:0;width:100%;max-height:min(35dvh,300px);overflow:auto;scrollbar-width:thin}
.hapi-source-state-view {padding:16px;max-width:900px;box-sizing:border-box;color:var(--hapi-fg);font:var(--hapi-font-chrome);overflow-wrap:anywhere}.hapi-source-state-view h2 {font:var(--hapi-font-title)}.hapi-source-state-view h3 {font:var(--hapi-font-section)}.hapi-source-state-view>p {color:var(--hapi-secondary)}.hapi-source-state-view dl {display:grid;gap:8px}.hapi-source-state-view dl>div {display:grid;grid-template-columns:minmax(80px,1fr) minmax(0,3fr);gap:12px}.hapi-source-state-view dt {color:var(--hapi-secondary)}.hapi-source-state-view dd {margin:0;min-width:0}.hapi-source-state-view dd small {display:block;color:var(--hapi-secondary)}.hapi-source-state-view section {border-top:1px solid var(--hapi-border);margin-top:16px}.hapi-source-state-view section p {white-space:pre-wrap}.hapi-source-state-empty {padding:16px;color:var(--hapi-secondary)}
.hapi-host-frame [data-sidebar-right-panel="fullscreen"] {width:100cqw!important;max-width:100cqw!important;--dsh-sidebar-width:100cqw!important}
.hapi-plugin-view-shell [data-slot="root"]>div:has(>[data-shell-overlay]) {grid-template-columns:0 0 minmax(0,1fr)!important}
.hapi-plugin-view-shell [data-sidebar-right-panel] {width:100cqw!important;max-width:100cqw!important;--dsh-sidebar-width:100cqw!important}
.hapi-plugin-view-shell [data-side="rightbar"] {display:none}
.hapi-plugin-view-shell [data-slot="main"] {visibility:hidden;pointer-events:none}
[data-slot="root"]>div:has(>[data-shell-overlay]):has(>[class]>.hapi-workspace)>[data-rightbar-col] {display:none}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay]) {padding-top:0!important}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay])>div:has(>[data-slot="main"]) {grid-column:1 / 3;grid-row:1}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay])>[data-rightbar-col] {grid-column:3;grid-row:1}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay])>div:has(>[data-slot="sidebar"]) {display:none}
.hapi-remote-shell [data-slot="sidebar"],.hapi-remote-shell [data-shell-leading],.hapi-remote-shell [data-side="sidebar"] {display:none!important}
/* One compact utility cluster for the pane's global entries, seated in the
   official session header instead of a permanent full-width tool row. */
.hapi-pane-tools {display:flex;align-items:center;gap:2px;flex:none;min-width:0}
.hapi-pane-tools-select {min-width:0;max-width:132px;padding:2px 4px;border:1px solid transparent;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--hapi-secondary);font:var(--hapi-font-small);cursor:pointer}
.hapi-pane-tools-select:hover,.hapi-pane-tools-select:focus-visible {border-color:var(--hapi-border);color:var(--hapi-fg)}
.hapi-pane-tools-button {display:inline-flex;align-items:center;gap:4px;height:24px;padding:2px 6px;border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--hapi-secondary);font:var(--hapi-font-small);cursor:pointer;white-space:nowrap}
.hapi-pane-tools-button:hover,.hapi-pane-tools-button[aria-pressed=true] {background:var(--hapi-hover);color:var(--hapi-fg)}
.hapi-pane-tools-settings:empty {display:none}
.hapi-pane:not(.hapi-pane-focused) .hapi-pane-tools {opacity:.72}
.hapi-pane-tool-error {flex:0 0 auto;padding:5px 10px;color:var(--hapi-danger);font:var(--hapi-font-small);overflow-wrap:anywhere;border-bottom:1px solid var(--hapi-border)}
.hapi-empty {display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:28px;overflow:auto;box-sizing:border-box;text-align:center;color:var(--hapi-secondary)}
.hapi-empty>svg {color:var(--hapi-accent);opacity:.6}.hapi-empty h2 {font:var(--hapi-font-title);margin:0;color:var(--hapi-fg)}.hapi-empty p {font:var(--hapi-font-chrome);line-height:1.6;max-width:320px;margin:0}.hapi-empty kbd {font:var(--hapi-font-small);font-family:var(--ds-font-family-code,ui-monospace,monospace);opacity:.7}
.hapi-empty>button,.hapi-native button,.hapi-dialog button:not(.hapi-icon-button),.hapi-notice>button:not(.hapi-icon-button) {padding:6px 10px;background:var(--hapi-muted);color:var(--hapi-fg);border:1px solid var(--hapi-border);border-radius:var(--dsw-radius-xs,4px);cursor:pointer;font:var(--hapi-font-chrome)}
.hapi-empty>button:hover,.hapi-native button:hover,.hapi-dialog button:not(.hapi-icon-button):hover {background:var(--hapi-hover)}
.hapi-native button:disabled,.hapi-dialog button:disabled {opacity:.45;cursor:default}.hapi-loading {padding:20px;font:var(--hapi-font-chrome);color:var(--hapi-secondary)}
.hapi-resize {position:absolute;z-index:6;touch-action:none;outline:0}.hapi-resize-horizontal {width:7px;transform:translateX(-50%);cursor:col-resize}.hapi-resize-vertical {height:7px;transform:translateY(-50%);cursor:row-resize}
.hapi-resize:hover,.hapi-resize:focus-visible {background:color-mix(in srgb,var(--hapi-accent) 45%,transparent)}
.hapi-statusbar {display:flex;align-items:center;min-height:34px;flex:0 0 auto;border-top:1px solid var(--hapi-border);padding:0 6px 0 0;gap:2px;font:var(--hapi-font-chrome);color:var(--hapi-secondary);background:var(--hapi-muted)}
.hapi-window-tabs {display:flex;align-items:stretch;min-width:0;overflow-x:auto;scrollbar-width:thin;flex:0 1 auto}
.hapi-window-tabs>button {display:flex;align-items:center;gap:6px;white-space:nowrap;max-width:260px;border:0;border-right:1px solid var(--hapi-border);padding:8px 10px;font:inherit;background:transparent;color:var(--hapi-secondary);cursor:pointer;overflow:hidden;text-overflow:ellipsis}.hapi-pane-actions {margin-left:2px;flex:0 0 auto}.hapi-pane-actions>summary {width:26px;height:26px}.hapi-pane-actions .hapi-menu-content {top:auto;bottom:calc(100% + 4px);right:0;left:auto}.hapi-window-context {position:fixed;right:auto;bottom:auto;z-index:10000;min-width:min(230px,calc(100vw - 16px));overscroll-behavior:contain;box-sizing:border-box;color:var(--hapi-fg)}.hapi-window-context>button:focus-visible {background:var(--hapi-hover);outline:2px solid var(--hapi-accent);outline-offset:-2px}.hapi-window-context>[role=separator] {border:0;border-top:1px solid var(--hapi-border);margin:4px}
.hapi-window-tabs>button.hapi-window-tab-active {color:var(--hapi-fg);background:var(--hapi-bg);box-shadow:inset 0 -2px var(--hapi-accent);font-weight:500}
.hapi-window-tabs>button>span:first-child {color:var(--hapi-accent)}.hapi-window-count {opacity:.55;font:var(--hapi-font-small);padding:0 2px;border-radius:999px;background:var(--hapi-hover)}.hapi-prefix {margin-left:auto;font:inherit;border:0;background:transparent;color:var(--hapi-secondary);white-space:nowrap;cursor:pointer;padding:4px}
.hapi-prefix-active {color:var(--hapi-accent)}.hapi-persistence {font:var(--hapi-font-small);color:var(--hapi-secondary)}.hapi-persistence-saved {color:var(--hapi-accent)}.hapi-persistence-failed {color:var(--hapi-danger)}
.hapi-menu {position:relative;flex:0 0 auto}.hapi-menu>summary {list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:center;width:24px;height:25px;border-radius:4px}.hapi-menu>summary::-webkit-details-marker {display:none}.hapi-menu>summary:hover,.hapi-menu[open]>summary {background:var(--hapi-hover)}
.hapi-menu-content {position:absolute;right:0;top:100%;display:flex;flex-direction:column;width:max-content;min-width:200px;max-width:min(300px,calc(100vw - 24px));max-height:min(520px,70dvh);overflow:auto;z-index:40;background:var(--hapi-bg);border:1px solid var(--hapi-border);border-radius:var(--hapi-radius);padding:4px;box-shadow:0 5px 25px #0002;font:var(--hapi-font-chrome)}
.hapi-menu-content>button {border:0;border-radius:var(--dsw-radius-xs,4px);display:block;background:transparent;color:var(--hapi-fg);text-align:left;padding:6px 8px;cursor:pointer;font:inherit}.hapi-menu-content>button:hover {background:var(--hapi-hover)}.hapi-menu-content>button:disabled {opacity:.4;cursor:default}
.hapi-sidebar-context {position:fixed;right:auto;bottom:auto;z-index:10000;min-width:min(230px,calc(100vw - 16px));overscroll-behavior:contain;box-sizing:border-box;color:var(--hapi-fg)}
.hapi-sidebar-context>button:focus-visible {background:var(--hapi-hover);outline:2px solid var(--hapi-accent);outline-offset:-2px}.hapi-sidebar-context>[role=separator] {border:0;border-top:1px solid var(--hapi-border);margin:4px}
.hapi-session-menu-heading {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:270px;padding:5px 9px;color:var(--hapi-secondary);font:var(--hapi-font-small)}.hapi-sidebar-context>button[data-danger=true] {color:var(--hapi-danger)}
.hapi-source-export {display:flex;flex-direction:column;gap:9px}.hapi-source-export>h3,.hapi-source-export>p {margin:0}.hapi-source-export>label {display:flex;align-items:center;gap:10px}.hapi-source-export>label select {flex:1}
@media (pointer:coarse) {.hapi-sidebar-context>button,.hapi-menu-content>button,.hapi-pane-tools-button {min-height:44px}.hapi-menu>summary,.hapi-mobile-pane-bar>.hapi-icon-button {min-width:36px;min-height:36px}}
@media (pointer:coarse) {.hapi-pane-toolbar>.hapi-icon-button,.hapi-pane-toolbar>.hapi-menu>summary {min-width:44px;min-height:44px}}
.hapi-notice {display:flex;align-items:center;gap:8px;padding:5px 10px;background:var(--hapi-muted);border-bottom:1px solid var(--hapi-border);border-left:3px solid var(--hapi-danger);font:var(--hapi-font-chrome);color:var(--hapi-secondary);flex:0 0 auto}.hapi-notice>span {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hapi-session-sidebar {display:flex;flex:1;flex-direction:column;min-height:0;width:100%;box-sizing:border-box;padding:5px 8px 0;overflow:hidden}
.hapi-session-sidebar>header {display:flex;align-items:center;gap:6px;padding:2px 4px 6px;font:var(--hapi-font-chrome)}.hapi-session-sidebar>header>strong {font-weight:600}.hapi-session-sidebar>header>span {font:var(--hapi-font-small);color:var(--hapi-secondary)}.hapi-session-sidebar>header>button {margin-left:auto;width:24px;height:24px}
.hapi-search {display:flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:var(--hapi-secondary)}
.hapi-search>input {font:var(--hapi-font-chrome);border:0;background:transparent;color:var(--hapi-fg);outline:0;min-width:0;width:100%;padding:2px}.hapi-search:focus-within {border-color:var(--hapi-accent)}
.hapi-sidebar-search-controls {position:relative;display:flex;gap:4px;align-items:center;min-height:32px;flex:0 0 auto}.hapi-sidebar-search-controls:has(.hapi-sidebar-calendar) {z-index:120}.hapi-sidebar-search-controls>.hapi-search {flex:1;min-width:0}.hapi-sidebar-search-controls button {font:inherit;color:inherit;cursor:pointer}.hapi-search-chip {display:flex;align-items:center;min-width:0;max-width:calc(100% - 36px);border-radius:18px;color:var(--hapi-secondary)}.hapi-search-chip-active {background:var(--hapi-hover);color:var(--hapi-accent)}.hapi-search-chip>button {border:0;background:transparent;min-width:0;display:flex;align-items:center;gap:6px;padding:6px;font:var(--hapi-font-small);text-align:left}.hapi-search-chip>button>span {overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hapi-search-chip svg {flex:none}.hapi-search-clear {flex:none;background:transparent;border:0;font:16px/1 system-ui!important;padding:2px 4px;min-height:24px;min-width:24px;border-radius:6px}.hapi-search-clear:hover {background:var(--hapi-hover)}.hapi-calendar-trigger {position:relative;display:grid;place-items:center;flex:none;width:30px;height:30px;border:0;border-radius:8px;background:transparent;color:var(--hapi-secondary)!important}.hapi-calendar-trigger:hover {background:var(--hapi-hover)}.hapi-calendar-active {color:var(--hapi-accent)!important}.hapi-calendar-active>span {position:absolute;width:5px;height:5px;border-radius:50%;top:1px;right:1px;background:var(--hapi-accent)}
.hapi-calendar-backdrop {position:fixed;inset:0;background:transparent;border:0;z-index:1;cursor:default!important}.hapi-sidebar-calendar {position:absolute;z-index:2;top:calc(100% + 5px);right:0;width:100%;box-sizing:border-box;border:1px solid var(--hapi-border);background:var(--hapi-bg);color:var(--hapi-fg);border-radius:var(--dsw-radius-md,12px);box-shadow:0 8px 32px #0003;padding:10px;font:var(--hapi-font-small)}.hapi-sidebar-calendar>header {display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px}.hapi-sidebar-calendar>header>button {background:transparent;border:0;border-radius:6px;width:27px;height:27px;font-size:20px}.hapi-sidebar-calendar button:hover {background:var(--hapi-hover)}.hapi-calendar-weekdays,.hapi-calendar-days {display:grid;grid-template-columns:repeat(7,minmax(0,1fr));gap:2px;text-align:center}.hapi-calendar-weekdays {color:var(--hapi-secondary);font-size:10px;padding:3px 0 6px}.hapi-calendar-days>button {position:relative;min-width:0;height:29px;background:transparent;border:0;border-radius:6px;color:var(--hapi-secondary);font-size:11px}.hapi-calendar-days>button[data-activity] {font-weight:600;color:var(--hapi-fg)}.hapi-calendar-days>button[aria-current=date] {box-shadow:inset 0 0 0 1px var(--hapi-border)}.hapi-calendar-days>button[data-in-range] {background:color-mix(in srgb,var(--hapi-accent) 13%,transparent);color:var(--hapi-accent)}.hapi-calendar-days>button[aria-pressed=true] {background:var(--hapi-accent);color:var(--hapi-bg)}.hapi-calendar-inputs {display:flex;gap:6px;margin-top:8px}.hapi-calendar-inputs>label {display:flex;flex-direction:column;gap:3px;flex:1;min-width:0;color:var(--hapi-secondary);font-size:10px}.hapi-calendar-inputs input {background:var(--hapi-bg);color:var(--hapi-fg);border:1px solid var(--hapi-border);border-radius:var(--dsw-radius-xs,4px);padding:3px;min-width:0;max-width:100%;box-sizing:border-box;font:var(--hapi-font-small)}.hapi-sidebar-calendar>footer {display:flex;align-items:center;justify-content:space-between;gap:6px;margin-top:8px;padding-top:7px;border-top:1px solid var(--hapi-border);font-size:10px}.hapi-sidebar-calendar>footer>span {color:var(--hapi-secondary)}.hapi-sidebar-calendar>footer>button {background:transparent;border:0;color:var(--hapi-accent);padding:3px;text-align:right}
.hapi-sidebar-options .hapi-session-filters {display:flex;gap:5px;margin:0 0 2px;padding:0}.hapi-session-filters>select {flex:1;min-width:0;width:50%;padding:4px;border:1px solid var(--hapi-border);background:var(--hapi-bg);color:var(--hapi-fg);border-radius:var(--dsw-radius-xs,4px);font:var(--hapi-font-small)}
.hapi-session-list {flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-bottom:8px;scrollbar-width:thin}.hapi-list-empty {font:var(--hapi-font-chrome);color:var(--hapi-secondary);text-align:center;padding:16px 8px;line-height:1.6}
.hapi-session-row {position:relative;display:flex;align-items:flex-start;gap:1px;border-radius:var(--dsw-radius-xs,4px);margin-bottom:1px}.hapi-session-row:hover {background:var(--hapi-hover)}.hapi-session-selected {background:var(--hapi-hover);box-shadow:inset 2px 0 var(--hapi-accent)}
.hapi-session-open {display:block;flex:1;min-width:0;padding:6px 4px 6px 8px;border:0;border-radius:var(--dsw-radius-xs,4px);cursor:pointer;background:transparent;color:inherit;text-align:left;font:inherit}
.hapi-session-title {display:flex;align-items:center;gap:6px;font:var(--hapi-font-chrome)}.hapi-session-title>span:nth-child(2) {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;font-weight:500}.hapi-session-open-mark {color:var(--hapi-accent);font-size:11px}
.hapi-session-meta {display:flex;align-items:center;gap:6px;padding-top:2px;padding-left:12px;font:var(--hapi-font-small);color:var(--hapi-secondary)}
.hapi-session-time {font:var(--hapi-font-small);color:var(--hapi-secondary);white-space:nowrap;max-width:66px;overflow:hidden;text-overflow:ellipsis;flex:none}.hapi-session-source-state {display:flex;gap:7px;flex-wrap:wrap;padding:2px 0 0 12px;font:var(--hapi-font-small);color:var(--hapi-secondary)}.hapi-session-source-state:empty {display:none}.hapi-session-source-state>span {white-space:nowrap}.hapi-session-tier {color:var(--hapi-accent);font-size:10px;font-weight:600}.hapi-session-request-count {color:#b57b19}.hapi-session-background-count {color:var(--hapi-accent)}.hapi-sidebar-options select {min-width:0;margin-left:auto;max-width:50%;font:var(--hapi-font-small);background:var(--hapi-bg);color:var(--hapi-fg);border:1px solid var(--hapi-border);border-radius:var(--dsw-radius-xs,4px);padding:3px}
.hapi-engine {font:var(--hapi-font-small);line-height:1.3;padding:1px 4px;border-radius:3px;background:var(--hapi-muted);color:var(--hapi-secondary);flex:0 0 auto}.hapi-engine-codex {color:var(--hapi-accent);background:color-mix(in srgb,var(--hapi-accent) 10%,transparent)}
.hapi-session-menu {margin-top:5px;opacity:0}.hapi-session-row:hover>.hapi-session-menu,.hapi-session-row:focus-within>.hapi-session-menu,.hapi-session-menu[open] {opacity:1}.hapi-session-menu .hapi-menu-content {z-index:60}
.hapi-ellipsis {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hapi-archived-toggle {display:flex;align-items:center;gap:6px;padding:5px 4px;font:var(--hapi-font-small);color:var(--hapi-secondary);cursor:pointer}.hapi-archived-toggle>input {accent-color:var(--hapi-accent)}
.hapi-session-rail {display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;color:var(--hapi-secondary)}.hapi-session-rail>span {font:var(--hapi-font-small)}
.hapi-dialog {width:min(420px,calc(100vw - 36px));max-height:80vh;overflow:auto;box-sizing:border-box;border:1px solid var(--hapi-border);border-radius:var(--dsw-radius-md,12px);padding:16px;background:var(--hapi-bg);box-shadow:0 15px 70px #0004;color:var(--hapi-fg);font:var(--hapi-font-body)}
.hapi-dialog::backdrop {background:#0005}.hapi-dialog>header {display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.hapi-dialog h2 {margin:0;font:var(--hapi-font-title)}.hapi-dialog p {font:var(--hapi-font-chrome);color:var(--hapi-secondary);line-height:1.6}
.hapi-dialog form>label {display:flex;flex-direction:column;gap:6px;font:var(--hapi-font-chrome)}.hapi-dialog input {border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:inherit;font:inherit;padding:9px}.hapi-dialog .hapi-button-row {justify-content:flex-end;margin-top:14px}
.hapi-shortcuts {font:var(--hapi-font-chrome)}.hapi-shortcuts>div {display:flex;align-items:center;gap:16px;margin:9px 0}.hapi-shortcuts dt {width:82px;flex:0 0 auto}.hapi-shortcuts dd {margin:0}.hapi-shortcuts kbd {background:var(--hapi-muted);border:1px solid var(--hapi-border);border-radius:4px;padding:3px 7px;font:11px ui-monospace,monospace}
.hapi-native {min-width:0;max-height:none;flex:0 0 auto;border-top:0;background:transparent;font:var(--hapi-font-small);line-height:1.5;padding:0 2px}.hapi-native-request {border:1px solid var(--hapi-border);border-left:2px solid var(--hapi-accent);padding:8px;border-radius:5px;margin:6px 0}.hapi-native-request>header {display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.hapi-state {font:var(--hapi-font-small);color:var(--hapi-secondary)}
.hapi-native fieldset {border:0;border-top:1px solid var(--hapi-border);padding:8px 0;margin:8px 0}.hapi-native legend {padding:0;font:var(--hapi-font-chrome);line-height:1.6}.hapi-native textarea {width:100%;box-sizing:border-box;resize:vertical;min-height:48px;background:var(--hapi-bg);border:1px solid var(--hapi-border);border-radius:var(--dsw-radius-xs,4px);color:inherit;padding:7px;font:var(--hapi-font-chrome);margin-top:5px}
.hapi-native-option {display:flex;align-items:flex-start;gap:7px;padding:5px 0;cursor:pointer}.hapi-native-option input {accent-color:var(--hapi-accent)}.hapi-native-option small {display:block;color:var(--hapi-secondary);font:var(--hapi-font-small);line-height:1.5}.hapi-native .hapi-button-row {gap:5px;margin-top:7px}.hapi-native button {font-size:10px;padding:5px 8px}
.hapi-native-create>label,.hapi-create-models>label {display:flex;flex-direction:column;gap:5px;margin:10px 0;font:var(--hapi-font-chrome)}.hapi-native-create select {border:1px solid var(--hapi-border);border-radius:6px;padding:8px;font:inherit;color:var(--hapi-fg);background:var(--hapi-bg);min-width:0}.hapi-create-models {display:flex;gap:10px}.hapi-create-models>label {flex:1;min-width:0}.hapi-native-create>.hapi-create-checkbox {flex-direction:row;align-items:center;gap:7px}.hapi-create-checkbox>input {accent-color:var(--hapi-accent)}
.hapi-native details>summary {cursor:pointer;color:var(--hapi-secondary);font:var(--hapi-font-small);padding:3px 0}.hapi-native pre {max-height:160px;overflow:auto;font:11px/1.6 var(--ds-font-family-code,ui-monospace,monospace);white-space:pre-wrap;overflow-wrap:anywhere}.hapi-native-delivery {padding:7px 0;border-top:1px solid var(--hapi-border)}.hapi-delivery-heading {display:flex;align-items:center;justify-content:space-between;gap:8px}.hapi-error {color:var(--hapi-danger);font:var(--hapi-font-small);line-height:1.5;overflow-wrap:anywhere;margin:6px 0;padding:5px 8px;border-left:2px solid var(--hapi-danger);border-radius:var(--dsw-radius-xs,4px);background:color-mix(in srgb,var(--hapi-danger) 7%,transparent)}
.hapi-fork-receipt {margin-top:15px;padding-top:12px;border-top:1px solid var(--hapi-border)}.hapi-fork-receipt>header {font:var(--hapi-font-chrome);margin-bottom:5px}.hapi-fork-receipt details {margin-top:10px;font:var(--hapi-font-small)}.hapi-fork-receipt summary {cursor:pointer}
.hapi-risk-checkbox {display:flex;align-items:flex-start;gap:6px;margin:8px 0;font:var(--hapi-font-small);line-height:1.6}.hapi-risk-checkbox input {accent-color:var(--hapi-accent);margin-top:2px}
.hapi-native-fork-action {display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--hapi-secondary);width:24px;height:24px;padding:4px;border-radius:4px;cursor:pointer}.hapi-native-fork-action:hover {color:var(--hapi-accent);background:var(--hapi-hover)}
.hapi-directory-browser {margin-top:10px;border:1px solid var(--hapi-border);border-radius:6px;padding:8px}.hapi-directory-browser>nav {display:flex;flex-wrap:wrap;gap:3px;border-bottom:1px solid var(--hapi-border);padding-bottom:6px}.hapi-directory-entries {max-height:170px;overflow:auto;margin:5px 0}.hapi-directory-entries>button {display:block;width:100%;text-align:left;border:0!important;background:transparent!important}.hapi-directory-entries>button:hover {background:var(--hapi-hover)!important}.hapi-directory-create {display:flex;gap:5px;margin-top:7px}.hapi-directory-create>input {min-width:0;flex:1}
.hapi-new-choice {display:grid;gap:12px;padding-top:8px}.hapi-new-choice>button {display:grid;gap:7px;text-align:left;padding:15px!important}.hapi-new-choice strong {font:var(--hapi-font-title)}.hapi-new-choice span {font:var(--hapi-font-chrome);line-height:1.5;color:var(--hapi-secondary)}
@media (pointer:coarse) {.hapi-session-menu {opacity:1}.hapi-icon-button {min-width:32px;min-height:32px}.hapi-pane-actions>summary {min-width:32px;min-height:32px}.hapi-resize-horizontal {width:12px}.hapi-resize-vertical {height:12px}}
@media (max-width:600px) {.hapi-prefix {font-size:0;width:12px;height:12px;border:1px solid var(--hapi-border);border-radius:3px}.hapi-prefix-active {background:var(--hapi-accent)}.hapi-workspace-toolbar {padding-left:max(8px,var(--dsh-frame-leading-clearance,0px));gap:5px}.hapi-workspace-brand>span {max-width:60px}.hapi-workspace-tools {gap:1px}.hapi-workspace-tools>.hapi-icon-button {width:27px}.hapi-empty {padding:16px}.hapi-statusbar {min-height:38px}}
@media (prefers-reduced-motion:reduce) {.hapi-workspace *,.hapi-session-sidebar * {scroll-behavior:auto!important}}
.hapi-activity {position:relative;display:inline-flex;align-items:center;flex:0 0 8px;width:8px;height:12px}
.hapi-dock-indicator{position:absolute;inset:5px;border:2px solid var(--hapi-accent);border-radius:5px;background:color-mix(in srgb,var(--hapi-accent) 16%,transparent);pointer-events:none;z-index:80;box-sizing:border-box}
.hapi-dock-indicator[data-hapi-drop=left]{right:50%}.hapi-dock-indicator[data-hapi-drop=right]{left:50%}.hapi-dock-indicator[data-hapi-drop=top]{bottom:50%}.hapi-dock-indicator[data-hapi-drop=bottom]{top:50%}
.hapi-dot-error {background:var(--hapi-danger);opacity:1}.hapi-dot-permission {background:#d79435;opacity:1}.hapi-dot-input {background:#8873d9;opacity:1}.hapi-dot-background {background:#5b8ec8;opacity:1}.hapi-dot-offline {background:transparent;outline:1px solid var(--hapi-secondary);opacity:.5}
.hapi-pending-badge {position:absolute;left:4px;top:-7px;font:600 var(--hapi-font-small);color:#b07826}.hapi-unread-dot {width:5px;height:5px;border-radius:50%;background:#438adc;flex:0 0 auto}
.hapi-window-label {min-width:0;overflow:hidden;text-overflow:ellipsis;max-width:200px;flex:0 1 auto}.hapi-window-session {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:40%;flex:0 1 auto;color:var(--hapi-secondary);font:var(--hapi-font-small)}.hapi-window-position {color:var(--hapi-accent);font:var(--hapi-font-small);font-weight:500}.hapi-window-tabs>button {flex-shrink:0;max-width:260px}
.hapi-window-switcher {display:flex;flex-direction:column;gap:6px}.hapi-window-switcher>button {display:flex;align-items:center;gap:10px;text-align:left}.hapi-window-switcher>button[aria-current=page] {border-color:var(--hapi-accent)}.hapi-window-switcher>button>span:not(.hapi-activity) {flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hapi-window-switcher small {color:var(--hapi-secondary)}
.hapi-sidebar-toolbar {display:flex;align-items:center;gap:3px;margin:0 0 5px;min-height:26px;flex:0 0 auto}.hapi-sidebar-toolbar .hapi-list-modes {display:flex;gap:2px;margin:0}.hapi-list-modes>button {border:0;border-radius:var(--dsw-radius-xs,4px);background:transparent;color:var(--hapi-secondary);padding:4px 7px;font:var(--hapi-font-small);cursor:pointer}.hapi-list-modes>button[aria-pressed=true] {background:var(--hapi-hover);color:var(--hapi-fg);font-weight:500}.hapi-sidebar-toolbar .hapi-list-modes {flex:0 0 auto}.hapi-status-select {flex:1 1 0;margin-left:auto;min-width:0;max-width:52%;padding:3px 4px;border:1px solid transparent;background:transparent;color:var(--hapi-secondary);border-radius:var(--dsw-radius-xs,4px);font:var(--hapi-font-small);cursor:pointer}.hapi-status-select:hover,.hapi-status-select:focus-visible {border-color:var(--hapi-border);color:var(--hapi-fg)}.hapi-sidebar-toolbar>.hapi-icon-button {width:22px;height:22px;padding:2px}.hapi-sidebar-toolbar>.hapi-mark-all {margin-left:0;width:22px;height:22px;padding:0;border:0;background:transparent;color:var(--hapi-secondary);border-radius:var(--dsw-radius-xs,4px);cursor:pointer;font:var(--hapi-font-small)}.hapi-sidebar-toolbar>.hapi-mark-all:hover {background:var(--hapi-hover);color:var(--hapi-fg)}
.hapi-session-list {overflow-anchor:none}.hapi-session-list-content {min-width:0}.hapi-recent-window {overflow-anchor:none}.hapi-recent-row {display:flow-root;width:100%;overflow-anchor:none}.hapi-session-date {padding:6px 8px 3px;color:var(--hapi-secondary);font:var(--hapi-font-small);font-weight:500}.hapi-session-date[data-following-day] {padding-top:12px}
.hapi-sidebar-options{color:var(--hapi-secondary);font:var(--hapi-font-small);padding:1px 4px 6px}.hapi-sidebar-options>summary{cursor:pointer;padding:3px 0}.hapi-sidebar-options>label{display:flex;align-items:center;gap:7px;line-height:1.5;margin:7px 0}.hapi-sidebar-options input[type=number]{margin-left:auto;max-width:55px;padding:3px;background:var(--hapi-bg);color:var(--hapi-fg);border:1px solid var(--hapi-border);border-radius:4px}
.hapi-sidebar-section{border-bottom:1px solid var(--hapi-border);margin-bottom:4px;padding-bottom:3px}.hapi-sidebar-section>button{display:flex;align-items:center;gap:6px;width:100%;border:0;background:transparent;color:var(--hapi-secondary);padding:5px 6px;font:var(--hapi-font-small);cursor:pointer;text-align:left}.hapi-sidebar-section>button>strong{flex:1;color:var(--hapi-fg);font-weight:600}.hapi-bucket-heading{font:var(--hapi-font-small);color:var(--hapi-secondary);padding:3px 9px}.hapi-folder-preview-actions{display:flex;gap:6px;flex-wrap:wrap;padding:3px 6px 6px}.hapi-folder-preview-actions>button{border:0;background:transparent;color:var(--hapi-accent);padding:4px;font:var(--hapi-font-small);cursor:pointer}
.hapi-date-filter {flex-shrink:0;font:var(--hapi-font-small);margin:0 0 6px;color:var(--hapi-secondary)}.hapi-date-filter>summary {cursor:pointer;padding:3px}.hapi-date-filter>div {display:flex;flex-wrap:wrap;gap:5px;margin:5px 0}.hapi-date-filter label {display:grid;gap:3px;min-width:0;flex:1}.hapi-date-filter input {min-width:0;width:100%;box-sizing:border-box;border:1px solid var(--hapi-border);border-radius:4px;background:var(--hapi-bg);color:var(--hapi-fg);font:inherit;padding:4px}.hapi-date-filter>button {font:inherit;border:0;background:transparent;color:var(--hapi-accent);cursor:pointer;padding:4px}.hapi-date-filter>button:disabled {opacity:.4;cursor:default}
.hapi-sidebar-count {padding:0 5px;border-radius:999px;background:var(--hapi-hover);line-height:16px}
.hapi-session-destination {color:var(--hapi-accent);white-space:nowrap;font:var(--hapi-font-small);flex-shrink:0;margin-left:auto}.hapi-session-directory {margin-left:auto}.hapi-pinned-sessions {border-bottom:1px solid var(--hapi-border);padding-bottom:5px;margin-bottom:7px}
.hapi-session-branch>.hapi-session-row {margin-left:calc(var(--hapi-row-depth,0) * 12px)}.hapi-tree-toggle {position:relative;flex-shrink:0;width:22px;align-self:center;display:flex;flex-direction:column;align-items:center;border:0;background:transparent;color:var(--hapi-secondary);padding:3px 1px;cursor:pointer;font:var(--hapi-font-chrome)}.hapi-tree-toggle>span {font:var(--hapi-font-small)}
.hapi-folder {margin-bottom:5px}.hapi-folder>header {display:flex;align-items:center;gap:3px;padding:2px 1px}.hapi-folder>header>button {display:flex;align-items:center;gap:5px;min-width:0;flex:1;background:transparent;border:0;color:var(--hapi-secondary);font:var(--hapi-font-small);cursor:pointer;padding:4px 3px}.hapi-folder-name {min-width:0;flex:1;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--hapi-fg);font-weight:500}.hapi-folder small {max-width:65px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font:var(--hapi-font-small);color:var(--hapi-secondary)}.hapi-folder>header .hapi-menu>summary {width:20px;height:20px}
.hapi-picker-back {border:0;background:transparent;color:var(--hapi-accent);font:var(--hapi-font-small);cursor:pointer}.hapi-mobile-session-layer {position:fixed;inset:0;z-index:900;display:flex;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);background:var(--dsw-alias-bg-base,#fff)}.hapi-session-picker {height:100%;background:var(--hapi-bg);padding:12px;box-sizing:border-box}.hapi-session-picker>header {min-height:36px}.hapi-session-picker .hapi-search input {font-size:16px}.hapi-session-picker .hapi-session-open {padding-top:13px;padding-bottom:13px}.hapi-session-picker .hapi-session-title {font:var(--hapi-font-body)}
.hapi-mobile-pane-bar {display:flex;align-items:center;flex:0 0 auto;gap:3px;border-top:1px solid var(--hapi-border);background:var(--hapi-muted);padding:2px 5px;min-height:34px;font:var(--hapi-font-chrome);color:var(--hapi-secondary)}
.hapi-pane-tabs {display:flex;min-width:0;flex:1;overflow-x:auto;scrollbar-width:none}.hapi-pane-tabs>button {display:flex;gap:6px;align-items:center;flex:0 0 auto;max-width:140px;white-space:nowrap;padding:7px;border:0;background:transparent;border-radius:4px;color:var(--hapi-secondary);font:inherit;cursor:pointer}.hapi-pane-tabs>button>span:last-child {overflow:hidden;text-overflow:ellipsis}.hapi-pane-tabs>button[aria-selected=true] {background:var(--hapi-bg);color:var(--hapi-fg);box-shadow:inset 0 -2px var(--hapi-accent);font-weight:500}.hapi-pane-tabs>button>span:first-child {color:var(--hapi-accent)}.hapi-pane-add {border:1px solid var(--hapi-border);border-radius:4px;padding:5px;background:var(--hapi-bg);color:var(--hapi-fg);font:inherit;cursor:pointer;white-space:nowrap}
.hapi-mobile-pane-bar .hapi-menu-content {top:auto;bottom:calc(100% + 5px)}
.hapi-workspace-mobile .hapi-pane {padding:0}.hapi-workspace-mobile .hapi-pane::after {display:none}.hapi-workspace-mobile .hapi-pane-body {border-radius:0}.hapi-workspace-mobile .hapi-pane-grip {display:none}.hapi-workspace-mobile .hapi-pane-actions {display:none}.hapi-workspace-mobile .hapi-workspace-tools>.hapi-icon-button {display:none}.hapi-workspace-mobile .hapi-workspace-toolbar {min-height:34px}.hapi-workspace-mobile .hapi-statusbar {min-height:34px;padding-bottom:env(safe-area-inset-bottom)}.hapi-workspace-mobile .hapi-window-tabs {flex:1}.hapi-workspace-mobile .hapi-window-tabs>button {max-width:190px;padding:9px 8px;gap:5px}.hapi-workspace-mobile .hapi-prefix {display:none}
.hapi-dialog:has(.hapi-files-browser),.hapi-dialog:has(.hapi-native-library),.hapi-dialog:has(.hapi-session-tools) {width:min(900px,calc(100vw - 28px));max-height:90dvh}.hapi-files-browser {height:min(65dvh,700px);min-height:250px;display:flex;flex-direction:column}.hapi-files-browser>.hapi-workbench {flex:1}
.hapi-sidebar-native {border-top:1px solid var(--hapi-border);padding:5px 4px;flex-shrink:0;color:var(--hapi-secondary);font:var(--hapi-font-small)}.hapi-sidebar-native>button {font:inherit;cursor:pointer;border:0;background:transparent;color:var(--hapi-fg);padding:6px 0;text-align:left}.hapi-sidebar-native details summary {cursor:pointer;padding:5px 0}.hapi-sidebar-native details>div {display:flex;align-items:center;gap:7px;padding:4px 0}.hapi-sidebar-native details small {margin-left:auto}
.hapi-native-library,.hapi-machine-panel,.hapi-session-tools {display:flex;flex-direction:column;gap:12px;font:var(--hapi-font-chrome);min-width:0}.hapi-native-library>header h2 {font:var(--hapi-font-title);margin:0}.hapi-native-library nav {display:flex;gap:7px}.hapi-native-library label,.hapi-machine-panel label,.hapi-session-tools label {display:flex;flex-direction:column;gap:5px}.hapi-native-library input,.hapi-native-library select,.hapi-session-tools input,.hapi-session-tools textarea,.hapi-machine-panel input,.hapi-machine-panel select {border:1px solid var(--hapi-border);border-radius:5px;padding:7px;background:var(--hapi-bg);color:var(--hapi-fg);font:inherit;min-width:0}.hapi-native-library textarea,.hapi-session-tools textarea {min-height:80px;resize:vertical;white-space:pre-wrap}.hapi-native-library button[aria-pressed=true] {border-color:var(--hapi-accent)!important;color:var(--hapi-accent)!important}
.hapi-source-panel>.hapi-source-panel {height:auto;min-height:0;overflow:visible;padding:16px 0;border-top:1px solid var(--hapi-border,#8884)}
.hapi-native-search {display:flex;gap:6px;flex-wrap:wrap}.hapi-native-search input {min-width:100px;flex:1}.hapi-native-history-list {max-height:46dvh;overflow:auto}.hapi-native-history-list article,.hapi-machine-panel article {border:1px solid var(--hapi-border);border-radius:5px;padding:10px;margin:7px 0;overflow-wrap:anywhere}.hapi-native-history-list article>header {display:flex;gap:7px;align-items:center}.hapi-native-history-list article p {margin:5px 0}.hapi-native-history-list input[type=checkbox] {accent-color:var(--hapi-accent)}.hapi-native-history-list code,.hapi-operation-status code {font:10px ui-monospace,monospace;overflow-wrap:anywhere}.hapi-operation-status p {margin:4px 0}.hapi-native-confirm {border:1px solid #bf8e3a;border-radius:6px;padding:10px;margin:7px 0}.hapi-native-confirm>button {margin-right:7px}.hapi-device-login {padding:10px;border:1px solid var(--hapi-border);border-radius:6px}.hapi-device-login code {display:block;font:20px ui-monospace,monospace;margin:8px 0}
.hapi-native-user-actions {display:flex;justify-content:flex-end;margin:0 0 9px}.hapi-native-rewind {font:var(--hapi-font-small);color:var(--hapi-secondary)}.hapi-native-rewind button {border:0;background:transparent;color:inherit;font:inherit;padding:4px 7px;cursor:pointer}.hapi-native-rewind button:hover {color:var(--hapi-accent,#359b6c)}.hapi-native-rewind>[role=group] {display:flex;flex-wrap:wrap;gap:5px;padding:8px;border:1px solid var(--hapi-border,#8884);border-radius:5px}
.hapi-native-question-progress {font:var(--hapi-font-small);color:var(--hapi-secondary)}.hapi-native-url {overflow-wrap:anywhere;color:var(--hapi-secondary);font:var(--hapi-font-small)}

/* Narrow pane splits: demote metadata before content, keep one row of tools. */
@container hapi-pane (max-width:560px) {
  .hapi-remote-shell [data-window-drag] {padding:4px 8px 0}
  .hapi-pane-tools-label {display:none}
  .hapi-pane-tools-select {max-width:96px}
}
@container hapi-pane (max-width:400px) {
  .hapi-pane-tools {gap:0}
  .hapi-pane-tools-select {max-width:72px;padding:2px}
  .hapi-pane-tools-button {padding:2px 3px}
  .hapi-remote-shell [data-conversation-tabs] {gap:10px}
  .hapi-remote-shell [data-conversation-header-corner] {display:none}
}
/* HAPI-owned error panels: one calm heading, raw detail on demand. */
.hapi-lease-error {display:flex;flex-direction:column;align-items:flex-start;gap:9px;margin:auto;max-width:520px;padding:20px;color:var(--hapi-secondary);font:var(--hapi-font-body)}
.hapi-lease-error h2 {margin:0;font:var(--hapi-font-title);color:var(--hapi-fg)}
.hapi-lease-error p {margin:0;overflow-wrap:anywhere}
.hapi-lease-error details {width:100%;font:var(--hapi-font-small);color:var(--hapi-secondary)}
.hapi-lease-error pre {margin:4px 0 0;max-height:160px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font:11px/1.5 var(--ds-font-family-code,ui-monospace,monospace)}
/* Toasts stay a compact, dismissible corner stack; they never take the page. */
.hapi-notification-stack.hapi-notification-stack {right:12px;bottom:calc(38px + env(safe-area-inset-bottom,0px));gap:6px;max-width:min(336px,calc(100vw - 24px));max-height:42dvh;z-index:60}
.hapi-notification-stack.hapi-notification-stack article {padding:10px 12px;border-radius:var(--hapi-radius);font:var(--hapi-font-chrome);box-shadow:0 3px 16px #0002}
.hapi-notification-stack.hapi-notification-stack article p {margin:4px 0;max-height:88px}
.hapi-notification-stack.hapi-notification-stack .hapi-notification-dismiss {font-size:16px!important}
/* ===========================================================================
 * R8 — HAPI-style compact workspace composer (official bar retained).
 * Route C: no takeover, no repackage-private API. Official attach/editor/Stop/
 * Send nodes stay owned by ui-conversation; this block compacts toolbar chrome
 * and reveals plugin-owned controls through public slots. The editor retains
 * official auto-growth, font sizing and scroll limits. Pinned-hash class
 * names are confined to this compatibility block (dependency is pinned).
 * ========================================================================== */
.hapi-pane [data-composer-seat] {} /* anchor for readers */
.hapi-pane [data-composer-seat] .wSkVaW_composerStack {gap:4px}
.hapi-pane [data-composer-card] {
  box-sizing:border-box;border-radius:20px;padding:5px 8px 3px;gap:2px;
  background:var(--dsw-specific-input-major);box-shadow:var(--dsw-elevation-soft);
}
.hapi-pane [data-composer-card] .uV2eYG_row {flex-wrap:nowrap;align-items:center;gap:4px;min-height:26px;padding:2px 0 0}
.hapi-pane [data-composer-card] .uV2eYG_tools,
.hapi-pane [data-composer-card] .uV2eYG_modes {gap:4px}
.hapi-pane [data-composer-card] .uV2eYG_trailing {gap:5px;margin-left:auto}
.hapi-pane [data-composer-card] .uV2eYG_standardControls {gap:4px}
.hapi-pane [data-composer-card] .uV2eYG_add {width:26px;height:26px}
.hapi-pane [data-composer-card] .uV2eYG_primary {width:30px;height:30px;transform:none}
.hapi-pane [data-composer-card] .uV2eYG_select {height:24px;font-size:12px;max-width:170px;padding:0 18px 0 6px}
.hapi-pane [data-composer-card] .uV2eYG_notice {font-size:11px;line-height:16px;padding:3px 8px;margin-bottom:3px}
.hapi-pane [data-composer-card]:has([data-slot="conversation.input.attachments"] > *) {padding-top:4px}
.hapi-pane [data-composer-dock] {padding-top:2px;gap:8px;font-size:11px;line-height:16px}

/* R8b: no routine metadata row above the composer. Only actionable or
   exceptional states (approvals, deliveries, errors, resume/read-only) render. */
.hapi-pane .hapi-native {max-height:min(45dvh,360px);overflow:auto;padding:2px 2px 3px;border-top:0;background:transparent;display:flex;flex-direction:column;gap:3px}
.hapi-pane .hapi-native:empty {display:none}
.hapi-pane .hapi-composer-admission {margin:2px 2px 0;color:var(--dsw-alias-label-secondary,#65717b);font:var(--hapi-font-small);overflow-wrap:anywhere}
.hapi-pane .hapi-composer-resume {align-self:flex-start;margin:2px 2px 0}

/* Narrow pane: keep attach / editor / Stop+Send; secondary official controls are
   revealed in place by the overflow entry (no reparenting, no reimplementation). */
@container hapi-pane (max-width:560px) {
  [data-composer-card] .uV2eYG_row {--dsh-composer-model-text-display:none;--dsh-composer-model-icon-display:block}
  [data-composer-card] .uV2eYG_add {width:24px;height:24px}
  [data-composer-card] .uV2eYG_primary {width:28px;height:28px}
  [data-composer-card] .uV2eYG_select {max-width:120px}
  /* Blocked/read-only keeps model reachable: selecting a model is the official way out. */
  [data-composer-card]:has([data-composer-input][aria-disabled="true"]) :where(.uV2eYG_modes,.uV2eYG_standardControls) {display:flex}
}
@container hapi-pane (max-width:420px) {
  [data-composer-card] {border-radius:16px;padding:4px 6px 2px}
  [data-composer-card] .uV2eYG_row {overflow-x:auto;scrollbar-width:none;flex-wrap:nowrap;gap:3px}
  /* Horizontal scrolling also clips vertically. Let the open menu escape its
     row; the closed row keeps its compact horizontal scroll behavior. */
  [data-composer-card] .uV2eYG_row::-webkit-scrollbar {display:none}
  [data-composer-card] .uV2eYG_select {max-width:96px}
}
@media (pointer:coarse) {
  .hapi-pane [data-composer-card] .uV2eYG_add,
  .hapi-pane [data-composer-card] .uV2eYG_primary {width:44px;height:44px}
}

`

export function installWorkspaceStyles(document: Document): () => void {
    const style = document.createElement('style')
    style.dataset.hapiWorkspaceStyles = ''
    style.textContent = workspaceStyles
    document.head.append(style)
    return () => { style.remove() }
}
