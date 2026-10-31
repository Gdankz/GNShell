import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {InjectionManager} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Urgency} from 'resource:///org/gnome/shell/ui/messageTray.js';
import {Lifetime} from './lifetime.js';
import {button, label, column, row, icon, notificationIcon} from './island.js';

export class NotificationAdapter {
    constructor(life, settings, state, view) {
        this.settings = settings;
        this.state = state;
        this.view = view;
        this.sources = new Map();
        this.items = new Map();
        this.listeners = new Set();
        this.injections = new InjectionManager();
        this.routing = false;
        this.master = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        life.own(() => this.destroy());
        life.connect(this.master, 'changed::show-banners', () => {
            if (!this.master.get_boolean('show-banners'))
                state.clearPeeks();
        });
        life.connect(Main.messageTray, 'source-added', (_tray, source) => this.attach(source));
        life.connect(Main.messageTray, 'source-removed', (_tray, source) => this.detach(source));
        life.connect(settings, 'changed::redirect-notifications', () => this.configure());
        life.connect(settings, 'changed::privacy-mode', () => this.changed());
        for (const source of Main.messageTray.getSources())
            this.attach(source);
        this.configure();
    }

    attach(source) {
        if (this.sources.has(source))
            return;
        const scope = new Lifetime();
        this.sources.set(source, scope);
        scope.connect(source, 'notification-added', (_source, n) => this.track(n));
        scope.connect(source, 'notification-removed', (_source, n) => this.remove(n));
        scope.connect(source.policy, 'notify', () => {
            if (!source.policy.showBanners)
                this.state.clearPeeks();
            this.changed();
        });
        for (const notification of source.notifications)
            this.track(notification);
    }

    detach(source) {
        this.sources.get(source)?.destroy();
        this.sources.delete(source);
        for (const n of [...this.items.keys()]) {
            if (n.source === source)
                this.remove(n);
        }
    }

    track(n) {
        if (this.items.has(n))
            return;
        const scope = new Lifetime();
        this.items.set(n, scope);
        scope.connect(n, 'notify', () => {
            this.changed();
            if (this.state.current?.notification === n)
                this.state.changed();
        });
        scope.connect(n, 'action-added', () => this.changed());
        scope.connect(n, 'action-removed', () => this.changed());
        while (this.items.size > 50)
            this.remove(this.items.keys().next().value);
        this.changed();
    }

    remove(n) {
        this.items.get(n)?.destroy();
        this.items.delete(n);
        this.state.remove(n);
        this.changed();
    }

    valid(n) {
        return this.items.has(n) && n.source.notifications.includes(n) && n.source.policy.enable;
    }

    describe(n) {
        if (!this.valid(n))
            return {title: 'Notifikasi tidak tersedia', body: ''};
        const app = String(n.source.title ?? 'Aplikasi').slice(0, 80);
        if (this.settings.get_boolean('privacy-mode'))
            return {title: `${app}: notifikasi baru`, body: ''};
        return {title: `${app}: ${String(n.title ?? '').slice(0, 120)}`,
            body: String(n.body ?? '').replace(/<[^>]*>/g, '').slice(0, 180)};
    }

    changed() {
        for (const callback of this.listeners)
            callback();
    }

    configure() {
        this.injections.clear();
        this.state.clearPeeks();
        if (!this.settings.get_boolean('redirect-notifications'))
            return;
        const tray = Main.messageTray;
        if (!Array.isArray(tray._notificationQueue) || typeof tray._updateState !== 'function') {
            console.warn('[GNShell] Cannot enable notification redirection: the native MessageTray queue or _updateState API is unavailable. Keep redirect-notifications disabled and use native GNOME banners.');
            return;
        }
        const adapter = this;
        this.injections.overrideMethod(Object.getPrototypeOf(tray), '_updateState', original =>
            function (...args) {
                adapter.route(this);
                return original.apply(this, args);
            });
    }

    route(tray) {
        if (tray._busy && this.state.current)
            this.state.clearPeeks();
        if (this.routing || tray._busy || tray._bannerBlocked || !Main.sessionMode.hasNotifications ||
            !Main.layoutManager.primaryMonitor || Main.layoutManager.primaryMonitor.inFullscreen ||
            Main.overview.visible || this.state.suspended)
            return;
        this.routing = true;
        try {
            let changed = false;
            for (const n of [...tray._notificationQueue]) {
                if (!this.valid(n) || n.acknowledged || !n.source.policy.showBanners ||
                    n.urgency === Urgency.CRITICAL || n.urgency === Urgency.LOW)
                    continue;
                const entry = {
                    notification: n,
                    key: JSON.stringify([n.source.title, n.title, n.body]),
                    priority: n.actions.length ? 2 : 1,
                    time: GLib.get_monotonic_time(),
                    valid: () => this.valid(n),
                };
                // Admission happens before removing the native queue entry.
                if (!this.state.offer(entry))
                    continue;
                const index = tray._notificationQueue.indexOf(n);
                if (index >= 0)
                    tray._notificationQueue.splice(index, 1);
                changed = true;
                n.playSound();
            }
            if (changed)
                tray.emit('queue-changed');
        } catch (error) {
            // Stop custom routing immediately; remaining native entries are untouched.
            this.injections.clear();
            this.state.clearPeeks();
            console.error(`[GNShell] Notification routing failed: ${error.message}. Custom routing was stopped; remaining native queue entries are unchanged.`, error);
        } finally {
            this.routing = false;
        }
    }

    build(box) {
        const rows = new Map();
        const empty = column('ns-empty');
        empty.x_align = Clutter.ActorAlign.CENTER;
        empty.add_child(icon('preferences-system-notifications-symbolic', 32, 'ns-empty-icon'));
        const emptyText = label('Belum ada notifikasi.', 'ns-empty-text');
        emptyText.x_align = Clutter.ActorAlign.CENTER;
        empty.add_child(emptyText);
        box.add_child(empty);
        const refresh = () => {
            const items = [...this.items.keys()].filter(n => this.valid(n));
            for (const [n, entry] of rows) {
                if (!items.includes(n)) {
                    entry.actor.destroy();
                    rows.delete(n);
                }
            }
            for (const n of items) {
                let entry = rows.get(n);
                if (!entry) {
                    const actor = row('ns-notification');
                    const text = column('ns-notification-text');
                    text.x_expand = true;
                    const title = new St.Button({style_class: 'ns-notification-title', can_focus: true,
                        reactive: true, x_expand: true, x_align: Clutter.ActorAlign.FILL});
                    const titleLabel = label('', 'ns-notification-title-text');
                    title.set_child(titleLabel);
                    title.connect('clicked', () => {
                        if (this.valid(n)) {
                            this.state.close();
                            n.activate();
                        }
                    });
                    const body = label('', 'ns-notification-body');
                    const buttons = row('ns-notification-actions');
                    text.add_child(title);
                    text.add_child(body);
                    text.add_child(buttons);
                    actor.add_child(notificationIcon(n, 22, this.settings.get_boolean('privacy-mode')));
                    actor.add_child(text);
                    box.insert_child_at_index(actor, 0);
                    entry = {actor, title, titleLabel, body, buttons, actions: new Map()};
                    rows.set(n, entry);
                }
                const description = this.describe(n);
                entry.titleLabel.text = description.title;
                entry.title.accessible_name = description.title;
                entry.body.text = description.body;
                entry.body.visible = Boolean(description.body);
                const actions = this.settings.get_boolean('privacy-mode') ? [] : n.actions;
                for (const [action, actor] of entry.actions) {
                    if (!actions.includes(action)) {
                        actor.destroy();
                        entry.actions.delete(action);
                    }
                }
                for (const action of actions) {
                    if (entry.actions.has(action))
                        continue;
                    const actor = button(action.label, () => {
                        if (this.valid(n) && n.actions.includes(action)) {
                            this.state.close();
                            action.activate();
                        }
                    }, 'ns-button ns-small');
                    entry.buttons.add_child(actor);
                    entry.actions.set(action, actor);
                }
                entry.buttons.visible = entry.actions.size > 0;
            }
            empty.visible = items.length === 0;
        };
        this.listeners.add(refresh);
        refresh();
        return () => this.listeners.delete(refresh);
    }

    destroy() {
        this.injections.clear();
        this.listeners.clear();
        for (const scope of this.sources.values())
            scope.destroy();
        for (const scope of this.items.values())
            scope.destroy();
        this.sources.clear();
        this.items.clear();
        this.state.clearPeeks();
    }
}
