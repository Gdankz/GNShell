export class StateController {
    constructor(settings, life, changed) {
        this.settings = settings;
        this.life = life;
        this.changed = changed;
        this.fullscreen = false;
        this.suspended = false;
        this.locked = false; // lock screen: compact only, no Peek, no Expanded
        this.revealed = false;
        this.expanded = false;
        this.keyboard = false;
        this.live = null;
        this.current = null;
        this.queue = [];
        this.timer = 0;
    }

    get state() {
        if (this.suspended || (this.fullscreen && !this.revealed))
            return 'hidden';
        if (this.locked)
            return 'idle';
        if (this.expanded)
            return 'expanded';
        if (this.fullscreen && this.revealed)
            return this.live ? 'live' : 'idle';
        if (this.current)
            return 'peek';
        return this.live ? 'live' : 'idle';
    }

    policy(fullscreen, suspended, locked) {
        if (this.fullscreen !== fullscreen || suspended || this.locked !== locked) {
            this.revealed = false;
            this.expanded = false;
            this.keyboard = false;
        }
        this.fullscreen = fullscreen;
        this.suspended = suspended;
        this.locked = locked;
        this.changed();
    }

    shortcut() {
        if (this.suspended || this.locked)
            return;
        if (this.fullscreen && !this.revealed)
            this.revealed = true;
        else if (this.expanded && !this.keyboard)
            this.keyboard = true; // opened by pointer: the shortcut adds keyboard focus
        else {
            this.expanded = !this.expanded;
            this.keyboard = this.expanded;
        }
        this.changed();
    }

    // Pointer open (click or hover): never takes keyboard focus or a modal grab.
    open() {
        if (this.state === 'hidden' || this.locked)
            return;
        this.expanded = true;
        this.changed();
    }

    close() {
        this.expanded = false;
        this.keyboard = false;
        this.revealed = false;
        this.changed();
    }

    offer(entry) {
        if (this.locked)
            return false;
        // Expanded already presents these events in Activity; keep the current page.
        if (this.expanded)
            return true;
        if (this.current?.key === entry.key) {
            entry.count = (this.current.count ?? 1) + 1;
            this.current = entry;
            this._expire();
        } else if (this.current?.media && entry.priority > this.current.priority) {
            // Action Required must not wait behind a music Peek; the song is dropped.
            this.current = entry;
            this._expire();
        } else {
            const existing = this.queue.findIndex(item => item.key === entry.key);
            if (existing >= 0)
                this.queue[existing] = entry;
            else if (this.queue.length < 20)
                this.queue.push(entry);
            else
                return false;
            this.queue.sort((a, b) => b.priority - a.priority || a.time - b.time);
            if (!this.current)
                this._next();
        }
        this.changed();
        return true;
    }

    _expire() {
        this.life.cancel(this.timer);
        this.timer = this.life.after((this.current.seconds ?? this.settings.get_uint('peek-seconds')) * 1000, () => {
            this.timer = 0;
            this.current = null;
            this._next();
            this.changed();
        });
    }

    _next() {
        while (this.queue.length) {
            const entry = this.queue.shift();
            if (entry.valid()) {
                this.current = entry;
                this._expire();
                break;
            }
        }
    }

    clearPeeks() {
        this.life.cancel(this.timer);
        this.timer = 0;
        this.current = null;
        this.queue = [];
        this.changed();
    }

    remove(notification) {
        // Entries without a notification (media) are never removed by notification events.
        if (!notification)
            return;
        this.queue = this.queue.filter(item => item.notification !== notification);
        if (this.current?.notification === notification) {
            this.life.cancel(this.timer);
            this.current = null;
            this._next();
        }
        this.changed();
    }

    setLive(activity) {
        // Called only by a future, verified activity-start/stop source.
        this.live = activity;
        this.changed();
    }
}
