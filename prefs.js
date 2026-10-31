import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class GNShellPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'GNShell', icon_name: 'preferences-system-symbolic'});
        const display = new Adw.PreferencesGroup({title: 'Display and privacy'});
        page.add(display);
        const switches = [
            ['replace-panel', 'Replace Top Bar', 'Enable only after the panel and recovery tests pass.'],
            ['redirect-notifications', 'Redirect banners to the island', 'Off: use GNOME banners. Enable only after the notification tests pass.'],
            ['privacy-mode', 'Privacy Mode', 'Hide titles, message bodies, and action labels.'],
            ['animations', 'Animations', 'Still follows the GNOME reduced-motion setting.'],
        ];
        for (const [key, title, subtitle] of switches) {
            const row = new Adw.SwitchRow({title, subtitle});
            settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            display.add(row);
        }
        const music = new Adw.PreferencesGroup({title: 'Music'});
        page.add(music);
        const mediaPeek = new Adw.SwitchRow({title: 'Show now-playing song',
            subtitle: 'Peek in the island when the song changes in Spotify and other MPRIS players.'});
        settings.bind('media-peek', mediaPeek, 'active', Gio.SettingsBindFlags.DEFAULT);
        music.add(mediaPeek);
        const mediaSeconds = new Adw.SpinRow({title: 'Display duration (seconds)',
            adjustment: new Gtk.Adjustment({lower: 1, upper: 15, step_increment: 1})});
        settings.bind('media-peek-seconds', mediaSeconds, 'value', Gio.SettingsBindFlags.DEFAULT);
        music.add(mediaSeconds);
        const timing = new Adw.PreferencesGroup({title: 'Timing and shortcut'});
        page.add(timing);
        for (const [key, title, min, max] of [
            ['peek-seconds', 'Notification Peek (seconds)', 1, 15],
            ['reveal-seconds', 'Smart Reveal (seconds)', 2, 30],
        ]) {
            const row = new Adw.SpinRow({title,
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1})});
            settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            timing.add(row);
        }
        const shortcut = new Adw.EntryRow({title: 'Shortcut',
            text: settings.get_strv('toggle-island')[0] ?? ''});
        const apply = new Gtk.Button({label: 'Apply', valign: Gtk.Align.CENTER});
        apply.connect('clicked', () => {
            const text = shortcut.text.trim();
            const [valid, key, mods] = Gtk.accelerator_parse(text);
            if (valid && key !== 0 && Gtk.accelerator_valid(key, mods)) {
                settings.set_strv('toggle-island', [Gtk.accelerator_name(key, mods)]);
                shortcut.remove_css_class('error');
            } else {
                shortcut.add_css_class('error');
                window.add_toast(new Adw.Toast({title: 'Invalid keyboard shortcut. Enter a valid modified key combination, for example Super+Shift+N.'}));
            }
        });
        shortcut.add_suffix(apply);
        timing.add(shortcut);
        const note = new Adw.ActionRow({title: 'Check for shortcut conflicts in GNOME Settings',
            subtitle: 'Default: &lt;Super&gt;&lt;Shift&gt;n. Do not use a shortcut already taken by another application.'});
        timing.add(note);
        window.add(page);
    }
}
