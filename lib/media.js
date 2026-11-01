import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const DEBOUNCE_MS = 300;
const FALLBACK_ICON = 'audio-x-generic-symbolic';

// ---- Pure decision logic (no GNOME APIs) ----

function text(value, limit) {
    return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

// Accepts the plain object produced by Variant.recursiveUnpack() and tolerates missing or mistyped fields.
export function parseMetadata(raw) {
    const meta = raw && typeof raw === 'object' ? raw : {};
    const artists = Array.isArray(meta['xesam:artist']) ? meta['xesam:artist'] : [meta['xesam:artist']];
    return {
        trackId: text(meta['mpris:trackid'], 200),
        title: text(meta['xesam:title'], 120),
        artist: artists.map(a => text(a, 120)).filter(Boolean).slice(0, 3).join(', '),
        album: text(meta['xesam:album'], 120),
        artUrl: text(meta['mpris:artUrl'], 2000),
    };
}

// Stable identity of a song for one player; null when there is no title to show.
export function trackKey(meta) {
    if (!meta?.title)
        return null;
    return JSON.stringify([meta.trackId, meta.title, meta.artist, meta.album]);
}

// Peek only for a song not yet shown (or seeded) for this player while it is Playing.
// A song that is suppressed (setting off, Do Not Disturb, island hidden) is still marked as seen so it cannot surface later.
export function decidePeek({enabled, banners = true, hidden, status, key, shown}) {
    if (!key || status !== 'Playing' || key === shown)
        return {offer: false, shown};
    return {offer: Boolean(enabled) && Boolean(banners) && !hidden, shown: key};
}

// Only local files are used; remote URLs (for example Spotify https covers) are ignored on purpose.
export function localArtUri(url) {
    return typeof url === 'string' && url.startsWith('file://') ? url : null;
}

export function fallbackId(busName) {
    return String(busName).replace(MPRIS_PREFIX, '').split('.')[0].toLowerCase();
}

export function playerId(desktopEntry, busName) {
    const entry = text(desktopEntry, 200).replace(/\.desktop$/, '');
    return entry || fallbackId(busName);
}

export function iconNames(id) {
    return id ? [id, `${id}-client`, FALLBACK_ICON] : [FALLBACK_ICON];
}

export function displayName(identity, id) {
    return text(identity, 80) || id || 'Media player';
}

// ---- GNOME integration ----

function cancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function property(proxy, name) {
    try {
        return proxy?.get_cached_property(name)?.recursiveUnpack() ?? null;
    } catch (error) {
        console.warn(`[Islet] Ignoring unreadable MPRIS property "${name}": ${error.message}`);
        return null;
    }
}

export class MediaWatcher {
    constructor(life, settings, state) {
        this.life = life;
        this.settings = settings;
        this.state = state;
        this.players = new Map();
        this.cancellable = new Gio.Cancellable();
        // Master Do Not Disturb switch: show-banners=false silences music Peeks too.
        this.master = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        this.connection = null;
        this.subscription = 0;
        this.destroyed = false;
        life.own(() => this.destroy(), 'MPRIS media watcher');
        Gio.bus_get(Gio.BusType.SESSION, this.cancellable, (_source, result) => {
            try {
                this.connection = Gio.bus_get_finish(result);
            } catch (error) {
                if (!cancelled(error))
                    console.warn(`[Islet] Media peek is unavailable: could not connect to the session bus (${error.message}).`);
                return;
            }
            this._watch();
        });
    }

    _watch() {
        // Subscribe before ListNames so a player appearing in between is not missed.
        this.subscription = this.connection.signal_subscribe('org.freedesktop.DBus',
            'org.freedesktop.DBus', 'NameOwnerChanged', '/org/freedesktop/DBus', MPRIS_PREFIX.slice(0, -1),
            Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE, (_c, _s, _p, _i, _n, params) => {
                try {
                    const [name, , owner] = params.deepUnpack();
                    if (!name.startsWith(MPRIS_PREFIX))
                        return;
                    this._remove(name);
                    if (owner)
                        this._add(name, false);
                } catch (error) {
                    console.error(`[Islet] Failed to handle an MPRIS name change: ${error.message}`, error);
                }
            });
        this.connection.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this.cancellable,
            (connection, result) => {
                try {
                    const [names] = connection.call_finish(result).deepUnpack();
                    for (const name of names) {
                        // Players already on the bus at enable are seeded: they never produce a Peek for the current song.
                        if (name.startsWith(MPRIS_PREFIX) && !this.players.has(name))
                            this._add(name, true);
                    }
                } catch (error) {
                    if (!cancelled(error))
                        console.warn(`[Islet] Could not list MPRIS players on the session bus: ${error.message}`);
                }
            });
    }

    _add(name, seed) {
        if (this.destroyed || this.players.has(name))
            return;
        const player = {name, seed, root: null, proxy: null, handler: 0, timer: 0, shown: null,
            latestKey: null, released: false, cancellable: new Gio.Cancellable()};
        this.players.set(name, player);
        // Root interface (DesktopEntry/Identity) first; a failure only loses the display name and icon.
        this._proxy(player, 'org.mpris.MediaPlayer2', Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS, root => {
            player.root = root;
            this._proxy(player, 'org.mpris.MediaPlayer2.Player', Gio.DBusProxyFlags.NONE, proxy => {
                player.proxy = proxy;
                this._activate(player);
            });
        });
    }

    _proxy(player, iface, flags, done) {
        Gio.DBusProxy.new_for_bus(Gio.BusType.SESSION, flags | Gio.DBusProxyFlags.DO_NOT_AUTO_START, null,
            player.name, MPRIS_PATH, iface, player.cancellable, (_s, result) => {
                if (player.released)
                    return;
                let proxy = null;
                try {
                    proxy = Gio.DBusProxy.new_for_bus_finish(result);
                } catch (error) {
                    if (cancelled(error))
                        return;
                    console.warn(`[Islet] Cannot read MPRIS interface ${iface} from ${player.name}: ${error.message}`);
                    if (iface.endsWith('.Player')) {
                        this._remove(player.name);
                        return;
                    }
                }
                try {
                    done(proxy);
                } catch (error) {
                    console.error(`[Islet] Failed to set up MPRIS player ${player.name}: ${error.message}`, error);
                }
            });
    }

    _info(player) {
        const meta = parseMetadata(property(player.proxy, 'Metadata'));
        const status = property(player.proxy, 'PlaybackStatus');
        const id = playerId(property(player.root, 'DesktopEntry'), player.name);
        return {meta, key: trackKey(meta), status: typeof status === 'string' ? status : '',
            id, name: displayName(property(player.root, 'Identity'), id)};
    }

    _activate(player) {
        const info = this._info(player);
        player.latestKey = info.key;
        if (player.seed)
            player.shown = info.key;
        else
            this._schedule(player);
        player.handler = player.proxy.connect('g-properties-changed', (_proxy, changed) => {
            try {
                const keys = Object.keys(changed.deepUnpack());
                if (!keys.includes('Metadata') && !keys.includes('PlaybackStatus'))
                    return;
                player.latestKey = this._info(player).key;
                this._schedule(player);
            } catch (error) {
                console.error(`[Islet] Failed to process an MPRIS update from ${player.name}: ${error.message}`, error);
            }
        });
    }

    // Spotify sends Metadata and PlaybackStatus separately, so decide only after they settle.
    _schedule(player) {
        if (this.destroyed || player.released)
            return;
        this.life.cancel(player.timer);
        player.timer = this.life.after(DEBOUNCE_MS, () => {
            player.timer = 0;
            this._evaluate(player);
        });
    }

    _evaluate(player) {
        if (player.released)
            return;
        const info = this._info(player);
        const decision = decidePeek({
            enabled: this.settings.get_boolean('media-peek'),
            banners: this.master.get_boolean('show-banners'),
            hidden: this.state.state === 'hidden' || this.state.locked,
            status: info.status,
            key: info.key,
            shown: player.shown,
        });
        player.shown = decision.shown;
        if (!decision.offer)
            return;
        const key = info.key;
        // St.Icon renders nothing (no fallback_gicon either) for a missing FileIcon, so a missing cover means no art.
        let art = localArtUri(info.meta.artUrl);
        if (art && !Gio.File.new_for_uri(art).query_exists(null))
            art = null;
        this.state.offer({
            key: `media:${player.name}:${key}`,
            priority: 1,
            time: GLib.get_monotonic_time(),
            notification: null,
            seconds: this.settings.get_uint('media-peek-seconds'),
            valid: () => !player.released && player.latestKey === key,
            media: {
                app: info.name,
                title: info.meta.title,
                artist: info.meta.artist,
                appIcon: new Gio.ThemedIcon({names: iconNames(info.id)}),
                art: art ? new Gio.FileIcon({file: Gio.File.new_for_uri(art)}) : null,
            },
        });
    }

    _remove(name) {
        const player = this.players.get(name);
        if (!player)
            return;
        this.players.delete(name);
        player.released = true;
        player.cancellable.cancel();
        this.life.cancel(player.timer);
        player.timer = 0;
        try {
            if (player.handler)
                player.proxy.disconnect(player.handler);
        } catch (error) {
            console.warn(`[Islet] Could not disconnect the MPRIS proxy of ${name}: ${error.message}`);
        }
        player.handler = 0;
        player.proxy = null;
        player.root = null;
    }

    destroy() {
        this.destroyed = true;
        this.cancellable.cancel();
        if (this.connection && this.subscription)
            this.connection.signal_unsubscribe(this.subscription);
        this.subscription = 0;
        for (const name of [...this.players.keys()])
            this._remove(name);
        this.connection = null;
        this.master = null;
    }
}
