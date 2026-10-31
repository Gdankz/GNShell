import GLib from 'gi://GLib';

export class Lifetime {
    constructor() {
        this.jobs = [];
        this.timers = new Set();
        this.destroyed = false;
    }

    own(cleanup, description = 'owned resource') {
        if (this.destroyed)
            throw new Error(`[GNShell] Cannot register ${description}: the extension lifecycle has already ended.`);
        this.jobs.push({cleanup, description});
        return cleanup;
    }

    connect(object, signal, callback) {
        if (this.destroyed)
            throw new Error(`[GNShell] Cannot connect signal "${signal}": the extension lifecycle has already ended.`);
        let id;
        try {
            id = object.connect(signal, callback);
        } catch (error) {
            throw new Error(`[GNShell] Failed to connect signal "${signal}": ${error.message}`, {cause: error});
        }
        this.own(() => object.disconnect(id), `signal "${signal}" (handler ${id})`);
        return id;
    }

    after(milliseconds, callback) {
        if (this.destroyed)
            throw new Error('[GNShell] Cannot schedule a timer: the extension lifecycle has already ended.');
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, milliseconds, () => {
            this.timers.delete(id);
            try {
                callback();
            } catch (error) {
                console.error(`[GNShell] Timer callback failed after ${milliseconds} ms: ${error.message}`, error);
            }
            return GLib.SOURCE_REMOVE;
        });
        this.timers.add(id);
        return id;
    }

    cancel(id) {
        if (this.timers.delete(id))
            GLib.source_remove(id);
    }

    destroy() {
        if (this.destroyed)
            return;
        this.destroyed = true;
        for (const id of [...this.timers]) {
            try {
                this.cancel(id);
            } catch (error) {
                console.error(`[GNShell] Failed to remove timer ${id} during disable: ${error.message}`, error);
            }
        }
        for (const {cleanup, description} of this.jobs.splice(0).reverse()) {
            try {
                cleanup();
            } catch (error) {
                console.error(`[GNShell] Failed to clean up ${description} during disable: ${error.message}`, error);
            }
        }
    }
}
