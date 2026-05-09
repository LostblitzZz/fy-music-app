// Credit by Raitzu
'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');

const INSTANCE_LOCK_FILE = path.join(process.cwd(), 'data', 'bot-instance.lock.json');
let instanceLockHeld = false;

function isProcessAlive(pid) {
  const id = Number(pid);
  if (!Number.isInteger(id) || id <= 0) return false;

  try {
    process.kill(id, 0);
    return true;
  } catch (err) {
    return false;
  }
}

function acquireInstanceLock() {
  try {
    fs.mkdirSync(path.dirname(INSTANCE_LOCK_FILE), { recursive: true });

    if (fs.existsSync(INSTANCE_LOCK_FILE)) {
      try {
        const raw = fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8');
        const existing = raw ? JSON.parse(raw) : null;
        const runningPid = existing && Number(existing.pid);

        if (
          Number.isInteger(runningPid) &&
          runningPid > 0 &&
          runningPid !== process.pid &&
          isProcessAlive(runningPid)
        ) {
          console.error(`[bot] Another Fy Music instance is already running (PID ${runningPid}). Stop it before starting a new one.`);
          process.exit(1);
        }
      } catch (e) {
        // Corrupted/stale lock is safe to replace.
      }
    }

    const payload = {
      pid: process.pid,
      startedAt: Date.now(),
      cwd: process.cwd(),
    };
    fs.writeFileSync(INSTANCE_LOCK_FILE, JSON.stringify(payload, null, 2), 'utf8');
    instanceLockHeld = true;
  } catch (err) {
    console.warn('[bot] Failed to create instance lock:', err && err.message ? err.message : err);
  }
}

function releaseInstanceLock() {
  if (!instanceLockHeld) return;

  try {
    if (fs.existsSync(INSTANCE_LOCK_FILE)) {
      try {
        const raw = fs.readFileSync(INSTANCE_LOCK_FILE, 'utf8');
        const data = raw ? JSON.parse(raw) : null;
        const lockPid = data && Number(data.pid);

        if (!Number.isInteger(lockPid) || lockPid === process.pid) {
          fs.unlinkSync(INSTANCE_LOCK_FILE);
        }
      } catch (e) {
        try { fs.unlinkSync(INSTANCE_LOCK_FILE); } catch (e2) {}
      }
    }
  } catch (err) {
    console.warn('[bot] Failed to release instance lock:', err && err.message ? err.message : err);
  } finally {
    instanceLockHeld = false;
  }
}

acquireInstanceLock();

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
  MessageFlags,
  REST,
  Routes,
  Partials,
} = require('discord.js');

const MusicPlayer = require('./player');
const playShim    = require('./playdl-shim');
const lyricsFinderLib = require('lyrics-finder');

// ── Utility modules ───────────────────────────────────────────────────────────
const { formatCooldownSeconds, clampText, makeCooldownNotice } = require('./utils/helpers');
const { makeEmbed, makePremiumEmbed, makeQueueOverviewEmbed, makeNowPlayingInfoEmbed, makeHealthEmbed, formatAudioPresetLabel, getAudioPresetListText } = require('./utils/embeds');
const lyricsEngine = require('./utils/lyrics');
const spotifyUtil = require('./utils/spotify');
const { checkVoicePermissions } = require('./utils/permissions');

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

// Initialize lyrics engine
lyricsEngine.init({ geniusClient, lyricsFinder: lyricsFinderLib, spotifyFetch });

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
  // Initialize spotify util module
  spotifyUtil.init({ spotifyClient, spotifyFetch });
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
const OWNER_IDS = String(process.env.OWNER_IDS || process.env.OWNER_ID || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildVoiceStates,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,  // Required to read message content for prefix commands
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const player = new MusicPlayer();
const activeMessages = new Map(); // guildId -> { messageId, channelId, interval, lastTrackUrl }
const commandCooldowns = new Map();
const autocompleteCache = new Map(); // url -> { title, author, duration, thumbnail, savedAt }
const voiceStatusChannels = new Map(); // guildId -> channelId
const userInputLog = [];

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
  monitor: 10000,
  userinput: 4000,
  dmleave: 2000,
};

const AUTOCOMPLETE_CACHE_TTL_MS = 4 * 60 * 1000;
const AUTOCOMPLETE_CACHE_MAX = 300;
const USER_INPUT_LOG_MAX = 200;

const STATIC_ACTIVITY_LABEL = String(process.env.STATIC_ACTIVITY || 'Musik');

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

function cacheAutocompleteItem(item) {
  if (!item || !item.url) return;
  const url = String(item.url || '').trim();
  if (!url) return;
  autocompleteCache.set(url, {
    url,
    title: item.title || '',
    author: item.author || '',
    duration: Number(item.duration) || 0,
    thumbnail: item.thumbnail || '',
    savedAt: Date.now(),
  });

  if (autocompleteCache.size > AUTOCOMPLETE_CACHE_MAX) {
    const entries = Array.from(autocompleteCache.entries());
    entries.sort((a, b) => (a[1].savedAt || 0) - (b[1].savedAt || 0));
    const removeCount = Math.max(0, autocompleteCache.size - AUTOCOMPLETE_CACHE_MAX);
    for (let i = 0; i < removeCount; i++) {
      const key = entries[i] && entries[i][0];
      if (key) autocompleteCache.delete(key);
    }
  }
}

function getCachedAutocomplete(url) {
  if (!url) return null;
  const key = String(url || '').trim();
  if (!key) return null;
  const cached = autocompleteCache.get(key);
  if (!cached) return null;
  if (Date.now() - (cached.savedAt || 0) > AUTOCOMPLETE_CACHE_TTL_MS) {
    autocompleteCache.delete(key);
    return null;
  }
  return cached;
}

function applyStaticPresence() {
  if (!client || !client.user) return;
  try {
    client.user.setActivity(STATIC_ACTIVITY_LABEL, { type: 2 });
  } catch (e) {}
}

function formatGuildLabel(guildId) {
  if (!guildId) return 'unknown guild';
  const guild = client && client.guilds && client.guilds.cache
    ? client.guilds.cache.get(guildId)
    : null;
  if (!guild) return `${guildId} (unknown guild)`;
  return `${guild.name} (${guild.id})`;
}

function isOwner(userId) {
  if (!userId || OWNER_IDS.length === 0) return false;
  return OWNER_IDS.includes(String(userId));
}

function logUserInput({ userId, userTag, guildId, command, input }) {
  const entry = {
    at: Date.now(),
    userId: String(userId || '').trim(),
    userTag: String(userTag || '').trim(),
    guildId: guildId ? String(guildId) : null,
    command: String(command || '').trim(),
    input: String(input || '').trim(),
  };

  if (!entry.userId || !entry.command || !entry.input) return;

  userInputLog.push(entry);
  if (userInputLog.length > USER_INPUT_LOG_MAX) {
    userInputLog.splice(0, userInputLog.length - USER_INPUT_LOG_MAX);
  }
}

function buildUserInputLines(limit) {
  if (userInputLog.length === 0) return [];

  const safeLimit = Math.max(1, Math.min(50, Number(limit) || 20));
  const items = userInputLog.slice(-safeLimit).reverse();
  const lines = [`🧾 User input terakhir (${items.length}/${userInputLog.length})`];

  items.forEach((entry, idx) => {
    const ts = new Date(entry.at).toISOString().replace('T', ' ').replace('Z', '');
    const guildLabel = entry.guildId ? formatGuildLabel(entry.guildId) : 'DM';
    const userLabel = entry.userTag ? `${entry.userTag} (${entry.userId})` : entry.userId;
    const inputText = clampText(entry.input || '-', 120);
    lines.push(`${idx + 1}) ${ts} | ${guildLabel} | ${userLabel} | ${entry.command}: ${inputText}`);
  });

  return lines;
}

async function clearVoiceStatus(guildId, { retry = true, channelId: overrideChannelId } = {}) {
  const guild = client.guilds.cache.get(guildId);
  const currentChannelId = guild && guild.members && guild.members.me
    ? (guild.members.me.voice && guild.members.me.voice.channelId)
    : null;
  const channelId = overrideChannelId || currentChannelId || voiceStatusChannels.get(guildId);
  if (!channelId) return;

  const tryClear = async () => {
    const channel = guild && guild.members && guild.members.me && guild.members.me.voice
      ? guild.members.me.voice.channel
      : null;
    if (channel && typeof channel.setVoiceStatus === 'function') {
      try { await channel.setVoiceStatus(null); } catch (e) {}
      try { await channel.setVoiceStatus(''); } catch (e) {}
    } else {
      try { await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: null } }); } catch (e) {}
      try { await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: '' } }); } catch (e) {}
    }
  };

  await tryClear();
  if (retry) {
    setTimeout(() => { void tryClear(); }, 700);
    setTimeout(() => { void tryClear(); }, 2200);
  }

  if (voiceStatusChannels.get(guildId) === channelId) {
    voiceStatusChannels.delete(guildId);
  }
}

function formatVoiceMemberStatus(member) {
  const voice = member && member.voice ? member.voice : null;
  if (!voice) return '';

  const flags = [];
  if (voice.selfMute || voice.mute) flags.push('Muted');
  if (voice.selfDeaf || voice.deaf) flags.push('Deafened');
  if (voice.streaming) flags.push('Streaming');
  if (voice.selfVideo) flags.push('Video');

  if (flags.length === 0) return '';
  return ` [${flags.join(', ')}]`;
}

function splitLinesToChunks(lines, maxLen) {
  const chunks = [];
  let current = '';

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = '';
    }
  };

  for (const raw of lines) {
    const line = String(raw || '');
    if (!line) continue;

    if (line.length > maxLen) {
      flush();
      let cursor = 0;
      while (cursor < line.length) {
        chunks.push(line.slice(cursor, cursor + maxLen));
        cursor += maxLen;
      }
      continue;
    }

    if (current.length + line.length + 1 > maxLen) {
      flush();
    }

    current = current ? `${current}\n${line}` : line;
  }

  flush();
  return chunks;
}

async function buildVoiceReportForGuild(guild) {
  if (!guild) return { hasMembers: false, lines: [] };

  let channels;
  try {
    try { await guild.voiceStates.fetch(); } catch (e) {}
    channels = await guild.channels.fetch();
  } catch (err) {
    console.warn('[bot] Failed to fetch channels for', formatGuildLabel(guild.id), err && err.message ? err.message : err);
    return { hasMembers: false, lines: [] };
  }

  const voiceChannels = Array.from(channels.values())
    .filter((channel) => channel && typeof channel.isVoiceBased === 'function' && channel.isVoiceBased() && channel.members)
    .sort((a, b) => {
      const pos = (a.rawPosition || 0) - (b.rawPosition || 0);
      if (pos !== 0) return pos;
      return String(a.name || '').localeCompare(String(b.name || ''));
    });

  const lines = [`🌐 **Server: ${guild.name}**`];
  let hasMembers = false;

  for (const channel of voiceChannels) {
    if (!channel.members || channel.members.size === 0) continue;
    hasMembers = true;
    lines.push(`🔊 **${channel.name}**:`);

    for (const member of channel.members.values()) {
      const status = formatVoiceMemberStatus(member);
      lines.push(` ├─ ${member.displayName}${status}`);
    }

    lines.push('');
  }

  while (lines.length > 0 && !String(lines[lines.length - 1]).trim()) {
    lines.pop();
  }

  return { hasMembers, lines };
}

async function sendVoiceMonitorReport(sendFn) {
  const guilds = Array.from(client.guilds.cache.values());
  if (guilds.length === 0) {
    await sendFn('Bot belum bergabung ke server mana pun.');
    return;
  }

  let activeGuilds = 0;
  for (const guild of guilds) {
    const report = await buildVoiceReportForGuild(guild);
    if (!report.hasMembers) continue;

    activeGuilds += 1;
    const chunks = splitLinesToChunks(report.lines, 1900);
    for (const chunk of chunks) {
      await sendFn(chunk);
    }
  }

  if (activeGuilds === 0) {
    await sendFn('Saat ini voice channel sepi di semua server.');
  } else {
    await sendFn('✅ Pantauan selesai.');
  }
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

    const { embed, rows } = makePremiumEmbed(player, guildId, track, AUDIO_PRESET_LABEL_MAP);
    const msg = await ch.send({ embeds: [embed], components: rows });

    // Store message info and start update interval
    const interval = setInterval(async () => {
      try {
        const q = player.getQueue(guildId);
        if (!q.playing || q.playing.url !== track.url) {
          clearInterval(interval);
          return;
        }

        const { embed: updatedEmbed, rows: updatedRows } = makePremiumEmbed(player, guildId, q.playing, AUDIO_PRESET_LABEL_MAP);
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
        voiceStatusChannels.set(guildId, botVoice.id);
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

    // ── Keep static profile status ───────────────────────────────────────────
    applyStaticPresence();
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
  clearVoiceStatus(guildId);
  applyStaticPresence();
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

  applyStaticPresence();

  const cachedGuilds = client.guilds.cache.map(g => `${g.name} (${g.id})`);
  if (cachedGuilds.length > 0) {
    console.log('[bot] Cached guilds:');
    for (const label of cachedGuilds) {
      console.log(' -', label);
    }
  }

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
      console.log('[bot] Registered slash commands to guild', formatGuildLabel(gid));
    } catch (err) {
      console.warn('[bot] Failed registering commands to guild', formatGuildLabel(gid), err && err.message ? err.message : err);
    }
  }
});

client.on('error', (err) => {
  console.error('[bot] Discord Client Error:', err && err.message ? err.message : err);
});

client.on('voiceStateUpdate', (oldState, newState) => {
  if (!oldState || !oldState.member || !client.user) return;
  if (oldState.member.id !== client.user.id) return;

  const oldChannelId = oldState.channelId;
  const newChannelId = newState ? newState.channelId : null;
  if (oldChannelId && oldChannelId !== newChannelId) {
    clearVoiceStatus(oldState.guild.id, { channelId: oldChannelId });
  }
});

client.on('guildCreate', async (guild) => {
  try {
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
    await rest.put(Routes.applicationGuildCommands(client.user.id, guild.id), { body: slashCommands });
    console.log('[bot] Registered slash commands to new guild', `${guild.name} (${guild.id})`);
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

        const session = lyricsEngine.getLyricsSession(sessionId);
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
          lyricsEngine.deleteLyricsSession(sessionId);
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
          embeds: [lyricsEngine.makeLyricsPageEmbed(session, currentPage)],
          components: session.pages && session.pages.length > 1
            ? [lyricsEngine.makeLyricsNavigationRow(sessionId, currentPage, session.pages.length)]
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
        await clearVoiceStatus(guildId, { retry: false });
        player.stop(guildId);
        applyStaticPresence();
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
        const result = await lyricsEngine.getTrackLyricsStrict(q.playing);
        if (!result.ok) {
          return interaction.editReply({ embeds: [makeEmbed('📃 Lyrics', result.reason)] });
        }

        const payload = lyricsEngine.makeLyricsResultMessage(q.playing, result, interaction.user.id, guildId);
        await interaction.editReply(payload);
      } else if (customId === 'player_queue') {
        await interaction.reply({ embeds: [makeQueueOverviewEmbed(player, guildId, AUDIO_PRESET_LABEL_MAP, 10)], flags: MessageFlags.Ephemeral });
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
        const topTracks = (Array.isArray(tracks) ? tracks : []).slice(0, 5);
        for (const item of topTracks) {
          cacheAutocompleteItem(item);
        }
        const choices = topTracks.map((item) => ({
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

      logUserInput({
        userId: interaction.user.id,
        userTag: interaction.user.tag,
        guildId: interaction.guildId,
        command: '/play',
        input: query,
      });

      const memberVC = ensureMemberVC();

      // Permission check
      const permCheck = checkVoicePermissions(memberVC, interaction.guild.members.me);
      if (!permCheck.ok) {
        return interaction.reply({ content: permCheck.reason, flags: MessageFlags.Ephemeral });
      }

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await player.join(memberVC);

      const queueBefore = player.getQueue(interaction.guildId);
      const willPlayNow = !queueBefore.playing && queueBefore.queue.length === 0;

      // Spotify
      const { handled } = await spotifyUtil.handleSpotify(
        query, interaction.guildId, interaction.channelId, interaction.user.tag,
        (payload) => interaction.editReply(payload), player
      );
      if (handled) return;

      // Direct YouTube URL (music-only)
      if (spotifyUtil.isYouTubeUrl(query)) {
        const cached = getCachedAutocomplete(query);
        const check = await spotifyUtil.validateYouTubeMusicLink(query, playShim, { timeoutMs: 800 });
        if (!check.ok) {
          return interaction.editReply({ embeds: [makeEmbed('❌ YouTube Music Only', check.reason)] });
        }
        const normalizedUrl = check.normalizedUrl || (cached && cached.url) || query;
        const displayTitle = check.title || (cached && cached.title) || normalizedUrl;
        await player.enqueue(interaction.guildId, {
          title: displayTitle,
          url: normalizedUrl,
          author: check.author || (cached && cached.author) || undefined,
          duration: check.duration || (cached && cached.duration) || undefined,
          thumbnail: check.thumbnail || (cached && cached.thumbnail) || undefined,
          requestedBy: interaction.user.tag,
          textChannelId: interaction.channelId,
        });
        if (willPlayNow) {
          return interaction.editReply({ embeds: [makeEmbed('▶️ Playing', `Now playing: ${displayTitle}`)] });
        }
        return interaction.editReply({ embeds: [makeEmbed('✅ Queued', `Added link: ${displayTitle}`)] }); // ephemeral already set via deferReply
      }

      // Direct SoundCloud URL
      if (spotifyUtil.isSoundCloudUrl(query)) {
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
      clearVoiceStatus(interaction.guildId);
      applyStaticPresence();
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
      return interaction.reply({ embeds: [makeQueueOverviewEmbed(player, interaction.guildId, AUDIO_PRESET_LABEL_MAP, 20)], flags: MessageFlags.Ephemeral });
    }

    // /np
    if (commandName === 'np') {
      return interaction.reply({ embeds: [makeNowPlayingInfoEmbed(player, interaction.guildId, AUDIO_PRESET_LABEL_MAP)], flags: MessageFlags.Ephemeral });
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
      clearVoiceStatus(interaction.guildId);
      applyStaticPresence();
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
      const result = await lyricsEngine.getTrackLyricsStrict(q.playing);
      if (!result.ok) {
        return interaction.editReply({ embeds: [makeEmbed('📃 Lyrics', result.reason)] });
      }

      const payload = lyricsEngine.makeLyricsResultMessage(q.playing, result, interaction.user.id, interaction.guildId);
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
          embeds: [makeEmbed('❌ Preset Tidak Valid', `Mode tidak dikenali.\n\n${getAudioPresetListText(AUDIO_PRESET_CATALOG)}`)],
          flags: MessageFlags.Ephemeral,
        });
      }

      const memberVC = ensureMemberVC();
      const botVC = interaction.guild.members.me.voice.channel;
      if (botVC && memberVC.id !== botVC.id) {
        return interaction.reply({ content: '❌ Kamu harus berada di voice channel yang sama dengan bot!', flags: MessageFlags.Ephemeral });
      }

      const applied = player.setAudioPreset(interaction.guildId, mode);
      const label = formatAudioPresetLabel(applied, AUDIO_PRESET_LABEL_MAP);
      const q = player.getQueue(interaction.guildId);
      if (q.playing) player.applyAudioPresetNow(interaction.guildId);
      return interaction.reply({
        embeds: [makeEmbed('🎛 Audio Preset', `Preset aktif: **${label}** (\`${applied}\`)`)],
        flags: MessageFlags.Ephemeral,
      });
    }

    // /health
    if (commandName === 'health') {
      return interaction.reply({ embeds: [makeHealthEmbed(player, client, interaction.guildId, AUDIO_PRESET_LABEL_MAP)], flags: MessageFlags.Ephemeral });
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

    const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
    const cmd  = args.shift().toLowerCase();

    /** Quick reply helper */
    const reply = (payload) => message.reply(payload).catch(() => {});

    const isDM = !message.guild;
    if (isDM) {
      if (cmd !== 'pantausemua' && cmd !== 'pantau' && cmd !== 'userinput' && cmd !== 'leave') return;
      if (OWNER_IDS.length === 0) {
        return reply({ embeds: [makeEmbed('❌ Error', 'OWNER_ID belum di-set di .env.')] });
      }
      if (!isOwner(message.author.id)) {
        return reply({ embeds: [makeEmbed('❌ Error', 'Command ini hanya untuk owner bot.')] });
      }

      if (cmd === 'leave') {
        const remain = getCooldownRemainingMs(
          message.author.id,
          'dm',
          'prefix:dmleave',
          COMMAND_COOLDOWN_MS.dmleave
        );
        if (remain > 0) {
          return reply({ embeds: [makeEmbed('⏳ Cooldown', makeCooldownNotice(remain, `menggunakan ${PREFIX}${cmd}`))] });
        }

        const targetGuildId = String(args[0] || '').trim();
        if (!/^\d{5,25}$/.test(targetGuildId)) {
          return reply({ embeds: [makeEmbed('❌ Error', `Gunakan: ${PREFIX}leave <guildId>`)] });
        }

        const guild = client.guilds.cache.get(targetGuildId);
        if (!guild) {
          return reply({ embeds: [makeEmbed('❌ Error', 'Guild tidak ditemukan di cache. Pastikan bot sudah join server tersebut.')] });
        }

        player.setStay24h(guild.id, false);
        player.stop(guild.id, { forceLeave: true });
        clearVoiceStatus(guild.id);
        applyStaticPresence();

        return reply({ embeds: [makeEmbed('👋 Leave', `Bot keluar dari voice di **${guild.name}** (${guild.id}).`)] });
      }

      if (cmd === 'userinput') {
        const remain = getCooldownRemainingMs(
          message.author.id,
          'dm',
          'prefix:userinput',
          COMMAND_COOLDOWN_MS.userinput
        );
        if (remain > 0) {
          return reply({ embeds: [makeEmbed('⏳ Cooldown', makeCooldownNotice(remain, `menggunakan ${PREFIX}${cmd}`))] });
        }

        const limit = parseInt(args[0], 10);
        const lines = buildUserInputLines(limit);
        if (lines.length === 0) {
          return reply({ content: 'Belum ada input user tercatat.' });
        }

        const chunks = splitLinesToChunks(lines, 1900);
        for (const chunk of chunks) {
          await message.channel.send({ content: chunk });
        }
        return;
      }

      const remain = getCooldownRemainingMs(
        message.author.id,
        'dm',
        'prefix:monitor',
        COMMAND_COOLDOWN_MS.monitor
      );
      if (remain > 0) {
        return reply({ embeds: [makeEmbed('⏳ Cooldown', makeCooldownNotice(remain, `menggunakan ${PREFIX}${cmd}`))] });
      }

      await reply({ content: '🔍 Memulai pantauan voice di semua server...' });
      const send = (content) => message.channel.send({ content }).catch(() => {});
      await sendVoiceMonitorReport(send);
      return;
    }

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

      logUserInput({
        userId: message.author.id,
        userTag: message.author.tag,
        guildId: message.guild.id,
        command: '!play',
        input: query,
      });

      const memberVC = message.member && message.member.voice ? message.member.voice.channel : null;
      if (!memberVC) return reply({ embeds: [makeEmbed('❌ Error', 'You must be in a voice channel.')] });

      await player.join(memberVC);
      const searching = await reply({ content: '🔍 Searching...' });
      const edit      = (payload) => searching ? searching.edit(payload).catch(() => {}) : Promise.resolve();

      const queueBefore = player.getQueue(message.guild.id);
      const willPlayNow = !queueBefore.playing && queueBefore.queue.length === 0;

      // Spotify
      const { handled } = await spotifyUtil.handleSpotify(
        query, message.guild.id, message.channel.id, message.author.tag, edit, player
      );
      if (handled) return;

      // Direct YouTube URL (music-only)
      if (spotifyUtil.isYouTubeUrl(query)) {
        const cached = getCachedAutocomplete(query);
        const check = await spotifyUtil.validateYouTubeMusicLink(query, playShim, { timeoutMs: 800 });
        if (!check.ok) {
          return edit({ embeds: [makeEmbed('❌ YouTube Music Only', check.reason)] });
        }
        const normalizedUrl = check.normalizedUrl || (cached && cached.url) || query;
        const displayTitle = check.title || (cached && cached.title) || normalizedUrl;
        await player.enqueue(message.guild.id, {
          title: displayTitle,
          url: normalizedUrl,
          author: check.author || (cached && cached.author) || undefined,
          duration: check.duration || (cached && cached.duration) || undefined,
          thumbnail: check.thumbnail || (cached && cached.thumbnail) || undefined,
          requestedBy: message.author.tag,
          textChannelId: message.channel.id,
        });
        if (willPlayNow) {
          return edit({ embeds: [makeEmbed('▶️ Playing', `Now playing: ${displayTitle}`)] });
        }
        return edit({ embeds: [makeEmbed('✅ Queued', `Added link: ${displayTitle}`)] });
      }

      // Direct SoundCloud URL
      if (spotifyUtil.isSoundCloudUrl(query)) {
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
      clearVoiceStatus(message.guild.id);
      applyStaticPresence();
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
      return reply({ embeds: [makeQueueOverviewEmbed(player, message.guild.id, AUDIO_PRESET_LABEL_MAP, 20)] });
    }

    // ── !nowplaying / !np ──────────────────────────────────────────────────────
    if (cmd === 'nowplaying' || cmd === 'np') {
      return reply({ embeds: [makeNowPlayingInfoEmbed(player, message.guild.id, AUDIO_PRESET_LABEL_MAP)] });
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
      clearVoiceStatus(message.guild.id);
      applyStaticPresence();
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
      const result = await lyricsEngine.getTrackLyricsStrict(q.playing);
      if (!result.ok) {
        const failEmbed = makeEmbed('📃 Lyrics', result.reason);
        return wait ? wait.edit({ content: null, embeds: [failEmbed] }) : reply({ embeds: [failEmbed] });
      }

      const payload = lyricsEngine.makeLyricsResultMessage(q.playing, result, message.author.id, message.guild.id);
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
          embeds: [makeEmbed('🏛 Audio Preset', `Gunakan: \`!preset <mode>\`\n\nPreset tersedia:\n${getAudioPresetListText(AUDIO_PRESET_CATALOG)}`)],
        });
      }

      if (!AUDIO_PRESET_VALUE_SET.has(mode)) {
        return reply({
          embeds: [makeEmbed('❌ Preset Tidak Valid', `Mode \`${mode}\` tidak dikenali.\n\nPreset tersedia:\n${getAudioPresetListText(AUDIO_PRESET_CATALOG)}`)],
        });
      }

      const applied = player.setAudioPreset(message.guild.id, mode);
      const label = formatAudioPresetLabel(applied, AUDIO_PRESET_LABEL_MAP);
      const q = player.getQueue(message.guild.id);
      if (q.playing) player.applyAudioPresetNow(message.guild.id);

      return reply({
        embeds: [makeEmbed('🎛 Audio Preset', `Preset aktif: **${label}** (\`${applied}\`)`)],
      });
    }

    // ── !health ───────────────────────────────────────────────────────────────
    if (cmd === 'health') {
      return reply({ embeds: [makeHealthEmbed(player, client, message.guild.id, AUDIO_PRESET_LABEL_MAP)] });
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
  releaseInstanceLock();
  process.exit(0);
});

process.on('SIGTERM', () => {
  flushPlayerState('SIGTERM');
  releaseInstanceLock();
  process.exit(0);
});

process.on('beforeExit', () => {
  flushPlayerState('beforeExit');
  releaseInstanceLock();
});

process.on('exit', () => {
  releaseInstanceLock();
});

// ── Login ─────────────────────────────────────────────────────────────────────

const token = process.env.DISCORD_TOKEN;
if (!token || token === 'YOUR_BOT_TOKEN_HERE') {
  console.error('[bot] DISCORD_TOKEN is not set in .env — please fill in your token.');
  releaseInstanceLock();
  process.exit(1);
}

client.login(token).catch(err => {
  console.error('[bot] Failed to login:', err && err.message ? err.message : err);
  releaseInstanceLock();
  process.exit(1);
});
