#!/usr/bin/env bash
# Build Islet from this folder and install it for the current user.
set -euo pipefail

UUID="islet@local"
SCHEMA="schemas/org.gnome.shell.extensions.islet.gschema.xml"

cd "$(dirname "$(readlink -f "$0")")"

missing=()
for tool in gnome-extensions glib-compile-schemas msgfmt gsettings; do
    command -v "$tool" >/dev/null || missing+=("$tool")
done
if ((${#missing[@]})); then
    echo "Missing tools: ${missing[*]}" >&2
    echo "Install the GNOME Shell, GLib, and gettext packages for your distribution, then try again." >&2
    exit 1
fi

if command -v gnome-shell >/dev/null; then
    version=$(gnome-shell --version | grep -oE '[0-9]+' | head -n1)
    [[ "$version" == "50" ]] ||
        echo "Warning: Islet targets GNOME Shell 50, this system has version ${version:-unknown}. It may not load." >&2
fi

build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

glib-compile-schemas --strict --dry-run schemas
gnome-extensions pack --force --extra-source=lib --extra-source=bridge --extra-source=LICENSE \
    --podir=po --schema="$SCHEMA" --out-dir="$build" .
gnome-extensions install --force "$build/$UUID.shell-extension.zip"

# A running Shell does not know a newly installed extension, so enable it for the next login instead.
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
    enabled=$(gsettings get org.gnome.shell enabled-extensions)
    case "$enabled" in
        *"'$UUID'"*) ;;
        "@as []") gsettings set org.gnome.shell enabled-extensions "['$UUID']" ;;
        *) gsettings set org.gnome.shell enabled-extensions "${enabled%]}, '$UUID']" ;;
    esac
fi

echo "Islet is installed. Log out and back in to load it."
