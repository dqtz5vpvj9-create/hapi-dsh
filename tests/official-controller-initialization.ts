/** Direct fixtures use the same protected initialization entry as upstream's test harness. */
import { Service } from '@deepseek-ai/cordis'
import { SessionController } from '@deepseek-ai/dsh-api-session-controller'
class ControllerInitialization extends SessionController {
  static initialize(controller: SessionController): Promise<void> {
    const target = controller as ControllerInitialization
    const ctx = target.ctx
    // Attachment IO is outside fixtures that only exercise history and routing.
    if (ctx.get('attachments') === undefined) ctx.provide('attachments', { imageLimits: {
      maxImageBytes: 50 * 1024 * 1024, maxImagesPerMessage: 20, maxMessageImageBytes: 200 * 1024 * 1024,
      maxImagePixels: 64_000_000, maxImageDimension: 8192, mediaTypes: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'],
    } } as unknown as import('@deepseek-ai/cordis').Context['attachments'])
    return target[Service.init]()
  }
}
export async function initializeOfficialController<T extends SessionController>(controller: T): Promise<T> {
  await ControllerInitialization.initialize(controller)
  return controller
}
