# 📖 Fy Music APP Documentation

Welcome to the full technical documentation for **Fy Music APP**. This guide provides a deep dive into how the bot works, how to configure it, and how to troubleshoot common issues.

> **Bilingual: [English](#english) | [Bahasa Indonesia](#bahasa-indonesia)**

---

<div id="english"></div>

## 🇺🇸 English Documentation

### 🏗️ 1. Architecture Overview
The bot is built using a modular structure to ensure stability and ease of maintenance:

-   **`index.js`**: The heart of the bot. Handles Discord client events, Slash/Prefix commands, and button interactions.
-   **`player.js`**: The music engine. Manages the queue, voice connections, and audio player state using `@discordjs/voice`.
-   **`playdl-shim.js`**: A custom wrapper for `yt-dlp-exec`. It handles stable audio streaming from YouTube and other sources via child processes.
-   **`Dockerfile`**: Container definition for easy cross-platform deployment.

### ✨ 1.1 Premium UX & Reliability Features
-   **Premium Queue/Now Playing panel**: `/queue`, `/np`, `!queue`, and `!np` use richer embeds with playback/session stats.
-   **Health diagnostics**: Use `/health` or `!health` to inspect runtime, memory, voice status, queue status, and persistence info.
-   **Queue auto-recovery**: The bot snapshots queue/player state to `data/player-state.json` and restores it on next boot.
-   **Anti-spam cooldown**: Command/button cooldowns reduce race-condition bugs from rapid repeated clicks/commands.
-   **Strict paginated lyrics**: Lyrics now use strict title/artist filtering with multi-source fallback and page navigation buttons.
-   **Audio preset (EQ style)**: Use `/preset` or `!preset` (`!eq`) to apply processing modes like `bass_boost`, `vocal_boost`, `bright`, and `studio`.

### ⚙️ 2. Environment Variables (`.env`)
| Variable | Description |
| :--- | :--- |
| `DISCORD_TOKEN` | Your Discord bot token from the [Developer Portal](https://discord.com/developers/applications). |
| `PREFIX` | The symbol used for chat commands (Default: `!`). |

> **Pro Tip**: Use `npm run setup` to automatically generate the `.env` file from the example template.

### 🛠️ 3. Advanced Customization
#### Adding Radio Stations
You can add more stations in `index.js` under the `RADIO_STATIONS` array:
```javascript
const RADIO_STATIONS = [
  { name: 'My New Station 🎵', value: 'https://youtube.com/...' },
  ...
];
```

#### Changing Embed Colors
The bot uses the hex color `0x1DB954` (Spotify Green). You can search and replace this in `index.js` to match your own branding.

### ❓ 4. Troubleshooting
-   **Audio is skipping/stuttering**: Ensure your server has a stable internet connection. `yt-dlp` is used to mitigate most issues, but network lag can still happen.
-   **"Command not found"**: If Slash Commands aren't appearing, wait up to 1 hour for global propagation or re-invite the bot with the `applications.commands` scope.
-   **FFmpeg errors**: Make sure `ffmpeg-static` installed correctly. If you're on a custom Linux server, you might need to install `ffmpeg` manually (`sudo apt install ffmpeg`).
-   **Need quick diagnostics**: Run `/health` (or `!health`) to check voice connection state, queue state, memory usage, and bot uptime.
-   **Queue disappeared after restart**: Verify that `data/player-state.json` exists and the bot process can write files in project directory.

---

<div id="bahasa-indonesia"></div>

## 🇮🇩 Bahasa Indonesia Documentation

### 🏗️ 1. Ikhtisar Arsitektur
Bot ini dibuat dengan struktur modular supaya stabil dan gampang dirawat:

-   **`index.js`**: Otak dari bot. Mengatur event Discord, perintah Slash/Prefix, dan interaksi tombol.
-   **`player.js`**: Mesin musiknya. Mengatur antrian (queue), koneksi suara, dan status player menggunakan `@discordjs/voice`.
-   **`playdl-shim.js`**: Wrapper khusus untuk `yt-dlp-exec`. Berfungsi buat streaming audio yang stabil dari YouTube dkk via child process.
-   **`Dockerfile`**: Definisi kontainer buat instalasi gampang di berbagai platform (VPS/Panel).

### ✨ 1.1 Fitur Premium & Stabilitas
-   **Panel Queue/Now Playing premium**: `/queue`, `/np`, `!queue`, dan `!np` pakai embed yang lebih rapi dengan statistik playback.
-   **Health diagnostics**: Pakai `/health` atau `!health` buat cek runtime, memory, status voice, status queue, dan info persistence.
-   **Auto-recovery queue**: State queue/player disimpan ke `data/player-state.json` lalu dipulihkan saat bot nyala lagi.
-   **Cooldown anti-spam**: Ada pembatasan command/tombol untuk mengurangi bug race condition akibat spam klik.
-   **Lyrics strict + pagination**: Lyrics sekarang difilter ketat berdasarkan judul/artis, pakai fallback multi-sumber, dan bisa pindah halaman via tombol.
-   **Audio preset (gaya EQ)**: Pakai `/preset` atau `!preset` (`!eq`) untuk mode seperti `bass_boost`, `vocal_boost`, `bright`, dan `studio`.

### ⚙️ 2. Variabel Lingkungan (`.env`)
| Variabel | Deskripsi |
| :--- | :--- |
| `DISCORD_TOKEN` | Token bot Discord kamu dari [Developer Portal](https://discord.com/developers/applications). |
| `PREFIX` | Simbol buat perintah chat (Bawaan: `!`). |

> **Tips**: Gunakan `npm run setup` buat otomatis buat file `.env` dari template yang ada.

### 🛠️ 3. Kustomisasi Lanjut
#### Menambah Stasiun Radio
Kamu bisa nambahin stasiun radio sendiri di `index.js` pada bagian `RADIO_STATIONS`:
```javascript
const RADIO_STATIONS = [
  { name: 'Radio Baru Saya 🎵', value: 'https://youtube.com/...' },
  ...
];
```

#### Mengubah Warna Embed
Bot ini pake warna hex `0x1DB954` (Hijau Spotify). Kamu bisa search dan ganti kode ini di `index.js` sesuai keinginanmu.

### ❓ 4. Masalah Umum & Solusi
-   **Audio putus-putus**: Pastikan koneksi internet server/VPS kamu stabil. `yt-dlp` udah dipake buat minimalisir masalah ini, tapi lag jaringan tetep bisa pengaruh.
-   **Perintah Slash nggak muncul**: Tunggu sekitar 1 jam karena sinkronisasi global Discord, atau invite ulang bot dengan izin `applications.commands`.
-   **Error FFmpeg**: Pastikan `ffmpeg-static` terinstal bener. Kalo di VPS Linux tertentu, mungkin perlu instal FFmpeg manual (`sudo apt install ffmpeg`).
-   **Butuh cek cepat kondisi bot**: Jalankan `/health` (atau `!health`) untuk melihat status koneksi voice, queue, memory, dan uptime.
-   **Queue hilang setelah restart**: Pastikan file `data/player-state.json` ada, dan process bot punya izin write ke folder project.

---
*Documentation maintained by **Raitzu**.*
