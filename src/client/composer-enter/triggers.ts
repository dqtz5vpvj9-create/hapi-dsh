import type { ArbitrateOutcome, InputTriggerController } from '@deepseek-ai/dsh-client-ui-input-trigger/client'

/** Original HAPI Enter chooses the first suggestion when none was explicitly highlighted. */
export function arbitrateComposerEnter(controller: Pick<InputTriggerController, 'menu' | 'arbitrate'>): ArbitrateOutcome {
  const menu = controller.menu.getSnapshot()
  if (menu.open && menu.highlight === null) {
    if (menu.groups.some(group => group.status === 'ready' && group.items.length > 0)) {
      // The public controller owns ordering, refinement, chip insertion and
      // the selected candidate. We only issue its ordinary first-row gesture.
      controller.arbitrate('down', false)
    } else if (menu.groups.some(group => group.status === 'pending')) return 'consumed'
  }
  return controller.arbitrate('enter', false)
}
