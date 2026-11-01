import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences, gettext as _} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class IsletPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Islet', icon_name: 'preferences-system-symbolic'});
        const display = new Adw.PreferencesGroup({title: _('Display and privacy')});
        page.add(display);
        const switches = [
            ['replace-panel', _('Replace Top Bar'), _('Enable only after the panel and recovery tests pass.')],
            ['redirect-notifications', _('Redirect banners to the island'), _('Off: use GNOME banners. Enable only after the notification tests pass.')],
            ['privacy-mode', _('Privacy Mode'), _('Hide titles, message bodies, and action labels.')],
            ['animations', _('Animations'), _('Still follows the GNOME reduced-motion setting.')],
        ];
        for (const [key, title, subtitle] of switches) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            display.add(row);
        }
        const music = new Adw.PreferencesGroup({title: _('Music')});
        page.add(music);
        const mediaPeek = new Adw.SwitchRow({title: _('Show now-playing song'),
            subtitle: _('Peek in the island when the song changes in Spotify and other MPRIS players.')});
        settings.bind('media-peek', mediaPeek, 'active', Gio.SettingsBindFlags.DEFAULT);
        music.add(mediaPeek);
        const mediaSeconds = new Adw.SpinRow({title: _('Display duration (seconds)'),
            adjustment: new Gtk.Adjustment({lower: 1, upper: 15, step_increment: 1})});
        settings.bind('media-peek-seconds', mediaSeconds, 'value', Gio.SettingsBindFlags.DEFAULT);
        music.add(mediaSeconds);
        const timing = new Adw.PreferencesGroup({title: _('Timing and shortcut')});
        page.add(timing);
        for (const [key, title, min, max] of [
            ['peek-seconds', _('Notification Peek (seconds)'), 1, 15],
            ['reveal-seconds', _('Smart Reveal (seconds)'), 2, 30],
        ]) {
            const row = new Adw.SpinRow({title,
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            timing.add(row);
        }
        const shortcut = new Adw.EntryRow({title: _('Shortcut'),
            text: settings.get_strv('toggle-island')[0] ?? ''});
        const apply = new Gtk.Button({label: _('Apply'), valign: Gtk.Align.CENTER});
        apply.connect('clicked', () => {
            const text = shortcut.text.trim();
            const [valid, key, mods] = Gtk.accelerator_parse(text);
            if (valid && key !== 0 && Gtk.accelerator_valid(key, mods)) {
                settings.set_strv('toggle-island', [Gtk.accelerator_name(key, mods)]);
                shortcut.remove_css_class('error');
            } else {
                shortcut.add_css_class('error');
                window.add_toast(new Adw.Toast({title: _('Invalid keyboard shortcut. Enter a valid modified key combination, for example Super+Shift+N.')}));
            }
        });
        shortcut.add_suffix(apply);
        timing.add(shortcut);
        const note = new Adw.ActionRow({title: _('Check for shortcut conflicts in GNOME Settings'),
            subtitle: _('Default: &lt;Super&gt;&lt;Shift&gt;n. Do not use a shortcut already taken by another application.')});
        timing.add(note);
        window.add(page);
    }
}
