# GNShell

GNOME Shell extension for a top-center overlay. Phase 0 implements the technical
proof of concept for GNOME Shell **50.5 on Wayland**: overlay placement, optional
native panel replacement, fullscreen hiding, and temporary keyboard reveal.

The implementation and local checks are complete. Desktop acceptance testing is
pending because this development sandbox cannot access the session D-Bus or start
an isolated D-Bus daemon. See [Phase 0 verification](docs/phase-0-verification.md).

## Local checks

Run from the repository root. Node is used for boundary tests; GJS runs the actual
GLib timer and GObject signal cleanup checks.

```sh
node tests/phase0.mjs
glib-compile-schemas --strict --dry-run schemas
for file in extension.js lib/*.js; do
    node --input-type=module --check < "$file" || exit 1
done
```

The test runner intentionally causes one cleanup failure, captures its error
message, and verifies that the remaining cleanups still run. This is a test case.
Boundary tests replace GNOME objects; they do not prove actual fullscreen input,
work areas, Activities Overview, or panel restoration on a running desktop.

## Build and install for desktop testing

Run these commands in a terminal in your graphical GNOME session:

```sh
glib-compile-schemas --strict schemas
mkdir -p /tmp/gnshell-phase0-dist
gnome-extensions pack --force --extra-source=lib \
    --schema=schemas/org.gnome.shell.extensions.gnshell.gschema.xml \
    --out-dir=/tmp/gnshell-phase0-dist .
gnome-extensions install /tmp/gnshell-phase0-dist/gnshell@local.shell-extension.zip
```

If `gnshell@local` is already installed, back up that installation before replacing
it. Save your work and log out and back in after installing or changing the source
so GNOME Shell loads the new ES modules. Then run:

```sh
gnome-extensions enable gnshell@local
```

The default keeps the GNOME panel visible. First check the small GNShell overlay on
the primary monitor, application clicks outside the overlay, and Overview. In
fullscreen, `Super+Shift+N` shows the overlay for six seconds; pressing the shortcut
again hides it. Escape also hides a reveal when Shell receives the key event.
Expanded UI and a clock belong to Phase 1.

After preparing the recovery command below, test native panel replacement:

```sh
gsettings --schemadir schemas set org.gnome.shell.extensions.gnshell replace-panel true
```

Check maximized window work areas, Overview, fullscreen, monitor changes, display
scaling, and normal disable/re-enable. Changing `reveal-seconds` changes the next
reveal timeout. Phase 0 has no Preferences window; use GSettings for configuration.

## Error messages and recovery

Extension-generated errors use English and identify the failed operation and its
cause. For example:

```text
[GNShell] Cannot load GSettings schema "org.gnome.shell.extensions.gnshell": <cause> Run "glib-compile-schemas schemas" in the extension directory and reinstall the extension.
[GNShell] Failed to register keyboard shortcut "toggle-island" (<accelerator>): GNOME Shell returned Meta.KeyBindingAction.NONE. The binding may be unavailable or already registered. Choose another shortcut and enable GNShell again.
[GNShell] Failed to clean up <resource> during disable: <cause>
```

Use GNOME Logs to inspect errors containing `[GNShell]`. If panel replacement fails,
the extension attempts to restore the saved native panel tracking. Any restoration
failure is reported explicitly, including the recovery action.

For a responsive session:

```sh
gnome-extensions disable gnshell@local
```

If the graphical session is unresponsive, log in through a TTY with the same user
and move only GNShell out of the extension search directory:

```sh
mkdir -p "$HOME/.local/share/gnshell-recovery"
mv "$HOME/.local/share/gnome-shell/extensions/gnshell@local" \
    "$HOME/.local/share/gnshell-recovery/gnshell-$(date +%Y%m%d-%H%M%S)"
```

Then log out and back in to the graphical session. Crash recovery is separate from
normal disable cleanup. Keep Phase 1 implementation pending until the Phase 0
desktop acceptance checklist passes.
