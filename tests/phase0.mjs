import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';

// Execute the production modules with GNOME boundaries replaced by local objects.
// This checks control flow and rollback, not real Shell input, struts, or rendering.
function load(path, name, globals) {
    const source = fs.readFileSync(new URL(path, import.meta.url), 'utf8')
        .replace(/^import .*;\n/gm, '').replace(/export (?:default )?class /g, 'class ');
    return vm.runInNewContext(`${source}\n${name}`, globals);
}

class Signals {
    handlers = new Map();
    serial = 0;
    connect(name, callback) {
        this.handlers.set(++this.serial, {name, callback});
        return this.serial;
    }
    disconnect(id) { this.handlers.delete(id); }
    emit(name, ...args) {
        for (const handler of [...this.handlers.values()]) {
            if (handler.name === name)
                handler.callback(this, ...args);
        }
    }
}

function fixture({replace = false, shortcutFailure = false, schemaFailure = false, trackingFailures = 0} = {}) {
    const errors = [];
    const timers = new Map();
    const binding = {handler: null, removed: false};
    const actors = new Set();
    const display = new Signals();
    const stage = new Signals();
    const theme = Object.assign(new Signals(), {scale_factor: 1});
    const settings = Object.assign(new Signals(), {
        get_boolean: () => replace,
        get_uint: () => 6,
        get_strv: () => ['<Super><Shift>n'],
    });
    const panel = Object.assign(new Signals(), {visible: true});
    const layout = Object.assign(new Signals(), {
        panelBox: panel,
        primaryMonitor: {x: 100, y: 50, width: 1920, inFullscreen: false},
        _trackedActors: [{actor: panel, affectsStruts: true, trackFullscreen: true}],
        untrackChrome(actor) {
            this._trackedActors = this._trackedActors.filter(data => data.actor !== actor);
        },
        trackChrome(actor, params) {
            if (trackingFailures-- > 0)
                throw new Error('simulated trackChrome failure');
            this._trackedActors.push({actor, ...params});
            if (params.trackFullscreen)
                actor.visible = !this.primaryMonitor.inFullscreen;
        },
        addTopChrome(actor) { actors.add(actor); actor.parent = this; },
        removeChrome(actor) { actors.delete(actor); actor.parent = null; },
    });
    const Main = {
        layoutManager: layout,
        overview: Object.assign(new Signals(), {visible: false}),
        sessionMode: Object.assign(new Signals(), {isLocked: false, isGreeter: false}),
        panel: {statusArea: {}},
        wm: {
            addKeybinding(_name, _settings, _flags, mode, handler) {
                binding.mode = mode;
                if (shortcutFailure)
                    return 0;
                binding.handler = handler;
                return 1;
            },
            removeKeybinding() { binding.removed = true; binding.handler = null; },
        },
    };
    let timerId = 0;
    const GLib = {
        PRIORITY_DEFAULT: 0, SOURCE_REMOVE: false,
        timeout_add(_priority, milliseconds, callback) {
            timers.set(++timerId, {milliseconds, callback});
            return timerId;
        },
        source_remove(id) { timers.delete(id); },
    };
    const globals = {Main, GLib, console: {error: (...args) => errors.push(args[0])}};
    const Lifetime = load('../lib/lifetime.js', 'Lifetime', globals);
    const PanelManager = load('../lib/panel.js', 'PanelManager', globals);
    class Extension {
        getSettings() {
            if (schemaFailure)
                throw new Error('schema not found');
            return settings;
        }
    }
    class Button {
        constructor(params) { Object.assign(this, params); }
        get_parent() { return this.parent; }
        set_position(x, y) { this.x = x; this.y = y; }
        destroy() { this.destroyed = true; }
    }
    const GNShell = load('../extension.js', 'GNShell', {
        ...globals, Extension, Lifetime, PanelManager,
        global: {display, stage},
        St: {Button, ThemeContext: {get_for_stage: () => theme}},
        Meta: {KeyBindingFlags: {NONE: 0}, KeyBindingAction: {NONE: 0}},
        Shell: {ActionMode: {NORMAL: 1}},
        Clutter: {EventType: {KEY_PRESS: 1}, KEY_Escape: 27, EVENT_STOP: true, EVENT_PROPAGATE: false},
    });
    const extension = new GNShell();
    const emitters = [settings, panel, layout, Main.overview, Main.sessionMode, display, stage, theme];
    return {extension, binding, actors, timers, Main, theme, display, stage, errors,
        checkReleased() {
            assert.equal(actors.size, 0);
            assert.equal(timers.size, 0);
            assert.ok(emitters.every(object => object.handlers.size === 0));
            assert.equal(extension.life, null);
        }};
}

{
    const f = fixture({replace: true});
    for (let cycle = 0; cycle < 20; cycle++) {
        f.extension.enable();
        const [pill] = f.actors;
        assert.equal(pill.visible, true);
        assert.equal(pill.x, 998);
        assert.equal(pill.y, 50);
        assert.equal(f.Main.layoutManager.panelBox.visible, false);
        assert.equal(f.Main.layoutManager._trackedActors[0].affectsStruts, false);
        f.Main.overview.visible = true;
        f.Main.overview.emit('showing');
        assert.equal(pill.visible, false);
        assert.equal(f.Main.layoutManager.panelBox.visible, true);
        f.Main.overview.visible = false;
        f.Main.overview.emit('hidden');
        f.extension.disable();
        f.extension.disable();
        assert.equal(f.Main.layoutManager.panelBox.visible, true);
        assert.equal(f.Main.layoutManager._trackedActors[0].affectsStruts, true);
        assert.equal(pill.destroyed, true);
        f.checkReleased();
    }
    assert.equal(f.errors.length, 0);
}
{
    const f = fixture();
    f.extension.enable();
    const [pill] = f.actors;
    f.theme.scale_factor = 2;
    f.theme.emit('notify::scale-factor');
    assert.equal(pill.width, 248);
    assert.equal(pill.x, 936);
    f.Main.layoutManager.primaryMonitor.inFullscreen = true;
    f.display.emit('in-fullscreen-changed');
    assert.equal(pill.visible, false);
    assert.equal(f.binding.mode, 1);
    f.binding.handler();
    assert.equal(pill.visible, true);
    assert.equal([...f.timers.values()][0].milliseconds, 6000);
    f.binding.handler();
    assert.equal(pill.visible, false);
    assert.equal(f.timers.size, 0);
    f.binding.handler();
    f.stage.emit('captured-event', {type: () => 1, get_key_symbol: () => 27});
    assert.equal(pill.visible, false);
    assert.equal(f.timers.size, 0);
    f.binding.handler();
    const [id, timer] = [...f.timers.entries()][0];
    f.timers.delete(id);
    timer.callback();
    assert.equal(pill.visible, false);
    f.extension.disable();
    f.checkReleased();
}
for (const [options, message] of [
    [{schemaFailure: true}, /Cannot load GSettings schema.*schema not found.*glib-compile-schemas/],
    [{shortcutFailure: true}, /Failed to register keyboard shortcut.*Choose another shortcut/],
    [{replace: true, trackingFailures: 1}, /simulated trackChrome failure.*replacement was rolled back/],
    [{replace: true, trackingFailures: 2}, /Restoring the native panel also failed.*Disable GNShell/],
]) {
    const f = fixture(options);
    assert.throws(() => f.extension.enable(), message);
    f.checkReleased();
    assert.equal(f.Main.layoutManager.panelBox.visible, true);
    assert.equal(f.Main.layoutManager._trackedActors[0].affectsStruts, true);
    if (options.shortcutFailure)
        assert.equal(f.binding.removed, false, 'A rejected shortcut must not remove an existing binding.');
}
console.log('Phase 0 boundary tests passed: 20 lifecycle cycles, overlay policy, reveal timers, and failure rollback.');

const lifecycle = spawnSync('gjs', ['-m', fileURLToPath(new URL('./phase0-lifecycle.js', import.meta.url))],
    {encoding: 'utf8'});
assert.equal(lifecycle.status, 0, lifecycle.error?.message ?? lifecycle.stderr);
assert.match(lifecycle.stderr, /Failed to clean up failing test resource during disable: simulated cleanup failure/);
assert.doesNotMatch(lifecycle.stderr, /JS ERROR|JS WARNING|Gjs-CRITICAL/);
console.log(lifecycle.stdout.trim());
