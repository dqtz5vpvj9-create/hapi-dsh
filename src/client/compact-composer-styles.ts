/** One layout owner for the HHPI composer. The native editor and slots remain mounted. */
export const compactComposerStyles = String.raw`
/* Official activity/usage pills remain mounted and available in More details.
   Only this exact HHPI composer removes their persistent footer reading. */
[data-composer-card]:has([data-hhpi-composer-controls]) + [data-composer-dock] :is([data-composer-stat="activity"],[data-composer-stat="usage"]) {display:none!important}
/* Hidden readings must not leave the native reserved statistics row behind. */
.hapi-pane [data-composer-card]:has([data-hhpi-composer-controls]) + [data-composer-dock] {min-height:0!important;padding-top:0!important}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) {
 display:grid!important;grid-template-columns:44px minmax(0,1fr) var(--hapi-composer-activity-width,0px) 44px;grid-template-rows:auto minmax(44px,auto) 44px;
 align-items:end;gap:0!important;padding:4px!important;border-radius:12px!important;min-width:0;max-width:100%;box-sizing:border-box;
}
/* A missing voice/activity seat must not reserve a blank button-width beside
   the draft. Stop + Send still receive two independent native button seats. */
.hapi-pane [data-composer-card]:has(.hapi-compact-attach):is(:has(.hapi-voice-seat),:has([class*="_activity"] button),:has(button[class*="_primary"]+button[class*="_primary"])) {--hapi-composer-activity-width:44px}
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
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) button[class*="_primary"]:disabled:not([data-sending]) {background:var(--dsw-alias-bg-layer-2,#eef2f1);color:var(--dsw-alias-label-secondary,#65717b);opacity:.5;cursor:default}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) button[class*="_primary"]:has(+button[class*="_primary"]) {grid-column:3;background:transparent;color:var(--dsw-alias-label-primary)}
.hapi-pane [data-composer-card]:has(button[class*="_primary"]+button[class*="_primary"]) .hapi-voice-seat {visibility:hidden}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-source-controls {
 grid-column:1 / -1;grid-row:3;display:flex!important;flex-wrap:nowrap!important;gap:0!important;align-items:center!important;justify-content:flex-start!important;
 margin:0!important;width:100%;min-width:0;height:44px;border-top:1px solid var(--dsw-alias-border-l1);
}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-picker-anchor {flex:0 0 auto;max-width:none}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-hapi-composer-picker="model"] {flex:1 1 106px;width:auto;max-width:220px;min-width:106px;margin-inline-end:auto}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-picker-capsule {padding:0 4px;gap:2px;height:44px;min-height:44px;font-size:12px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-model-trigger {width:100%;min-width:0;justify-content:flex-start;text-align:left}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-effort-trigger {min-width:44px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-permission-trigger {width:68px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-permission-trigger>svg:first-child {width:14px}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) :is([data-picker-label],[data-picker-effort]) {display:block!important;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-model-trigger [data-picker-label] {flex:1 1 auto}
.hapi-picker-utility,.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-picker-overflow {display:inline-flex;flex:0 0 44px;width:44px;min-width:44px;height:44px;align-items:center;justify-content:center;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);padding:0;cursor:pointer;font:inherit}
.hapi-picker-utility:hover {background:var(--dsw-alias-interactive-bg-hover)}
.hapi-picker-utility:disabled {opacity:.45;cursor:default}
.hapi-picker-utility[aria-pressed=true] {color:var(--hapi-accent)}
.hapi-source-controls [data-slot="hapi.source.composer-tools"] {display:contents}
.hapi-picker-actions .hapi-composer-expand-more {display:none}
@container hapi-pane (max-width:520px) {
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-permission-trigger {width:44px}
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-permission-trigger [data-picker-label] {display:none!important}
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-effort-trigger {width:44px;padding:0}
 /* Each button already opens a picker. Keep its source value instead of
    spending the narrow row on a second indication of that same action. */
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) :is(.hapi-model-trigger,.hapi-effort-trigger)>svg {display:none}
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-model-trigger {padding:0 2px}
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-picker-effort] {white-space:nowrap}
}
@container hapi-pane (max-width:420px) {
 /* Keep the model readable beside five 44px controls. Expansion uses the
    same retained card state through More instead of taking a seventh seat. */
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-composer-expand-trigger {display:none}
}
/* Popovers live in document.body, outside the Pane's size container. The
   overflow seat mirrors the owning trigger's computed container result. */
.hapi-composer-expand-more[data-compact] {display:block!important}
.hapi-pane [data-composer-card]:has(.hapi-compact-attach) .hapi-source-collaboration {position:absolute;right:8px;bottom:100%;font-size:11px}
.hapi-composer-files {grid-column:1 / -1;grid-row:1;display:flex;flex-direction:column;gap:4px;min-width:0;max-width:100%}
.hapi-composer-files[hidden] {display:none}
.hapi-composer-file-list {min-width:0;max-width:100%;overflow-x:auto;max-height:80px}
.hapi-composer-upload-status {padding:4px 8px 0;color:var(--dsw-alias-label-secondary,#65717b);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.hapi-composer-files img {object-fit:contain!important}
/* The native rail's negative flex-gap compensation does not belong inside
   our zero-gap grid: it otherwise paints the file card over the draft. */
.hapi-composer-file-list>div {margin-bottom:0}
/* This flex-sized Pane body already has a definite available height. Short
   layouts size one grid track from it, without changing the reader's tree. */
.hapi-workspace-mobile .hapi-pane-body {container-name:hhpi-composer-pane;container-type:size}
/* A short, wide Pane can retain a complete attachment beside its text rather
   than spending a third vertical row. All normal controls keep their seats. */
@container hhpi-composer-pane (min-width:640px) and (max-height:240px) {
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) {
  /* 44px toolbar + card padding/border and native bar clearance. The 96px
     normal text cap still leaves reading space when the Pane is taller. */
  grid-template-rows:0 minmax(44px,min(96px,calc(100cqh - 60px))) 44px;
 }
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach) [data-input-scroll] {min-height:0;max-height:100%;align-self:stretch}
 .hapi-pane [data-composer-card]:has(.hapi-compact-attach):has(.hapi-composer-files:not([hidden])) {
  grid-template-columns:44px minmax(0,260px) minmax(0,1fr) var(--hapi-composer-activity-width,0px) 44px;grid-template-rows:minmax(64px,min(96px,calc(100cqh - 60px))) 44px;
 }
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) .hapi-composer-files {grid-column:2;grid-row:1;align-self:center}
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) [data-input-scroll] {grid-column:3;grid-row:1}
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) .hapi-compact-attach {grid-row:1}
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) .hapi-voice-seat {grid-column:4;grid-row:1}
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) button[class*="_primary"] {grid-column:5;grid-row:1}
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) button[class*="_primary"]:has(+button[class*="_primary"]) {grid-column:4}
 .hapi-pane [data-composer-card]:has(.hapi-composer-files:not([hidden])) .hapi-source-controls {grid-row:2}
}
.hapi-composer-details {margin-top:8px;padding:8px;border-top:1px solid var(--dsw-alias-border-l1)}
.hapi-composer-details:empty {display:none}
.hapi-composer-steer-action {box-sizing:border-box;width:100%;min-height:44px;padding:10px 12px;border:0;border-radius:8px;background:transparent;font:inherit;color:inherit;text-align:left;cursor:pointer}
.hapi-composer-steer-action:hover {background:var(--dsw-alias-interactive-bg-hover)}
.hapi-workspace-mobile[data-software-keyboard]>.hapi-statusbar {display:none}
.hhpi-plan-actions {margin:12px 0 8px;font:inherit}.hhpi-plan-actions>div {display:flex;flex-wrap:wrap;gap:8px}.hhpi-plan-actions button {min-height:44px;padding:8px 16px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;cursor:pointer}.hhpi-plan-actions>div>button:first-child {background:var(--hapi-accent);color:white;border-color:transparent}.hhpi-plan-actions button:disabled {opacity:.45;cursor:default}.hhpi-plan-actions p {font-size:13px}
`
