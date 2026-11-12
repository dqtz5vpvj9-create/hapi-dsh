import { classifyClientError } from './error-policy.ts'

/** The existing catalog poll and explicit refresh share one in-flight read.
 * A failed read never substitutes an empty inventory or tears down a Host. */
export class CatalogRefresh<T> {
    private current: Promise<void> | undefined
    private disposed = false

    constructor(private readonly options: {
        read(): Promise<T>
        accept(value: T): void | Promise<void>
        failed(error: unknown): void
    }) {}

    refresh = (): Promise<void> => {
        if (this.disposed) return Promise.resolve()
        if (this.current) return this.current
        const current = Promise.resolve().then(() => this.options.read()).then(async value => {
            if (!this.disposed) await this.options.accept(value)
        }).catch(error => {
            if (!this.disposed && classifyClientError(error) !== 'cancel') this.options.failed(error)
        }).finally(() => {
            if (this.current === current) this.current = undefined
        })
        this.current = current
        return current
    }

    dispose(): void { this.disposed = true }
}
