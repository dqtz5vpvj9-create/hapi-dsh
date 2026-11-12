# Withdrawn: defer virtual Chat restoration until measured spacers commit

This proposal was archived in `.13` and then withdrawn from prepared source. The test established two callbacks at different readiness states, but the actual coordinated publication reader already skips virtual restoration while its paging anchor is retained. The claimed duplicate landing and resulting expensive layout were not demonstrated.

The `.13` formal run retains valid source bodies, exact anchors and zero-read cache round trips, but fails the unchanged 80ms budget at 233ms desktop and 117ms narrow viewport. These live-source timings are not a controlled before/after comparison.

The implementation and its lifecycle-count assertions were reverted together. The immutable source/package archives and the original test/performance evidence are retained. A future patch must identify the actual expensive geometry call and its required invalidation before claiming a performance fix.
