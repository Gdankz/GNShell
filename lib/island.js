import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

const WIDTH = {compact: 150, peek: 320, expanded: 320};
const KIND = {idle: 'compact', live: 'compact', peek: 'peek', expanded: 'expanded'};
const FALLBACK_ICON = 'preferences-system-notifications-symbolic';
const MEDIA_ICON = 'audio-x-generic-symbolic';

// SystemAdapter registers itself here so the notch can show network/battery
// icons without the view depending on system.js (which imports this file).
const hub = {provider: null, subscribers: new Set()};

export function provideStatus(provider) {
    hub.provider = provider;
    notifyStatus();
    return () => {
        if (hub.provider === provider) {
            hub.provider = null;
            notifyStatus();
        }
    };
}

export function notifyStatus() {
    for (const callback of [...hub.subscribers])
        callback();
}

function readStatus() {
    try {
        return hub.provider?.status() ?? null;
    } catch (error) {
        console.error(`[Islet] Failed to read system status for the notch: ${error.message}`, error);
        return null;
    }
}

function classes(...names) {
    return names.filter(Boolean).join(' ');
}

export function button(text, clicked, styleClass = 'ns-button') {
    const actor = new St.Button({label: text, style_class: styleClass, can_focus: true,
        reactive: true});
    actor.connect('clicked', clicked);
    return actor;
}

export function label(text, styleClass = '') {
    const actor = new St.Label({text: String(text), x_expand: true, style_class: styleClass});
    actor.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return actor;
}

export function column(styleClass = 'ns-list') {
    return new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: styleClass});
}

export function row(styleClass = 'ns-row') {
    return new St.BoxLayout({style_class: styleClass});
}

export function icon(name, size = 16, styleClass = '') {
    return new St.Icon({icon_name: name, icon_size: size,
        style_class: classes('ns-icon', styleClass), y_align: Clutter.ActorAlign.CENTER});
}

export function enable(actor, on) {
    actor.reactive = actor.can_focus = Boolean(on);
    if (on)
        actor.remove_style_class_name('ns-disabled');
    else
        actor.add_style_class_name('ns-disabled');
}

export function iconButton(name, accessibleName, clicked, styleClass = '', size = 16) {
    const actor = new St.Button({child: icon(name, size), accessible_name: accessibleName,
        style_class: classes('ns-icon-button', styleClass), can_focus: true, reactive: true,
        x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
    actor.connect('clicked', clicked);
    return actor;
}

export function pill(name, text, clicked) {
    const content = row('ns-pill-row');
    content.add_child(icon(name, 16));
    content.add_child(new St.Label({text, y_align: Clutter.ActorAlign.CENTER}));
    const actor = new St.Button({child: content, accessible_name: text, style_class: 'ns-pill',
        can_focus: true, reactive: true, x_expand: true});
    content.x_align = Clutter.ActorAlign.CENTER;
    actor.connect('clicked', clicked);
    return actor;
}

// Control tile: round icon button with a small caption. Colored when active; the
// status text is exposed through accessible_name.
export function tile(clicked) {
    const symbol = icon('image-missing', 18);
    const circle = new St.Bin({child: symbol, style_class: 'ns-tile-icon',
        x_align: Clutter.ActorAlign.CENTER});
    const title = label('', 'ns-tile-title');
    title.x_align = Clutter.ActorAlign.CENTER;
    title.clutter_text.set_line_alignment(Pango.Alignment.CENTER);
    const content = column('ns-tile-column');
    content.x_expand = true;
    content.add_child(circle);
    content.add_child(title);
    const actor = new St.Button({child: content, style_class: 'ns-tile', can_focus: true,
        reactive: true, x_expand: true});
    actor.connect('clicked', clicked);
    return {
        actor,
        set({iconName, name, state, active, enabled = true}) {
            symbol.icon_name = iconName;
            title.text = name;
            actor.accessible_name = `${name}: ${state}`;
            if (active)
                actor.add_style_class_name('ns-active');
            else
                actor.remove_style_class_name('ns-active');
            enable(actor, enabled);
        },
    };
}

// Media metadata icons (app icon, album art) arrive as Gio.Icon, icon name, path or file URI.
// Remote URLs are not fetched; callers fall back to the app icon.
function mediaGicon(value) {
    if (value instanceof Gio.Icon)
        return value;
    if (typeof value !== 'string' || !value)
        return null;
    if (value.startsWith('file://'))
        return new Gio.FileIcon({file: Gio.File.new_for_uri(value)});
    if (value.startsWith('/'))
        return new Gio.FileIcon({file: Gio.File.new_for_path(value)});
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(value))
        return null;
    return new Gio.ThemedIcon({names: [value]});
}

// With privacy on, notification.gicon / iconName may carry content (avatar, photo), and
// source.icon may be a per-message file from the D-Bus app_icon: only themed icons pass.
export function notificationIcon(notification, size, privacy = true) {
    const candidates = privacy ? [notification?.source?.icon] : [notification?.gicon, notification?.source?.icon];
    const gicon = candidates.find(candidate =>
        candidate instanceof (privacy ? Gio.ThemedIcon : Gio.Icon));
    const names = [privacy ? null : notification?.iconName, FALLBACK_ICON].filter(Boolean);
    return new St.Icon({gicon: gicon ?? new Gio.ThemedIcon({names}), icon_size: size,
        style_class: 'ns-app-icon', y_align: Clutter.ActorAlign.START});
}

export class IslandView {
    constructor(life, settings, state) {
        this.life = life;
        this.settings = settings;
        this.state = state;
        this.mode = null;
        this.page = 'controls';
        this.width = 0;
        this.shown = false;
        this.morphing = false;
        this.morphToken = 0;
        this.body = null;
        this.bindings = [];
        this.actor = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: 'islet', reactive: true, track_hover: true,
            accessible_name: 'Islet'});
        this.actor.hide();
        Main.layoutManager.addTopChrome(this.actor, {affectsStruts: false, trackFullscreen: false});
        life.own(() => this.destroy());
        global.focus_manager.add_group(this.actor);
        life.connect(this.actor, 'notify::allocation', () => this.position());
        life.connect(St.ThemeContext.get_for_stage(global.stage), 'notify::scale-factor', () => {
            this.render();
            this.position();
        });
        life.connect(settings, 'changed::privacy-mode', () => {
            if (this.mode === 'expanded' && this.page === 'activity')
                this.showPage('activity');
            else
                this.render();
        });
        const bind = () => {
            const status = readStatus();
            for (const apply of this.bindings)
                apply(status);
        };
        hub.subscribers.add(bind);
        life.own(() => hub.subscribers.delete(bind));
        const tick = () => {
            try {
                this.render();
                this.refreshHeader?.();
            } finally {
                const now = GLib.DateTime.new_now_local();
                life.after((60 - now.get_second()) * 1000, tick);
            }
        };
        tick();
    }

    duration() {
        return this.settings.get_boolean('animations') && St.Settings.get().enable_animations ? 240 : 0;
    }

    centerX(width) {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return this.actor.x;
        return Math.round(monitor.x + (monitor.width - width) / 2);
    }

    position() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor || this.morphing)
            return;
        const x = this.centerX(this.width || this.actor.width);
        if (this.actor.x !== x || this.actor.y !== monitor.y)
            this.actor.set_position(x, monitor.y);
    }

    stopMorph() {
        this.morphToken++;
        this.morphing = false;
        this.actor.remove_all_transitions();
    }

    // Resize the notch to `width` and the natural height of its content. When
    // animating, width, height and x ease together so the notch stays centered.
    // `from` must be captured before the content changes: afterwards the actor
    // reports the new natural height instead of its current allocation.
    snapshot() {
        return [this.actor.x, this.actor.width, this.actor.height];
    }

    fit(width, animate, from = this.snapshot()) {
        const actor = this.actor;
        const [fromX, fromW, fromH] = from;
        this.stopMorph();
        actor.set_width(width);
        actor.set_height(-1);
        const [, toH] = actor.get_preferred_height(width);
        this.width = width;
        const duration = animate && this.shown && Main.layoutManager.primaryMonitor ? this.duration() : 0;
        if (!duration || (Math.round(fromW) === Math.round(width) && Math.round(fromH) === Math.round(toH))) {
            this.position();
            return;
        }
        const token = this.morphToken;
        this.morphing = true;
        actor.set_size(fromW, fromH);
        actor.set_x(fromX);
        actor.ease({width, height: toH, x: this.centerX(width), duration,
            mode: Clutter.AnimationMode.EASE_OUT_QUINT, onComplete: () => {
                if (token !== this.morphToken)
                    return;
                this.morphing = false;
                actor.set_height(-1);
                this.position();
            }});
    }

    fadeIn(actor) {
        if (!this.duration())
            return;
        actor.opacity = 0;
        actor.ease({opacity: 255, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    bindStatus(apply) {
        this.bindings.push(apply);
        apply(readStatus());
    }

    render() {
        if (this.life.destroyed)
            return; // teardown: measuring a notch that is about to be destroyed logs St warnings
        const mode = this.state.state;
        const old = this.mode;
        this.mode = mode;
        if (mode === 'hidden') {
            this.stopMorph();
            this.actor.hide();
            this.shown = false;
            return;
        }
        const kind = KIND[mode];
        const oldKind = old && old !== 'hidden' && this.shown ? KIND[old] : null;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const monitorWidth = Main.layoutManager.primaryMonitor?.width ?? 340 * scale;
        const width = Math.min(WIDTH[kind] * scale, monitorWidth);
        if (kind === 'expanded' && oldKind === 'expanded') {
            if (Math.round(width) !== Math.round(this.width))
                this.fit(width, false);
            else
                this.position();
            return;
        }
        for (const name of Object.values(KIND)) {
            if (name === kind)
                this.actor.add_style_class_name(`ns-${name}`);
            else
                this.actor.remove_style_class_name(`ns-${name}`);
        }
        const before = this.shown ? this.snapshot() : null;
        this.rebuild(kind);
        this.actor.show();
        this.fit(width, true, before ?? undefined);
        if (kind !== oldKind)
            this.fadeIn(this.body);
        this.shown = true;
    }

    rebuild(kind) {
        this.clearPage?.();
        this.clearPage = null;
        this.refreshHeader = null;
        this.bindings = [];
        this.content = null;
        this.body?.destroy();
        this.body = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL,
            style_class: `ns-body ns-body-${kind}`, x_expand: true, y_expand: true,
            clip_to_allocation: true});
        this.actor.add_child(this.body);
        if (kind === 'expanded')
            this._expanded();
        else if (kind === 'peek' && this.state.current)
            this._peek(this.state.current);
        else
            this._compact();
    }

    _compact() {
        const content = row('ns-compact-row');
        const text = this.state.state === 'live' ? this.state.live.label :
            GLib.DateTime.new_now_local().format('%H:%M');
        content.add_child(label(text, 'ns-compact-text'));
        const network = icon('network-wireless-offline-symbolic', 14);
        const battery = icon('battery-missing-symbolic', 14);
        content.add_child(network);
        content.add_child(battery);
        this.bindStatus(status => {
            network.visible = Boolean(status);
            battery.visible = Boolean(status?.battery.present);
            if (status) {
                network.icon_name = status.network;
                battery.icon_name = status.battery.icon;
            }
        });
        const compact = new St.Button({child: content, can_focus: true, reactive: true,
            x_expand: true, y_expand: true, style_class: 'ns-compact-button',
            accessible_name: _('Open Islet')});
        compact.connect('clicked', () => this.state.open());
        this.body.add_child(compact);
    }

    _peek(entry) {
        const privacy = this.settings.get_boolean('privacy-mode');
        const lines = column('ns-peek-text');
        lines.x_expand = true;
        lines.y_align = Clutter.ActorAlign.CENTER;
        const content = row('ns-peek-row');
        content.x_expand = true;
        if (entry.media) {
            const media = entry.media;
            const app = media.app || _('Music');
            const art = privacy ? null : mediaGicon(media.art);
            const gicon = art ?? mediaGicon(media.appIcon) ?? new Gio.ThemedIcon({names: [MEDIA_ICON]});
            content.add_child(new St.Icon({gicon, icon_size: 28, style_class: 'ns-app-icon',
                y_align: Clutter.ActorAlign.CENTER}));
            if (privacy) {
                lines.add_child(label(_('%s: now playing').format(app), 'ns-peek-title'));
            } else {
                lines.add_child(label(media.title || app, 'ns-peek-title'));
                lines.add_child(label([media.artist, app].filter(Boolean).join(' • '), 'ns-peek-body'));
            }
            content.add_child(lines);
            content.add_child(icon('media-playback-start-symbolic', 14, 'ns-peek-mark'));
        } else {
            const text = this.describe?.(entry.notification) ?? {title: _('Notification'), body: ''};
            lines.add_child(label(`${text.title}${entry.count > 1 ? ` (${entry.count})` : ''}`,
                'ns-peek-title'));
            if (text.body)
                lines.add_child(label(text.body, 'ns-peek-body'));
            content.add_child(notificationIcon(entry.notification, 28, privacy));
            content.add_child(lines);
        }
        const peek = new St.Button({child: content, can_focus: true, reactive: true,
            x_expand: true, y_expand: true, style_class: 'ns-peek-button',
            accessible_name: _('Open Islet')});
        peek.connect('clicked', () => this.state.open());
        this.body.add_child(peek);
    }

    _expanded() {
        const clock = new St.Label({style_class: 'ns-clock', y_align: Clutter.ActorAlign.CENTER});
        const date = label('', 'ns-date');
        date.y_align = Clutter.ActorAlign.CENTER;
        const battery = row('ns-battery');
        battery.y_align = Clutter.ActorAlign.CENTER;
        const batteryIcon = icon('battery-missing-symbolic', 14);
        const percent = new St.Label({style_class: 'ns-percent', y_align: Clutter.ActorAlign.CENTER});
        battery.add_child(batteryIcon);
        battery.add_child(percent);
        this.bindStatus(status => {
            battery.visible = Boolean(status?.battery.present);
            if (status?.battery.present) {
                batteryIcon.icon_name = status.battery.icon;
                percent.text = `${status.battery.percent}%`;
            }
        });
        this.refreshHeader = () => {
            const now = GLib.DateTime.new_now_local();
            clock.text = now.format('%H:%M');
            date.text = now.format('%a, %-d %b');
        };
        this.refreshHeader();
        const header = row('ns-header');
        header.add_child(clock);
        header.add_child(date);
        header.add_child(battery);
        header.add_child(iconButton('window-close-symbolic', _('Close'), () => this.state.close(),
            'ns-close ns-small', 12));
        this.body.add_child(header);

        const tabs = row('ns-tabs');
        this.tabs = {};
        for (const [page, name, symbol] of [
            ['controls', _('Controls'), 'view-grid-symbolic'],
            ['activity', _('Activity'), 'preferences-system-notifications-symbolic'],
        ]) {
            const content = row('ns-tab-row');
            content.add_child(icon(symbol, 14));
            content.add_child(new St.Label({text: name, y_align: Clutter.ActorAlign.CENTER}));
            content.x_align = Clutter.ActorAlign.CENTER;
            const tab = new St.Button({child: content, accessible_name: name, style_class: 'ns-tab',
                can_focus: true, reactive: true, x_expand: true});
            tab.connect('clicked', () => this.selectPage(page));
            tabs.add_child(tab);
            this.tabs[page] = tab;
        }
        this.body.add_child(tabs);

        this.scroll = new St.ScrollView({overlay_scrollbars: true, x_expand: true});
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const height = Math.min(300, (Main.layoutManager.primaryMonitor?.height ?? 600) / scale - 140);
        this.scroll.set_style(`max-height: ${Math.max(80, height)}px;`);
        this.content = column('ns-page');
        this.scroll.set_child(this.content);
        this.body.add_child(this.scroll);
        this.showPage(this.page);
    }

    selectPage(page) {
        const before = this.snapshot();
        this.showPage(page);
        this.fadeIn(this.content);
        this.fit(this.width, true, before);
    }

    showPage(page) {
        this.page = page;
        this.clearPage?.();
        this.clearPage = null;
        this.content.destroy_all_children();
        for (const [name, tab] of Object.entries(this.tabs ?? {})) {
            if (name === page)
                tab.add_style_class_name('ns-active');
            else
                tab.remove_style_class_name('ns-active');
            tab.checked = name === page;
        }
        if (page === 'controls') {
            this.clearPage = this.buildControls?.(this.content);
            if (!this.buildControls)
                this.content.add_child(label(_('System controls are not available yet.')));
        } else {
            this.clearPage = this.buildActivity?.(this.content);
            if (!this.buildActivity)
                this.content.add_child(label(_('No activity yet.')));
        }
    }

    destroy() {
        global.focus_manager.remove_group(this.actor);
        this.clearPage?.();
        this.clearPage = null;
        this.stopMorph();
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}
