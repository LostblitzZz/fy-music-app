# 🎵 Fy Music APP (v1.0.0)

> **Dokumentasi Dwibahasa: [English](#english) | [Bahasa Indonesia](#bahasa-indonesia)**

---

<div id="english"></div>

# English 🇺🇸

**Fy Music APP** is a premium Discord music player designed for a seamless, high-quality audio experience. Built with **Discord.js v14**, **@discordjs/voice**, and **yt-dlp**, it ensures maximum stability and superior sound performance.

Designed & Developed with ❤️ by **Raitzu**.

## 🌟 Key Features

-   **Premium Interface**: Spotify-inspired embeds featuring dynamic progress bars and interactive controls.
-   **Multi-Platform Support**: Play tracks directly from **YouTube**, **Spotify**, and **SoundCloud**.
-   **Autoplay Mode**: Automatically suggests and plays related tracks when the queue is empty to keep the music going.
-   **Radio Stations**: Access 24/7 curated stations for various genres such as Lo-Fi, Jazz, and K-Pop.
-   **Strict Lyrics + Pagination**: Fetch lyrics with strict title/artist filtering and navigate long lyrics with next/prev buttons.
-   **Audio Preset (EQ Style)**: Tune sound character with presets like bass boost, vocal boost, bright, and studio.
-   **24/7 Connectivity**: Keep the bot active in your voice channel even when idle.
-   **Lossless Quality**: Optimized audio streaming utilizing `yt-dlp` for the best possible fidelity.

## 🚀 Getting Started

1.  **Clone the Repository**:
    ```bash
    git clone https://github.com/LostblitzZz/fy-music-app.git
    cd fy-music-app
    ```
2.  **Install Dependencies**:
    ```bash
    npm install
    ```
3.  **Configure Environment**:
    Initialize the environment settings by running the setup script, then add your Discord Bot Token to the generated `.env` file.
    ```bash
    npm run setup
    ```
4.  **Start the Application**:
    ```bash
    npm start
    ```

## 🔄 Update on Another Laptop (PM2)

If this bot is running 24/7 on another Windows laptop using PM2, you can update it from terminal with one command:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-bot.ps1 -AutoStash
```

What this script does:
- Pulls the newest code from GitHub.
- Installs production dependencies.
- Auto-detects the PM2 app from the current project folder.
- Restarts PM2 app and saves PM2 state.

Optional parameters:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-bot.ps1 -AppName fy-music-app -AutoStash -ShowLogs
```

- `-AppName` to force a specific PM2 app name.
- `-ShowLogs` to show latest PM2 logs after restart.
- `-SkipNpm` to skip dependency installation.

## 📜 Available Commands

| Command | Description |
| :--- | :--- |
| `/play` | Plays a song from a title or URL |
| `/skip` | Skips the current track |
| `/stop` | Stops playback and clears the queue |
| `/pause` / `/resume` | Toggles music playback |
| `/queue` | Displays the current musical queue |
| `/radio` | Starts a genre-based radio station |
| `/autoplay` | Toggles the automatic recommendation system |
| `/preset` | Sets audio preset/EQ mode |
| `/247` | Toggles 24/7 mode in the voice channel |

---

<div id="bahasa-indonesia"></div>

# Bahasa Indonesia 🇮🇩

**Fy Music APP** adalah pemutar musik Discord premium yang dirancang untuk memberikan pengalaman mendengarkan musik bersama teman dengan stabil dan berkualitas tinggi. Menggunakan **Discord.js v14**, **@discordjs/voice**, dan **yt-dlp**, bot ini menjamin kualitas audio yang jernih dan performa yang optimal.

Dibuat dengan sepenuh hati oleh **Raitzu**.

## ✨ Fitur Unggulan

-   **Antarmuka Premium**: Tampilan embed yang terinspirasi oleh Spotify, lengkap dengan *progress bar* dinamis dan tombol interaktif.
-   **Dukungan Multi-Platform**: Mendukung pemutaran musik dari **YouTube**, **Spotify**, hingga **SoundCloud**. 
-   **Mode Autoplay**: Menambahkan rekomendasi lagu secara otomatis saat antrean habis agar musik tidak terhenti.
-   **Stasiun Radio**: Tersedia pilihan stasiun radio 24/7 untuk berbagai genre seperti Lo-Fi, Jazz, dan K-Pop.
-   **Lirik Strict + Pagination**: Menampilkan lirik lagu dengan filter ketat judul/artis serta tombol next/prev untuk lirik panjang.
-   **Audio Preset (Gaya EQ)**: Atur karakter suara dengan preset seperti bass boost, vocal boost, bright, dan studio.
-   **Mode 24/7**: Bot tetap berada di dalam *Voice Channel* secara terus-menerus meskipun tidak ada aktivitas.
-   **Audio Berkualitas Tinggi**: Proses *streaming* dioptimalkan menggunakan *engine* `yt-dlp` untuk kualitas suara terbaik.

## 🛠️ Panduan Instalasi

1.  **Klon Repositori**:
    ```bash
    git clone https://github.com/LostblitzZz/fy-music-app.git
    cd fy-music-app
    ```
2.  **Instal Dependensi**:
    ```bash
    npm install
    ```
3.  **Konfigurasi Lingkungan**:
    Jalankan skrip *setup* untuk membuat file `.env` secara otomatis, kemudian masukkan *Discord Bot Token* Anda ke dalamnya.
    ```bash
    npm run setup
    ```
4.  **Mulai Aplikasi**:
    ```bash
    npm start
    ```

## 🔄 Update di Laptop Lain (PM2)

Kalau bot ini jalan 24/7 di laptop Windows lain pakai PM2, update cukup lewat terminal dengan satu perintah:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-bot.ps1 -AutoStash
```

Yang dilakukan skrip:
- Tarik kode terbaru dari GitHub.
- Instal dependency produksi.
- Auto-detect nama app PM2 dari folder project saat ini.
- Restart app PM2 lalu simpan state PM2.

Parameter opsional:

```powershell
powershell -ExecutionPolicy Bypass -File .\update-bot.ps1 -AppName fy-music-app -AutoStash -ShowLogs
```

- `-AppName` untuk paksa nama app PM2 tertentu.
- `-ShowLogs` untuk menampilkan log PM2 setelah restart.
- `-SkipNpm` untuk lewati instal dependency.

## 📜 Perintah Tersedia

| Perintah | Deskripsi |
| :--- | :--- |
| `/play` | Memutar lagu berdasarkan judul atau URL |
| `/skip` | Melewati lagu yang sedang diputar |
| `/stop` | Menghentikan musik dan menghapus antrean |
| `/pause` / `/resume` | Menghentikan sementara atau melanjutkan musik |
| `/queue` | Melihat daftar lagu dalam antrean |
| `/radio` | Memilih genre stasiun radio tertentu |
| `/autoplay` | Mengaktifkan atau menonaktifkan sistem rekomendasi otomatis |
| `/preset` | Mengatur mode audio preset/EQ |
| `/247` | Mengaktifkan mode standby 24/7 di Voice Channel |

## 🤝 Dukungan

Jika Anda menyukai proyek ini, berikan dukungan Anda dengan memberikan ⭐ pada repositori ini. Ikuti profil **Raitzu** untuk informasi pembaruan lainnya.

---
*Didukung oleh yt-dlp exec untuk pengalaman audio terbaik.*
