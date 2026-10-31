import * as Main from 'resource:///org/gnome/shell/ui/main.js';

export class PanelManager {
    constructor(life, settings) {
        this.settings = settings;
        this.layout = Main.layoutManager;
        this.panel = this.layout.panelBox;
        this.saved = null;
        this.menu = null;
        this.priorVisible = null;
        this._changing = false;
        life.own(() => this.destroy(), 'native panel tracking and visibility');
        life.connect(settings, 'changed::replace-panel', () => this._syncFromSignal('a replace-panel preference change'));
        life.connect(this.panel, 'notify::visible', () => this._syncFromSignal('a native panel visibility change'));
    }

    _syncFromSignal(reason) {
        try {
            this.sync();
        } catch (error) {
            console.error(`[GNShell] Failed to synchronize the native panel after ${reason}: ${error.message}`, error);
        }
    }

    sync() {
        if (this._changing)
            return;
        this._changing = true;
        try {
            if (!this.settings.get_boolean('replace-panel')) {
                this.restore();
                return;
            }
            if (!this.saved) {
                if (!Array.isArray(this.layout._trackedActors))
                    throw new Error('GNOME Shell LayoutManager._trackedActors is unavailable; this integration requires the verified GNOME Shell 50.5 layout API.');
                const data = this.layout._trackedActors.find(a => a.actor === this.panel);
                if (!data || !data.affectsStruts || typeof data.trackFullscreen !== 'boolean')
                    throw new Error('The native panel is not tracked with the expected strut/fullscreen parameters; another panel extension or an incompatible Shell build may be active.');
                this.saved = {
                    affectsStruts: data.affectsStruts,
                    trackFullscreen: data.trackFullscreen,
                    // While a native menu forced the panel visible, the pre-menu value is what must come back.
                    visible: this.priorVisible ? this.priorVisible.visible : this.panel.visible,
                    fullscreen: Boolean(this.layout.primaryMonitor?.inFullscreen),
                };
                this.layout.untrackChrome(this.panel);
                this.layout.trackChrome(this.panel, {affectsStruts: false, trackFullscreen: false});
            }
            // The replaced panel is shown only while a native menu opened through openNative() is open.
            this.panel.visible = Boolean(this.menu?.isOpen);
        } catch (error) {
            try {
                this.restore();
            } catch (restoreError) {
                throw new Error(`[GNShell] Panel replacement failed: ${error.message} Restoring the native panel also failed: ${restoreError.message} Disable GNShell and log out and back in to recover the panel.`, {cause: error});
            }
            throw new Error(`[GNShell] Failed to apply the native panel policy: ${error.message} Native panel replacement was rolled back. Keep "replace-panel" disabled until compatibility is verified.`, {cause: error});
        } finally {
            this._changing = false;
        }
    }

    openNative(name) {
        const indicator = Main.panel.statusArea[name];
        if (!indicator?.menu)
            throw new Error(`[GNShell] Cannot open native menu "${name}": Main.panel.statusArea does not expose this menu in the current session.`);
        this.menu?.close();
        this.menu = indicator.menu;
        this._menuId = this.menu.connect('open-state-changed', (_menu, open) => {
            if (!open) {
                this.menu.disconnect(this._menuId);
                this.menu = null;
                this._menuId = 0;
                this._releaseShown();
                this._syncFromSignal(`native menu "${name}" closing`);
                this.onMenuChange?.();
            }
        });
        this._changing = true;
        try {
            this.priorVisible = {visible: this.panel.visible,
                fullscreen: Boolean(this.layout.primaryMonitor?.inFullscreen)};
            this.panel.show();
            this.menu.open();
        } finally {
            this._changing = false;
        }
        this.sync();
    }

    // Without replace-panel the native panel was only forced visible for the menu; hand it back to GNOME's state.
    _releaseShown() {
        const prior = this.priorVisible;
        this.priorVisible = null;
        if (prior && !this.saved && Boolean(this.layout.primaryMonitor?.inFullscreen) === prior.fullscreen)
            this.panel.visible = prior.visible;
    }

    restore() {
        if (!this.saved)
            return;
        const saved = this.saved;
        this.layout.untrackChrome(this.panel);
        this.layout.trackChrome(this.panel, {
            affectsStruts: saved.affectsStruts,
            trackFullscreen: saved.trackFullscreen,
        });
        if (Boolean(this.layout.primaryMonitor?.inFullscreen) === saved.fullscreen)
            this.panel.visible = saved.visible;
        this.saved = null;
    }

    destroy() {
        this._changing = true;
        try {
            if (this.menu) {
                this.menu.disconnect(this._menuId);
                this.menu.close();
            }
        } finally {
            this.menu = null;
            this._releaseShown();
            this.restore();
        }
    }
}
