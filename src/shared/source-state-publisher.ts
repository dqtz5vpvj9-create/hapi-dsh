/** Independently publish complete status and notice values. A status change
 * must not append another copy of every historical notice to the Session log.
 * These are whole domain values, not patches; the client still receives the
 * same complete, sequenced projection from the official registry. */
export class SourceStatePublisher<T extends { notices: unknown[] }> {
    private status: string | undefined;
    private notices: string | undefined;
    constructor(private readonly write: {
        initial(value: T): void;
        status(value: Omit<T, 'notices'>): void;
        notices(value: T['notices']): void;
    }) {}

    publish(value: T): void {
        const { notices, ...status } = value;
        const statusJson = JSON.stringify(status), noticesJson = JSON.stringify(notices);
        if (this.status === undefined) {
            this.write.initial(value);
            this.status = statusJson; this.notices = noticesJson;
            return;
        }
        if (noticesJson !== this.notices) {
            this.write.notices(notices);
            this.notices = noticesJson;
        }
        if (statusJson !== this.status) {
            this.write.status(status);
            this.status = statusJson;
        }
    }
}
