# Retain mounted readers across interior history growth

Status: source implementation and scoped contracts complete; installed-package acceptance pending. Upstream DSH `0.2.2-rc.1`, commit `66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db`.

The `.8` actual desktop trace attributes its 150 ms gap to a before-page publication. In the largest 154.2 ms microtask, independent candidate preparation takes about 40.7 ms and synchronous live publication 96.7 ms. Two virtual-list measurements force 28.6 ms of style and 21.3 ms of layout. The first layout mounts eight fresh rows; the next mounts another seventeen. This motivates checking range churn, without claiming that the source fix already meets 80 ms.

`VirtualChatRows` previously preserved mounted seats only when every mounted key moved by the same index delta. A retained dependency/control can stay at index zero while older bodies arrive between it and the visible body. The uniform-shift test fails, so the virtualizer first applies the old numeric scroll position to the new model, then replaces that range again after the official viewport publishes its corrected landing.

The regression keeps a control at zero and inserts a hundred earlier rows after it. The old implementation drops resident `row-2` through `row-10` and mounts unrelated prefix rows before landing. The changed implementation retains the same DOM seats when every mounted key remains in source order, no key moves backward and at least one advances. The existing official landing/native scroll observer releases that temporary range. Real deletion, backward movement or reordering clears it; explicit navigation keeps its normal path. Measurement, node/byte capacity, reader validation, scroll correction, page budget and public interfaces are unchanged.

Production component contracts check DOM identity before landing, range release at the official landing, actual reorder/deletion, real dirty-height changes, hidden and resized readers, and explicit navigation. The new source behavior must still be tested through the installed application; this ADR does not turn the `.8` performance failure into a pass.
