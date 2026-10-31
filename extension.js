import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Lifetime} from './lib/lifetime.js';
import {PanelManager} from './lib/panel.js';

export default class GNShell extends Extension {
    enable() {
        this.life = new Lifetime();
        try {
            const life = this.life;
            let settings;
            try {
                settings = this.getSettings();
            } catch (error) {
                throw new Error(`[GNShell] Cannot load GSettings schema "org.gnome.shell.extensions.gnshell": ${error.message} Run "glib-compile-schemas schemas" in the extension directory and reinstall the extension.`, {cause: error});
            }
            const panel = new PanelManager(life, settings);
            const pill = new St.Button({style_class: 'gnshell', label: 'GNShell',
                reactive: true, can_focus: true, accessible_name: 'GNShell Phase 0 overlay'});
            life.own(() => {
                try {
                    if (pill.get_parent())
                        Main.layoutManager.removeChrome(pill);
                } finally {
                    pill.destroy();
                }
            }, 'Phase 0 overlay actor');
            Main.layoutManager.addTopChrome(pill, {affectsStruts: false, trackFullscreen: false});
            let revealed = false;
            let timer = 0;
            const theme = St.ThemeContext.get_for_stage(global.stage);
            const sync = () => {
                const monitor = Main.layoutManager.primaryMonitor;
                pill.visible = Boolean(monitor) && !Main.overview.visible &&
                    !Main.sessionMode.isLocked && !Main.sessionMode.isGreeter &&
                    (!monitor.inFullscreen || revealed);
                if (monitor) {
                    pill.width = Math.min(monitor.width, 124 * theme.scale_factor);
                    pill.set_position(Math.round(monitor.x + (monitor.width - pill.width) / 2), monitor.y);
                }
                panel.sync();
            };
            const update = () => {
                try {
                    sync();
                } catch (error) {
                    console.error(`[GNShell] Failed to update the Phase 0 overlay: ${error.message}`, error);
                }
            };
            const hideReveal = () => {
                revealed = false;
                life.cancel(timer);
                timer = 0;
                update();
            };
            life.connect(global.display, 'in-fullscreen-changed', hideReveal);
            life.connect(Main.layoutManager, 'monitors-changed', hideReveal);
            life.connect(Main.overview, 'showing', hideReveal);
            life.connect(Main.overview, 'hidden', update);
            life.connect(Main.sessionMode, 'updated', hideReveal);
            life.connect(theme, 'notify::scale-factor', update);
            life.connect(global.stage, 'captured-event', (_actor, event) => {
                if (revealed && event.type() === Clutter.EventType.KEY_PRESS &&
                    event.get_key_symbol() === Clutter.KEY_Escape) {
                    hideReveal();
                    return Clutter.EVENT_STOP;
                }
                return Clutter.EVENT_PROPAGATE;
            });
            const accelerators = settings.get_strv('toggle-island');
            if (accelerators.length === 0)
                throw new Error('[GNShell] No keyboard shortcut is configured for "toggle-island". Configure a shortcut such as <Super><Shift>n before enabling GNShell.');
            const action = Main.wm.addKeybinding('toggle-island', settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => {
                    if (!Main.layoutManager.primaryMonitor?.inFullscreen)
                        return;
                    revealed = !revealed;
                    life.cancel(timer);
                    timer = 0;
                    if (revealed) {
                        timer = life.after(settings.get_uint('reveal-seconds') * 1000, () => {
                            timer = 0;
                            revealed = false;
                            update();
                        });
                    }
                    update();
                });
            if (action === Meta.KeyBindingAction.NONE)
                throw new Error(`[GNShell] Failed to register keyboard shortcut "toggle-island" (${accelerators.join(', ')}): GNOME Shell returned Meta.KeyBindingAction.NONE. The binding may be unavailable or already registered. Choose another shortcut and enable GNShell again.`);
            life.own(() => Main.wm.removeKeybinding('toggle-island'), 'keyboard shortcut "toggle-island"');
            sync();
        } catch (error) {
            this.disable();
            throw new Error(`[GNShell] Failed to enable the Phase 0 extension: ${error.message}`, {cause: error});
        }
    }

    disable() {
        this.life?.destroy();
        this.life = null;
    }
}
