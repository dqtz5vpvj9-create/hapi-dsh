/** Independently publish complete status and notice values. A status change
 * must not append another copy of every historical notice to the Session log.
 * These are whole domain values, not patches; the client still receives the
 * same complete, sequenced projection from the official registry. */
export class SourceStatePublisher<T extends { notices: unknown[] }, K extends Exclude<keyof T, 'notices'> = never> {
    private status: string | undefined;
    private notices: string | undefined;
    private separateValue: string | undefined;
    constructor(private readonly write: {
        initial(value: T): void;
        status(value: Omit<T, 'notices' | K>): void;
        notices(value: T['notices']): void;
    }, private readonly separate?: { key: K; write(value: T[K]): void }) {}

    publish(value: T): void {
        const { notices, ...status } = value;
        // An independently changing domain still carries its whole current
        // value. This avoids repeating unrelated queues and approvals for
        // every source execution sequence, without introducing field patches.
        const separateJson = this.separate ? JSON.stringify(value[this.separate.key]) : undefined;
        if (this.separate) delete (status as Partial<T>)[this.separate.key];
        const statusJson = JSON.stringify(status), noticesJson = JSON.stringify(notices);
        if (this.status === undefined) {
            this.write.initial(value);
            this.status = statusJson; this.notices = noticesJson; this.separateValue = separateJson;
            return;
        }
        if (noticesJson !== this.notices) {
            this.write.notices(notices);
            this.notices = noticesJson;
        }
        if (statusJson !== this.status) {
            this.write.status(status as Omit<T, 'notices' | K>);
            this.status = statusJson;
        }
        if (this.separate && separateJson !== this.separateValue) {
            this.separate.write(value[this.separate.key]);
            this.separateValue = separateJson;
        }
    }
}
