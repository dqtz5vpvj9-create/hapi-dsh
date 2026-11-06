/** One layout owner for the HHPI composer. The native editor and slots remain mounted. */
export const compactComposerStyles = String.raw`
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) {
 display:grid!important;grid-template-columns:44px minmax(0,1fr) 44px 44px;grid-template-rows:auto minmax(44px,auto) 44px;
 align-items:end;gap:0!important;padding:4px!important;border-radius:12px!important;min-width:0;max-width:100%;box-sizing:border-box;
}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) :is([class*="_row"],[class*="_tools"],[class*="_trailing"],[class*="_standardControls"],[data-slot="conversation.input.left"],[data-slot="conversation.input.right"],[data-slot="conversation.input.attachments"]) {
 display:contents!important;container-type:normal!important;
}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) :is([class*="_tools"][hidden],[class*="_standardControls"][hidden]) {display:none!important}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) :is([class*="_add"],[class*="_modes"]) {display:none!important}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-input-scroll] {grid-column:2;grid-row:2;min-width:0;max-height:96px;margin:0;align-self:center}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-composer-input] {box-sizing:border-box;min-height:44px!important;padding:10px 4px!important;font-size:16px!important;line-height:24px!important}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-composer-placeholder] {inset:10px 4px auto!important;font-size:16px!important;line-height:24px!important;white-space:nowrap!important}
.hapi-pane [data-composer-card][data-hapi-composer-expanded] [data-input-scroll] {max-height:min(320px,45dvh)}
.hapi-compact-attach {grid-column:1;grid-row:2;display:grid;place-items:center;width:44px;height:44px;padding:0;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);cursor:pointer}
.hapi-compact-attach:hover {background:var(--dsw-alias-interactive-bg-hover)}
.hapi-compact-attach:disabled {opacity:.45;cursor:default}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-voice-seat {grid-column:3;grid-row:2;min-width:0}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-voice-trigger {width:44px;height:44px;min-height:44px;padding:0;justify-content:center}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-voice-trigger span {display:none}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [class*="_activity"] {grid-column:3;grid-row:2}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [class*="_activityExpanded"] {grid-column:1 / 4}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) button[class*="_primary"] {grid-column:4;grid-row:2;align-self:end;width:44px;height:44px;min-width:44px;min-height:44px;margin:0;transform:none!important;padding:8px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) button[class*="_primary"]:has(+button[class*="_primary"]) {grid-column:3;background:transparent;color:var(--dsw-alias-label-primary)}
.hapi-pane [data-composer-card]:has(button[class*="_primary"]+button[class*="_primary"]) .hapi-voice-seat {visibility:hidden}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-source-controls {
 grid-column:1 / -1;grid-row:3;display:flex!important;flex-wrap:nowrap!important;gap:0!important;align-items:center!important;justify-content:flex-start!important;
 margin:0!important;width:100%;min-width:0;height:44px;border-top:1px solid var(--dsw-alias-border-l1);
}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-picker-anchor {flex:0 0 auto;max-width:none}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-hapi-composer-picker="model"] {flex:0 1 220px;min-width:40px;overflow:hidden}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-picker-capsule {padding:0 4px;gap:2px;height:44px;min-height:44px;font-size:12px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-model-trigger {width:100%;justify-content:flex-start}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-effort-trigger {min-width:44px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-permission-trigger {width:68px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-permission-trigger>svg:first-child {width:14px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) :is([data-picker-label],[data-picker-effort]) {display:inline!important}
.hapi-picker-utility,.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-picker-overflow {display:inline-flex;flex:0 0 44px;width:44px;min-width:44px;height:44px;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;font:inherit}
.hapi-picker-utility:hover {background:var(--dsw-alias-interactive-bg-hover)}
.hapi-picker-utility:disabled {opacity:.45;cursor:default}
.hapi-picker-utility[aria-pressed=true] {color:var(--hapi-accent)}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-source-collaboration {position:absolute;right:8px;bottom:100%;font-size:11px}
.hapi-composer-files {grid-column:1 / -1;grid-row:1;min-width:0;max-width:100%;overflow-x:auto;max-height:80px}
.hapi-composer-files[hidden] {display:none}
.hapi-composer-files img {object-fit:contain!important}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) ~ [data-composer-dock] {display:none}
.hapi-composer-details {margin-top:8px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.hapi-composer-details:empty {display:none}
.hapi-composer-steer-action {box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:8px;background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer}
.hapi-composer-steer-action:hover {background:var(--dsw-alias-interactive-bg-hover)}
.hapi-workspace-mobile[data-software-keyboard]>.hapi-statusbar {display:none}
.hhpi-plan-actions {margin:12px 0 8px;font:inherit}.hhpi-plan-actions>div {display:flex;flex-wrap:wrap;gap:8px}.hhpi-plan-actions button {min-height:44px;padding:8px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.hhpi-plan-actions>div>button:first-child {background:var(--hapi-accent);color:white;border-color:transparent}.hhpi-plan-actions button:disabled {opacity:.45;cursor:default}.hhpi-plan-actions p {font-size:13px}
`
