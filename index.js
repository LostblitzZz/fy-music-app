// Credit by Raitzu
'use strict';

require('dotenv').config();
const path = require('path');

process.on('unhandledRejection', (reason) => {
  console.error('[bot] Unhandled Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('[bot] Uncaught Exception:', err);
});

// ── FFmpeg path setup (ffmpeg-static) ─────────────────────────────────────────
try {
  const ffmpegStatic = require('ffmpeg-static');
  if (ffmpegStatic) {
    const dir = path.dirname(ffmpegStatic);
    process.env.PATH       = dir + path.delimiter + (process.env.PATH || '');
    process.env.FFMPEG_PATH = ffmpegStatic;
    console.log('[bot] ffmpeg-static found and PATH updated');
  }
} catch (e) {
  console.warn('[bot] ffmpeg-static not available — install ffmpeg manually if audio fails.');
}

// ── Discord.js v14 ─────────────────────────────────────────────────────────────
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  MessageFlags,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
} = require('discord.js');

const MusicPlayer = require('./player');
const playShim    = require('./playdl-shim');
const lyricsFinder = require('lyrics-finder');

let geniusClient = null;
try {
  const geniusLib = require('genius-lyrics');
  const GeniusClient = geniusLib && (geniusLib.Client || (geniusLib.default && geniusLib.default.Client));
  if (typeof GeniusClient === 'function') {
    geniusClient = new GeniusClient();
  }
} catch (err) {
  console.warn('[bot] genius-lyrics init failed — strict lyrics matching will use fallback providers:', err && err.message ? err.message : err);
}

// ── Spotify support ───────────────────────────────────────────────────────────
const spotifyFetch = typeof globalThis.fetch === 'function'
  ? globalThis.fetch.bind(globalThis)
  : (...args) => import('node-fetch').then(({ default: fetchFn }) => fetchFn(...args));

let spotifyClient = null;
(async () => {
  try {
    const s       = require('spotify-url-info');
    const factory = s && (s.default || s);
    if (typeof factory === 'function') {
      spotifyClient = factory(spotifyFetch);
    } else if (s && (s.getTracks || s.getData || s.getPreview)) {
      spotifyClient = s;
    }
  } catch (err) {
    try {
      const mod     = await import('spotify-url-info');
      const factory = mod && (mod.default || mod);
      if (typeof factory === 'function') {
        spotifyClient = factory(spotifyFetch);
      } else if (mod && (mod.getTracks || mod.getData)) {
        spotifyClient = mod;
      }
    } catch (e) {
      console.warn('[bot] spotify-url-info init failed — Spotify URLs will not work:', e && e.message ? e.message : e);
    }
  }
})();

const RADIO_STATIONS = [
  { name: 'Lofi Girl ☕ (LIVE 24/7)', value: 'https://www.youtube.com/watch?v=jfKfPfyJRdk' },
  { name: 'Coffee Shop Jazz 🎷', value: 'coffee shop jazz piano music 2026' },
  { name: 'Gaming Mix 🎮 (Non-Stop)', value: 'gaming music mix 2026' },
  { name: 'K-Pop Top Hits 💃', value: 'k-pop top hits 2026' },
  { name: 'TikTok Viral 🎵', value: 'viral tiktok songs 2026' },
  { name: 'Stop Radio 🛑', value: 'stop' },
];

// ── Client ────────────────────────────────────────────────────────────────────
const PREFIX = process.env.PREFIX || '!';

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // Required to read message content for prefix commands
  ],
});

const player = new MusicPlayer();
const activeMessages = new Map(); // guildId -> { messageId, channelId, interval, lastTrackUrl }
const commandCooldowns = new Map();
const lyricsSessions = new Map();

const AUDIO_PRESET_CATALOG = typeof player.getAudioPresetCatalog === 'function'
  ? player.getAudioPresetCatalog()
  : [
    { value: 'flat', label: 'Flat', description: 'No filter' },
    { value: 'bass_boost', label: 'Bass Boost', description: 'Bass lebih tebal' },
    { value: 'vocal_boost', label: 'Vocal Boost', description: 'Vokal lebih jelas' },
    { value: 'bright', label: 'Bright', description: 'Treble lebih terang' },
    { value: 'studio', label: 'Studio', description: 'EQ + compressor ringan' },
  ];

const AUDIO_PRESET_LABEL_MAP = new Map(
  AUDIO_PRESET_CATALOG.map((item) => [String(item.value), String(item.label || item.value)])
);

const AUDIO_PRESET_CHOICES = AUDIO_PRESET_CATALOG
  .map((item) => {
    const label = String(item.label || item.value || 'Preset');
    const description = String(item.description || '').trim();
    const name = description ? `${label} — ${description}` : label;
    return {
      name: name.substring(0, 100),
      value: String(item.value || 'flat').substring(0, 100),
    };
  })
  .slice(0, 25);

const AUDIO_PRESET_VALUE_SET = new Set(AUDIO_PRESET_CATALOG.map((item) => String(item.value)));

const LYRICS_PAGE_MAX_CHARS = 1500;
const LYRICS_MAX_PAGES = 10;
const LYRICS_SESSION_TTL_MS = 12 * 60 * 1000;
const LYRICS_MAX_SESSIONS = 250;

const COMMAND_COOLDOWN_MS = {
  play: 2200,
  skip: 1400,
  stop: 1400,
  pause: 900,
  resume: 900,
  volume: 700,
  preset: 900,
  radio: 1600,
  autoplay: 1000,
  lyrics: 1800,
  queue: 500,
  np: 500,
  help: 400,
  health: 800,
  button: 700,
};

function getCooldownRemainingMs(userId, guildId, action, cooldownMs) {
  if (!userId || !guildId || !action || !cooldownMs) return 0;

  const key = `${guildId}:${userId}:${action}`;
  const now = Date.now();
  const readyAt = commandCooldowns.get(key) || 0;
  if (readyAt > now) return readyAt - now;

  commandCooldowns.set(key, now + cooldownMs);

  if (commandCooldowns.size > 3000) {
    for (const [k, expiresAt] of commandCooldowns.entries()) {
      if (expiresAt <= now) commandCooldowns.delete(k);
    }
  }

  return 0;
}

function formatCooldownSeconds(ms) {
  if (!ms || ms <= 0) return '0.0';
  return ms >= 5000 ? String(Math.ceil(ms / 1000)) : (ms / 1000).toFixed(1);
}

// ── Player event handlers ─────────────────────────────────────────────────────

player.on('trackStart', async (guildId, track) => {
  try {
    if (!track || !track.textChannelId) return;
    const ch = await client.channels.fetch(track.textChannelId).catch(() => null);
    if (!ch || !ch.send) return;

    // Clean up old interval for this guild
    if (activeMessages.has(guildId)) {
      clearInterval(activeMessages.get(guildId).interval);
    }

    const { embed, rows } = makePremiumEmbed(guildId, track);
    const msg = await ch.send({ embeds: [embed], components: rows });

    // Store message info and start update interval
    const interval = setInterval(async () => {
      try {
        const q = player.getQueue(guildId);
        if (!q.playing || q.playing.url !== track.url) {
          clearInterval(interval);
          return;
        }

        const { embed: updatedEmbed, rows: updatedRows } = makePremiumEmbed(guildId, q.playing);
        await msg.edit({ embeds: [updatedEmbed], components: updatedRows }).catch(() => {
          clearInterval(interval);
        });
      } catch (e) {
        clearInterval(interval);
      }
    }, 10000); // Update every 10 seconds to avoid rate limits

    activeMessages.set(guildId, { messageId: msg.id, channelId: ch.id, interval, lastTrackUrl: track.url });

    // ── Set Voice Channel Status (DJS v14.12+) ───────────────────────────────
    const guild = client.guilds.cache.get(guildId);
    if (guild) {
      const botVoice = guild.members.me.voice.channel;
      if (botVoice) {
        const statusText = `🎶 Playing: ${String(track.title).substring(0, 480)}`;
        if (typeof botVoice.setVoiceStatus === 'function') {
          botVoice.setVoiceStatus(statusText).catch(err => console.warn('[bot] setVoiceStatus error:', err.message));
        } else {
          // Fallback manual REST
          client.rest.put(`/channels/${botVoice.id}/voice-status`, { body: { status: statusText } })
            .catch(err => console.warn('[bot] Manual voice-status error:', err.message));
        }
      }
    }

    // ── Set Global Activity ──────────────────────────────────────────────────
    client.user.setActivity(`🎶 ${track.title}`, { type: 2 }); // Type 2 is LISTENING
  } catch (err) {
    console.error('[bot] Failed sending Now Playing embed:', err && err.message ? err.message : err);
  }
});

player.on('idle', (guildId) => {
  if (activeMessages.has(guildId)) {
    const info = activeMessages.get(guildId);
    clearInterval(info.interval);
    activeMessages.delete(guildId);
  }

  // ── Clear Voice Channel Status & Activity ──────────────────────────────────
  const guild = client.guilds.cache.get(guildId);
  if (guild) {
    const botVoice = guild.members.me.voice.channel;
    if (botVoice) {
      if (typeof botVoice.setVoiceStatus === 'function') {
        botVoice.setVoiceStatus('').catch(() => {});
      } else {
        client.rest.put(`/channels/${botVoice.id}/voice-status`, { body: { status: '' } }).catch(() => {});
      }
    }
  }
  client.user.setPresence({ activities: [], status: 'online' });
});

player.on('radioRecommend', async (guildId, track) => {
  try {
    if (!track || !track.textChannelId) return;
    const ch = await client.channels.fetch(track.textChannelId).catch(() => null);
    if (!ch || !ch.send) return;
    await ch.send({ content: `🔁 Radio: memutar **${track.title || 'lagu berikutnya'}**...` });
  } catch (err) {
    console.error('[bot] Failed sending radioRecommend message:', err && err.message ? err.message : err);
  }
});

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Create a simple single-field embed with the bot's brand colour. */
function makeEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(String(description).substring(0, 4096))
    .setColor(0x1DB954);
}

/** Create a visual progress bar string. */
function createProgressBar(currentMs, totalSecs) {
  const size = 15;
  const currentSecs = Math.floor(currentMs / 1000);
  const total = totalSecs > 0 ? totalSecs : 1;
  const progress = Math.min(1, currentSecs / total);
  const filledChars = Math.floor(progress * size);
  const emptyChars = size - filledChars;
  return '▬'.repeat(filledChars) + '🔘' + '▬'.repeat(Math.max(0, emptyChars));
}

/** Create a visual volume bar string. */
function createVolumeBar(volume) {
  const totalBars = 10;
  const filled = Math.round(volume / 10);
  const empty = totalBars - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

/** Format seconds to MM:SS or HH:MM:SS string. */
function formatTime(secs) {
  if (!secs || isNaN(secs) || secs < 0) return '0:00';
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function makeCooldownNotice(ms, actionLabel) {
  return `⏳ Tunggu ${formatCooldownSeconds(ms)} detik sebelum ${actionLabel}.`;
}

function clampText(input, max) {
  const text = String(input || '');
  if (!max || text.length <= max) return text;
  return `${text.substring(0, Math.max(0, max - 1))}…`;
}

function formatAudioPresetLabel(value) {
  const key = String(value || 'flat').toLowerCase();
  if (AUDIO_PRESET_LABEL_MAP.has(key)) return AUDIO_PRESET_LABEL_MAP.get(key);
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Flat';
}

function getAudioPresetListText() {
  return AUDIO_PRESET_CATALOG
    .map((item) => `• \`${item.value}\` — ${item.label}${item.description ? ` (${item.description})` : ''}`)
    .join('\n');
}

/** Clean song title from junk like [Official Video], (Lyrics), etc. */
function cleanTitle(title) {
  if (!title) return '';
  return String(title)
    .replace(/\[(?:official|video|audio|lyrics?|lirik|terjemahan|translation|hd|4k)[^\]]*\]/gi, ' ')
    .replace(/\((?:official|video|audio|lyrics?|lirik|terjemahan|translation|hd|4k)[^)]*\)/gi, ' ')
    .replace(/\s*[-|]\s*(?:official|video|audio|lyrics?|lirik|terjemahan|translation).*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeLookupText(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeLookupText(input) {
  return normalizeLookupText(input)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3);
}

function cleanArtistName(name) {
  return String(name || '')
    .replace(/\s*[-|]\s*topic\b/gi, '')
    .replace(/\s*[-|]\s*official.*$/gi, '')
    .replace(/\s*\(official[^)]*\)/gi, '')
    .replace(/\s*(?:ft|feat)\.?\s+.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanLyricsTitle(title) {
  return cleanTitle(String(title || ''))
    .replace(/\s*\((?:ft|feat)\.?[^)]*\)/gi, '')
    .replace(/\s*\[(?:ft|feat)\.?[^\]]*\]/gi, '')
    .replace(/\s+(?:ft|feat)\.?\s+.+$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildArtistVariants(artist) {
  const base = cleanArtistName(artist);
  if (!base) return [];

  const variants = new Set([base]);
  const parts = base
    .split(/\s*(?:,|&|\/|\+|\bx\b|\band\b)\s*/i)
    .map((part) => cleanArtistName(part))
    .filter(Boolean);

  for (const part of parts) {
    variants.add(part);
  }

  const primary = parts[0] || '';
  if (primary) {
    variants.delete(primary);
    return [base, primary, ...Array.from(variants)];
  }

  return Array.from(variants);
}

function tokenOverlapRatio(a, b) {
  const aTokens = tokenizeLookupText(a);
  const bTokens = tokenizeLookupText(b);
  if (aTokens.length === 0 || bTokens.length === 0) return 0;

  const bSet = new Set(bTokens);
  let hits = 0;
  for (const tok of aTokens) {
    if (bSet.has(tok)) hits += 1;
  }

  return hits / Math.max(aTokens.length, bTokens.length, 1);
}

function isLikelyArtistSegment(segment, artistCandidates) {
  const seg = normalizeLookupText(segment);
  if (!seg) return false;

  for (const cand of artistCandidates || []) {
    const artist = normalizeLookupText(cand);
    if (!artist) continue;

    if (seg === artist || seg.includes(artist) || artist.includes(seg)) return true;
    if (tokenOverlapRatio(seg, artist) >= 0.6) return true;
  }

  return false;
}

function inferArtistTitleFromName(rawTitle) {
  const value = cleanTitle(rawTitle);
  const match = value.match(/^(.{2,90}?)\s*[-:|]\s*(.{2,200})$/);
  if (!match) return null;

  const artist = cleanArtistName(match[1]);
  const title = cleanLyricsTitle(match[2]);
  if (!artist || !title) return null;

  return { artist, title };
}

function parseLyricsTarget(track) {
  if (!track) return { title: '', artist: '' };

  const rawTitle = String(track.spotifyTitle || track.title || track.search || '').trim();
  const rawArtist = String(track.spotifyArtist || track.author || '').trim();
  const parsedFromName = inferArtistTitleFromName(track.title || rawTitle);

  let title = cleanLyricsTitle(rawTitle);
  let artist = cleanArtistName(rawArtist);

  const genericArtist = /^(unknown(?: artist)?|youtube artist|various artists)$/i.test(artist);
  if ((!artist || genericArtist) && parsedFromName && parsedFromName.artist) {
    artist = parsedFromName.artist;
  } else if (genericArtist) {
    artist = '';
  } else if (artist && parsedFromName && parsedFromName.artist) {
    const normArtist = normalizeLookupText(artist);
    const normParsed = normalizeLookupText(parsedFromName.artist);
    if (normArtist && normParsed && normParsed.includes(normArtist) && normParsed.length >= normArtist.length + 3) {
      artist = parsedFromName.artist;
    }
  }

  if ((!title || title.length < 2) && parsedFromName && parsedFromName.title) {
    title = parsedFromName.title;
  }

  if (title) {
    const artistCandidates = [artist, parsedFromName && parsedFromName.artist].filter(Boolean);
    const segments = title
      .split(/\s*-\s*/)
      .map((part) => cleanLyricsTitle(part))
      .filter(Boolean);

    if (segments.length >= 2 && artistCandidates.length > 0) {
      if (segments.length > 1 && isLikelyArtistSegment(segments[0], artistCandidates)) {
        segments.shift();
      }
      if (segments.length > 1 && isLikelyArtistSegment(segments[segments.length - 1], artistCandidates)) {
        segments.pop();
      }

      const joined = cleanLyricsTitle(segments.join(' - '));
      if (joined) title = joined;
    }
  }

  if (title && artist) {
    const splitTitle = title.match(/^(.+?)\s*-\s*(.+)$/);
    if (splitTitle && normalizeLookupText(splitTitle[1]) === normalizeLookupText(artist)) {
      title = cleanLyricsTitle(splitTitle[2]);
    }
  }

  return {
    title: title || cleanTitle(track.title || ''),
    artist,
  };
}

function hasLyricsVersionPenalty(text) {
  return /\b(cover|karaoke|instrumental|remix|nightcore|slowed|sped up|8d)\b/i.test(text);
}

function scoreLyricsCandidate(candidate, expectedTitle, expectedArtist) {
  const candidateTitle = normalizeLookupText(candidate && (candidate.title || candidate.fullTitle));
  const candidateArtist = normalizeLookupText(
    candidate && candidate.artist
      ? (candidate.artist.name || candidate.artist.fullName || candidate.artist)
      : ''
  );
  const candidateFull = normalizeLookupText([
    candidate && candidate.fullTitle,
    candidate && candidate.title,
    candidate && candidate.artist && (candidate.artist.name || candidate.artist.fullName || candidate.artist),
  ].filter(Boolean).join(' '));

  const targetTitle = normalizeLookupText(expectedTitle);
  const targetArtist = normalizeLookupText(expectedArtist);
  const titleTokens = tokenizeLookupText(targetTitle);
  const artistTokens = tokenizeLookupText(targetArtist);

  let score = 0;
  let titleHits = 0;
  let artistHits = 0;

  if (targetTitle && candidateTitle === targetTitle) {
    score += 18;
    titleHits += 3;
  } else if (targetTitle && candidateTitle.includes(targetTitle)) {
    score += 12;
    titleHits += 2;
  }

  for (const token of titleTokens) {
    if (candidateTitle.includes(token)) {
      score += 2;
      titleHits += 1;
    }
  }

  if (targetArtist) {
    if (candidateArtist === targetArtist) {
      score += 16;
      artistHits += 3;
    } else if (candidateArtist.includes(targetArtist)) {
      score += 10;
      artistHits += 2;
    }

    if (candidateTitle.includes(targetArtist) || candidateFull.includes(targetArtist)) {
      score += 3;
      artistHits += 1;
    }

    for (const token of artistTokens) {
      if (candidateArtist.includes(token)) {
        score += 4;
        artistHits += 1;
      } else if (candidateTitle.includes(token)) {
        score += 1;
        artistHits += 0.5;
      }
    }
  }

  if (hasLyricsVersionPenalty(candidateTitle)) score -= 6;
  if (/\blive\b/.test(candidateTitle)) score -= 2;

  return { score, titleHits, artistHits };
}

function pickBestLyricsCandidate(candidates, expectedTitle, expectedArtist) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;

  const scored = candidates
    .map((candidate) => ({
      candidate,
      ...scoreLyricsCandidate(candidate, expectedTitle, expectedArtist),
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best) return null;

  const hasArtist = !!normalizeLookupText(expectedArtist);
  const minScore = hasArtist ? 16 : 8;

  if (best.score < minScore) return null;
  if (best.titleHits <= 0) return null;
  if (hasArtist && best.artistHits < 1) return null;

  return best.candidate;
}

function normalizeLyricsBody(raw) {
  if (!raw) return '';

  let text = String(raw)
    .replace(/\r/g, '')
    .replace(/\n?You might also like[\s\S]*$/i, '')
    .replace(/\n?\d*Embed\s*$/i, '')
    .trim();

  if (/^lyrics\s*$/i.test(text)) return '';
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return text;
}

function isUsableLyricsBody(text) {
  const value = String(text || '').trim();
  if (value.length < 45) return false;
  if (/\b(no lyrics|lyrics not found|not found|instrumental)\b/i.test(value)) return false;
  if (/we are not authorized|copyright/i.test(value)) return false;
  return true;
}

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function buildLyricsQueries(target) {
  const title = cleanLyricsTitle(target && target.title);
  const artist = cleanArtistName(target && target.artist);
  const artistVariants = buildArtistVariants(artist);
  const queries = new Set();

  if (title && artistVariants.length > 0) {
    for (const variant of artistVariants.slice(0, 3)) {
      queries.add(`"${title}" "${variant}"`);
      queries.add(`${title} ${variant}`);
      queries.add(`${variant} ${title}`);
    }
  }
  if (title) queries.add(title);
  if (title) queries.add(`${title} lyrics`);

  return Array.from(queries).filter(Boolean).slice(0, 9);
}

function buildLyricsTitleVariants(title) {
  const base = cleanLyricsTitle(title);
  const variants = new Set();
  if (!base) return [];

  variants.add(base);
  variants.add(base.replace(/[\u2018\u2019]/g, "'"));
  variants.add(base.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim());
  variants.add(base.replace(/\s+(?:ft|feat)\.?\s+.+$/i, '').trim());

  return Array.from(variants).filter(Boolean);
}

async function fetchJsonWithTimeout(url, timeoutMs = 7000) {
  let timer = null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;

  try {
    if (controller) {
      timer = setTimeout(() => controller.abort(), timeoutMs);
    }

    const response = await spotifyFetch(url, {
      signal: controller ? controller.signal : undefined,
      headers: {
        'User-Agent': 'fy-music-app/1.0',
      },
    });

    if (!response || !response.ok) return null;
    return response.json().catch(() => null);
  } catch (err) {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function tryGeniusLyrics(target) {
  if (!geniusClient || !target || !target.title) return null;

  const seen = new Set();
  const queries = buildLyricsQueries(target);

  for (const query of queries) {
    let candidates = [];
    try {
      candidates = await withTimeout(geniusClient.songs.search(query), 8500, 'genius-search');
    } catch (err) {
      continue;
    }

    if (!Array.isArray(candidates) || candidates.length === 0) continue;

    const deduped = candidates.filter((song) => {
      const key = String((song && song.url) || `${song && song.title}|${song && song.artist && (song.artist.name || song.artist.fullName || song.artist)}`);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 10);

    const best = pickBestLyricsCandidate(deduped, target.title, target.artist);
    if (!best) continue;

    try {
      const rawLyrics = await withTimeout(best.lyrics(), 12000, 'genius-lyrics');
      const lyrics = normalizeLyricsBody(rawLyrics);
      if (!isUsableLyricsBody(lyrics)) continue;

      return {
        lyrics,
        source: 'Genius',
        matchedTitle: best.title || target.title,
        matchedArtist: cleanArtistName(best.artist && (best.artist.name || best.artist.fullName || best.artist)) || target.artist || '',
      };
    } catch (err) {
      continue;
    }
  }

  return null;
}

async function tryLyricsOvh(target) {
  if (!target || !target.title || !target.artist) return null;

  const artistVariants = new Set(buildArtistVariants(target.artist));
  const titleVariants = buildLyricsTitleVariants(target.title);

  for (const artist of artistVariants) {
    if (!artist) continue;

    for (const title of titleVariants) {
      if (!title) continue;
      const endpoint = `https://api.lyrics.ovh/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`;
      const json = await fetchJsonWithTimeout(endpoint, 7000);
      const lyrics = normalizeLyricsBody(json && json.lyrics);

      if (!isUsableLyricsBody(lyrics)) continue;

      return {
        lyrics,
        source: 'lyrics.ovh',
        matchedTitle: title,
        matchedArtist: artist,
      };
    }
  }

  return null;
}

async function tryLegacyLyricsFinder(target) {
  if (!target || !target.title) return null;

  const artistVariants = target.artist
    ? new Set(buildArtistVariants(target.artist))
    : new Set(['']);

  for (const artist of artistVariants) {
    try {
      const rawLyrics = await withTimeout(lyricsFinder(artist || '', target.title), 9000, 'lyrics-finder');
      const lyrics = normalizeLyricsBody(rawLyrics);
      if (!isUsableLyricsBody(lyrics)) continue;

      return {
        lyrics,
        source: 'lyrics-finder',
        matchedTitle: target.title,
        matchedArtist: artist || '',
      };
    } catch (err) {
      continue;
    }
  }

  // Last fallback when no artist metadata is available.
  if (!target.artist) {
    try {
      const rawLyrics = await withTimeout(lyricsFinder('', target.title), 9000, 'lyrics-finder');
      const lyrics = normalizeLyricsBody(rawLyrics);
      if (isUsableLyricsBody(lyrics)) {
        return {
          lyrics,
          source: 'lyrics-finder',
          matchedTitle: target.title,
          matchedArtist: '',
        };
      }
    } catch (err) {}
  }

  return null;
}

async function getTrackLyricsStrict(track) {
  const target = parseLyricsTarget(track);

  if (!target.title) {
    return {
      ok: false,
      target,
      reason: 'Judul lagu tidak bisa dikenali untuk pencarian lirik.',
    };
  }

  const providers = [tryGeniusLyrics, tryLyricsOvh, tryLegacyLyricsFinder];
  for (const provider of providers) {
    const result = await provider(target);
    if (result && result.lyrics) {
      return {
        ok: true,
        target,
        ...result,
      };
    }
  }

  const reason = target.artist
    ? `Lirik akurat untuk **${target.title}** - **${target.artist}** belum ditemukan.`
    : `Lirik akurat untuk **${target.title}** belum ditemukan.`;

  return {
    ok: false,
    target,
    reason,
  };
}

function pruneLyricsSessions() {
  const now = Date.now();

  for (const [sessionId, session] of lyricsSessions.entries()) {
    if (!session || now - session.updatedAt > LYRICS_SESSION_TTL_MS) {
      lyricsSessions.delete(sessionId);
    }
  }

  if (lyricsSessions.size <= LYRICS_MAX_SESSIONS) return;

  const ordered = Array.from(lyricsSessions.entries())
    .sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));

  const removeCount = Math.max(0, lyricsSessions.size - LYRICS_MAX_SESSIONS);
  for (let i = 0; i < removeCount; i++) {
    const id = ordered[i] && ordered[i][0];
    if (id) lyricsSessions.delete(id);
  }
}

function splitLyricsIntoPages(rawLyrics, maxChars = LYRICS_PAGE_MAX_CHARS) {
  const text = String(rawLyrics || '').trim();
  if (!text) return ['Lirik kosong.'];

  const lines = text.split('\n');
  const pages = [];
  let buffer = '';

  const pushBuffer = () => {
    if (buffer.trim()) {
      pages.push(buffer.trim());
      buffer = '';
    }
  };

  for (const originalLine of lines) {
    let line = String(originalLine || '');

    if (line.length > maxChars) {
      pushBuffer();
      while (line.length > maxChars) {
        pages.push(line.slice(0, maxChars).trim());
        line = line.slice(maxChars);
      }
      buffer = line;
      continue;
    }

    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= maxChars) {
      buffer = candidate;
      continue;
    }

    pushBuffer();
    buffer = line;
  }

  pushBuffer();

  const cleanPages = pages.filter((p) => p && p.trim());
  if (cleanPages.length === 0) return ['Lirik kosong.'];
  return cleanPages.slice(0, LYRICS_MAX_PAGES);
}

function makeLyricsSession(track, result, ownerId, guildId) {
  pruneLyricsSessions();

  const target = result && result.target ? result.target : parseLyricsTarget(track);
  const pages = splitLyricsIntoPages(result && result.lyrics ? result.lyrics : '');
  const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

  lyricsSessions.set(sessionId, {
    ownerId: ownerId || null,
    guildId: guildId || null,
    displayTitle: clampText((track && track.title) || target.title || 'Unknown Title', 220),
    targetTitle: target && target.title ? target.title : '',
    targetArtist: target && target.artist ? target.artist : '',
    matchedTitle: result && result.matchedTitle ? result.matchedTitle : '',
    matchedArtist: result && result.matchedArtist ? result.matchedArtist : '',
    source: result && result.source ? result.source : 'unknown',
    pages,
    page: 0,
    updatedAt: Date.now(),
  });

  return sessionId;
}

function getLyricsSession(sessionId) {
  if (!sessionId) return null;
  pruneLyricsSessions();

  const session = lyricsSessions.get(sessionId);
  if (!session) return null;

  if (Date.now() - session.updatedAt > LYRICS_SESSION_TTL_MS) {
    lyricsSessions.delete(sessionId);
    return null;
  }

  return session;
}

function makeLyricsNavigationRow(sessionId, pageIndex, totalPages) {
  const current = Math.max(0, Math.min(totalPages - 1, Number(pageIndex) || 0));
  const isSinglePage = totalPages <= 1;

  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lyrics_nav:${sessionId}:prev`)
      .setLabel('⬅️ Prev')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSinglePage || current <= 0),
    new ButtonBuilder()
      .setCustomId(`lyrics_nav:${sessionId}:close`)
      .setLabel('✖ Close')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId(`lyrics_nav:${sessionId}:next`)
      .setLabel('Next ➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isSinglePage || current >= totalPages - 1)
  );
}

function makeLyricsPageEmbed(session, pageIndex) {
  const totalPages = Array.isArray(session && session.pages) ? session.pages.length : 0;
  const safeTotal = totalPages > 0 ? totalPages : 1;
  const current = Math.max(0, Math.min(safeTotal - 1, Number(pageIndex) || 0));
  const body = (session && session.pages && session.pages[current]) || 'Lirik tidak tersedia.';

  const lines = [
    `**${session && session.displayTitle ? session.displayTitle : 'Unknown Title'}**`,
    session && session.targetTitle
      ? (session.targetArtist
          ? `Target: **${session.targetTitle}** - **${session.targetArtist}**`
          : `Target: **${session.targetTitle}**`)
      : null,
    session && session.matchedTitle
      ? `Match: **${session.matchedTitle}**${session.matchedArtist ? ` - **${session.matchedArtist}**` : ''}`
      : null,
    '',
    body,
  ].filter(Boolean);

  return new EmbedBuilder()
    .setTitle('📃 Lyrics')
    .setDescription(lines.join('\n').substring(0, 4096))
    .setColor(0x1DB954)
    .setFooter({
      text: `Sumber: ${session && session.source ? session.source : 'unknown'} • Halaman ${current + 1}/${safeTotal} • strict-filtered`,
    });
}

function makeLyricsResultMessage(track, result, ownerId, guildId) {
  const sessionId = makeLyricsSession(track, result, ownerId, guildId);
  const session = getLyricsSession(sessionId);
  if (!session) {
    return {
      embeds: [makeEmbed('📃 Lyrics', 'Sesi lirik gagal dibuat. Coba lagi.')],
    };
  }

  const embed = makeLyricsPageEmbed(session, 0);
  if (session.pages.length <= 1) {
    return { embeds: [embed] };
  }

  return {
    embeds: [embed],
    components: [makeLyricsNavigationRow(sessionId, 0, session.pages.length)],
  };
}

/** Create a premium Spotify-like embed and button rows. */
function makePremiumEmbed(guildId, track) {
  const q = player.getQueue(guildId);
  const playbackMs = player.guilds.get(guildId)?.resource?.playbackDuration || 0;
  
  const bar = createProgressBar(playbackMs, track.duration);
  const volBar = createVolumeBar(q.volume);
  const timeInfo = `\`${formatTime(playbackMs / 1000)} / ${formatTime(track.duration)}\``;
  const presetLabel = formatAudioPresetLabel(q.audioPreset);
  
  const loopLabel = q.loopMode === 'track' ? '🔂' : (q.loopMode === 'queue' ? '🔁' : '➡️');
  const shuffleLabel = q.shuffle ? '✅' : '❌';

  const queueList = q.queue.length > 0 
    ? q.queue.slice(0, 5).map((s, i) => `\`${i + 1}.\` ${String(s.title || s.url).substring(0, 40)}`).join('\n')
    : '_Antrian kosong_';

  const embed = new EmbedBuilder()
    .setAuthor({ 
      name: 'Fy Music APP', 
      iconURL: 'https://cdn-icons-png.flaticon.com/512/3844/3844724.png' 
    })
    .setTitle(track.title || 'Unknown Title')
    .setURL(track.url || null)
    .setThumbnail(track.thumbnail || null)
    .setDescription(
      `**${track.author || 'YouTube Artist'}**\n` +
      `${bar}\n` +
      `${timeInfo}\n\n` +
      `Volume: \`${volBar}\` **${q.volume}%**\n` +
      `Loop: \`${q.loopMode}\` • Shuffle: ${shuffleLabel} • Autoplay: ${q.autoplay ? '✅' : '❌'}\n` +
      `Preset: \`${presetLabel}\``
    )
    .addFields({ name: '📋 Next in Queue', value: queueList, inline: false })
    .setColor(0x1DB954) // Spotify green
    .setFooter({ 
      text: `Requested by ${track.requestedBy || 'Unknown'} • ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`,
      iconURL: track.thumbnail || null
    });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_pause_resume')
      .setLabel('⏯️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('player_skip')
      .setLabel('⏭️')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('player_stop')
      .setLabel('⏹️')
      .setStyle(ButtonStyle.Danger),
    new ButtonBuilder()
      .setCustomId('player_loop')
      .setLabel(loopLabel)
      .setStyle(q.loopMode !== 'none' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('player_shuffle')
      .setLabel('🔀')
      .setStyle(q.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_vol_down')
      .setLabel('🔉 -10')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('player_vol_up')
      .setLabel('🔊 +10')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('player_autoplay')
      .setLabel('♾️ Autoplay')
      .setStyle(q.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId('player_queue')
      .setLabel('📜 Full Queue')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('player_lyrics')
      .setLabel('📃 Lyrics')
      .setStyle(ButtonStyle.Secondary)
  );

  return { embed, rows: [row1, row2, row3] };
}

function getTrackSourceLabel(track) {
  if (!track) return 'Unknown';
  const url = String(track.url || '').toLowerCase();
  if (url.includes('music.youtube.com')) return 'YouTube Music';
  if (url.includes('youtube.com') || url.includes('youtu.be')) return 'YouTube';
  if (url.includes('soundcloud.com')) return 'SoundCloud';
  if (url.includes('spotify.com')) return 'Spotify';
  if (track.search) return 'Search';
  return 'Unknown';
}

function getQueueRemainingSeconds(guildId) {
  const q = player.getQueue(guildId);
  const playbackMs = player.guilds.get(guildId)?.resource?.playbackDuration || 0;

  let total = 0;
  if (q.playing && q.playing.duration) {
    total += Math.max(0, (Number(q.playing.duration) || 0) - Math.floor(playbackMs / 1000));
  }

  for (const item of q.queue) {
    total += Number(item.duration) || 0;
  }

  return total;
}

function makeQueueOverviewEmbed(guildId, limit = 20) {
  const q = player.getQueue(guildId);
  const current = q.playing;
  const remainingSecs = getQueueRemainingSeconds(guildId);
  const totalTracks = q.queue.length + (current ? 1 : 0);

  const upNextRaw = q.queue.length > 0
    ? q.queue.slice(0, limit).map((t, i) => {
      const title = clampText(t.title || t.search || t.url || 'Unknown', 58);
      const dur = formatTime(Number(t.duration) || 0);
      return `\`${i + 1}.\` [${dur}] ${title}`;
    }).join('\n')
    : '_Antrian kosong_';
  const upNext = clampText(upNextRaw, 1000);

  const modeLine = `Loop: \`${q.loopMode}\` • Shuffle: ${q.shuffle ? '✅' : '❌'} • Autoplay: ${q.autoplay ? '✅' : '❌'}`;
  const presetLine = `Preset: \`${formatAudioPresetLabel(q.audioPreset)}\``;

  const embed = new EmbedBuilder()
    .setAuthor({
      name: 'Fy Music APP',
      iconURL: 'https://cdn-icons-png.flaticon.com/512/3844/3844724.png',
    })
    .setTitle('📋 Queue Overview')
    .setDescription(
      current
        ? `**Now:** ${clampText(current.title || current.url || 'Unknown', 120)}\n` +
          `Sumber: \`${getTrackSourceLabel(current)}\``
        : 'Belum ada lagu yang sedang diputar.'
    )
    .addFields(
      {
        name: '🎛 Session Stats',
        value:
          `Total Track: **${totalTracks}**\n` +
          `Sisa Durasi: **${formatTime(remainingSecs)}**\n` +
          `Volume: **${q.volume}%**\n` +
          `${modeLine}\n${presetLine}`,
        inline: false,
      },
      {
        name: `⏭ Up Next (${Math.min(limit, q.queue.length)}/${q.queue.length})`,
        value: upNext,
        inline: false,
      }
    )
    .setThumbnail((current && current.thumbnail) || null)
    .setColor(0x1DB954)
    .setFooter({ text: 'Premium Queue Panel • Fy Music APP' });

  return embed;
}

function makeNowPlayingInfoEmbed(guildId) {
  const q = player.getQueue(guildId);
  const track = q.playing;
  if (!track) return makeEmbed('🎵 Now Playing', 'Nothing is playing right now.');

  const playbackMs = player.guilds.get(guildId)?.resource?.playbackDuration || 0;
  const bar = createProgressBar(playbackMs, track.duration);
  const timeInfo = `\`${formatTime(playbackMs / 1000)} / ${formatTime(track.duration)}\``;
  const modeLine = `Loop: \`${q.loopMode}\` • Shuffle: ${q.shuffle ? '✅' : '❌'} • Autoplay: ${q.autoplay ? '✅' : '❌'}`;
  const presetLine = `Preset: \`${formatAudioPresetLabel(q.audioPreset)}\``;

  return new EmbedBuilder()
    .setAuthor({
      name: 'Fy Music APP',
      iconURL: 'https://cdn-icons-png.flaticon.com/512/3844/3844724.png',
    })
    .setTitle(clampText(track.title || 'Unknown Title', 250))
    .setURL(track.url || null)
    .setThumbnail(track.thumbnail || null)
    .setDescription(
      `**${track.author || 'Unknown Artist'}**\n` +
      `${bar}\n` +
      `${timeInfo}\n\n` +
      `Sumber: \`${getTrackSourceLabel(track)}\``
    )
    .addFields({
      name: '🎚 Playback',
      value: `Volume: **${q.volume}%**\n${modeLine}\n${presetLine}`,
      inline: false,
    })
    .setColor(0x1DB954)
    .setFooter({ text: `Requested by ${track.requestedBy || 'Unknown'}` });
}

function makeHealthEmbed(guildId) {
  const diag = player.getDiagnostics(guildId);
  const persist = player.getPersistenceInfo();
  const mem = process.memoryUsage();
  const nowTrack = diag.playingTitle ? clampText(diag.playingTitle, 80) : '-';
  const persistPath = persist.path ? path.relative(process.cwd(), persist.path) : 'data/player-state.json';

  return new EmbedBuilder()
    .setAuthor({
      name: 'Fy Music APP',
      iconURL: 'https://cdn-icons-png.flaticon.com/512/3844/3844724.png',
    })
    .setTitle('🩺 Bot Health')
    .setColor(0x1DB954)
    .addFields(
      {
        name: '⚙️ Runtime',
        value:
          `Uptime: **${formatTime(Math.floor(process.uptime()))}**\n` +
          `Ping: **${Math.max(0, Math.round(client.ws.ping || 0))} ms**\n` +
          `Node: **${process.version}**`,
        inline: true,
      },
      {
        name: '🧠 Memory',
        value:
          `RSS: **${formatBytes(mem.rss)}**\n` +
          `Heap Used: **${formatBytes(mem.heapUsed)}**\n` +
          `Heap Total: **${formatBytes(mem.heapTotal)}**`,
        inline: true,
      },
      {
        name: '🔊 Voice Engine',
        value:
          `Connection: **${diag.connectionStatus}**\n` +
          `Player: **${diag.playerStatus}**\n` +
          `Stream Process: **${diag.hasStreamProcess ? 'ON' : 'OFF'}**\n` +
          `Disconnect Pending: **${diag.disconnectPending ? 'YES' : 'NO'}**`,
        inline: false,
      },
      {
        name: '🎵 Queue State',
        value:
          `Now: **${nowTrack}**\n` +
          `Queued: **${diag.queueLength}**\n` +
          `Volume: **${diag.volume}%**\n` +
          `Preset: **${formatAudioPresetLabel(diag.audioPreset)}**\n` +
          `Loop: **${diag.loopMode}** • Shuffle: **${diag.shuffle ? 'ON' : 'OFF'}**`,
        inline: false,
      },
      {
        name: '🛡️ Safety & Recovery',
        value:
          `Autoplay: **${diag.autoplay ? 'ON' : 'OFF'}**\n` +
          `24/7: **${diag.stay24h ? 'ON' : 'OFF'}**\n` +
          `Radio: **${diag.radioEnabled ? `ON (${diag.radioKeyword || '-'})` : 'OFF'}**\n` +
          `Snapshot: **${persistPath}**`,
        inline: false,
      }
    )
    .setFooter({
      text:
        `Saved: ${persist.lastPersistAt ? new Date(persist.lastPersistAt).toLocaleString('id-ID') : 'never'} • ` +
        `Guild State: ${persist.activeGuildStates}`,
    });
}

function isSpotifyUrl(str) {
  return /open\.spotify\.com\/(track|playlist|album)\/.+/i.test(str) || /spotify:(track|playlist|album):/i.test(str);
}

function isYouTubeUrl(str) {
  return /^(?:https?:\/\/)?(?:www\.)?(?:music\.)?(?:youtube\.com|youtu\.be)\/.+/i.test(String(str));
}

function isSoundCloudUrl(str) {
  return /soundcloud\.com\/.+/i.test(str);
}

function getSpotifyUrlType(str) {
  const input = String(str || '');
  const webMatch = input.match(/open\.spotify\.com\/(track|playlist|album)\//i);
  if (webMatch && webMatch[1]) return webMatch[1].toLowerCase();

  const uriMatch = input.match(/spotify:(track|playlist|album):/i);
  if (uriMatch && uriMatch[1]) return uriMatch[1].toLowerCase();

  return null;
}

function normalizeSpotifyTrack(raw) {
  const t = raw && (raw.track || raw);
  if (!t) return null;

  const name = String(t.name || t.title || '').trim();
  const artists = [];

  if (Array.isArray(t.artists)) {
    for (const a of t.artists) {
      if (!a) continue;
      const value = typeof a === 'string' ? a : (a.name || a.title || '');
      if (value) artists.push(String(value).trim());
    }
  } else if (t.artist) {
    const value = typeof t.artist === 'string' ? t.artist : (t.artist.name || t.artist.title || '');
    if (value) artists.push(String(value).trim());
  }

  const artistText = artists.filter(Boolean).join(', ');
  const primaryArtist = artists.find(Boolean) || '';
  const title = artistText ? `${name} - ${artistText}` : name;

  // Quoted query helps avoid wrong songs with the same title from other artists.
  const search = primaryArtist
    ? `"${name}" "${primaryArtist}"`
    : `"${name}"`;

  if (!title && !search) return null;
  return {
    title: title || search,
    search: search || title,
    spotifyTitle: name,
    spotifyArtist: primaryArtist || artistText || '',
  };
}

async function spotifyGetData(url) {
  if (!spotifyClient) return null;
  if (typeof spotifyClient.getData === 'function') return spotifyClient.getData(url);
  if (typeof spotifyClient === 'function') return spotifyClient(url);
  return null;
}

async function spotifyGetTracks(url, data) {
  if (spotifyClient && typeof spotifyClient.getTracks === 'function') {
    const tracks = await spotifyClient.getTracks(url).catch(() => []);
    if (Array.isArray(tracks) && tracks.length > 0) return tracks;
  }

  // Fallback sources from getData/getDetails shape.
  if (Array.isArray(data && data.tracks) && data.tracks.length > 0) return data.tracks;
  if (Array.isArray(data && data.trackList) && data.trackList.length > 0) return data.trackList;

  if (Array.isArray(data && data.items) && data.items.length > 0) {
    return data.items.map((it) => (it && (it.track || it))).filter(Boolean);
  }

  return [];
}

async function validateYouTubeMusicLink(url) {
  if (!isYouTubeUrl(url)) return { ok: true, normalizedUrl: url };

  const info = await playShim.getInfo(url).catch(() => null);
  if (!info) {
    // Metadata can be incomplete for some regional/copyright-limited uploads.
    // Keep playback permissive so valid songs are not blocked by false negatives.
    return { ok: true, normalizedUrl: url };
  }

  return { ok: true, normalizedUrl: info.url || url };
}

/**
 * Consistently handle Spotify links — shared between prefix and slash handlers.
 * Returns { handled: true } or { handled: false }.
 */
async function handleSpotify(query, guildId, textChannelId, requestedBy, replyFn) {
  if (!isSpotifyUrl(query)) return { handled: false };
  if (!spotifyClient) {
    await replyFn({ embeds: [makeEmbed('⚠️ Spotify', 'Fitur Spotify masih inisialisasi. Coba lagi beberapa detik lagi.')] });
    return { handled: true };
  }
  try {
    const type = getSpotifyUrlType(query);
    const data = await spotifyGetData(query);

    if (type === 'playlist' || type === 'album' || (data && (data.type === 'playlist' || data.type === 'album'))) {
      const tracks = await spotifyGetTracks(query, data);
      const queueSnapshot = player.getQueue(guildId);
      const maxQueue = player.guilds.get(guildId)?.maxQueue || 500;
      const availableSlots = Math.max(0, maxQueue - queueSnapshot.queue.length);
      const limit = Math.min(availableSlots, tracks.length);
      const items = [];

      if (availableSlots <= 0) {
        await replyFn({ embeds: [makeEmbed('⚠️ Queue Full', `Queue sudah penuh (**${maxQueue}** lagu).`)] });
        return { handled: true };
      }

      for (let i = 0; i < limit; i++) {
        const t = normalizeSpotifyTrack(tracks[i]);
        if (!t) continue;
        items.push({
          title: t.title,
          search: t.search,
          spotifyTitle: t.spotifyTitle,
          spotifyArtist: t.spotifyArtist,
          sourceHint: 'spotify',
          strictSearch: true,
          requestedBy,
          textChannelId,
        });
      }

      if (items.length === 0) {
        await replyFn({ embeds: [makeEmbed('⚠️ Spotify', 'Playlist/album Spotify ini tidak punya track yang bisa diproses.')] });
        return { handled: true };
      }

      await player.enqueue(guildId, items);
      const sourceLabel = type === 'album' ? 'album Spotify' : 'playlist Spotify';
      const truncatedText = tracks.length > items.length
        ? `\n\n⚠️ Sebagian lagu tidak dimasukkan karena slot queue tersisa **${availableSlots}**.`
        : '';
      await replyFn({ embeds: [makeEmbed('✅ Queued', `Berhasil menambahkan **${items.length}** lagu dari ${sourceLabel}.${truncatedText}`)] });
      return { handled: true };
    }

    const normalized = normalizeSpotifyTrack(data && (data.track || data));
    if (normalized) {
      await player.enqueue(guildId, {
        title: normalized.title,
        search: normalized.search,
        spotifyTitle: normalized.spotifyTitle,
        spotifyArtist: normalized.spotifyArtist,
        sourceHint: 'spotify',
        strictSearch: true,
        requestedBy,
        textChannelId,
      });
      await replyFn({ embeds: [makeEmbed('✅ Queued', `Berhasil menambahkan **${normalized.title}** (Spotify → YouTube Music).`)] });
      return { handled: true };
    }

    await replyFn({ embeds: [makeEmbed('⚠️ Spotify', 'Link Spotify tidak bisa diproses. Pastikan link track/playlist/album valid.')] });
    return { handled: true };
  } catch (err) {
    console.error('[bot] Spotify parse error:', err && err.message ? err.message : err);
    await replyFn({ embeds: [makeEmbed('❌ Error', 'Gagal memproses link Spotify.')] });
    return { handled: true };
  }
}

// ── Slash command definitions ─────────────────────────────────────────────────

const slashCommands = [
  {
    name: 'play',
    description: 'Play a song — search YouTube Music or paste a URL',
    options: [
      {
        name: 'query', type: 3, description: 'Judul lagu / kata kunci', required: false, autocomplete: true,
      },
      {
        name: 'link', type: 3, description: 'Link YouTube Music / SoundCloud / Spotify', required: false,
      },
    ],
  },
  { name: 'skip',   description: 'Skip current track' },
  { name: 'stop',   description: 'Stop and clear queue' },
  { name: 'pause',  description: 'Pause playback' },
  { name: 'resume', description: 'Resume playback' },
  { name: 'queue',  description: 'Show upcoming tracks' },
  { name: 'np',     description: 'Show currently playing track' },
  {
    name: 'radio',
    description: 'Pilih stasiun radio favorit atau mulai autoplay berdasarkan genre',
    options: [{ 
      name: 'station', 
      type: 3, 
      description: 'Pilih stasiun radio', 
      required: true,
      choices: RADIO_STATIONS 
    }],
  },
  { name: '247',   description: 'Toggle 24/7 stay-in-channel mode' },
  { name: 'leave', description: 'Leave voice channel and disable 24/7 mode' },
  { name: 'autoplay', description: 'Toggle autoplay mode (related songs)' },
  { name: 'lyrics', description: 'Search lyrics for the current song' },
  {
    name: 'volume',
    description: 'Atur volume bot (0-100)',
    options: [{ name: 'level', type: 4, description: 'Level volume (0-100)', required: true, min_value: 0, max_value: 100 }],
  },
  {
    name: 'preset',
    description: 'Pilih preset audio (EQ style)',
    options: [{ name: 'mode', type: 3, description: 'Nama preset audio', required: true, choices: AUDIO_PRESET_CHOICES }],
  },
  { name: 'health', description: 'Status bot, voice, dan queue diagnostics' },
  { name: 'help',  description: 'Show all commands' },
];

// ── Register slash commands on ready ─────────────────────────────────────────

client.once('clientReady', async () => {
  console.log(`[bot] Logged in as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

  // Register to each guild for instant propagation (vs. global which takes ~1h)
  const guilds = client.guilds.cache.map(g => g.id);
  if (guilds.length === 0) {
    console.log('[bot] No guilds cached — commands will be registered on guildCreate.');
    return;
  }
  for (const gid of guilds) {
    try {
      await rest.put(Routes.applicationGuildCommands(client.user.id, gid), { body: slashCommands });
      console.log('[bot] Registered slash commands to guild', gid);
    } catch (err) {
      console.warn('[bot] Failed registering commands to guild', gid, err && err.message ? err.message : err);
    }
  }
});

client.on('error', (err) => {
  console.error('[bot] Discord Client Error:', err && err.message ? err.message : err);
});

client.on('guildCreate', async (guild) => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: slashCommands });
    console.log('[bot] Registered slash commands to new guild', guild.id);
  } catch (err) {
    console.warn('[bot] Failed registering commands on guildCreate:', err && err.message ? err.message : err);
  }
});

// ── Interaction handler ───────────────────────────────────────────────────────

client.on('interactionCreate', async (interaction) => {

  // ── Button interactions ─────────────────────────────────────────────────────
  if (interaction.isButton()) {
    const { customId, guildId } = interaction;
    if (!guildId) return;

    if (customId.startsWith('lyrics_nav:')) {
      try {
        const parts = customId.split(':');
        const sessionId = parts[1] || '';
        const action = parts[2] || '';

        const session = getLyricsSession(sessionId);
        if (!session) {
          return interaction.reply({
            content: '⌛ Sesi lyrics sudah kadaluarsa. Jalankan command lyrics lagi.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (session.ownerId && interaction.user.id !== session.ownerId) {
          return interaction.reply({
            content: '❌ Tombol lyrics ini hanya untuk user yang meminta lyrics.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (session.guildId && session.guildId !== guildId) {
          return interaction.reply({
            content: '❌ Sesi lyrics tidak cocok dengan server ini.',
            flags: MessageFlags.Ephemeral,
          });
        }

        if (action === 'close') {
          lyricsSessions.delete(sessionId);
          return interaction.update({
            embeds: [makeEmbed('📃 Lyrics', 'Panel lyrics ditutup.')],
            components: [],
          });
        }

        const maxPage = Math.max(0, (session.pages ? session.pages.length : 1) - 1);
        let currentPage = Math.max(0, Math.min(maxPage, Number(session.page) || 0));

        if (action === 'next') currentPage += 1;
        if (action === 'prev') currentPage -= 1;

        currentPage = Math.max(0, Math.min(maxPage, currentPage));
        session.page = currentPage;
        session.updatedAt = Date.now();

        return interaction.update({
          embeds: [makeLyricsPageEmbed(session, currentPage)],
          components: session.pages && session.pages.length > 1
            ? [makeLyricsNavigationRow(sessionId, currentPage, session.pages.length)]
            : [],
        });
      } catch (err) {
        console.error('[bot] Lyrics navigation error:', err && err.message ? err.message : err);
        return interaction.reply({
          content: '❌ Gagal memproses navigasi lyrics.',
          flags: MessageFlags.Ephemeral,
        }).catch(() => {});
      }
    }

    // Helper: ensure user in voice for buttons too
    const memberVC = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
    if (!memberVC) return interaction.reply({ content: '❌ You must be in a voice channel to use buttons!', flags: MessageFlags.Ephemeral });

    const buttonActionMap = {
      player_pause_resume: 'pause',
      player_skip: 'skip',
      player_stop: 'stop',
      player_vol_up: 'volume',
      player_vol_down: 'volume',
      player_loop: 'loop',
      player_shuffle: 'shuffle',
      player_autoplay: 'autoplay',
      player_lyrics: 'lyrics',
      player_queue: 'queue',
    };

    const btnAction = buttonActionMap[customId];
    if (btnAction) {
      const remain = getCooldownRemainingMs(
        interaction.user.id,
        guildId,
        `btn:${btnAction}`,
        COMMAND_COOLDOWN_MS.button
      );
      if (remain > 0) {
        return interaction.reply({ content: makeCooldownNotice(remain, 'menggunakan tombol ini'), flags: MessageFlags.Ephemeral });
      }
    }

    try {
      if (customId === 'player_pause_resume') {
        // Use player API to reliably detect and toggle pause state
        try {
          const nowPaused = player.togglePause(guildId);
          if (nowPaused) {
            await interaction.reply({ content: '⏸️ Paused', flags: MessageFlags.Ephemeral });
          } else {
            await interaction.reply({ content: '▶️ Resumed', flags: MessageFlags.Ephemeral });
          }
        } catch (e) {
          console.error('[bot] pause/resume button failed:', e && e.message ? e.message : e);
          await interaction.reply({ content: '❌ Failed to toggle pause/resume', flags: MessageFlags.Ephemeral });
        }
        return;
      } else if (customId === 'player_skip') {
        player.skip(guildId);
        await interaction.reply({ content: '⏭️ Skipped', flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_stop') {
        player.stop(guildId);
        await interaction.reply({ content: '⏹️ Stopped', flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_vol_up') {
        const current = player.getVolume(guildId);
        const next = player.setVolume(guildId, current + 10);
        await interaction.reply({ content: `🔊 Volume: **${next}%**`, flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_vol_down') {
        const current = player.getVolume(guildId);
        const next = player.setVolume(guildId, current - 10);
        await interaction.reply({ content: `🔉 Volume: **${next}%**`, flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_loop') {
        const q = player.getQueue(guildId);
        const modes = ['none', 'track', 'queue'];
        const nextMode = modes[(modes.indexOf(q.loopMode) + 1) % modes.length];
        player.setLoopMode(guildId, nextMode);
        await interaction.reply({ content: `🔄 Loop Mode: **${nextMode}**`, flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_shuffle') {
        const newState = player.toggleShuffle(guildId);
        await interaction.reply({ content: newState ? '🔀 Shuffle: **ON**' : '🔀 Shuffle: **OFF**', flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_autoplay') {
        const newState = player.toggleAutoplay(guildId);
        await interaction.reply({ content: newState ? '♾️ Autoplay: **ON**' : '♾️ Autoplay: **OFF**', flags: MessageFlags.Ephemeral });
      } else if (customId === 'player_lyrics') {
        const q = player.getQueue(guildId);
        if (!q.playing) return interaction.reply({ content: '❌ Tidak ada lagu yang sedang diputar.', flags: MessageFlags.Ephemeral });
        
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const result = await getTrackLyricsStrict(q.playing);
        if (!result.ok) {
          return interaction.editReply({ embeds: [makeEmbed('📃 Lyrics', result.reason)] });
        }

        const payload = makeLyricsResultMessage(q.playing, result, interaction.user.id, guildId);
        await interaction.editReply(payload);
      } else if (customId === 'player_queue') {
        await interaction.reply({ embeds: [makeQueueOverviewEmbed(guildId, 10)], flags: MessageFlags.Ephemeral });
      }
    } catch (err) {
      console.error('[bot] Button interaction error:', err);
      await interaction.reply({ content: '❌ Error: ' + (err.message || String(err)), flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return;
  }

  // ── Autocomplete ────────────────────────────────────────────────────────────
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'play') {
      const query = String(interaction.options.getFocused() || '').trim();
      if (!query || query.length < 2) {
        return interaction.respond([{ name: 'Ketik minimal 2 huruf...', value: 'none' }]).catch(() => {});
      }

      const manualChoice = {
        name: `Cari: ${query}`.substring(0, 100),
        value: query.substring(0, 100),
      };

      try {
        const tracks = await playShim.search(query, { limit: 8, timeoutMs: 2800 });
        const choices = (Array.isArray(tracks) ? tracks : []).slice(0, 5).map((item) => ({
          name: `${item && item.title ? item.title : 'Unknown'}${item && item.author ? ` — ${item.author}` : ''}`.substring(0, 100),
          value: String((item && (item.url || item.title)) || 'none').substring(0, 100),
        }));

        const payload = choices.length ? choices : [manualChoice];
        await interaction.respond(payload.slice(0, 25)).catch(() => {});
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg !== 'timeout') console.error('[bot] Autocomplete error:', msg);
        await interaction.respond([manualChoice]).catch(() => {});
      }
    }
    return;
  }

  // ── Chat input (slash) commands ─────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  const slashCooldownKeyMap = {
    play: 'play',
    skip: 'skip',
    stop: 'stop',
    pause: 'pause',
    resume: 'resume',
    queue: 'queue',
    np: 'np',
    radio: 'radio',
    autoplay: 'autoplay',
    lyrics: 'lyrics',
    volume: 'volume',
    preset: 'preset',
    help: 'help',
    health: 'health',
  };

  const slashCooldownKey = slashCooldownKeyMap[commandName];
  if (slashCooldownKey) {
    const cooldownMs = COMMAND_COOLDOWN_MS[slashCooldownKey] || 900;
    const remain = getCooldownRemainingMs(
      interaction.user.id,
      interaction.guildId,
      `slash:${slashCooldownKey}`,
      cooldownMs
    );
    if (remain > 0) {
      return interaction.reply({
        content: makeCooldownNotice(remain, `menjalankan /${commandName}`),
        flags: MessageFlags.Ephemeral,
      });
    }
  }

  // Helper: ensure the user is in a voice channel
  const ensureMemberVC = () => {
    const vc = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
    if (!vc) throw new Error('You must be in a voice channel to use this command.');
    return vc;
  };

  try {
    // /play
    if (commandName === 'play') {
      const queryOpt = (interaction.options.getString('query', false) || '').trim();
      const linkOpt  = (interaction.options.getString('link', false) || '').trim();
      const query    = linkOpt || queryOpt;

      if (!query) {
        return interaction.reply({
          embeds: [makeEmbed('❌ Error', 'Isi salah satu: `query` atau `link`.')],
          flags: MessageFlags.Ephemeral,
        });
      }

      const memberVC = ensureMemberVC();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await player.join(memberVC);

      const queueBefore = player.getQueue(interaction.guildId);
      const willPlayNow = !queueBefore.playing && queueBefore.queue.length === 0;

      // Spotify
      const { handled } = await handleSpotify(
        query, interaction.guildId, interaction.channelId, interaction.user.tag,
        (payload) => interaction.editReply(payload)
      );
      if (handled) return;

      // Direct YouTube URL (music-only)
      if (isYouTubeUrl(query)) {
        const check = await validateYouTubeMusicLink(query);
        if (!check.ok) {
          return interaction.editReply({ embeds: [makeEmbed('❌ YouTube Music Only', check.reason)] });
        }
        await player.enqueue(interaction.guildId, {
          title: check.normalizedUrl,
          url: check.normalizedUrl,
          requestedBy: interaction.user.tag,
          textChannelId: interaction.channelId,
        });
        if (willPlayNow) {
          return interaction.editReply({ embeds: [makeEmbed('▶️ Playing', `Now playing: ${check.normalizedUrl}`)] });
        }
        return interaction.editReply({ embeds: [makeEmbed('✅ Queued', `Added link: ${check.normalizedUrl}`)] }); // ephemeral already set via deferReply
      }

      // Direct SoundCloud URL
      if (isSoundCloudUrl(query)) {
        await player.enqueue(interaction.guildId, { title: query, url: query, requestedBy: interaction.user.tag, textChannelId: interaction.channelId });
        if (willPlayNow) {
          return interaction.editReply({ embeds: [makeEmbed('▶️ Playing', `Now playing: ${query}`)] });
        }
        return interaction.editReply({ embeds: [makeEmbed('✅ Queued', `Added link: ${query}`)] }); // ephemeral already set via deferReply
      }

      // Search query
      await player.enqueue(interaction.guildId, { title: query, search: query, requestedBy: interaction.user.tag, textChannelId: interaction.channelId });
      if (willPlayNow) {
        return interaction.editReply({ embeds: [makeEmbed('▶️ Playing', `Playing search result for: **${query}**`)] });
      }
      return interaction.editReply({ embeds: [makeEmbed('🔍 Queued', `Queued search: **${query}**`)] });
    }

    // /skip
    if (commandName === 'skip') {
      player.skip(interaction.guildId);
      return interaction.reply({ embeds: [makeEmbed('⏭ Skip', 'Skipped current track.')], flags: MessageFlags.Ephemeral });
    }

    // /stop
    if (commandName === 'stop') {
      const stay = player.getStay24h(interaction.guildId);
      player.stop(interaction.guildId, { keepConnection: stay });
      return interaction.reply({ embeds: [makeEmbed('⏹ Stop', 'Stopped playback and cleared the queue.')], flags: MessageFlags.Ephemeral });
    }

    // /pause
    if (commandName === 'pause') {
      player.pause(interaction.guildId);
      return interaction.reply({ embeds: [makeEmbed('⏸ Pause', 'Paused playback.')], flags: MessageFlags.Ephemeral });
    }

    // /resume
    if (commandName === 'resume') {
      player.resume(interaction.guildId);
      return interaction.reply({ embeds: [makeEmbed('▶ Resume', 'Resumed playback.')], flags: MessageFlags.Ephemeral });
    }

    // /queue
    if (commandName === 'queue') {
      return interaction.reply({ embeds: [makeQueueOverviewEmbed(interaction.guildId, 20)], flags: MessageFlags.Ephemeral });
    }

    // /np
    if (commandName === 'np') {
      return interaction.reply({ embeds: [makeNowPlayingInfoEmbed(interaction.guildId)], flags: MessageFlags.Ephemeral });
    }

    // /radio
    if (commandName === 'radio') {
      const station = interaction.options.getString('station', true);
      const memberVC = ensureMemberVC();

      if (station === 'stop') {
        player.setRadio(interaction.guildId, false, null);
        return interaction.reply({ embeds: [makeEmbed('📻 Radio', 'Radio mode **OFF**.')], flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await player.join(memberVC);
      player.setRadio(interaction.guildId, true, station);
      
      const stationName = RADIO_STATIONS.find(s => s.value === station)?.name || station;
      const found = await player.searchTrack(station, []);
      if (found) {
        await player.enqueue(interaction.guildId, { title: found.title, url: found.url, requestedBy: interaction.user.tag, textChannelId: interaction.channelId });
      }
      return interaction.editReply({ embeds: [makeEmbed('📻 Radio ON', `Menghubungkan ke: **${stationName}**`)] });
    }

    // /247
    if (commandName === '247') {
      const newState = !player.getStay24h(interaction.guildId);
      player.setStay24h(interaction.guildId, newState);
      return interaction.reply({ embeds: [makeEmbed('♾ 24/7', newState ? 'Mode 24/7 **aktif** — bot tetap di channel.' : 'Mode 24/7 **dimatikan**.')], flags: MessageFlags.Ephemeral });
    }

    // /leave
    if (commandName === 'leave') {
      player.setStay24h(interaction.guildId, false);
      player.stop(interaction.guildId, { forceLeave: true });
      return interaction.reply({ embeds: [makeEmbed('👋 Leave', 'Left voice channel and disabled 24/7 mode.')], flags: MessageFlags.Ephemeral });
    }

    // /autoplay
    if (commandName === 'autoplay') {
      const newState = player.toggleAutoplay(interaction.guildId);
      return interaction.reply({ embeds: [makeEmbed('♾️ Autoplay', newState ? 'Autoplay **aktif** — bot akan memutar rekomendasi lagu.' : 'Autoplay **dimatikan**.')], flags: MessageFlags.Ephemeral });
    }

    // /lyrics
    if (commandName === 'lyrics') {
      const q = player.getQueue(interaction.guildId);
      if (!q.playing) return interaction.reply({ content: '❌ Tidak ada lagu yang sedang diputar.', flags: MessageFlags.Ephemeral });
      
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      const result = await getTrackLyricsStrict(q.playing);
      if (!result.ok) {
        return interaction.editReply({ embeds: [makeEmbed('📃 Lyrics', result.reason)] });
      }

      const payload = makeLyricsResultMessage(q.playing, result, interaction.user.id, interaction.guildId);
      return interaction.editReply(payload);
    }

    // /volume
    if (commandName === 'volume') {
      const level = interaction.options.getInteger('level', true);
      const memberVC = ensureMemberVC();
      // Ensure bot is in same VC
      const botVC = interaction.guild.members.me.voice.channel;
      if (botVC && memberVC.id !== botVC.id) {
        return interaction.reply({ content: '❌ Kamu harus berada di voice channel yang sama dengan bot!', flags: MessageFlags.Ephemeral });
      }

      const next = player.setVolume(interaction.guildId, level);
      return interaction.reply({ embeds: [makeEmbed('🔊 Volume', `Volume diatur ke **${next}%**`)], flags: MessageFlags.Ephemeral });
    }

    // /preset
    if (commandName === 'preset') {
      const mode = interaction.options.getString('mode', true);
      if (!AUDIO_PRESET_VALUE_SET.has(String(mode))) {
        return interaction.reply({
          embeds: [makeEmbed('❌ Preset Tidak Valid', `Mode tidak dikenali.\n\n${getAudioPresetListText()}`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      const memberVC = ensureMemberVC();
      const botVC = interaction.guild.members.me.voice.channel;
      if (botVC && memberVC.id !== botVC.id) {
        return interaction.reply({ content: '❌ Kamu harus berada di voice channel yang sama dengan bot!', flags: MessageFlags.Ephemeral });
      }

      const applied = player.setAudioPreset(interaction.guildId, mode);
      const label = formatAudioPresetLabel(applied);
      const q = player.getQueue(interaction.guildId);
      if (q.playing) player.applyAudioPresetNow(interaction.guildId);
      return interaction.reply({
        embeds: [makeEmbed('🎛 Audio Preset', `Preset aktif: **${label}** (\`${applied}\`)`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // /health
    if (commandName === 'health') {
      return interaction.reply({ embeds: [makeHealthEmbed(interaction.guildId)], flags: MessageFlags.Ephemeral });
    }

    // /help
    if (commandName === 'help') {
      const lines = [
        '`/play query:<judul> atau link:<url>` — Play from YouTube Music/SoundCloud/Spotify',
        '`/skip` — Skip current track',
        '`/stop` — Stop and clear queue',
        '`/pause` / `/resume` — Pause / resume',
        '`/queue` — Show queue',
        '`/np` — Show now playing',
        '`/radio` — Pilih stasiun radio genre',
        '`/autoplay` — Toggle autoplay (related songs)',
        '`/volume <0-100>` — Set bot volume',
        '`/preset <mode>` — Set audio preset/EQ',
        '`/health` — Show bot diagnostics',
        '`/247` — Toggle 24/7 stay mode',
        '`/leave` — Leave voice channel',
        '',
        'Prefix commands: all above also available as `!play`, `!skip`, etc.',
      ];
      return interaction.reply({ embeds: [makeEmbed('📖 Help', lines.join('\n'))], flags: MessageFlags.Ephemeral });
    }

  } catch (err) {
    const msg = '❌ ' + (err && err.message ? err.message : 'An unexpected error occurred.');
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply({ content: msg }).catch(() => {});
    } else {
      await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
    }
  }
});

// ── Prefix command handler ────────────────────────────────────────────────────

client.on('messageCreate', async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.content.startsWith(PREFIX)) return;
    if (!message.guild) return;

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();

    /** Quick reply helper */
    const reply = (payload) => message.reply(payload).catch(() => {});

    const prefixCooldownKeyMap = {
      play: 'play',
      skip: 'skip',
      stop: 'stop',
      pause: 'pause',
      resume: 'resume',
      queue: 'queue',
      np: 'np',
      nowplaying: 'np',
      radio: 'radio',
      autoplay: 'autoplay',
      ap: 'autoplay',
      lyrics: 'lyrics',
      ly: 'lyrics',
      volume: 'volume',
      vol: 'volume',
      preset: 'preset',
      eq: 'preset',
      health: 'health',
      help: 'help',
      commands: 'help',
    };

    const prefixCooldownKey = prefixCooldownKeyMap[cmd];
    if (prefixCooldownKey) {
      const cooldownMs = COMMAND_COOLDOWN_MS[prefixCooldownKey] || 900;
      const remain = getCooldownRemainingMs(
        message.author.id,
        message.guild.id,
        `prefix:${prefixCooldownKey}`,
        cooldownMs
      );

      if (remain > 0) {
        return reply({ embeds: [makeEmbed('⏳ Cooldown', makeCooldownNotice(remain, `menggunakan ${PREFIX}${cmd}`))] });
      }
    }

    // ── !play ──────────────────────────────────────────────────────────────────
    if (cmd === 'play') {
      const query = args.join(' ');
      if (!query) return reply({ embeds: [makeEmbed('❌ Error', 'Please provide a song name or link.')] });

      const memberVC = message.member && message.member.voice ? message.member.voice.channel : null;
      if (!memberVC) return reply({ embeds: [makeEmbed('❌ Error', 'You must be in a voice channel.')] });

      await player.join(memberVC);
      const searching = await reply({ content: '🔍 Searching...' });
      const edit      = (payload) => searching ? searching.edit(payload).catch(() => {}) : Promise.resolve();

      const queueBefore = player.getQueue(message.guild.id);
      const willPlayNow = !queueBefore.playing && queueBefore.queue.length === 0;

      // Spotify
      const { handled } = await handleSpotify(
        query, message.guild.id, message.channel.id, message.author.tag, edit
      );
      if (handled) return;

      // Direct YouTube URL (music-only)
      if (isYouTubeUrl(query)) {
        const check = await validateYouTubeMusicLink(query);
        if (!check.ok) {
          return edit({ embeds: [makeEmbed('❌ YouTube Music Only', check.reason)] });
        }
        await player.enqueue(message.guild.id, {
          title: check.normalizedUrl,
          url: check.normalizedUrl,
          requestedBy: message.author.tag,
          textChannelId: message.channel.id,
        });
        if (willPlayNow) {
          return edit({ embeds: [makeEmbed('▶️ Playing', `Now playing: ${check.normalizedUrl}`)] });
        }
        return edit({ embeds: [makeEmbed('✅ Queued', `Added link: ${check.normalizedUrl}`)] });
      }

      // Direct SoundCloud URL
      if (isSoundCloudUrl(query)) {
        await player.enqueue(message.guild.id, { title: query, url: query, requestedBy: message.author.tag, textChannelId: message.channel.id });
        if (willPlayNow) {
          return edit({ embeds: [makeEmbed('▶️ Playing', `Now playing: ${query}`)] });
        }
        return edit({ embeds: [makeEmbed('✅ Queued', `Added link: ${query}`)] });
      }

      // Search
      await player.enqueue(message.guild.id, { title: query, search: query, requestedBy: message.author.tag, textChannelId: message.channel.id });
      if (willPlayNow) {
        return edit({ embeds: [makeEmbed('▶️ Playing', `Playing search result for: **${query}**`)] });
      }
      return edit({ embeds: [makeEmbed('🔍 Queued', `Queued: **${query}**`)] });
    }

    // ── !skip ──────────────────────────────────────────────────────────────────
    if (cmd === 'skip') {
      player.skip(message.guild.id);
      return reply({ embeds: [makeEmbed('⏭ Skip', 'Skipped current track.')] });
    }

    // ── !stop ──────────────────────────────────────────────────────────────────
    if (cmd === 'stop') {
      const stay = player.getStay24h(message.guild.id);
      player.stop(message.guild.id, { keepConnection: stay });
      return reply({ embeds: [makeEmbed('⏹ Stop', 'Stopped playback and cleared the queue.')] });
    }

    // ── !pause ─────────────────────────────────────────────────────────────────
    if (cmd === 'pause') {
      player.pause(message.guild.id);
      return reply({ embeds: [makeEmbed('⏸ Pause', 'Paused playback.')] });
    }

    // ── !resume ────────────────────────────────────────────────────────────────
    if (cmd === 'resume') {
      player.resume(message.guild.id);
      return reply({ embeds: [makeEmbed('▶ Resume', 'Resumed playback.')] });
    }

    // ── !queue ─────────────────────────────────────────────────────────────────
    if (cmd === 'queue') {
      return reply({ embeds: [makeQueueOverviewEmbed(message.guild.id, 20)] });
    }

    // ── !nowplaying / !np ──────────────────────────────────────────────────────
    if (cmd === 'nowplaying' || cmd === 'np') {
      return reply({ embeds: [makeNowPlayingInfoEmbed(message.guild.id)] });
    }

    // ── !radio ─────────────────────────────────────────────────────────────────
    if (cmd === 'radio') {
      const sub = args.join(' ').trim().toLowerCase();
      if (sub === 'stop') {
        player.setRadio(message.guild.id, false, null);
        return reply({ embeds: [makeEmbed('📻 Radio', 'Radio mode **OFF**.')] });
      }
      
      // If no args, show stations
      if (!sub) {
        const list = RADIO_STATIONS.map((s, i) => `\`${i + 1}.\` ${s.name}`).join('\n');
        return reply({ embeds: [makeEmbed('📻 Radio Stations', `Pilih stasiun: \`!radio <nomor>\`\n\n${list}`)] });
      }

      const index = parseInt(sub) - 1;
      const station = RADIO_STATIONS[index] ? RADIO_STATIONS[index].value : sub;

      const memberVC = message.member && message.member.voice ? message.member.voice.channel : null;
      if (!memberVC) return reply({ embeds: [makeEmbed('❌ Error', 'You must be in a voice channel to start radio.')] });

      await player.join(memberVC);
      player.setRadio(message.guild.id, true, station);
      const found = await player.searchTrack(station, []);
      if (found) {
        await player.enqueue(message.guild.id, { title: found.title, url: found.url, requestedBy: message.author.tag, textChannelId: message.channel.id });
      }
      return reply({ embeds: [makeEmbed('📻 Radio ON', `Memutar stasiun radio...`)] });
    }

    // ── !247 ───────────────────────────────────────────────────────────────────
    if (cmd === '247') {
      const newState = !player.getStay24h(message.guild.id);
      player.setStay24h(message.guild.id, newState);
      if (newState) {
        const memberVC = message.member && message.member.voice ? message.member.voice.channel : null;
        if (memberVC) await player.join(memberVC).catch(() => {});
      }
      return reply({ embeds: [makeEmbed('♾ 24/7', newState ? 'Mode 24/7 **aktif**.' : 'Mode 24/7 **dimatikan**.')] });
    }

    // ── !leave ─────────────────────────────────────────────────────────────────
    if (cmd === 'leave') {
      player.setStay24h(message.guild.id, false);
      player.stop(message.guild.id, { forceLeave: true });
      return reply({ embeds: [makeEmbed('👋 Leave', 'Left voice channel and disabled 24/7 mode.')] });
    }

    // ── !autoplay ─────────────────────────────────────────────────────────────
    if (cmd === 'autoplay' || cmd === 'ap') {
      const newState = player.toggleAutoplay(message.guild.id);
      return reply({ embeds: [makeEmbed('♾️ Autoplay', newState ? 'Autoplay **AKTIF**.' : 'Autoplay **OFF**.')] });
    }

    // ── !lyrics ───────────────────────────────────────────────────────────────
    if (cmd === 'lyrics' || cmd === 'ly') {
      const q = player.getQueue(message.guild.id);
      if (!q.playing) return reply({ embeds: [makeEmbed('❌ Error', 'Tidak ada lagu yang sedang diputar.')] });
      
      const wait = await reply({ content: '🔍 Mencari lirik...' });
      const result = await getTrackLyricsStrict(q.playing);
      if (!result.ok) {
        const failEmbed = makeEmbed('📃 Lyrics', result.reason);
        return wait ? wait.edit({ content: null, embeds: [failEmbed] }) : reply({ embeds: [failEmbed] });
      }

      const payload = makeLyricsResultMessage(q.playing, result, message.author.id, message.guild.id);
      return wait ? wait.edit({ content: null, ...payload }) : reply(payload);
    }

    // ── !volume ───────────────────────────────────────────────────────────────
    if (cmd === 'volume' || cmd === 'vol') {
      const level = parseInt(args[0]);
      if (isNaN(level) || level < 0 || level > 100) {
        return reply({ embeds: [makeEmbed('❌ Error', 'Gunakan: `!volume <0-100>`')] });
      }
      const next = player.setVolume(message.guild.id, level);
      return reply({ embeds: [makeEmbed('🔊 Volume', `Volume diatur ke **${next}%**`)] });
    }

    // ── !preset / !eq ───────────────────────────────────────────────────────
    if (cmd === 'preset' || cmd === 'eq') {
      const mode = String(args[0] || '').trim().toLowerCase();
      if (!mode) {
        return reply({
          embeds: [makeEmbed('🎛 Audio Preset', `Gunakan: \`!preset <mode>\`\n\nPreset tersedia:\n${getAudioPresetListText()}`)],
        });
      }

      if (!AUDIO_PRESET_VALUE_SET.has(mode)) {
        return reply({
          embeds: [makeEmbed('❌ Preset Tidak Valid', `Mode \`${mode}\` tidak dikenali.\n\nPreset tersedia:\n${getAudioPresetListText()}`)],
        });
      }

      const applied = player.setAudioPreset(message.guild.id, mode);
      const label = formatAudioPresetLabel(applied);
      const q = player.getQueue(message.guild.id);
      if (q.playing) player.applyAudioPresetNow(message.guild.id);

      return reply({
        embeds: [makeEmbed('🎛 Audio Preset', `Preset aktif: **${label}** (\`${applied}\`)`)],
      });
    }

    // ── !health ───────────────────────────────────────────────────────────────
    if (cmd === 'health') {
      return reply({ embeds: [makeHealthEmbed(message.guild.id)] });
    }

    // ── !help ──────────────────────────────────────────────────────────────────
    if (cmd === 'help' || cmd === 'commands') {
      const lines = [
        '`!play <query|url>` — Play from YouTube Music/SoundCloud/Spotify',
        '`!skip` — Skip current track',
        '`!stop` — Stop and clear queue',
        '`!pause` / `!resume` — Pause / resume',
        '`!queue` — Show queue',
        '`!nowplaying` / `!np` — Show now playing',
        '`!radio <keyword>` — Start radio autoplay',
        '`!radio stop` — Stop radio',
        '`!autoplay` — Toggle autoplay mode',
        '`!volume <0-100>` — Set bot volume',
        '`!preset <mode>` / `!eq <mode>` — Set audio preset',
        '`!health` — Show bot diagnostics',
        '`!247` — Toggle 24/7 stay mode',
        '`!leave` — Leave voice channel',
        '`!help` — Show this list',
      ];
      return reply({ embeds: [makeEmbed('📖 Help', lines.join('\n'))] });
    }

  } catch (err) {
    console.error('[bot] Command handler error:', err && err.message ? err.message : err);
    message.reply({ embeds: [makeEmbed('❌ Error', 'An unexpected error occurred.')] }).catch(() => {});
  }
});

function flushPlayerState(reason) {
  try {
    player.flushPersistenceNow();
    console.log(`[bot] Player state flushed (${reason}).`);
  } catch (err) {
    console.warn('[bot] Failed to flush player state:', err && err.message ? err.message : err);
  }
}

process.on('SIGINT', () => {
  flushPlayerState('SIGINT');
  process.exit(0);
});

process.on('SIGTERM', () => {
  flushPlayerState('SIGTERM');
  process.exit(0);
});

process.on('beforeExit', () => {
  flushPlayerState('beforeExit');
});

// ── Login ─────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
  console.error('[bot] DISCORD_TOKEN is not set in .env — please fill in your token.');
  process.exit(1);
}

client.login(token).catch(err => {
  console.error('[bot] Failed to login:', err && err.message ? err.message : err);
  process.exit(1);
});
