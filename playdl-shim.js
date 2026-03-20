// Credit by Raitzu
// yt-dlp-exec shim — stable audio streaming via child_process.spawn
'use strict';

const ytdlp = require('yt-dlp-exec');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

// Resolve yt-dlp executable path robustly to avoid ENOENT on Windows
function resolveYtdlpExecutable() {
  try {
    // 1. If ytdlp.path is a real absolute path that exists, use it directly
    if (ytdlp && ytdlp.path && typeof ytdlp.path === 'string' && ytdlp.path !== 'yt-dlp') {
      try { if (fs.existsSync(ytdlp.path)) return ytdlp.path; } catch (e) {}
    }

    // 2. Locate the binary inside the yt-dlp-exec package's bin/ directory
    try {
      const resolved  = require.resolve('yt-dlp-exec');
      const base      = path.dirname(resolved);
      const binName   = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      const candidates = [
        path.join(base, '..', 'bin', binName),
        path.join(base, 'bin', binName),
        path.join(base, '..', binName),
      ];
      for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch (e) {}
      }
    } catch (e) {}

    // 3. Fallback: rely on PATH
    return (ytdlp && ytdlp.path) ? ytdlp.path : 'yt-dlp';
  } catch (e) {
    return (ytdlp && ytdlp.path) ? ytdlp.path : 'yt-dlp';
  }
}

const ytdlpPath = resolveYtdlpExecutable();
console.log('[playdl-shim] using yt-dlp path:', ytdlpPath);

// Run yt-dlp with --dump-single-json and return parsed JSON
async function runYtdlpJson(target, extra = {}) {
  // Merge defaults with extras, but remove any explicit `false` flags because
  // the underlying yt-dlp wrapper converts boolean keys to CLI flags and
  // passing `false` can produce invalid double-negated options (e.g. --no-no-playlist).
  const merged = Object.assign({ dumpSingleJson: true, noWarnings: true, noCheckCertificates: true }, extra);
  const opts = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] === false) continue; // skip false flags
    opts[k] = merged[k];
  }
  try {
    const out = await ytdlp(target, opts);
    if (!out) return null;
    if (typeof out === 'string') return JSON.parse(out);
    return out;
  } catch (err) {
    // yt-dlp sometimes writes JSON to stdout even on non-zero exit
    if (err && err.stdout) {
      try {
        const txt = Buffer.isBuffer(err.stdout) ? err.stdout.toString() : err.stdout;
        return JSON.parse(txt);
      } catch (e) {}
    }
    throw err;
  }
}

// Determine if a string looks like an http(s) URL or a known service link
function isUrl(str) {
  return /^https?:\/\//i.test(String(str)) ||
    /(?:youtube\.com|youtu\.be|soundcloud\.com|spotify\.com)\//i.test(String(str));
}

module.exports = {
  /**
   * Search YouTube for tracks.
   * @param {string} query
   * @param {{ limit?: number }} opts
   * @returns {Promise<Array<{title: string, url: string}>>}
   */
  search: async (query, { limit = 5 } = {}) => {
    try {
      if (!query) return [];
      const target = `ytsearch${limit}:${query}`;
      const info   = await runYtdlpJson(target, { noPlaylist: true });
      if (!info) return [];
      const entries = info.entries || (info.id ? [info] : []);
      return entries.map(e => ({
        title:    (e && e.title) ? e.title : 'Unknown Title',
        url:      (e && (e.webpage_url || e.url)) ? (e.webpage_url || e.url) : '',
        duration: (e && e.duration) ? parseInt(e.duration) : 0,
        thumbnail: (e && e.thumbnail) ? e.thumbnail : (e && e.thumbnails && e.thumbnails[0] ? e.thumbnails[0].url : ''),
        author:   (e && (e.uploader || e.channel)) ? (e.uploader || e.channel) : 'Unknown Artist',
      }));
    } catch (err) {
      console.warn('[playdl-shim] search failed:', err && err.message ? err.message : err);
      return [];
    }
  },

  /**
   * Start a yt-dlp streaming process for the given target (URL or search query).
   * Returns a resolved Promise of { stream, type, process }.
   * @param {string} target URL or search term
   * @returns {Promise<{stream: import('stream').Readable, type: string, process: import('child_process').ChildProcess}>}
   */
  stream: (target) => {
    return new Promise((resolve, reject) => {
      try {
        if (!target) return reject(new Error('No target provided to stream()'));

        const spawnTarget = isUrl(target) ? String(target) : `ytsearch1:${String(target)}`;

        // Prefer webm/opus to avoid FFmpeg re-encoding; fall back to bestaudio
        const args = [
          '-f', 'bestaudio[ext=webm]/bestaudio',
          '-o', '-',
          '--no-playlist',
          '--no-part',
          '--no-cache-dir',
          spawnTarget,
        ];

        console.log('[playdl-shim] spawning yt-dlp for:', spawnTarget);
        const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'ignore'] });

        if (!proc) return reject(new Error('Failed to spawn yt-dlp process'));
        if (!proc.stdout) {
          try { proc.kill(); } catch (e) {}
          return reject(new Error('yt-dlp stdout is null'));
        }

        proc.on('error', (err) => {
          console.error('[playdl-shim] process error:', err && err.message ? err.message : err);
          if (err && err.code === 'ENOENT') {
            console.error('[playdl-shim] yt-dlp not found. Run: npm install yt-dlp-exec');
          }
        });

        proc.on('close', (code) => {
          if (code !== 0 && code !== null) {
            console.log(`[playdl-shim] yt-dlp exited with code ${code}`);
          } else {
            console.log('[playdl-shim] yt-dlp exited normally');
          }
        });

        // Resolve immediately with the stdout stream; audio data flows asynchronously
        resolve({ stream: proc.stdout, type: 'webm_opus', process: proc });
      } catch (err) {
        console.error('[playdl-shim] spawn failed:', err && err.message ? err.message : err);
        reject(err);
      }
    });
  },

  /**
   * Get full info for a single track.
   * @param {string} url
   */
  getInfo: async (url) => {
    try {
      const info = await runYtdlpJson(url, { noPlaylist: true });
      if (!info) return null;
      return {
        title:     info.title || 'Unknown Title',
        url:       info.webpage_url || info.url || url,
        duration:  info.duration ? parseInt(info.duration) : 0,
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0] ? info.thumbnails[0].url : ''),
        author:    info.uploader || info.channel || 'Unknown Artist',
      };
    } catch (err) {
      console.warn('[playdl-shim] getInfo failed:', err && err.message ? err.message : err);
      return null;
    }
  },

  /**
   * Get related tracks (YouTube Mix) for a given video ID.
   * @param {string} videoId
   * @param {{ limit?: number }} opts
   * @returns {Promise<Array<{title: string, url: string, duration: number, thumbnail: string, author: string}>>}
   */
  getRelated: async (videoId, { limit = 5 } = {}) => {
    try {
      if (!videoId) return [];
      // YouTube Mix URL pattern: RD + videoId
      const target = `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`;
      const info   = await runYtdlpJson(target, { 
        noPlaylist: false, 
        playlistItems: `1-${limit}`, 
        flatPlaylist: true 
      });
      if (!info || !info.entries) return [];
      return info.entries.map(e => ({
        title:     e.title || 'Unknown Title',
        url:       e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : ''),
        duration:  e.duration ? parseInt(e.duration) : 0,
        thumbnail: e.thumbnail || '',
        author:    e.uploader || e.channel || 'YouTube Artist',
      }));
    } catch (err) {
      console.warn('[playdl-shim] getRelated failed:', err && err.message ? err.message : err);
      return [];
    }
  },

  /**
   * Validate whether a string is a YouTube or SoundCloud URL.
   * @param {string} str
   * @returns {'video'|'soundcloud'|false}
   */
  yt_validate: (str) => {
    if (/^(?:https?:\/\/)?(?:www\.)?(?:youtube\.com|youtu\.be)\/.+/.test(str)) return 'video';
    if (/soundcloud\.com\/.+/.test(str)) return 'soundcloud';
    return false;
  },
};
