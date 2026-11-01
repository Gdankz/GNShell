import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Lifetime} from './lib/lifetime.js';
import {PanelManager} from './lib/panel.js';
import {StateController} from './lib/state.js';
import {IslandView} from './lib/island.js';
import {DesktopController} from './lib/desktop.js';
import {SystemAdapter} from './lib/system.js';
import {NotificationAdapter} from './lib/notifications.js';
import {MediaWatcher} from './lib/media.js';

export default class Islet extends Extension {
    enable() {
        this.life = new Lifetime();
        try {
            const settings = this.getSettings();
            const panel = new PanelManager(this.life, settings);
            const state = new StateController(settings, this.life, () => {
                try {
                    this.view?.render();
                } finally {
                    this.desktop?.render();
                }
            });
            this.state = state;
            this.view = new IslandView(this.life, settings, state);
            this.desktop = new DesktopController(this.life, settings, state, this.view, panel);
            panel.onMenuChange = () => this.desktop.sync();
            const openNative = name => {
                state.close();
                panel.openNative(name);
                this.desktop.sync();
            };
            const system = new SystemAdapter(this.life, () => state.close(), openNative);
            this.view.buildControls = box => system.build(box);
            const notifications = new NotificationAdapter(this.life, settings, state, this.view);
            this.view.describe = notification => notifications.describe(notification);
            this.view.buildActivity = box => notifications.build(box);
            new MediaWatcher(this.life, settings, state);
            this.desktop.sync();
        } catch (error) {
            this.disable();
            throw new Error(`[Islet] Failed to enable the extension: ${error.message} Check schema compilation and the GNOME Shell log before enabling Islet again.`, {cause: error});
        }
    }

    disable() {
        this.life?.destroy();
        this.life = null;
        this.view = null;
        this.desktop = null;
        this.state = null;
    }
}
