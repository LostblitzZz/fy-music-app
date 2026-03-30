// Credit by Raitzu
// yt-dlp-exec shim — stable audio streaming via child_process.spawn
'use strict';

const ytdlp = require('yt-dlp-exec');
const { spawn } = require('child_process');
const fs   = require('fs');
const path = require('path');

let ffmpegPath = process.env.FFMPEG_PATH || null;
if (!ffmpegPath) {
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    ffmpegPath = null;
  }
}

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
if (ffmpegPath) {
  console.log('[playdl-shim] using ffmpeg path:', ffmpegPath);
} else {
  console.warn('[playdl-shim] ffmpeg not found, audio presets will fallback to flat mode');
}

const AUDIO_PRESET_FILTERS = Object.freeze({
  flat: null,
  bass_boost: 'bass=g=6:f=110:w=0.75,acompressor=threshold=-18dB:ratio=2.2:attack=18:release=180,alimiter=limit=0.95',
  vocal_boost: 'highpass=f=110,lowpass=f=9000,equalizer=f=2500:width_type=o:width=1.1:g=4,acompressor=threshold=-20dB:ratio=2.3:attack=14:release=130,alimiter=limit=0.95',
  bright: 'treble=g=5:f=6500:w=0.9,highpass=f=80,alimiter=limit=0.95',
  studio: 'highpass=f=70,bass=g=2:f=120:w=0.6,treble=g=2:f=5500:w=0.8,acompressor=threshold=-19dB:ratio=2.0:attack=22:release=160,alimiter=limit=0.96',
});

function normalizeAudioPreset(preset) {
  const key = String(preset || 'flat')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();

  return Object.prototype.hasOwnProperty.call(AUDIO_PRESET_FILTERS, key) ? key : 'flat';
}

function getFilterForAudioPreset(preset) {
  const key = normalizeAudioPreset(preset);
  return AUDIO_PRESET_FILTERS[key] || null;
}

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

function extractYouTubeVideoId(url) {
  const m = String(url || '').match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/)|music\.youtube\.com\/watch\?v=)([^&?#]+)/i);
  return m ? m[1] : null;
}

function toMusicYouTubeUrl(url) {
  const id = extractYouTubeVideoId(url);
  if (!id) return String(url || '');
  return `https://music.youtube.com/watch?v=${id}`;
}

function isYouTubeLike(input) {
  const text = String(input || '').toLowerCase();
  return /youtube\.com|youtu\.be|music\.youtube\.com/.test(text);
}

function isLikelyMusicEntry(entry) {
  if (!entry) return false;

  const url = String(entry.webpage_url || entry.original_url || entry.url || '').toLowerCase();
  const domain = String(entry.webpage_url_domain || '').toLowerCase();
  const categories = Array.isArray(entry.categories) ? entry.categories.map(c => String(c).toLowerCase()) : [];
  const tags = Array.isArray(entry.tags) ? entry.tags.map(t => String(t).toLowerCase()) : [];
  const channel = String(entry.channel || entry.uploader || '').toLowerCase();

  if (url.includes('music.youtube.com') || domain.includes('music.youtube.com')) return true;
  if (categories.includes('music')) return true;
  if (tags.includes('music')) return true;
  if (entry.track || entry.artist || entry.album) return true;
  if (channel.endsWith(' - topic') || channel.includes('vevo')) return true;

  return false;
}

// Keep music-like items first but never hide other potentially valid results.
function prioritizeLikelyMusicEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return entries
    .slice()
    .sort((a, b) => Number(isLikelyMusicEntry(b)) - Number(isLikelyMusicEntry(a)));
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
      const sourceEntries = prioritizeLikelyMusicEntries(entries);

      return sourceEntries.map(e => ({
        title:    (e && e.title) ? e.title : 'Unknown Title',
        url:      (e && (e.webpage_url || e.url)) ? toMusicYouTubeUrl(e.webpage_url || e.url) : '',
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
  * @param {{ audioPreset?: string, startAtSeconds?: number }} [opts]
   * @returns {Promise<{stream: import('stream').Readable, type: string, process: import('child_process').ChildProcess}>}
   */
  stream: (target, opts = {}) => {
    return new Promise((resolve, reject) => {
      try {
        if (!target) return reject(new Error('No target provided to stream()'));

        const spawnTarget = isUrl(target) ? String(target) : `ytsearch1:${String(target)}`;
        const selectedPreset = normalizeAudioPreset(opts && opts.audioPreset);
        const audioFilter = getFilterForAudioPreset(selectedPreset);
        const startAtSeconds = Math.max(0, Number(opts && opts.startAtSeconds) || 0);
        const needsSeek = startAtSeconds > 0.5;

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

        // Flat mode without seek: pass-through yt-dlp stream (lowest CPU).
        if (!ffmpegPath || (!audioFilter && !needsSeek)) {
          if ((audioFilter || needsSeek) && !ffmpegPath) {
            console.warn('[playdl-shim] ffmpeg unavailable; cannot apply preset/seek, using flat stream from start');
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

          return resolve({ stream: proc.stdout, type: 'webm_opus', process: proc });
        }

        // Preset/seek mode: run stream through ffmpeg and output raw PCM.
        const ffmpegArgs = [
          '-hide_banner',
          '-loglevel', 'error',
          '-i', 'pipe:0',
        ];

        if (needsSeek) {
          ffmpegArgs.push('-ss', String(startAtSeconds.toFixed(2)));
        }

        ffmpegArgs.push(
          '-vn',
          '-ar', '48000',
          '-ac', '2',
          '-f', 's16le',
          'pipe:1',
        );

        if (audioFilter) {
          ffmpegArgs.splice(ffmpegArgs.indexOf('-ar'), 0, '-af', audioFilter);
        }

        const ffmpegProc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'ignore'] });
        if (!ffmpegProc || !ffmpegProc.stdout || !ffmpegProc.stdin) {
          try { proc.kill('SIGKILL'); } catch (e) {}
          try { if (ffmpegProc) ffmpegProc.kill('SIGKILL'); } catch (e) {}
          return reject(new Error('Failed to start ffmpeg audio filter process'));
        }

        if (audioFilter) {
          console.log(`[playdl-shim] applying audio preset: ${selectedPreset}`);
        }
        if (needsSeek) {
          console.log(`[playdl-shim] seeking stream to ~${startAtSeconds.toFixed(1)}s`);
        }

        proc.stdout.pipe(ffmpegProc.stdin);

        proc.stdout.on('error', () => {
          try { ffmpegProc.stdin.end(); } catch (e) {}
        });

        ffmpegProc.stdin.on('error', () => {});

        proc.on('error', (err) => {
          console.error('[playdl-shim] process error:', err && err.message ? err.message : err);
          try { ffmpegProc.kill('SIGKILL'); } catch (e) {}
        });

        proc.on('close', () => {
          try { ffmpegProc.stdin.end(); } catch (e) {}
        });

        ffmpegProc.on('close', () => {
          try {
            if (!proc.killed) proc.kill('SIGKILL');
          } catch (e) {}
        });

        const originalKill = ffmpegProc.kill.bind(ffmpegProc);
        ffmpegProc.kill = (signal = 'SIGKILL') => {
          try {
            if (proc && !proc.killed) proc.kill(signal);
          } catch (e) {}
          return originalKill(signal);
        };

        return resolve({ stream: ffmpegProc.stdout, type: 'raw_pcm', process: ffmpegProc });

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

      const resolvedUrl = info.webpage_url || info.url || url;
      const youtubeLike = isYouTubeLike(resolvedUrl) || isYouTubeLike(info.extractor || '');
      const normalizedUrl = youtubeLike ? toMusicYouTubeUrl(resolvedUrl) : resolvedUrl;
      const isMusic = youtubeLike
        ? (isLikelyMusicEntry(info) || (Number(info.duration) || 0) >= 45)
        : true;

      return {
        title:     info.title || 'Unknown Title',
        url:       normalizedUrl,
        duration:  info.duration ? parseInt(info.duration) : 0,
        thumbnail: info.thumbnail || (info.thumbnails && info.thumbnails[0] ? info.thumbnails[0].url : ''),
        author:    info.uploader || info.channel || 'Unknown Artist',
        isMusic,
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
      const sourceEntries = prioritizeLikelyMusicEntries(info.entries);

      return sourceEntries.map(e => ({
        title:     e.title || 'Unknown Title',
        url:       toMusicYouTubeUrl(e.url || (e.id ? `https://www.youtube.com/watch?v=${e.id}` : '')),
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
    if (/^(?:https?:\/\/)?(?:www\.)?(?:music\.)?(?:youtube\.com|youtu\.be)\/.+/.test(str)) return 'video';
    if (/soundcloud\.com\/.+/.test(str)) return 'soundcloud';
    return false;
  },
};
