import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const HOVER_OPEN_MS = 150;
const HOVER_CLOSE_MS = 350;

export class DesktopController {
    constructor(life, settings, state, view, panel) {
        this.life = life;
        this.settings = settings;
        this.state = state;
        this.view = view;
        this.panel = panel;
        this.revealTimer = 0;
        this.openTimer = 0;
        this.closeTimer = 0;
        this.armed = true;
        this.wasExpanded = false;
        this.grab = null;
        life.own(() => {
            this.cancelHover();
            this.release();
        });
        life.connect(view.actor, 'notify::hover', () => this.hover());
        life.connect(global.display, 'in-fullscreen-changed', () => this.sync());
        life.connect(Main.layoutManager, 'monitors-changed', () => {
            state.close();
            this.sync();
        });
        life.connect(Main.overview, 'showing', () => this.sync());
        life.connect(Main.overview, 'hidden', () => this.sync());
        life.connect(Main.sessionMode, 'updated', () => this.sync());
        life.connect(global.stage, 'captured-event', (_actor, event) => this.event(event));
        // A modal grab routes every event through the notch and bypasses the stage handler.
        life.connect(view.actor, 'captured-event', (_actor, event) =>
            this.grab ? this.event(event) : Clutter.EVENT_PROPAGATE);
        // Tab/arrows move focus inside the modal notch (like ModalDialog). Bubble phase,
        // so the focused widget (e.g. the volume slider) handles its own keys first.
        life.connect(view.actor, 'key-press-event', (_actor, event) =>
            this.grab && global.focus_manager.navigate_from_event(event) ?
                Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);
        const accelerators = settings.get_strv('toggle-island');
        if (accelerators.length === 0)
            throw new Error('[Islet] No keyboard shortcut is configured for "toggle-island". Configure a shortcut before enabling Islet.');
        const action = Main.wm.addKeybinding('toggle-island', settings, Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.POPUP, () => {
                if (Main.modalCount > 0 && !this.grab)
                    return;
                state.shortcut();
                this.touch();
            });
        if (action === Meta.KeyBindingAction.NONE)
            throw new Error(`[Islet] Failed to register keyboard shortcut "toggle-island" (${accelerators.join(', ')}): GNOME Shell returned Meta.KeyBindingAction.NONE. Choose another shortcut and enable Islet again.`);
        life.own(() => Main.wm.removeKeybinding('toggle-island'), 'keyboard shortcut "toggle-island"');
    }

    sync() {
        const monitor = Main.layoutManager.primaryMonitor;
        this.state.policy(Boolean(monitor?.inFullscreen),
            !monitor || Main.overview.visible ||
            Main.sessionMode.isGreeter || Boolean(this.panel.menu?.isOpen),
            Boolean(Main.sessionMode.isLocked));
        this.view.position();
        this.panel.sync();
    }

    render() {
        const mode = this.state.state;
        if (mode === 'hidden')
            this.cancelHover();
        else if (mode === 'expanded')
            this.cancel('openTimer');
        else
            this.cancel('closeTimer');
        if (mode !== 'expanded' && this.wasExpanded && this.view.actor.hover)
            this.armed = false; // closed under the pointer: re-enter before opening again
        this.wasExpanded = mode === 'expanded';
        // Only a keyboard-opened Expanded needs focus, so only it takes a modal grab.
        if (mode === 'expanded' && this.state.keyboard) {
            if (!this.grab) {
                this.grab = Main.pushModal(this.view.actor, {actionMode: Shell.ActionMode.POPUP});
                this.view.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
            }
        } else {
            this.release();
        }
        if (!this.state.fullscreen || !this.state.revealed) {
            this.life.cancel(this.revealTimer);
            this.revealTimer = 0;
        }
    }

    cancel(name) {
        this.life.cancel(this[name]);
        this[name] = 0;
    }

    cancelHover() {
        this.cancel('openTimer');
        this.cancel('closeTimer');
    }

    hover() {
        const hovered = this.view.actor.hover;
        this.cancelHover();
        if (hovered) {
            if (!this.armed || this.state.state === 'expanded' || this.state.state === 'hidden')
                return;
            this.openTimer = this.life.after(HOVER_OPEN_MS, () => {
                this.openTimer = 0;
                if (this.view.actor.hover && this.state.state !== 'expanded' &&
                    this.state.state !== 'hidden' && (Main.modalCount === 0 || this.grab))
                    this.state.open();
            });
            return;
        }
        this.armed = true;
        if (this.state.state === 'expanded' && !this.state.keyboard)
            this.scheduleClose();
    }

    contains(x, y) {
        const [ax, ay] = this.view.actor.get_transformed_position();
        const [aw, ah] = this.view.actor.get_transformed_size();
        return x >= ax && x < ax + aw && y >= ay && y < ay + ah;
    }

    scheduleClose() {
        this.cancel('closeTimer');
        this.closeTimer = this.life.after(HOVER_CLOSE_MS, () => {
            this.closeTimer = 0;
            if (this.view.actor.hover || this.state.state !== 'expanded' || this.state.keyboard)
                return;
            // A slider drag may leave the notch while the button is still down. A leave
            // crossing is also not proof that the pointer left (a window below can take
            // pointer focus without a following enter), so trust the geometry and keep polling.
            const [x, y, mods] = global.get_pointer();
            if ((mods & Clutter.ModifierType.BUTTON1_MASK) || this.contains(x, y))
                this.scheduleClose();
            else
                this.state.close();
        });
    }

    release() {
        if (this.grab) {
            Main.popModal(this.grab);
            this.grab = null;
        }
    }

    touch() {
        this.life.cancel(this.revealTimer);
        this.revealTimer = 0;
        if (this.state.fullscreen && this.state.revealed)
            this.revealTimer = this.life.after(this.settings.get_uint('reveal-seconds') * 1000,
                () => this.state.close());
    }

    event(event) {
        if (this.state.state === 'hidden')
            return Clutter.EVENT_PROPAGATE;
        const type = event.type();
        if ((this.grab || this.state.revealed) && type === Clutter.EventType.KEY_PRESS &&
            event.get_key_symbol() === Clutter.KEY_Escape) {
            this.state.close();
            return Clutter.EVENT_STOP;
        }
        const [x, y] = event.get_coords();
        const inside = this.contains(x, y);
        if (inside || (this.grab && type === Clutter.EventType.KEY_PRESS))
            this.touch();
        if (this.grab && type === Clutter.EventType.BUTTON_PRESS && !inside)
            this.state.close();
        return Clutter.EVENT_PROPAGATE;
    }
}
