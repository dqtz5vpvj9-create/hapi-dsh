export const composerPickerStyles = String.raw`
/* Replace source cells only at the actual composer occurrence. The ordinary
   DSH composer has no source group and keeps all official controls/styles. */
[data-composer-card]:has(.hapi-source-controls) :is([data-slot="conversation.input.model"],[data-slot="conversation.input.permission"],[data-slot="conversation.input.plan"]) {display:none!important}
/* Pinned toolbar compatibility: let our one group wrap before it can cover
   attach/Stop/Send. Active voice retains its official expanded/hidden state. */
.hapi-pane [data-composer-card]:has(.hapi-source-controls) .uV2eYG_row {flex-wrap:wrap;overflow:visible;align-items:flex-end;row-gap:4px}
.hapi-pane [data-composer-card]:has(.hapi-source-controls) .uV2eYG_tools:not([hidden]) {flex:0 0 auto;max-width:100%}
.hapi-pane [data-composer-card]:has(.hapi-source-controls) .uV2eYG_trailing:not(.uV2eYG_trailingActive) {flex:1 1 180px;max-width:100%;align-items:flex-end}
.hapi-pane [data-composer-card] .uV2eYG_standardControls:not([hidden]):has(.hapi-source-controls) {display:flex;flex:1 1 auto;min-width:0;max-width:100%}
[data-composer-card] [data-slot="conversation.input.right"]:has(.hapi-source-controls) {display:contents!important}
.hapi-source-controls {display:flex;flex:0 1 auto;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:4px;min-width:0;max-width:100%;margin-left:auto}
.hapi-picker-anchor {display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:232px}
.hapi-picker-anchor[data-hapi-composer-picker="permission"] {max-width:174px}
.hapi-picker-capsule,.hapi-picker-overflow {box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:4px;min-width:0;max-width:100%;min-height:32px;padding:4px 10px;border:1px solid transparent;border-radius:9px;background:transparent;color:var(--dsw-alias-label-secondary,#65717b);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.hapi-picker-capsule:hover,.hapi-picker-capsule[aria-expanded=true],.hapi-picker-overflow:hover,.hapi-picker-overflow[aria-expanded=true] {background:var(--dsw-alias-interactive-bg-hover,#eef2f1);color:var(--dsw-alias-label-primary,#22272c)}
.hapi-picker-capsule>[data-picker-label] {min-width:0;overflow:hidden;text-overflow:ellipsis}
.hapi-picker-badge {flex:0 0 auto;max-width:80px;overflow:hidden;text-overflow:ellipsis;font-size:11px;color:var(--dsw-alias-label-primary,#22272c)}
.hapi-picker-capsule svg,.hapi-picker-overflow svg {width:13px;height:13px;flex:none}
.hapi-picker-capsule:focus-visible,.hapi-picker-overflow:focus-visible,.hapi-picker-popover button:focus-visible {outline:2px solid var(--hapi-palette-accent,#359b6c);outline-offset:2px}
.hapi-picker-capsule[data-pending]::after {content:'';width:5px;height:5px;background:var(--hapi-palette-accent,#359b6c);border-radius:50%;flex:none}
.hapi-picker-overflow {position:relative;flex:none;width:32px;padding:4px;border-color:transparent}
.hapi-picker-attention {position:absolute;top:5px;right:5px;width:5px;height:5px;border-radius:50%;background:var(--dsw-alias-state-error-primary,#bd4b4b)}
.hapi-source-permission,.hapi-source-readonly,.hapi-source-collaboration {display:inline-flex;align-items:center;min-height:28px;padding:2px 6px;color:var(--dsw-alias-label-secondary,#65717b);font-size:12px;line-height:18px;overflow-wrap:anywhere}
.hapi-picker-popover {position:fixed;z-index:10030;box-sizing:border-box;overflow:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-l2,#d8dedf);border-radius:12px;padding:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#22272c);box-shadow:0 8px 28px rgb(0 0 0 / 12%);font:13px/1.45 var(--dsw-font-family,system-ui,sans-serif);text-align:left;overflow-wrap:anywhere}
.hapi-picker-popover[hidden] {display:none}
.hapi-picker-popover[data-picker-layout="bottom"] {border-radius:18px;padding-bottom:max(8px,env(safe-area-inset-bottom,0px))}
.hapi-picker-popover button {font:inherit;color:inherit;cursor:pointer}
.hapi-picker-popover button:disabled {opacity:.45;cursor:default}
.hapi-picker-popover>header {position:sticky;top:-8px;z-index:1;display:flex;align-items:center;gap:8px;margin:-8px -8px 4px;padding:4px 8px;background:inherit;border-bottom:1px solid var(--dsw-alias-border-l2,#d8dedf)}
.hapi-picker-popover>header>strong {flex:1;font-weight:600}
.hapi-picker-popover>header>button {width:44px;height:44px;flex:none;border:0;border-radius:9px;background:transparent;display:grid;place-items:center}
.hapi-picker-popover>header>button:hover {background:var(--dsw-alias-interactive-bg-hover,#eef2f1)}
.hapi-picker-popover svg {width:15px;height:15px;flex:none}
.hapi-picker-model-page,.hapi-picker-options {display:flex;flex-direction:column;gap:4px}
.hapi-picker-model-page>button,.hapi-picker-options>label {box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:44px;padding:8px 10px;border:0;border-radius:9px;background:transparent;text-align:left}
.hapi-picker-model-page>button:hover,.hapi-picker-options>label:hover {background:var(--dsw-alias-interactive-bg-hover,#eef2f1)}
.hapi-picker-model-page>button>span,.hapi-picker-options>label>span {flex:1;min-width:0;overflow-wrap:anywhere}
.hapi-picker-model-page small,.hapi-picker-options small {display:block;color:var(--dsw-alias-label-secondary,#65717b);font-size:11px}
.hapi-picker-options>label,.hapi-picker-segments>label {position:relative;cursor:pointer}
.hapi-picker-options input,.hapi-picker-segments input {position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer}
.hapi-picker-options>label>span,.hapi-picker-options>label>svg,.hapi-picker-segments>label>span {pointer-events:none}
.hapi-picker-options>label:has(input:checked),.hapi-picker-segments>label:has(input:checked) {background:var(--dsw-alias-bg-layer-2,#f2f4f3);color:var(--dsw-alias-label-primary,#22272c)}
.hapi-picker-options>label:has(input:disabled),.hapi-picker-segments>label:has(input:disabled) {opacity:.55;cursor:default}
.hapi-picker-options input:disabled,.hapi-picker-segments input:disabled {cursor:default}
.hapi-picker-options>label:has(input:focus-visible),.hapi-picker-segments>label:has(input:focus-visible) {outline:2px solid var(--hapi-palette-accent,#359b6c);outline-offset:2px}
.hapi-picker-effort {margin:12px 4px 8px;padding:0;min-width:0;border:0}
.hapi-picker-effort legend {margin-bottom:8px;font-weight:600}
.hapi-picker-effort-value {display:flex;align-items:center;justify-content:center;gap:5px;font-size:12px;min-height:20px}
.hapi-picker-effort-slider {display:block;width:100%;height:44px;margin:0;accent-color:var(--hapi-palette-accent,#359b6c);cursor:pointer}
.hapi-picker-effort-slider:disabled {opacity:.5;cursor:default}
.hapi-picker-effort-stops {display:flex;justify-content:space-between;gap:2px}
.hapi-picker-effort-stops>button {flex:1;min-width:0;min-height:44px;padding:3px 1px;border:0;border-radius:6px;background:transparent;font-size:11px;color:var(--dsw-alias-label-secondary,#65717b)}
.hapi-picker-effort-stops>button[aria-pressed=true] {color:var(--hapi-palette-accent,#359b6c);font-weight:600}
.hapi-picker-effort-stops>button:hover {background:var(--dsw-alias-interactive-bg-hover,#eef2f1)}
.hapi-picker-segments {display:grid;grid-template-columns:repeat(auto-fit,minmax(72px,1fr));gap:4px}
.hapi-picker-segments>label {box-sizing:border-box;display:flex;align-items:center;justify-content:center;min-height:44px;padding:6px 5px;border:1px solid var(--dsw-alias-border-l2,#d8dedf);border-radius:8px;color:var(--dsw-alias-label-secondary,#65717b);font-size:12px;text-align:center}
.hapi-picker-segments>label>span {display:flex;align-items:center;justify-content:center;gap:3px;min-width:0}
.hapi-picker-segments svg {width:12px;height:12px}
.hapi-picker-fast {display:flex;align-items:center;justify-content:space-between;gap:12px;padding:4px 8px;margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2,#d8dedf)}
.hapi-picker-switch {position:relative;flex:none;width:44px;height:44px;padding:0;border:0;border-radius:8px;background:transparent}
.hapi-picker-switch::before {content:'';position:absolute;top:12px;left:5px;width:34px;height:20px;border-radius:999px;background:var(--dsw-alias-label-secondary,#87918d)}
.hapi-picker-switch>span {position:absolute;top:14px;left:7px;display:block;width:16px;height:16px;border-radius:50%;background:white;transition:transform .12s}
.hapi-picker-switch[aria-checked=true]::before {background:var(--hapi-palette-accent,#359b6c)}
.hapi-picker-switch[aria-checked=true]>span {transform:translateX(14px)}
.hapi-picker-note {margin:8px 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#65717b);overflow-wrap:anywhere}
.hapi-picker-note[role=alert] {color:var(--dsw-alias-label-danger,#bd4b4b)}
.hapi-picker-pending {display:flex;flex-direction:column;gap:3px;margin:8px 4px;padding:8px;border:1px solid var(--dsw-alias-border-l2,#d8dedf);border-radius:8px;font-size:12px}
.hapi-picker-pending strong {font-weight:600}
.hapi-picker-refresh {display:block;min-height:44px;margin:4px 0 0;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--hapi-palette-accent,#359b6c)!important;font-size:12px!important}
.hapi-picker-actions .hapi-composer-parking {display:block;min-width:0}
.hapi-picker-actions .hapi-composer-overflow-section {display:flex;flex-direction:column;gap:2px}
.hapi-picker-actions .hapi-composer-overflow-title {padding:10px 8px 4px;font-size:12px;color:var(--dsw-alias-label-secondary,#65717b)}
.hapi-picker-actions .hapi-composer-overflow-section>button,.hapi-picker-actions .hapi-composer-parking button {box-sizing:border-box;min-height:44px;width:100%;padding:8px;border:0;border-radius:8px;background:transparent;color:inherit;text-align:left;font:inherit;white-space:normal}
.hapi-picker-actions .hapi-composer-overflow-section>button:hover,.hapi-picker-actions .hapi-composer-parking button:hover {background:var(--dsw-alias-interactive-bg-hover,#eef2f1)}
.hapi-picker-actions .hapi-parking-panel {background:var(--dsw-alias-bg-layer-1,#fff);color:inherit}
@media (max-width:600px),(pointer:coarse) {
 .hapi-picker-capsule {min-height:44px}
 .hapi-picker-overflow {width:44px;height:44px}
}
@media (prefers-reduced-motion:reduce) {.hapi-picker-switch>span {transition:none}}
`
