import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GnomeBluetooth from 'gi://GnomeBluetooth?version=3.0';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as SystemActions from 'resource:///org/gnome/shell/misc/systemActions.js';
import * as Screenshot from 'resource:///org/gnome/shell/ui/screenshot.js';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';
import {Lifetime} from './lifetime.js';
import {row, iconButton, tile, enable, provideStatus, notifyStatus} from './island.js';

export class SystemAdapter {
    constructor(life, close, openNative) {
        this.life = life;
        this.close = close;
        this.openNative = openNative;
        this.dead = false;
        this.cookie = 0;
        this.pending = false;
        this.listeners = new Set();
        this.cancel = new Gio.Cancellable();
        this.mixer = Volume.getMixerControl();
        this.bluetooth = GnomeBluetooth.Client.new();
        this.actions = SystemActions.getDefault();
        life.own(() => this.destroy());
        life.own(provideStatus(this), 'notch status provider');
        life.connect(this.bluetooth, 'notify::default-adapter-powered', () => this.changed());
        life.connect(this.bluetooth, 'notify::default-adapter', () => this.changed());
        life.connect(this.actions, 'notify', () => this.changed());
        this.proxy('network', 'org.freedesktop.NetworkManager', '/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager');
        this.proxy('battery', 'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            'org.freedesktop.UPower.Device');
    }

    proxy(key, service, path, iface) {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SYSTEM, Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null, service, path, iface, this.cancel, (_object, result) => {
                try {
                    const proxy = Gio.DBusProxy.new_for_bus_finish(result);
                    if (this.dead)
                        return;
                    this[key] = proxy;
                    this.life.connect(proxy, 'g-properties-changed', () => this.changed());
                    this.life.connect(proxy, 'notify::g-name-owner', () => this.changed());
                    this.changed();
                } catch (error) {
                    if (!this.dead)
                        console.warn(`[Islet] Failed to read ${key} status from the system D-Bus service: ${error.message}. The corresponding status will remain unavailable.`, error);
                }
            });
    }

    changed() {
        for (const callback of this.listeners)
            callback();
        notifyStatus();
    }

    // Icons for the notch; only icon names present in the Adwaita symbolic set.
    status() {
        const wireless = this.property(this.network, 'WirelessEnabled');
        const state = this.property(this.network, 'State');
        const connected = state !== null && state >= 50;
        const wired = connected && this.property(this.network, 'PrimaryConnectionType') === '802-3-ethernet';
        let wifiIcon = 'network-wireless-offline-symbolic';
        if (wireless === false)
            wifiIcon = 'network-wireless-disabled-symbolic';
        else if (wireless && connected)
            wifiIcon = 'network-wireless-signal-excellent-symbolic';
        const present = Boolean(this.property(this.battery, 'IsPresent'));
        const value = this.property(this.battery, 'Percentage');
        const charge = this.property(this.battery, 'State');
        const percent = value === null ? 0 : Math.round(value);
        const level = Math.max(0, Math.min(100, Math.round(percent / 10) * 10));
        let batteryIcon = `battery-level-${level}-symbolic`;
        if (level === 100 && (charge === 1 || charge === 4))
            batteryIcon = 'battery-level-100-charged-symbolic';
        else if (charge === 1)
            batteryIcon = `battery-level-${level}-charging-symbolic`;
        return {
            wifi: wireless,
            wifiIcon,
            network: wired ? 'network-wired-symbolic' : wifiIcon,
            battery: {present: present && value !== null, percent, icon: batteryIcon},
        };
    }

    property(proxy, key) {
        if (!proxy?.g_name_owner)
            return null;
        return proxy.get_cached_property(key)?.deep_unpack() ?? null;
    }

    // Opens GNOME Settings (optionally at a panel). Never shows the native top bar.
    settings(panel) {
        this.close();
        if (!panel) {
            const app = Gio.DesktopAppInfo.new('org.gnome.Settings.desktop');
            try {
                if (app?.launch([], global.create_app_launch_context(0, -1)))
                    return;
            } catch (error) {
                console.warn(`[Islet] Failed to launch org.gnome.Settings.desktop: ${error.message}. Falling back to gnome-control-center.`);
            }
        }
        Gio.Subprocess.new(panel ? ['gnome-control-center', panel] : ['gnome-control-center'],
            Gio.SubprocessFlags.NONE);
    }

    caffeine() {
        if (this.pending)
            return;
        if (this.cookie) {
            const cookie = this.cookie;
            this.pending = true;
            this.call('Uninhibit', new GLib.Variant('(u)', [cookie]), null, () => {
                this.cookie = 0;
                this.pending = false;
                this.changed();
            }, () => { this.pending = false; this.changed(); });
        } else {
            this.pending = true;
            this.call('Inhibit', new GLib.Variant('(susu)',
                ['islet@local', 0, 'Islet Caffeine', 12]), '(u)', reply => {
                const [cookie] = reply.deep_unpack();
                this.pending = false;
                if (this.dead)
                    this.call('Uninhibit', new GLib.Variant('(u)', [cookie]), null, () => {});
                else {
                    this.cookie = cookie;
                    this.changed();
                }
            }, () => { this.pending = false; this.changed(); });
        }
        this.changed();
    }

    // Starts GNOME's own screen recording UI, or stops a recording in progress. The native
    // top bar is replaced, so its recording indicator is not visible while recording.
    record() {
        const ui = Main.screenshotUI;
        if (ui.screencastInProgress) {
            ui.stopScreencast();
            return;
        }
        this.close();
        Screenshot.showScreenRecordingUI();
    }

    call(method, args, replyType, success, failed = () => {}) {
        // Do not cancel an Inhibit request: a late cookie must still be released.
        Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager',
            'org.gnome.SessionManager', method, args,
            replyType ? new GLib.VariantType(replyType) : null, Gio.DBusCallFlags.NONE,
            5000, null, (bus, result) => {
                try {
                    success(bus.call_finish(result));
                } catch (error) {
                    if (!this.dead)
                        Main.notifyError('Islet', `Failed to call org.gnome.SessionManager.${method}: ${error.message}. Check the session D-Bus service and power settings before retrying Caffeine.`);
                    failed();
                }
            });
    }

    build(box) {
        const page = new Lifetime();
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const wifi = tile(() => this.settings('wifi'));
        const bluetooth = tile(() => this.settings('bluetooth'));
        const caffeine = tile(() => this.caffeine());
        const sound = tile(() => toggleMute());
        const record = tile(() => this.record());
        const layout = new Clutter.GridLayout({column_homogeneous: true,
            column_spacing: 4 * scale});
        const grid = new St.Widget({layout_manager: layout, x_expand: true});
        layout.attach(wifi.actor, 0, 0, 1, 1);
        layout.attach(bluetooth.actor, 1, 0, 1, 1);
        layout.attach(caffeine.actor, 2, 0, 1, 1);
        layout.attach(sound.actor, 3, 0, 1, 1);
        layout.attach(record.actor, 4, 0, 1, 1);
        box.add_child(grid);

        const toggleMute = () => {
            const stream = this.mixer.get_default_sink();
            stream?.change_is_muted(!stream.is_muted);
        };
        const mute = iconButton('audio-volume-high-symbolic', _('Mute'), toggleMute, 'ns-small', 14);
        const slider = new Slider(0);
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        const percent = new St.Label({style_class: 'ns-percent', y_align: Clutter.ActorAlign.CENTER});
        const volumeRow = row('ns-volume');
        volumeRow.add_child(mute);
        volumeRow.add_child(slider);
        volumeRow.add_child(percent);
        box.add_child(volumeRow);

        // One row of small icon buttons: native menus, separator, power actions.
        const actionsRow = row('ns-actions');
        const addAction = (symbol, name, clicked) => {
            const actor = iconButton(symbol, name, clicked, 'ns-small', 14);
            actor.x_expand = true;
            actionsRow.add_child(actor);
            return actor;
        };
        addAction('emblem-system-symbolic', _('Open GNOME Settings'), () => this.settings());
        addAction('preferences-system-notifications-symbolic', _('Notification settings'),
            () => this.settings('notifications'));
        actionsRow.add_child(new St.Widget({style_class: 'ns-separator',
            y_align: Clutter.ActorAlign.CENTER}));
        const power = [
            ['system-lock-screen-symbolic', _('Lock screen'), 'canLockScreen', 'activateLockScreen'],
            ['system-log-out-symbolic', _('Log out'), 'canLogout', 'activateLogout'],
            ['system-reboot-symbolic', _('Restart'), 'canRestart', 'activateRestart'],
            ['system-shutdown-symbolic', _('Power off'), 'canPowerOff', 'activatePowerOff'],
        ].map(([symbol, name, available, method]) => [addAction(symbol, name, () => {
            this.close();
            this.actions[method]();
        }), available]);
        box.add_child(actionsRow);

        let stream = null;
        let streamLife = null;
        let updating = false;
        const volume = () => {
            updating = true;
            const level = stream ? Math.min(1, stream.volume / this.mixer.get_vol_max_norm()) : 0;
            const muted = !stream || stream.is_muted || level === 0;
            slider.value = level;
            percent.text = stream ? `${Math.round(level * 100)}%` : '–';
            const symbol = muted ? 'audio-volume-muted-symbolic' :
                level < 0.34 ? 'audio-volume-low-symbolic' :
                    level < 0.67 ? 'audio-volume-medium-symbolic' : 'audio-volume-high-symbolic';
            mute.child.icon_name = symbol;
            mute.accessible_name = stream?.is_muted ? _('Unmute') : _('Mute');
            enable(mute, stream);
            enable(slider, stream);
            sound.set({iconName: symbol, name: _('Sound'),
                state: !stream ? _('Unavailable') : stream.is_muted ? _('Muted') : `${Math.round(level * 100)}%`,
                active: Boolean(stream) && !stream.is_muted, enabled: Boolean(stream)});
            updating = false;
        };
        const sink = () => {
            streamLife?.destroy();
            streamLife = new Lifetime();
            stream = this.mixer.get_default_sink();
            if (stream) {
                streamLife.connect(stream, 'notify::volume', volume);
                streamLife.connect(stream, 'notify::is-muted', volume);
            }
            volume();
        };
        page.own(() => streamLife?.destroy());
        page.connect(this.mixer, 'default-sink-changed', sink);
        page.connect(this.mixer, 'state-changed', sink);
        page.connect(slider, 'notify::value', () => {
            if (!updating && stream) {
                stream.volume = Math.round(slider.value * this.mixer.get_vol_max_norm());
                stream.push_volume();
                stream.change_is_muted(slider.value === 0);
            }
        });
        sink();

        const refresh = () => {
            const status = this.status();
            wifi.set({iconName: status.wifiIcon, name: 'Wi-Fi',
                state: status.wifi === null ? _('Unavailable') : status.wifi ? _('On') : _('Off'),
                active: status.wifi === true});
            const adapter = this.bluetooth.default_adapter;
            const powered = Boolean(adapter) && this.bluetooth.default_adapter_powered;
            bluetooth.set({iconName: powered ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
                name: 'Bluetooth', state: !adapter ? _('No adapter') : powered ? _('On') : _('Off'),
                active: powered});
            caffeine.set({iconName: 'weather-clear-night-symbolic', name: 'Caffeine',
                state: this.pending ? _('Waiting…') : this.cookie ? _('On') : _('Off'),
                active: Boolean(this.cookie), enabled: !this.pending});
            const recording = Main.screenshotUI.screencastInProgress;
            record.set({iconName: recording ? 'media-playback-stop-symbolic' : 'media-record-symbolic',
                name: recording ? _('Stop') : _('Record'), state: recording ? _('Recording') : _('Ready'),
                active: recording, enabled: recording || Main.screenshotUI._screencastSupported !== false});
            for (const [actor, available] of power)
                enable(actor, this.actions[available]);
        };
        page.connect(Main.screenshotUI, 'notify::screencast-in-progress', refresh);
        this.listeners.add(refresh);
        page.own(() => this.listeners.delete(refresh));
        refresh();
        return () => page.destroy();
    }

    destroy() {
        this.dead = true;
        this.cancel.cancel();
        this.listeners.clear();
        if (this.cookie) {
            this.call('Uninhibit', new GLib.Variant('(u)', [this.cookie]), null, () => {});
            this.cookie = 0;
        }
        this.network = null;
        this.battery = null;
        this.bluetooth = null;
    }
}
