# Finish virtual row measurement before restoring the reading seat

Status: withdrawn from prepared source after receiver audit. The immutable `.13` source/package archives retain the attempted change and its negative results. Applies to `@deepseek-ai/dsh-client-ui-chat` at DSH `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`.

The actual `.12` formal reader completes six earlier body segments and three cached-tail round trips with all anchors at 0px, but still fails the 80ms frame budget at 100ms desktop and 83ms narrow viewport. A subsequent bounded diagnostic, with native geometry methods unwrapped, observes a 133.4ms frame containing two expensive style/layout passes in `VirtualChatRows`' React layout effects. That sampled timing is diagnostic and does not replace the formal result.

The attempted change held `afterLayout` until measured sizes matched the committed virtual geometry. Its source regression observed `[false, true]` for **layout readiness**, rather than the callback's `changed` argument, when actual message text, child or style changes grew a mounted row. Requiring one ready call tested the proposed lifecycle; it did not establish an observable viewport error or explain the expensive native layout work.

The real window-commit reader calls `capturePosition` and `beginPreserving` before publishing. This sets `ChatViewport.paging`. `captureVirtualLayout` then returns immediately, without reading geometry. With no pending explicit restore, `restoreVirtualLayout` also returns because there is no saved virtual position or paging is active. The early callback therefore does not perform the extra restore previously claimed for this publication path. A pending explicit navigation restore is a different path; this investigation has not demonstrated erroneous behavior there.

The `.13` formal run still failed the unchanged 80ms requirement at 233ms desktop and 117ms at 390px. Both scenes passed six source-body segments, all exact anchors at 0px and three cache round trips with zero new reads. The live inputs differ from earlier runs, so these numbers neither prove improvement nor regression.

The prepared implementation and the callback-count assertions were reverted together (`635403a7-0971-4b9f-b58b-d49b29692e70`). Existing height, visibility, width, range, explicit reveal and deletion/reorder checks remain. No candidate runtime was changed by this withdrawal. The five-file, 68-case result remains evidence about the attempted source version, not evidence that the actual slow frame was fixed.

The sampled `VirtualChatRows` function contains direct `getClientRects` and row-bound reads as well as the callback. The function-start CPU location cannot separate those sites. Further changes require attribution to an actual geometry call and the mutation/new-row reason requiring it. The separate Conversation candidate JS work and all previous negative results remain recorded.
