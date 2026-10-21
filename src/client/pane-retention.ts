/** A layout may retire its own view before a pending draft CAS has settled.
 * Retention does not extend Host lifetime or make a hidden view interactive. */
export function createPaneRetention(retire: () => void, dispose: () => Promise<void>) {
    let holds = 0, retired = false, started = false;
    let resolve!: () => void, reject!: (error: unknown) => void;
    const finished = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
    const finish = (): void => {
        if (started) return;
        started = true; Promise.resolve().then(dispose).then(resolve, reject);
    };
    return {
        retain(): () => void {
            if (retired || started) throw new Error('This original pane has already been retired. Its saved draft remains available.');
            holds++; let released = false;
            return () => { if (released) return; released = true; holds--; if (retired && !holds) finish(); };
        },
        stop(force = false): Promise<void> {
            if (!retired) { retired = true; retire(); }
            if (force || !holds) finish();
            return finished;
        },
    };
}
