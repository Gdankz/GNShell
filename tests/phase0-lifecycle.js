import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Lifetime} from '../lib/lifetime.js';

function check(condition, message) {
    if (!condition)
        throw new Error(message);
}

const scope = new Lifetime();
const action = Gio.SimpleAction.new('phase0-test', null);
let signals = 0;
let fired = false;
const order = [];
scope.connect(action, 'activate', () => signals++);
scope.own(() => order.push('first'), 'first test resource');
scope.own(() => { throw new Error('simulated cleanup failure'); }, 'failing test resource');
scope.own(() => order.push('last'), 'last test resource');
scope.after(5, () => { fired = true; });

// The Node runner captures this intentional cleanup failure from stderr.
scope.destroy();
scope.destroy();
action.activate(null);
const loop = GLib.MainLoop.new(null, false);
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 20, () => {
    loop.quit();
    return GLib.SOURCE_REMOVE;
});
loop.run();
check(!fired && signals === 0, 'Disable must cancel pending timers and disconnect signals.');
check(order.join(',') === 'last,first', 'A cleanup failure must not stop the remaining cleanups.');
check(scope.timers.size === 0 && scope.jobs.length === 0, 'Disable must release owned resources.');

for (const register of [
    () => scope.after(1, () => {}),
    () => scope.connect(action, 'activate', () => {}),
    () => scope.own(() => {}),
]) {
    let rejected = false;
    try {
        register();
    } catch (error) {
        rejected = error.message.includes('the extension lifecycle has already ended');
    }
    check(rejected, 'A disabled lifecycle must reject new resources with an explicit English error.');
}

const completed = new Lifetime();
const done = GLib.MainLoop.new(null, false);
completed.after(1, () => done.quit());
done.run();
check(completed.timers.size === 0, 'A completed one-shot timer must release its source ID.');
completed.destroy();
print('Phase 0 GJS lifecycle tests passed: signals, timers, cleanup failures, and repeated disable.');
