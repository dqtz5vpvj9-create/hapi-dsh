/** Our two public toolbar contributions; no official editor node is moved. */
export const composerPickerStyles = String.raw`
/* Shared embedded Conversation occurrences have no per-pane AppFrame. Own the
   replacement at the actual composer card, not an assumed frame ancestor.
   Slot wrappers carry inline display:contents, hence the explicit override.
   Ordinary DSH cards have no source capsules and retain their official cells. */
[data-composer-card]:has([data-hapi-composer-picker="model"]) [data-slot="conversation.input.model"],
[data-composer-card]:has([data-hapi-composer-picker="permission"]) [data-slot="conversation.input.permission"],
[data-composer-card]:has([data-hapi-composer-picker]) [data-slot="conversation.input.plan"] {display:none!important}
/* R8's single row may be narrower than the two official toolbar groups. Let
   source groups wrap as units instead of shrinking the left group underneath
   the fixed trailing group. Attach / Stop / Send retain their official seats.
   Active voice still owns the expanded trailing group and hidden controls. */
.hapi-pane [data-composer-card]:has([data-hapi-composer-picker]) .uV2eYG_row {flex-wrap:wrap;overflow:visible;row-gap:4px}
.hapi-pane [data-composer-card]:has([data-hapi-composer-picker]) .uV2eYG_tools:not([hidden]),
.hapi-pane [data-composer-card]:has([data-hapi-composer-picker]) .uV2eYG_trailing:not(.uV2eYG_trailingActive) {flex:0 1 auto;max-width:100%}
[data-composer-card] [data-slot="conversation.input.right"]:has([data-hapi-composer-picker="model"]) {min-width:0;max-width:100%}
/* Plain DSH keeps its official controls, directories, dialogs and semantics.
   These declared public slot containers only receive the capsule outline. */
.hapi-host-frame [data-slot="conversation.input.model"] button:not([role]),.hapi-host-frame [data-slot="conversation.input.permission"] button:not([role]) {border-radius:999px;border:1px solid var(--dsw-alias-border-l2,#d8dedf);min-height:28px;padding:3px 9px;font-size:12px;line-height:18px}
.hapi-picker-anchor {display:inline-flex;align-items:center;flex:0 1 auto;min-width:0;max-width:190px}
.hapi-picker-capsule {box-sizing:border-box;display:inline-flex;align-items:center;justify-content:center;gap:5px;min-width:0;max-width:100%;min-height:28px;padding:3px 9px;border:1px solid var(--dsw-alias-border-l2,#d8dedf);border-radius:999px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-secondary,#65717b);font:inherit;font-size:12px;line-height:18px;white-space:nowrap;cursor:pointer}
.hapi-picker-capsule:hover,.hapi-picker-capsule[aria-expanded=true] {background:var(--dsw-alias-interactive-bg-hover,#eef2f1);color:var(--dsw-alias-label-primary,#22272c)}
.hapi-picker-capsule>span[data-picker-label] {min-width:0;overflow:hidden;text-overflow:ellipsis}
.hapi-picker-capsule>small {font-size:10px;opacity:.75}
.hapi-picker-capsule svg {width:13px;height:13px;flex:none}
.hapi-picker-capsule:focus-visible,.hapi-picker-popover button:focus-visible {outline:2px solid var(--hapi-palette-accent,#359b6c);outline-offset:2px}
.hapi-picker-capsule[data-pending]::after {content:'';width:5px;height:5px;background:var(--hapi-palette-accent,#359b6c);border-radius:50%;flex:none}
.hapi-picker-popover {position:fixed;z-index:10030;box-sizing:border-box;width:min(304px,calc(100vw - 16px));max-height:min(440px,calc(100dvh - 16px));overflow:auto;overscroll-behavior:contain;border:1px solid var(--dsw-alias-border-l2,#d8dedf);border-radius:16px;padding:8px;background:var(--dsw-alias-bg-layer-1,#fff);color:var(--dsw-alias-label-primary,#22272c);box-shadow:0 12px 36px #0003;font:13px/1.45 var(--dsw-font-family,system-ui,sans-serif);text-align:left}
.hapi-picker-popover button {font:inherit;color:inherit;cursor:pointer}
.hapi-picker-popover button:disabled {opacity:.45;cursor:default}
.hapi-picker-popover>header {display:flex;align-items:center;gap:8px;padding:5px 4px 9px}
.hapi-picker-popover>header>strong {flex:1;font-weight:600}
.hapi-picker-popover>header>button {width:27px;height:27px;border:0;border-radius:7px;background:transparent;display:grid;place-items:center}
.hapi-picker-popover>header>button:hover {background:var(--dsw-alias-interactive-bg-hover,#eef2f1)}
.hapi-picker-popover svg {width:15px;height:15px;flex:none}
.hapi-picker-model-page,.hapi-picker-options {display:flex;flex-direction:column;gap:3px}
.hapi-picker-model-page>button,.hapi-picker-options>button {display:flex;align-items:center;gap:8px;width:100%;min-height:38px;padding:8px 10px;border:0;border-radius:9px;background:transparent;text-align:left}
.hapi-picker-model-page>button:hover,.hapi-picker-options>button:hover {background:var(--dsw-alias-interactive-bg-hover,#eef2f1)}
.hapi-picker-model-page>button>span,.hapi-picker-options>button>span {flex:1;min-width:0;overflow-wrap:anywhere}
.hapi-picker-model-page small,.hapi-picker-options small {display:block;color:var(--dsw-alias-label-secondary,#65717b);font-size:11px}
.hapi-picker-options [aria-checked=true] {background:var(--dsw-alias-bg-layer-2,#f6f7f8)}
.hapi-picker-effort {margin:12px 6px 8px;min-width:0}
.hapi-picker-effort>div:first-child {display:flex;justify-content:space-between;gap:8px;margin-bottom:11px}
.hapi-picker-effort output {font-size:12px;color:var(--dsw-alias-label-secondary,#65717b)}
.hapi-picker-effort input[type=range] {display:block;width:100%;margin:0;accent-color:var(--hapi-palette-accent,#359b6c);cursor:pointer}
.hapi-picker-stops {display:flex;justify-content:space-between;gap:2px;margin:5px -5px 0}
.hapi-picker-stops>button {flex:1;min-width:0;border:0;border-radius:5px;padding:3px 1px;background:transparent;color:var(--dsw-alias-label-secondary,#65717b);font-size:10px;overflow-wrap:anywhere;text-align:center}
.hapi-picker-stops>button[aria-pressed=true] {color:var(--hapi-palette-accent,#359b6c);font-weight:600}
.hapi-picker-fast {display:flex;align-items:center;justify-content:space-between;gap:12px;padding:12px 8px 8px;margin-top:8px;border-top:1px solid var(--dsw-alias-border-l2,#d8dedf)}
.hapi-picker-switch {position:relative;flex:none;width:33px;height:20px;padding:2px;border:0;border-radius:999px;background:var(--dsw-alias-label-secondary,#87918d)}
.hapi-picker-switch>span {display:block;width:16px;height:16px;border-radius:50%;background:white;transition:transform .12s}
.hapi-picker-switch[aria-checked=true] {background:var(--hapi-palette-accent,#359b6c)}
.hapi-picker-switch[aria-checked=true]>span {transform:translateX(13px)}
.hapi-picker-note {margin:8px 6px;font-size:12px;color:var(--dsw-alias-label-secondary,#65717b);overflow-wrap:anywhere}
.hapi-picker-note[role=alert] {color:var(--dsw-alias-label-danger,#bd4b4b)}
.hapi-picker-refresh {display:block;margin:7px 4px 2px;border:0;background:transparent;color:var(--hapi-palette-accent,#359b6c)!important;font-size:12px!important}
/* Keep the source model capsule reachable in the existing narrow toolbar.
   The official activity's hidden state still wins while voice is expanded. */
@container hapi-pane (max-width:560px) {
 .hapi-pane [data-composer-card] .uV2eYG_standardControls:not([hidden]):has([data-hapi-composer-picker="model"]),
 .hapi-pane [data-composer-card] [data-slot="conversation.input.right"]:has([data-hapi-composer-picker="model"]) {display:flex}
 .hapi-picker-anchor {max-width:145px}
}
@container hapi-pane (max-width:420px) {.hapi-picker-capsule {min-height:32px;padding:4px 8px}.hapi-picker-capsule>small {display:none}}
@container hapi-pane (max-width:360px) {.hapi-picker-anchor {max-width:115px}.hapi-picker-anchor[data-hapi-composer-picker="permission"] {max-width:100px}}
@media (pointer:coarse) {.hapi-picker-capsule {min-height:36px}.hapi-picker-options>button,.hapi-picker-model-page>button {min-height:44px}.hapi-picker-stops>button {min-height:30px}}
@media (prefers-reduced-motion:reduce) {.hapi-picker-switch>span {transition:none}}
`
