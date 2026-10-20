/** Scoped chrome only. Official Conversation owns every chat/composer style. */
export const workspaceStyles = String.raw`
.hapi-workspace,.hapi-session-sidebar,.hapi-session-rail,.hapi-dialog,.hapi-conversation,.hapi-remote-shell {
 --hapi-bg:var(--dsw-alias-bg-layer-1,#fff);--hapi-muted:var(--dsw-alias-bg-layer-2,#f6f7f8);
 --hapi-fg:var(--dsw-alias-label-primary,#22272c);--hapi-secondary:var(--dsw-alias-label-secondary,#65717b);
 --hapi-border:var(--dsw-alias-border-l2,#d8dedf);--hapi-hover:var(--dsw-alias-interactive-bg-hover,#eef2f1);
 --hapi-accent:#359b6c;--hapi-danger:#d75c5c;color:var(--hapi-fg);font:inherit;
}
.hapi-workspace {display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;overflow:hidden;background:var(--hapi-bg)}
.hapi-workspace-toolbar {display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:43px;padding:4px 10px 4px max(12px,var(--dsh-frame-leading-clearance,0px));border-bottom:1px solid var(--hapi-border);flex-shrink:0}
.hapi-workspace-brand {display:flex;align-items:center;gap:8px;min-width:0;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.hapi-workspace-brand>svg {color:var(--hapi-accent)}
.hapi-workspace-brand>strong {letter-spacing:.08em}.hapi-workspace-brand>span {color:var(--hapi-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hapi-workspace-tools,.hapi-button-row {display:flex;align-items:center;gap:5px;flex-wrap:wrap}
.hapi-workspace-tools {flex-wrap:nowrap}.hapi-icon-button {display:inline-flex;align-items:center;justify-content:center;flex:0 0 auto;width:29px;height:29px;padding:5px;border:0;border-radius:5px;background:transparent;color:inherit;cursor:pointer}
.hapi-icon-button:hover,.hapi-icon-button[aria-pressed=true] {background:var(--hapi-hover)}
.hapi-icon-button:disabled {opacity:.3;cursor:default}.hapi-icon-button:focus-visible,.hapi-menu>summary:focus-visible {outline:2px solid var(--hapi-accent);outline-offset:-1px}
.hapi-workspace-stage {position:relative;flex:1;min-height:0;min-width:0;overflow:hidden}
.hapi-window {position:absolute;inset:0;visibility:hidden;pointer-events:none}.hapi-window-active {visibility:visible;pointer-events:auto}
.hapi-pane {position:absolute;display:flex;flex-direction:column;min-width:0;min-height:0;padding:2px;box-sizing:border-box;outline:0}
.hapi-pane::after {content:"";position:absolute;inset:2px;border:1px solid var(--hapi-border);border-radius:5px;pointer-events:none;z-index:3}
.hapi-pane-focused::after {border-color:var(--hapi-accent)}
.hapi-pane-header {position:relative;display:flex;align-items:center;gap:6px;min-height:31px;max-height:31px;padding:0 4px 0 10px;border-radius:4px 4px 0 0;background:var(--hapi-muted);font:11px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;flex-shrink:0;z-index:4}
.hapi-pane-focused>.hapi-pane-header {background:color-mix(in srgb,var(--hapi-accent) 11%,var(--hapi-muted))}
.hapi-pane-title {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;flex:1}.hapi-pane-source {white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:35%;font-size:10px;color:var(--hapi-secondary)}
.hapi-pane-header>.hapi-icon-button {width:23px;height:23px}.hapi-dot {display:inline-block;width:6px;height:6px;border-radius:50%;flex:0 0 6px;background:var(--hapi-secondary);opacity:.45}
.hapi-dot-running {background:var(--hapi-accent);opacity:1;box-shadow:0 0 0 3px color-mix(in srgb,var(--hapi-accent) 12%,transparent)}
.hapi-pane-body {display:flex;flex:1;min-width:0;min-height:0;position:relative;overflow:hidden;border-radius:0 0 4px 4px;background:var(--hapi-bg)}
.hapi-pane-body>div {width:100%;min-height:0}.hapi-conversation {display:flex;flex-direction:column;min-width:0;min-height:0;flex:1;height:100%;overflow:hidden}
.hapi-conversation-content {display:flex;flex:1;min-height:0;min-width:0;position:relative;overflow:hidden}.hapi-conversation-content>div {flex:1;min-height:0;min-width:0;width:100%}
.hapi-conversation-native [data-slot="conversation.input.model"],.hapi-conversation-native [data-slot="conversation.input.permission"],.hapi-conversation-native [data-slot="conversation.input.plan"] {display:none!important}
.hapi-remote-shell {height:100%;min-height:0;min-width:0;flex:1;display:flex;flex-direction:column;overflow:hidden;--dsh-frame-leading-clearance:0px;--dsh-frame-top-clearance:0px}
.hapi-host-frame {flex:1;min-height:0;position:relative;overflow:hidden}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay]) {padding-top:0!important}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay])>div:has(>[data-slot="main"]) {grid-column:1 / 3;grid-row:1}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay])>[data-rightbar-col] {grid-column:3;grid-row:1}
.hapi-remote-shell [data-slot="root"]>div:has(>[data-shell-overlay])>div:has(>[data-slot="sidebar"]) {display:none}
.hapi-remote-shell [data-slot="sidebar"],.hapi-remote-shell [data-shell-leading],.hapi-remote-shell [data-side="sidebar"] {display:none!important}
.hapi-host-tools {display:flex;align-items:center;gap:7px;flex:0 0 auto;min-height:27px;padding:2px 7px;border-bottom:1px solid var(--hapi-border);font:10px ui-monospace,monospace}
.hapi-host-tools>span:first-child {max-width:35%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--hapi-secondary)}
.hapi-host-tools>select {margin-left:auto;min-width:70px;max-width:45%;background:var(--hapi-muted);border:1px solid var(--hapi-border);border-radius:4px;color:inherit;padding:3px 5px;font:inherit}
.hapi-host-tools button {background:transparent;border:0;border-radius:4px;padding:4px;color:inherit;font:inherit;cursor:pointer}.hapi-host-tools button:hover {background:var(--hapi-hover)}
.hapi-empty {display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;padding:28px;overflow:auto;box-sizing:border-box;text-align:center;color:var(--hapi-secondary)}
.hapi-empty>svg {color:var(--hapi-accent);opacity:.6}.hapi-empty h2 {font-size:15px;font-weight:550;margin:0;color:var(--hapi-fg)}.hapi-empty p {font-size:12px;line-height:1.65;max-width:310px;margin:0}.hapi-empty kbd {font:11px ui-monospace,SFMono-Regular,monospace;opacity:.7}
.hapi-empty>button,.hapi-native button,.hapi-dialog button:not(.hapi-icon-button),.hapi-notice>button:not(.hapi-icon-button) {padding:7px 11px;background:var(--hapi-muted);color:var(--hapi-fg);border:1px solid var(--hapi-border);border-radius:6px;cursor:pointer;font:inherit;font-size:12px}
.hapi-empty>button:hover,.hapi-native button:hover,.hapi-dialog button:not(.hapi-icon-button):hover {background:var(--hapi-hover)}
.hapi-native button:disabled,.hapi-dialog button:disabled {opacity:.45;cursor:default}.hapi-loading {padding:20px;font-size:12px;color:var(--hapi-secondary)}
.hapi-resize {position:absolute;z-index:6;touch-action:none;outline:0}.hapi-resize-horizontal {width:7px;transform:translateX(-50%);cursor:col-resize}.hapi-resize-vertical {height:7px;transform:translateY(-50%);cursor:row-resize}
.hapi-resize:hover,.hapi-resize:focus-visible {background:color-mix(in srgb,var(--hapi-accent) 45%,transparent)}
.hapi-statusbar {display:flex;align-items:center;min-height:34px;flex:0 0 auto;border-top:1px solid var(--hapi-border);padding:0 7px 0 0;gap:3px;font:11px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--hapi-muted)}
.hapi-window-tabs {display:flex;align-items:stretch;min-width:0;overflow-x:auto;scrollbar-width:thin;flex:0 1 auto}
.hapi-window-tabs>button {display:flex;align-items:center;gap:7px;white-space:nowrap;max-width:200px;border:0;border-right:1px solid var(--hapi-border);padding:8px 11px;font:inherit;background:transparent;color:var(--hapi-secondary);cursor:pointer;overflow:hidden;text-overflow:ellipsis}
.hapi-window-tabs>button.hapi-window-tab-active {color:var(--hapi-fg);background:var(--hapi-bg);box-shadow:inset 0 -2px var(--hapi-accent)}
.hapi-window-tabs>button>span:first-child {color:var(--hapi-accent)}.hapi-window-count {opacity:.5;font-size:9px}.hapi-prefix {margin-left:auto;font:inherit;font-size:10px;border:0;background:transparent;color:var(--hapi-secondary);white-space:nowrap;cursor:pointer;padding:4px}
.hapi-prefix-active {color:var(--hapi-accent)}.hapi-persistence {font-size:8px;color:var(--hapi-secondary)}.hapi-persistence-saved {color:var(--hapi-accent)}.hapi-persistence-failed {color:var(--hapi-danger)}
.hapi-menu {position:relative;flex:0 0 auto}.hapi-menu>summary {list-style:none;cursor:pointer;display:flex;align-items:center;justify-content:center;width:24px;height:25px;border-radius:4px}.hapi-menu>summary::-webkit-details-marker {display:none}.hapi-menu>summary:hover,.hapi-menu[open]>summary {background:var(--hapi-hover)}
.hapi-menu-content {position:absolute;right:0;top:100%;display:flex;flex-direction:column;width:max-content;min-width:170px;max-width:280px;max-height:300px;overflow:auto;z-index:40;background:var(--hapi-bg);border:1px solid var(--hapi-border);border-radius:7px;padding:4px;box-shadow:0 5px 25px #0002;font:12px/1.5 system-ui,sans-serif}
.hapi-menu-content>button {border:0;border-radius:4px;display:block;background:transparent;color:var(--hapi-fg);text-align:left;padding:7px 9px;cursor:pointer;font:inherit}.hapi-menu-content>button:hover {background:var(--hapi-hover)}.hapi-menu-content>button:disabled {opacity:.4;cursor:default}
.hapi-window-menu .hapi-menu-content {top:auto;bottom:calc(100% + 4px);right:auto;left:0}
.hapi-notice {display:flex;align-items:center;gap:8px;padding:6px 10px;background:color-mix(in srgb,var(--hapi-danger) 8%,var(--hapi-bg));font-size:12px;flex:0 0 auto}.hapi-notice>span {flex:1;overflow-wrap:anywhere}
.hapi-session-sidebar {display:flex;flex:1;flex-direction:column;min-height:0;width:100%;box-sizing:border-box;padding:4px 8px;overflow:hidden}
.hapi-session-sidebar>header {display:flex;align-items:center;gap:7px;padding:4px 5px 8px;font-size:12px}.hapi-session-sidebar>header>span {font-size:10px;color:var(--hapi-secondary)}.hapi-session-sidebar>header>button {margin-left:auto;width:24px;height:24px}
.hapi-search {display:flex;align-items:center;gap:7px;padding:5px 8px;border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:var(--hapi-secondary)}
.hapi-search>input {font:inherit;font-size:12px;border:0;background:transparent;color:var(--hapi-fg);outline:0;min-width:0;width:100%;padding:2px}.hapi-search:focus-within {border-color:var(--hapi-accent)}
.hapi-session-filters {display:flex;gap:5px;margin:7px 0 10px}.hapi-session-filters>select {flex:1;min-width:0;width:50%;padding:5px 4px;border:1px solid var(--hapi-border);background:var(--hapi-bg);color:var(--hapi-secondary);border-radius:5px;font:11px system-ui,sans-serif}
.hapi-session-list {flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;padding-bottom:10px;scrollbar-width:thin}.hapi-list-empty {font-size:12px;color:var(--hapi-secondary);text-align:center;padding:16px 8px;line-height:1.7}
.hapi-session-row {position:relative;display:flex;align-items:flex-start;gap:1px;border-radius:6px;margin-bottom:3px}.hapi-session-row:hover {background:var(--hapi-hover)}.hapi-session-selected {background:var(--hapi-hover);box-shadow:inset 2px 0 var(--hapi-accent)}
.hapi-session-open {display:block;flex:1;min-width:0;padding:9px 4px 9px 9px;border:0;border-radius:6px;cursor:pointer;background:transparent;color:inherit;text-align:left;font:inherit}
.hapi-session-title {display:flex;align-items:center;gap:7px;font-size:12px;line-height:1.4}.hapi-session-title>span:nth-child(2) {overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.hapi-session-open-mark {color:var(--hapi-accent);font-size:11px}
.hapi-session-meta {display:flex;align-items:center;gap:6px;padding-top:5px;padding-left:13px;font:10px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:var(--hapi-secondary)}
.hapi-engine {font-size:8px;line-height:1.3;letter-spacing:.04em;padding:2px 3px;border-radius:3px;background:color-mix(in srgb,var(--hapi-secondary) 10%,transparent);flex:0 0 auto}.hapi-engine-codex {color:var(--hapi-accent);background:color-mix(in srgb,var(--hapi-accent) 10%,transparent)}
.hapi-session-menu {margin-top:5px;opacity:0}.hapi-session-row:hover>.hapi-session-menu,.hapi-session-row:focus-within>.hapi-session-menu,.hapi-session-menu[open] {opacity:1}.hapi-session-menu .hapi-menu-content {z-index:60}
.hapi-ellipsis {min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.hapi-archived-toggle {display:flex;align-items:center;gap:6px;padding:8px 4px;font-size:10px;color:var(--hapi-secondary);cursor:pointer}.hapi-archived-toggle>input {accent-color:var(--hapi-accent)}
.hapi-session-rail {display:flex;flex-direction:column;align-items:center;gap:6px;padding:10px 0;color:var(--hapi-secondary)}.hapi-session-rail>span {font:10px ui-monospace,monospace}
.hapi-dialog {width:min(420px,calc(100vw - 36px));max-height:80vh;overflow:auto;box-sizing:border-box;border:1px solid var(--hapi-border);border-radius:12px;padding:18px;background:var(--hapi-bg);box-shadow:0 15px 70px #0004;color:var(--hapi-fg)}
.hapi-dialog::backdrop {background:#0005}.hapi-dialog>header {display:flex;align-items:center;justify-content:space-between;gap:16px;margin-bottom:14px}.hapi-dialog h2 {margin:0;font-size:16px;font-weight:600}.hapi-dialog p {font-size:12px;color:var(--hapi-secondary);line-height:1.7}
.hapi-dialog form>label {display:flex;flex-direction:column;gap:6px;font-size:12px}.hapi-dialog input {border:1px solid var(--hapi-border);border-radius:6px;background:var(--hapi-bg);color:inherit;font:inherit;padding:9px}.hapi-dialog .hapi-button-row {justify-content:flex-end;margin-top:14px}
.hapi-shortcuts {font-size:12px}.hapi-shortcuts>div {display:flex;align-items:center;gap:16px;margin:9px 0}.hapi-shortcuts dt {width:82px;flex:0 0 auto}.hapi-shortcuts dd {margin:0}.hapi-shortcuts kbd {background:var(--hapi-muted);border:1px solid var(--hapi-border);border-radius:4px;padding:3px 7px;font:11px ui-monospace,monospace}
.hapi-native {max-height:40%;flex:0 0 auto;overflow:auto;border-top:1px solid var(--hapi-border);background:var(--hapi-bg);font-size:11px;padding:5px 10px;scrollbar-width:thin}.hapi-native-status {display:flex;align-items:center;justify-content:space-between;gap:6px;color:var(--hapi-secondary);font:10px ui-monospace,SFMono-Regular,monospace;padding:3px 0}
.hapi-native-request {border:1px solid var(--hapi-border);border-left:2px solid var(--hapi-accent);padding:8px;border-radius:5px;margin:6px 0}.hapi-native-request>header {display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:7px}.hapi-state {font-size:10px;color:var(--hapi-secondary)}
.hapi-native fieldset {border:0;border-top:1px solid var(--hapi-border);padding:8px 0;margin:8px 0}.hapi-native legend {padding:0;font-size:12px;line-height:1.6}.hapi-native textarea {width:100%;box-sizing:border-box;resize:vertical;min-height:48px;background:var(--hapi-bg);border:1px solid var(--hapi-border);border-radius:5px;color:inherit;padding:7px;font:12px/1.6 inherit;margin-top:5px}
.hapi-native-option {display:flex;align-items:flex-start;gap:7px;padding:5px 0;cursor:pointer}.hapi-native-option input {accent-color:var(--hapi-accent)}.hapi-native-option small {display:block;color:var(--hapi-secondary);line-height:1.5}.hapi-native .hapi-button-row {gap:5px;margin-top:7px}.hapi-native button {font-size:10px;padding:5px 8px}
.hapi-native-create>label,.hapi-create-models>label {display:flex;flex-direction:column;gap:5px;margin:10px 0;font-size:12px}.hapi-native-create select {border:1px solid var(--hapi-border);border-radius:6px;padding:8px;font:inherit;color:var(--hapi-fg);background:var(--hapi-bg);min-width:0}.hapi-create-models {display:flex;gap:10px}.hapi-create-models>label {flex:1;min-width:0}.hapi-native-create>.hapi-create-checkbox {flex-direction:row;align-items:center;gap:7px}.hapi-create-checkbox>input {accent-color:var(--hapi-accent)}
.hapi-native details>summary {cursor:pointer;color:var(--hapi-secondary);font-size:10px;padding:3px 0}.hapi-native pre {max-height:160px;overflow:auto;font:11px/1.6 ui-monospace,monospace;white-space:pre-wrap;overflow-wrap:anywhere}.hapi-native-delivery {padding:7px 0;border-top:1px solid var(--hapi-border)}.hapi-delivery-heading {display:flex;align-items:center;justify-content:space-between;gap:8px}.hapi-error {color:var(--hapi-danger)!important;font-size:11px;line-height:1.6;overflow-wrap:anywhere;margin:6px 0}
.hapi-native .hapi-native-settings-fields {display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;border:0;padding:4px 0;margin:4px 0}.hapi-native-settings-fields>label {display:flex;flex-direction:column;gap:4px;font-size:10px;color:var(--hapi-secondary)}
.hapi-native-settings-fields select {min-width:0;background:var(--hapi-muted);border:1px solid var(--hapi-border);border-radius:4px;padding:5px;color:var(--hapi-fg);font:11px system-ui,sans-serif}
.hapi-native-settings p {font-size:10px;line-height:1.6;margin:5px 0}.hapi-native-settings code,.hapi-fork-receipt>code {display:block;overflow-wrap:anywhere;font:10px ui-monospace,monospace;color:var(--hapi-secondary)}
.hapi-native-plan {padding:5px 0;border-top:1px solid var(--hapi-border);margin-top:5px}.hapi-native-plan p {font-size:11px;line-height:1.6;margin:5px 0}.hapi-plan-receipt {margin-top:7px}.hapi-plan-receipt code {overflow-wrap:anywhere;font:10px ui-monospace,monospace;color:var(--hapi-secondary)}
.hapi-fork-receipt {margin-top:15px;padding-top:12px;border-top:1px solid var(--hapi-border)}.hapi-fork-receipt>header {font-size:12px;margin-bottom:5px}.hapi-fork-receipt details {margin-top:10px;font-size:11px}.hapi-fork-receipt summary {cursor:pointer}
.hapi-risk-checkbox {display:flex;align-items:flex-start;gap:6px;margin:8px 0;font-size:11px;line-height:1.6}.hapi-risk-checkbox input {accent-color:var(--hapi-accent);margin-top:2px}
.hapi-native-fork-action {display:inline-flex;align-items:center;justify-content:center;border:0;background:transparent;color:var(--hapi-secondary);width:24px;height:24px;padding:4px;border-radius:4px;cursor:pointer}.hapi-native-fork-action:hover {color:var(--hapi-accent);background:var(--hapi-hover)}
.hapi-directory-browser {margin-top:10px;border:1px solid var(--hapi-border);border-radius:6px;padding:8px}.hapi-directory-browser>nav {display:flex;flex-wrap:wrap;gap:3px;border-bottom:1px solid var(--hapi-border);padding-bottom:6px}.hapi-directory-entries {max-height:170px;overflow:auto;margin:5px 0}.hapi-directory-entries>button {display:block;width:100%;text-align:left;border:0!important;background:transparent!important}.hapi-directory-entries>button:hover {background:var(--hapi-hover)!important}.hapi-directory-create {display:flex;gap:5px;margin-top:7px}.hapi-directory-create>input {min-width:0;flex:1}
.hapi-new-choice {display:grid;gap:12px;padding-top:8px}.hapi-new-choice>button {display:grid;gap:7px;text-align:left;padding:15px!important}.hapi-new-choice strong {font-size:15px}.hapi-new-choice span {font-size:12px;line-height:1.5;color:var(--hapi-secondary)}
@media (pointer:coarse) {.hapi-session-menu {opacity:1}.hapi-icon-button {min-width:32px;min-height:32px}.hapi-pane-header>.hapi-icon-button {min-width:27px;min-height:27px}.hapi-resize-horizontal {width:12px}.hapi-resize-vertical {height:12px}}
@media (max-width:600px) {.hapi-pane-source {display:none}.hapi-prefix {font-size:0;width:12px;height:12px;border:1px solid var(--hapi-border);border-radius:3px}.hapi-prefix-active {background:var(--hapi-accent)}.hapi-workspace-toolbar {padding-left:max(8px,var(--dsh-frame-leading-clearance,0px));gap:5px}.hapi-workspace-brand>span {max-width:60px}.hapi-workspace-tools {gap:1px}.hapi-workspace-tools>.hapi-icon-button {width:27px}.hapi-empty {padding:16px}.hapi-statusbar {min-height:38px}}
@media (prefers-reduced-motion:reduce) {.hapi-workspace *,.hapi-session-sidebar * {scroll-behavior:auto!important}}
`

export function installWorkspaceStyles(document: Document): () => void {
    const style = document.createElement('style')
    style.dataset.hapiWorkspaceStyles = ''
    style.textContent = workspaceStyles
    document.head.append(style)
    return () => { style.remove() }
}
