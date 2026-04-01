// Credit by Raitzu
// yt-dlp-exec shim — stable audio streaming via child_process.spawn
'use strict';

const ytdlp = require('yt-dlp-exec');
const { spawn, spawnSync } = require('child_process');
const { PassThrough } = require('stream');
const fs   = require('fs');
const path = require('path');

let ffmpegPath = process.env.FFMPEG_PATH || null;
const ENABLE_STREAM_SEEK = /^(1|true|yes)$/i.test(String(process.env.ENABLE_STREAM_SEEK || ''));
if (!ffmpegPath) {
  try {
    ffmpegPath = require('ffmpeg-static');
  } catch (e) {
    ffmpegPath = null;
  }
}

// Resolve yt-dlp executable path robustly to avoid ENOENT on Windows
function resolveYtdlpExecutable() {
  const fileExists = (p) => {
    if (!p || typeof p !== 'string') return false;
    try { return fs.existsSync(p); } catch (e) { return false; }
  };

  const collectCandidates = () => {
    const candidates = [];

    // 1. Path exposed by the wrapper package
    if (ytdlp && typeof ytdlp.path === 'string' && ytdlp.path && ytdlp.path !== 'yt-dlp') {
      candidates.push(ytdlp.path);
    }

    // 2. Binary locations relative to package root
    try {
      const resolved = require.resolve('yt-dlp-exec');
      const base = path.dirname(resolved);
      const binName = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
      candidates.push(path.join(base, '..', 'bin', binName));
      candidates.push(path.join(base, 'bin', binName));
      candidates.push(path.join(base, '..', binName));

      // Keep package root handy for optional bootstrap step.
      candidates.packageBase = base;
    } catch (e) {}

    return candidates;
  };

  const tryResolveFromCandidates = (candidates) => {
    for (const c of candidates) {
      if (fileExists(c)) return c;
    }
    return null;
  };

  try {
    const candidates = collectCandidates();
    let resolvedPath = tryResolveFromCandidates(candidates);
    if (resolvedPath) return resolvedPath;

    // 3. If missing, run package postinstall once to bootstrap bin/yt-dlp
    try {
      const base = candidates.packageBase;
      const installScript = base ? path.join(base, '..', 'scripts', 'postinstall.js') : null;
      if (fileExists(installScript)) {
        spawnSync(process.execPath, [installScript], {
          cwd: path.join(base, '..'),
          windowsHide: true,
          stdio: 'ignore',
          timeout: 180000,
        });
      }
    } catch (e) {}

    resolvedPath = tryResolveFromCandidates(candidates);
    if (resolvedPath) return resolvedPath;

    // 4. Last fallback: rely on PATH
    return 'yt-dlp';
  } catch (e) {
    return 'yt-dlp';
  }
}

const ytdlpPath = resolveYtdlpExecutable();
const ytdlpRunner = (ytdlp && typeof ytdlp.create === 'function')
  ? ytdlp.create(ytdlpPath)
  : ytdlp;
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
async function runYtdlpJson(target, extra = {}, runtime = {}) {
  // Merge defaults with extras, but remove any explicit `false` flags because
  // the underlying yt-dlp wrapper converts boolean keys to CLI flags and
  // passing `false` can produce invalid double-negated options (e.g. --no-no-playlist).
  const merged = Object.assign({
    dumpSingleJson: true,
    noWarnings: true,
    noCheckCertificates: true,
    extractorArgs: YTDLP_EXTRACTOR_ARGS,
    jsRuntimes: YTDLP_JS_RUNTIMES,
  }, extra);
  const opts = {};
  for (const k of Object.keys(merged)) {
    if (merged[k] === false) continue; // skip false flags
    opts[k] = merged[k];
  }
  const timeoutMs = Number(runtime && runtime.timeoutMs) || 0;
  const execOpts = {
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  };

  if (timeoutMs > 0) {
    execOpts.timeout = timeoutMs;
    execOpts.killSignal = 'SIGKILL';
  }

  try {
    const out = await ytdlpRunner.exec(target, opts, execOpts);
    const stdout = out && out.stdout ? out.stdout : '';
    if (!stdout) return null;
    if (typeof stdout === 'string') return JSON.parse(stdout);
    return stdout;
  } catch (err) {
    if (err && err.timedOut) {
      const timeoutErr = new Error('timeout');
      timeoutErr.code = 'YTDLP_TIMEOUT';
      throw timeoutErr;
    }

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

function toWatchYouTubeUrl(url) {
  const id = extractYouTubeVideoId(url);
  if (!id) return String(url || '');
  return `https://www.youtube.com/watch?v=${id}`;
}

function isYouTubeLike(input) {
  const text = String(input || '').toLowerCase();
  return /youtube\.com|youtu\.be|music\.youtube\.com/.test(text);
}

function normalizePlayableTarget(input) {
  const value = String(input || '');
  if (!value) return value;
  if (!isUrl(value)) return value;
  // Keep search/result URLs in YouTube Music for UX, but stream from watch URL
  // to reduce throttling stalls that can cause premature idle transitions.
  if (isYouTubeLike(value)) return toWatchYouTubeUrl(value);
  return value;
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

function makeEntryKey(entry) {
  if (!entry) return null;
  const id = String(entry.id || '').trim();
  if (id) return `id:${id}`;
  const url = String(entry.webpage_url || entry.url || '').trim();
  if (url) return `url:${url}`;
  const title = String(entry.title || '').trim();
  const channel = String(entry.channel || entry.uploader || '').trim();
  if (!title && !channel) return null;
  return `meta:${title}|${channel}`.toLowerCase();
}

function dedupeEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  const seen = new Set();
  const out = [];

  for (const entry of entries) {
    if (!entry) continue;
    const key = makeEntryKey(entry);
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    out.push(entry);
  }

  return out;
}

// Keep music-like items first but never hide other potentially valid results.
function prioritizeLikelyMusicEntries(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return [];
  return entries
    .slice()
    .sort((a, b) => Number(isLikelyMusicEntry(b)) - Number(isLikelyMusicEntry(a)));
}

const YTDLP_EXTRACTOR_ARGS = process.env.YTDLP_EXTRACTOR_ARGS || 'youtube:player_client=web,web_safari';
const YTDLP_JS_RUNTIMES = process.env.YTDLP_JS_RUNTIMES || 'node';
const YTDLP_SEARCH_EXTRACTOR_ARGS = process.env.YTDLP_SEARCH_EXTRACTOR_ARGS || 'youtube:player_client=web_music';

const SEARCH_CACHE_TTL_MS = Math.max(3000, Number(process.env.SEARCH_CACHE_TTL_MS) || 12000);
const SEARCH_CACHE_MAX_SIZE = Math.max(25, Number(process.env.SEARCH_CACHE_MAX_SIZE) || 150);
const searchCache = new Map();
const searchInFlight = new Map();

function pruneSearchCache(now = Date.now()) {
  for (const [k, v] of searchCache.entries()) {
    if (!v || Number(v.expiresAt) <= now) searchCache.delete(k);
  }

  if (searchCache.size <= SEARCH_CACHE_MAX_SIZE) return;
  const overflow = searchCache.size - SEARCH_CACHE_MAX_SIZE;
  const keys = Array.from(searchCache.keys()).slice(0, overflow);
  for (const key of keys) searchCache.delete(key);
}

function tailProcessError(stderrChunks) {
  const text = Buffer.concat(stderrChunks || []).toString('utf8').trim();
  if (!text) return '';
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.slice(-3).join(' | ');
}

const activeChildProcesses = new Set();

function trackChildProcess(proc) {
  if (!proc || typeof proc.kill !== 'function') return;
  activeChildProcesses.add(proc);
  const cleanup = () => activeChildProcesses.delete(proc);
  proc.once('close', cleanup);
  proc.once('exit', cleanup);
}

function cleanupChildProcesses() {
  for (const proc of Array.from(activeChildProcesses)) {
    try {
      if (proc && !proc.killed) proc.kill('SIGKILL');
    } catch (e) {}
    activeChildProcesses.delete(proc);
  }
}

let cleanupHookBound = false;
function bindCleanupHooks() {
  if (cleanupHookBound) return;
  cleanupHookBound = true;

  process.once('SIGINT', cleanupChildProcesses);
  process.once('SIGTERM', cleanupChildProcesses);
  process.once('beforeExit', cleanupChildProcesses);
  process.once('exit', cleanupChildProcesses);
}

bindCleanupHooks();

module.exports = {
  /**
   * Search YouTube for tracks.
   * @param {string} query
   * @param {{ limit?: number }} opts
   * @returns {Promise<Array<{title: string, url: string}>>}
   */
  search: async (query, { limit = 5, timeoutMs = 2800 } = {}) => {
    const normalizedQuery = String(query || '').trim();
    if (!normalizedQuery) return [];

    const safeLimit = Math.max(1, Math.min(20, Number(limit) || 5));
    const requestedTimeout = Number(timeoutMs) || 0;
    const defaultTimeout = safeLimit <= 2 ? 1800 : 2500;
    const safeTimeoutMs = Math.max(700, requestedTimeout || defaultTimeout);
    const cacheKey = `${normalizedQuery.toLowerCase()}::${safeLimit}`;

    try {
      const now = Date.now();
      const cached = searchCache.get(cacheKey);
      if (cached && Number(cached.expiresAt) > now && Array.isArray(cached.results)) {
        return cached.results.slice(0, safeLimit);
      }

      if (searchInFlight.has(cacheKey)) {
        const shared = await searchInFlight.get(cacheKey);
        return Array.isArray(shared) ? shared.slice(0, safeLimit) : [];
      }

      const loader = (async () => {
        const fetchLimit = safeLimit <= 2
          ? 3
          : Math.max(5, Math.min(14, safeLimit + 3));
        const target = `ytsearch${fetchLimit}:${normalizedQuery}`;
        const info = await runYtdlpJson(
          target,
          {
            noPlaylist: true,
            flatPlaylist: true,
            extractorArgs: YTDLP_SEARCH_EXTRACTOR_ARGS,
          },
          { timeoutMs: safeTimeoutMs }
        );

        if (!info) return [];

        const entries = dedupeEntries(info.entries || (info.id ? [info] : []))
          .slice(0, safeLimit);

        return entries.map((e) => ({
          title: (e && e.title) ? e.title : 'Unknown Title',
          url: (e && (e.webpage_url || e.url)) ? toMusicYouTubeUrl(e.webpage_url || e.url) : '',
          duration: (e && e.duration) ? parseInt(e.duration, 10) : 0,
          thumbnail: (e && e.thumbnail) ? e.thumbnail : (e && e.thumbnails && e.thumbnails[0] ? e.thumbnails[0].url : ''),
          author: (e && (e.uploader || e.channel)) ? (e.uploader || e.channel) : 'Unknown Artist',
        }));
      })();

      searchInFlight.set(cacheKey, loader);
      const results = await loader;

      searchCache.set(cacheKey, {
        expiresAt: Date.now() + SEARCH_CACHE_TTL_MS,
        results: Array.isArray(results) ? results : [],
      });
      pruneSearchCache();

      return Array.isArray(results) ? results.slice(0, safeLimit) : [];
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      if (msg !== 'timeout') {
        console.warn('[playdl-shim] search failed:', msg);
      }
      return [];
    } finally {
      searchInFlight.delete(cacheKey);
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

        const spawnTarget = isUrl(target)
          ? normalizePlayableTarget(target)
          : `ytsearch1:${String(target)}`;
        const selectedPreset = normalizeAudioPreset(opts && opts.audioPreset);
        const audioFilter = getFilterForAudioPreset(selectedPreset);
        const requestedStartAtSeconds = Math.max(0, Number(opts && opts.startAtSeconds) || 0);
        const startAtSeconds = ENABLE_STREAM_SEEK ? requestedStartAtSeconds : 0;
        const needsSeek = ENABLE_STREAM_SEEK && startAtSeconds > 0.5;

        // Stability-first format selection: progressive mp4 tends to be more reliable
        // than segmented adaptive streams for long Discord playback sessions.
        const args = [
          '-f', '18/22/best[ext=mp4][protocol=https]/best[protocol=https]/best',
          '-o', '-',
          '--no-playlist',
          '--no-part',
          '--no-cache-dir',
          '--retries', 'infinite',
          '--fragment-retries', '25',
          '--retry-sleep', 'fragment:exp=1:20',
          '--extractor-args', YTDLP_EXTRACTOR_ARGS,
          '--js-runtimes', YTDLP_JS_RUNTIMES,
          spawnTarget,
        ];

        console.log('[playdl-shim] spawning yt-dlp for:', spawnTarget);
        const proc = spawn(ytdlpPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        trackChildProcess(proc);

        if (!proc) return reject(new Error('Failed to spawn yt-dlp process'));
        if (!proc.stdout) {
          try { proc.kill(); } catch (e) {}
          return reject(new Error('yt-dlp stdout is null'));
        }

        const ytdlpStderrChunks = [];
        if (proc.stderr) {
          proc.stderr.on('data', (chunk) => {
            if (chunk) ytdlpStderrChunks.push(Buffer.from(chunk));
          });
        }

        // Without ffmpeg we can only pass through whatever yt-dlp emits.
        if (!ffmpegPath) {
          if (audioFilter || needsSeek) {
            console.warn('[playdl-shim] ffmpeg unavailable; cannot apply preset/seek, using flat stream from start');
          }

          const passthrough = new PassThrough();
          let settled = false;
          let sawData = false;

          const failEarly = (reason) => {
            if (settled) return;
            settled = true;
            try { passthrough.destroy(); } catch (e) {}
            reject(new Error(reason));
          };

          proc.stdout.once('data', (firstChunk) => {
            sawData = true;
            if (settled) return;

            settled = true;
            passthrough.write(firstChunk);
            proc.stdout.pipe(passthrough);
            resolve({ stream: passthrough, type: 'webm_opus', process: proc });
          });

          proc.stdout.on('end', () => {
            try { passthrough.end(); } catch (e) {}
          });

          proc.on('error', (err) => {
            console.error('[playdl-shim] process error:', err && err.message ? err.message : err);
            if (err && err.code === 'ENOENT') {
              console.error('[playdl-shim] yt-dlp not found. Run: npm install yt-dlp-exec');
            }
            failEarly(`yt-dlp process error: ${err && err.message ? err.message : err}`);
          });

          proc.on('close', (code) => {
            if (code !== 0 && code !== null) {
              const tail = tailProcessError(ytdlpStderrChunks);
              console.log(`[playdl-shim] yt-dlp exited with code ${code}${tail ? ` | ${tail}` : ''}`);
            } else {
              console.log('[playdl-shim] yt-dlp exited normally');
            }

            if (!sawData) {
              const tail = tailProcessError(ytdlpStderrChunks);
              failEarly(`yt-dlp finished before audio output${tail ? `: ${tail}` : ''}`);
            }
          });

          return;
        }

        // ffmpeg mode: normalize to PCM so mp4/hls fallback formats remain playable.
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

        const ffmpegProc = spawn(ffmpegPath, ffmpegArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
        trackChildProcess(ffmpegProc);
        if (!ffmpegProc || !ffmpegProc.stdout || !ffmpegProc.stdin) {
          try { proc.kill('SIGKILL'); } catch (e) {}
          try { if (ffmpegProc) ffmpegProc.kill('SIGKILL'); } catch (e) {}
          return reject(new Error('Failed to start ffmpeg audio filter process'));
        }

        const ffmpegStderrChunks = [];
        if (ffmpegProc.stderr) {
          ffmpegProc.stderr.on('data', (chunk) => {
            if (chunk) ffmpegStderrChunks.push(Buffer.from(chunk));
          });
        }

        if (audioFilter) {
          console.log(`[playdl-shim] applying audio preset: ${selectedPreset}`);
        }
        if (needsSeek) {
          console.log(`[playdl-shim] seeking stream to ~${startAtSeconds.toFixed(1)}s`);
        }

        const pcmStream = new PassThrough();
        let settled = false;
        let sawData = false;

        const failEarly = (reason) => {
          if (settled) return;
          settled = true;
          try { pcmStream.destroy(); } catch (e) {}
          try { if (proc && !proc.killed) proc.kill('SIGKILL'); } catch (e) {}
          try { if (ffmpegProc && !ffmpegProc.killed) ffmpegProc.kill('SIGKILL'); } catch (e) {}
          reject(new Error(reason));
        };

        ffmpegProc.stdout.once('data', (firstChunk) => {
          sawData = true;
          if (settled) return;

          settled = true;
          pcmStream.write(firstChunk);
          ffmpegProc.stdout.pipe(pcmStream);
          resolve({ stream: pcmStream, type: 'raw_pcm', process: ffmpegProc });
        });

        ffmpegProc.stdout.on('end', () => {
          try { pcmStream.end(); } catch (e) {}
        });

        proc.stdout.pipe(ffmpegProc.stdin);

        proc.stdout.on('error', () => {
          try { ffmpegProc.stdin.end(); } catch (e) {}
        });

        ffmpegProc.stdin.on('error', () => {});

        proc.on('error', (err) => {
          console.error('[playdl-shim] process error:', err && err.message ? err.message : err);
          failEarly(`yt-dlp process error: ${err && err.message ? err.message : err}`);
        });

        proc.on('close', (code) => {
          try { ffmpegProc.stdin.end(); } catch (e) {}

          if (code !== 0 && code !== null) {
            const ytdlpTail = tailProcessError(ytdlpStderrChunks);
            console.log(`[playdl-shim] yt-dlp exited with code ${code}${ytdlpTail ? ` | ${ytdlpTail}` : ''}`);
            if (!sawData) {
              failEarly(`yt-dlp failed before audio output (code ${code})${ytdlpTail ? `: ${ytdlpTail}` : ''}`);
            }
          }
        });

        ffmpegProc.on('close', (code) => {
          if (!sawData) {
            const ffmpegTail = tailProcessError(ffmpegStderrChunks);
            failEarly(`ffmpeg finished before audio output (code ${code})${ffmpegTail ? `: ${ffmpegTail}` : ''}`);
            return;
          }

          if (code !== 0 && code !== null) {
            const ffmpegTail = tailProcessError(ffmpegStderrChunks);
            console.log(`[playdl-shim] ffmpeg exited with code ${code}${ffmpegTail ? ` | ${ffmpegTail}` : ''}`);
          }

          try { if (!proc.killed) proc.kill('SIGKILL'); } catch (e) {}
        });

        const originalKill = ffmpegProc.kill.bind(ffmpegProc);
        ffmpegProc.kill = (signal = 'SIGKILL') => {
          try {
            if (proc && !proc.killed) proc.kill(signal);
          } catch (e) {}
          return originalKill(signal);
        };

        return;

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
      const lookupTarget = normalizePlayableTarget(url);
      const info = await runYtdlpJson(lookupTarget, { noPlaylist: true });
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
