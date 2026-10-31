# GNShell — development candidate

Target awal: GNOME Shell 50.5 pada Wayland. Kompatibilitas runtime belum disertifikasi.
UUID lokal: `gnshell@local`. Tidak ada bundler, server notifikasi, database, ataupun daemon tambahan.

## Instalasi lokal

Jalankan dari root source yang telah dibuat sesuai handoff. Dibutuhkan GJS, tool GNOME Extensions,
GLib schemas, GNOME Bluetooth 3, GTK4/libadwaita untuk Preferences, Python3 dan notify-send untuk bridge.
Node 22+ hanya dibutuhkan untuk sebagian test. Pengaturan jaringan membuka gnome-control-center.

    glib-compile-schemas --strict schemas
    mkdir -p /tmp/gnshell-dist
    gnome-extensions pack --force --extra-source=lib --extra-source=bridge --schema=schemas/org.gnome.shell.extensions.gnshell.gschema.xml --out-dir=/tmp/gnshell-dist .
    gnome-extensions install --force /tmp/gnshell-dist/gnshell@local.shell-extension.zip

Sebelum install, pastikan UUID ini belum digunakan atau backup folder versi lama dahulu: `--force`
menimpa instalasi yang sudah ada, dan tanpa `--force` perintah gagal jika extension sudah terpasang.
Logout/login setelah instalasi pertama atau
perubahan source untuk memastikan Shell memakai module baru; simpan pekerjaan dahulu. Wayland tidak
mendukung restart Shell melalui Alt+F2 lalu r. Kemudian:

    gnome-extensions enable gnshell@local
    gnome-extensions prefs gnshell@local

Awalnya Top Bar tetap tampil dan banner tetap milik GNOME. Setelah pengujian Phase 0 lulus,
aktifkan Ganti Top Bar. Setelah pengujian Phase 3 lulus, aktifkan Alihkan banner ke notch.
Kedua default aman ini adalah tahapan validasi, bukan mode akhir Hybrid Replacement.

## Pemakaian

Arahkan pointer ke notch (jam di tepi atas): setelah sekitar 0,15 detik notch membesar menjadi Expanded
tanpa klik, dan menutup sekitar 0,35 detik setelah pointer keluar (ditunda selama tombol mouse masih
ditekan, mis. menggeser slider). Klik notch membuka seketika. Tab Kontrol/Aktivitas berpindah halaman;
tab aktif berwarna biru. Hover dan klik tidak mengambil fokus keyboard, jadi Alt+Tab dan klik aplikasi
lain tetap bekerja. Hanya shortcut yang membuka Expanded dengan fokus keyboard (modal): Escape, tombol
Tutup, klik luar, atau shortcut menutupnya, dan pointer keluar tidak menutupnya. Jika shortcut ditekan
saat Expanded sedang terbuka lewat pointer, Expanded tidak menutup melainkan berpindah ke mode keyboard
(fokus keyboard + modal); tekan sekali lagi untuk menutup.
Shortcut awal `<Super><Shift>n`: saat fullscreen, tekan sekali untuk ringkas dan sekali lagi untuk
Expanded. Setelah 6 detik tanpa input, reveal ditutup. Periksa konflik shortcut di Settings GNOME.
Saat Overview, lock, atau menu native dibuka, notch disembunyikan. Jika Ganti Top Bar aktif, Top Bar
asli tetap tersembunyi juga di Overview. Karena panel tidak tampil, pintasan GNOME Super+S (Quick
Settings) dan Super+V (kalender/notifikasi) tidak membuka menunya saat Ganti Top Bar aktif; tombol di
notch tidak menggantikannya, karena keduanya membuka aplikasi Settings, bukan menu Top Bar.

Tampilan compact: notch idle berisi jam dan ikon jaringan/baterai. Expanded (±320 px lebar) memuat
header satu baris (jam, tanggal, baterai, tombol tutup), tab Kontrol/Aktivitas, empat tombol bulat
(Wi-Fi, Bluetooth, Caffeine, Suara), baris volume, dan satu deret tombol ikon kecil (gear: buka
GNOME Settings, lonceng: Settings > Notifikasi, lalu Kunci, Keluar, Mulai ulang, Matikan). Status tombol terbaca dari warna aktif dan
dari nama aksesibilitasnya.

Peek musik: saat lagu berganti di Spotify atau player MPRIS lain, notch menampilkan sampul (hanya art
file lokal `file://`; Spotify memakai ikon aplikasi, URL https tidak diunduh), judul, dan "artis • aplikasi" dengan ikon putar di kanan. Dengan Privacy Mode aktif
hanya tampil "<aplikasi>: sedang memutar". Aktif/nonaktif dan durasinya diatur di Preferences,
grup Musik ("Tampilkan lagu yang diputar" dan "Durasi tampil (detik)"). Peek musik mengikuti DND:
saat banner dimatikan (`show-banners` false) lagu tidak ditampilkan dan tidak muncul belakangan.

Wi-Fi menampilkan status radio; tombolnya membuka Settings. Bluetooth membuka Settings.
Volume/mute mengendalikan default audio sink. Caffeine hanya mengelola inhibit idle+suspend milik
GNShell; mematikannya tidak melepas inhibitor aplikasi lain. Lock, Logout, Restart, Shutdown
memakai mekanisme GNOME dan kebijakan konfirmasi sistem. Tombol gear membuka aplikasi GNOME Settings
dan tombol lonceng membuka panel Notifikasi di Settings; keduanya menutup notch dan tidak memunculkan
Top Bar.

Privacy Mode aktif secara default. Label aplikasi dapat tetap terlihat, judul/isi/aksi disembunyikan.
Activity memakai referensi paling banyak 50 notifikasi yang masih tersedia di GNOME. Antrean Peek
maksimum 20 item, durasi 4 detik per item, duplikat selama antre/Peek digabung. Menutup Peek tidak
menghapus notifikasi sistem. Tidak ada histori tambahan yang ditulis ke disk. Riwayat native GNOME
tetap mengikuti konfigurasi sistemnya. Critical tetap melalui GNOME, termasuk saat fullscreen.
Low/background masuk Activity; tidak ditampilkan sebagai Running tanpa sumber aktivitas valid.

## Codex

Setelah extension terinstall, tambahkan SATU root key di konfigurasi USER Codex, sebelum tabel TOML:

    notify = ["python3", "/home/gabz/.local/share/gnome-shell/extensions/gnshell@local/bridge/codex-notify.py"]

Sesuaikan path jika akun berbeda. Backup config sebelum edit, pertahankan semua key lain, dan
restart proses Codex. Bridge hanya menerima agent-turn-complete. Isi prompt/jawaban, session ID,
dan path proyek tidak diteruskan secara default. Tambahkan `--show-project` sebagai argv sebelum
payload JSON hanya jika ingin menampilkan basename proyek; ini merupakan opt-in metadata.
Periksa notifikasi terminal/TUI agar satu penyelesaian tidak menghasilkan dua sumber notifikasi.

## Verifikasi

    glib-compile-schemas --strict --dry-run schemas

Pemeriksaan ini hanya memvalidasi schema. Fullscreen/input Wayland, perilaku panel, D-Bus,
perangkat, animasi, dan keamanan redirect banner hanya dapat diverifikasi pada sesi nyata.
Gunakan matriks QA dalam dokumen handoff.

## Disable dan recovery

Jika Shell masih responsif:

    gnome-extensions disable gnshell@local

Disable normal harus mengembalikan tracking strut dan kebijakan panel, melepas modal dan inhibitor
sendiri, memulihkan method notifikasi, serta menghapus signal, timer, dan actor yang dibuat extension.
Inhibit request yang masih berjalan harus melepaskan cookie saat jawaban diterima; uji race ini.
Jika API notifikasi berubah, matikan Alihkan banner ke notch dan pakai banner GNOME.

Jika Shell tidak responsif, masuk TTY (Ctrl+Alt+F3), login sebagai pengguna yang sama, lalu pindahkan
folder extension ke luar direktori extensions:

    mkdir -p "$HOME/.local/share/gnshell-recovery"
    mv "$HOME/.local/share/gnome-shell/extensions/gnshell@local" "$HOME/.local/share/gnshell-recovery/gnshell-$(date +%Y%m%d-%H%M%S)"

Simpan pekerjaan jika masih memungkinkan, lalu logout/login sesi grafis. Jangan menyalakan kembali
extension sebelum log diperiksa. Crash proses Shell berbeda dari disable normal; restore di proses
yang sudah berhenti tidak bisa dijanjikan. Backup/restore config Codex secara terpisah jika hook dicabut.
Jangan menghapus config user atau seluruh daftar enabled-extensions.
