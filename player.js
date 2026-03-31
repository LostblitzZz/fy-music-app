// Credit by Raitzu
'use strict';

const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  NoSubscriberBehavior,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');

// Load libsodium-wrappers so @discordjs/voice can encrypt audio packets
let libsodiumReady = false;
try {
  const sodium = require('libsodium-wrappers');
  sodium.ready.then(() => {
    libsodiumReady = true;
    console.log('[player] libsodium-wrappers is ready');
  }).catch((err) => {
    console.error('[player] libsodium-wrappers failed to load:', err);
  });
} catch (e) {
  console.warn('[player] libsodium-wrappers not found — voice encryption may fail. Run: npm install libsodium-wrappers');
}

const play = require('./playdl-shim');
const EventEmitter = require('events');
const fs = require('fs');
const path = require('path');

const PLAYER_STATE_FILE = path.join(process.cwd(), 'data', 'player-state.json');

const AUDIO_PRESET_CONFIG = Object.freeze({
  flat: {
    label: 'Flat',
    description: 'No filter (paling natural dan ringan CPU).',
  },
  bass_boost: {
    label: 'Bass Boost',
    description: 'Low-end lebih tebal untuk EDM, hip-hop, dan pop.',
  },
  vocal_boost: {
    label: 'Vocal Boost',
    description: 'Vokal lebih jelas, cocok untuk podcast/ballad.',
  },
  bright: {
    label: 'Bright',
    description: 'High/treble lebih detail, suara lebih terang.',
  },
  studio: {
    label: 'Studio',
    description: 'EQ + kompresor ringan biar volume lebih stabil.',
  },
});

const AUDIO_PRESET_GAIN = Object.freeze({
  flat: 1.0,
  bass_boost: 1.12,
  vocal_boost: 1.06,
  bright: 1.04,
  studio: 1.08,
});

function normalizeAudioPresetName(preset) {
  const key = String(preset || 'flat')
    .toLowerCase()
    .replace(/[\s-]+/g, '_')
    .trim();

  return AUDIO_PRESET_CONFIG[key] ? key : 'flat';
}

function getAudioPresetEntries() {
  return Object.entries(AUDIO_PRESET_CONFIG).map(([value, meta]) => ({
    value,
    label: meta.label,
    description: meta.description,
  }));
}

function getAudioPresetGain(preset) {
  const key = normalizeAudioPresetName(preset);
  return Number(AUDIO_PRESET_GAIN[key]) || 1.0;
}

function sanitizeTrack(track) {
  if (!track || typeof track !== 'object') return null;

  const title = track.title ? String(track.title).substring(0, 300) : '';
  const url = track.url ? String(track.url) : '';
  const search = track.search ? String(track.search).substring(0, 300) : '';
  const query = track.query ? String(track.query).substring(0, 300) : '';
  const durationRaw = Number(track.duration) || 0;
  const duration = durationRaw > 0 ? Math.floor(durationRaw) : 0;
  const thumbnail = track.thumbnail ? String(track.thumbnail) : '';
  const author = track.author ? String(track.author).substring(0, 120) : '';
  const requestedBy = track.requestedBy ? String(track.requestedBy).substring(0, 80) : '';
  const textChannelId = track.textChannelId ? String(track.textChannelId) : null;
  const spotifyTitle = track.spotifyTitle ? String(track.spotifyTitle).substring(0, 300) : '';
  const spotifyArtist = track.spotifyArtist ? String(track.spotifyArtist).substring(0, 200) : '';
  const sourceHint = track.sourceHint ? String(track.sourceHint).substring(0, 30) : '';
  const strictSearch = !!track.strictSearch;

  if (!title && !url && !search && !query) return null;

  return {
    title,
    url,
    search,
    query,
    duration,
    thumbnail,
    author,
    requestedBy,
    textChannelId,
    spotifyTitle,
    spotifyArtist,
    sourceHint,
    strictSearch,
  };
}

function isSameTrackIdentity(a, b) {
  if (!a || !b) return false;

  const aUrl = String(a.url || '').trim();
  const bUrl = String(b.url || '').trim();
  if (aUrl && bUrl) return aUrl === bUrl;

  const aSearch = normalizeMatchText(a.search || a.title || a.query || '');
  const bSearch = normalizeMatchText(b.search || b.title || b.query || '');
  return !!(aSearch && bSearch && aSearch === bSearch);
}

function applyEffectiveVolumeToState(state) {
  if (!state || !state.resource || !state.resource.volume) return;

  const base = Math.max(0, Math.min(1, Number(state.volume) || 0.2));
  const gain = getAudioPresetGain(state.audioPreset);
  const effective = Math.max(0, Math.min(2, base * gain));
  state.resource.volume.setVolume(effective);
}

function normalizeMatchText(input) {
  return String(input || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenizeMatchText(input) {
  return normalizeMatchText(input)
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length >= 3);
}

function hasVersionPenalty(text) {
  return /\b(cover|karaoke|nightcore|slowed|sped up|8d|remix|instrumental|reverb)\b/.test(text);
}

/**
 * MusicPlayer manages per-guild queue, radio mode, and 24/7 mode.
 * Events:
 *   'trackStart'     (guildId, track)  — emitted when a new track starts
 *   'radioRecommend' (guildId, track)  — emitted when radio queues a recommendation
 *   'idle'           (guildId)         — emitted when the player goes idle
 */
class MusicPlayer extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, GuildState>} */
    this.guilds = new Map();
    this._persistPath = PLAYER_STATE_FILE;
    this._persistTimer = null;
    this._lastPersistAt = 0;
    this._persistedSnapshots = this._readPersistedSnapshots();
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

  _readPersistedSnapshots() {
    const snapshots = new Map();
    try {
      if (!fs.existsSync(this._persistPath)) return snapshots;

      const raw = fs.readFileSync(this._persistPath, 'utf8');
      if (!raw || !raw.trim()) return snapshots;

      const parsed = JSON.parse(raw);
      const guilds = parsed && typeof parsed === 'object' ? parsed.guilds : null;
      if (!guilds || typeof guilds !== 'object') return snapshots;

      for (const [guildId, state] of Object.entries(guilds)) {
        if (!guildId || !state || typeof state !== 'object') continue;
        snapshots.set(String(guildId), state);
      }

      this._lastPersistAt = Number(parsed.savedAt) || 0;
      if (snapshots.size > 0) {
        console.log(`[player] loaded persisted snapshots: ${snapshots.size} guild(s)`);
      }
    } catch (err) {
      console.warn('[player] failed to load persisted snapshots:', err && err.message ? err.message : err);
    }
    return snapshots;
  }

  _buildGuildSnapshot(state) {
    const queue = Array.isArray(state.queue)
      ? state.queue.map((track) => sanitizeTrack(track)).filter(Boolean).slice(0, state.maxQueue)
      : [];

    const playing = sanitizeTrack(state.playing);
    const volumePercent = Math.round(Math.max(0, Math.min(1, Number(state.volume) || 0.2)) * 100);

    const hasMeaningfulState =
      queue.length > 0 ||
      !!playing ||
      !!state.autoplay ||
      state.loopMode !== 'none' ||
      !!state.shuffle ||
      !!(state.radio && state.radio.enabled) ||
      !!state.stay24h ||
      volumePercent !== 20 ||
      normalizeAudioPresetName(state.audioPreset) !== 'flat';

    if (!hasMeaningfulState) return null;

    return {
      playing,
      queue,
      volume: volumePercent,
      loopMode: ['none', 'track', 'queue'].includes(state.loopMode) ? state.loopMode : 'none',
      shuffle: !!state.shuffle,
      autoplay: !!state.autoplay,
      audioPreset: normalizeAudioPresetName(state.audioPreset),
      radio: {
        enabled: !!(state.radio && state.radio.enabled),
        keyword: state.radio && typeof state.radio.keyword === 'string' ? state.radio.keyword : null,
      },
      stay24h: !!state.stay24h,
      lastTextChannelId: state.lastTextChannelId || null,
      lastPlayed: Array.isArray(state.lastPlayed) ? state.lastPlayed.slice(-100) : [],
      updatedAt: Date.now(),
    };
  }

  _schedulePersist() {
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this._flushPersistedState();
    }, 800);

    if (this._persistTimer && typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  _flushPersistedState() {
    try {
      const guilds = {};

      for (const [guildId, snapshot] of this._persistedSnapshots.entries()) {
        if (!snapshot || typeof snapshot !== 'object') continue;
        guilds[guildId] = snapshot;
      }

      for (const [guildId, state] of this.guilds.entries()) {
        const snapshot = this._buildGuildSnapshot(state);
        if (snapshot) {
          guilds[guildId] = snapshot;
        } else {
          delete guilds[guildId];
        }
      }

      fs.mkdirSync(path.dirname(this._persistPath), { recursive: true });

      const payload = {
        savedAt: Date.now(),
        guilds,
      };

      const tmpFile = `${this._persistPath}.tmp`;
      fs.writeFileSync(tmpFile, JSON.stringify(payload, null, 2), 'utf8');
      fs.renameSync(tmpFile, this._persistPath);

      this._lastPersistAt = payload.savedAt;
    } catch (err) {
      console.warn('[player] failed to persist state:', err && err.message ? err.message : err);
    }
  }

  _applyPersistedState(guildId, state) {
    const snapshot = this._persistedSnapshots.get(guildId);
    if (!snapshot) return;

    try {
      const restoredQueue = [];

      const restoredPlaying = sanitizeTrack(snapshot.playing);
      if (restoredPlaying) restoredQueue.push(restoredPlaying);

      if (Array.isArray(snapshot.queue)) {
        for (const track of snapshot.queue) {
          const safe = sanitizeTrack(track);
          if (safe) restoredQueue.push(safe);
        }
      }

      state.queue = restoredQueue.slice(0, state.maxQueue);
      state.playing = null;
      state.resource = null;
      state.currentProcess = null;

      if (typeof snapshot.volume === 'number') {
        state.volume = Math.max(0, Math.min(100, snapshot.volume)) / 100;
      }

      state.loopMode = ['none', 'track', 'queue'].includes(snapshot.loopMode) ? snapshot.loopMode : 'none';
      state.shuffle = !!snapshot.shuffle;
      state.autoplay = !!snapshot.autoplay;
      state.audioPreset = normalizeAudioPresetName(snapshot.audioPreset);
      state.stay24h = !!snapshot.stay24h;

      state.radio = {
        enabled: !!(snapshot.radio && snapshot.radio.enabled),
        keyword: snapshot.radio && typeof snapshot.radio.keyword === 'string' ? snapshot.radio.keyword : null,
      };

      state.lastTextChannelId = snapshot.lastTextChannelId ? String(snapshot.lastTextChannelId) : null;
      state.lastPlayed = Array.isArray(snapshot.lastPlayed)
        ? snapshot.lastPlayed.filter((item) => typeof item === 'string').slice(-100)
        : [];

      if (state.queue.length > 0) {
        console.log(`[player] restored queue for guild ${guildId}: ${state.queue.length} track(s)`);
      }
    } catch (err) {
      console.warn(`[player] failed to apply snapshot for guild ${guildId}:`, err && err.message ? err.message : err);
    } finally {
      this._persistedSnapshots.delete(guildId);
    }
  }

  /**
   * Ensure a state object exists for the guild and return it.
   * @param {string} guildId
   * @returns {GuildState}
   */
  _ensureGuild(guildId) {
    if (this.guilds.has(guildId)) return this.guilds.get(guildId);

    const audioPlayer = createAudioPlayer({
      behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
    });

    /** @type {GuildState} */
      const state = {
        connection:     null,
        player:         audioPlayer,
        queue:          [],
        playing:        null,
        resource:       null,    // Track the currently active AudioResource
        currentProcess: null,
        volume:         0.2,     // Default to 20% (0.2)
        loopMode:       'none',  // 'none', 'track', 'queue'
        shuffle:        false,
        autoplay:       false,
        audioPreset:    'flat',  // audio processing mode (EQ-style preset)
        radio:          { enabled: false, keyword: null },
        stay24h:        false,
        lastPlayed:     [],
        lastTextChannelId: null,
        maxQueue:       500,
        _playingNext:   false,   // guard against re-entrant _playNext calls
        _needsPlayNext: false,   // enqueue happened while _playNext was running
        disconnectTimer: null,   // delayed disconnect to avoid queue race
      };

    this._applyPersistedState(guildId, state);

    // ── Audio player state events ────────────────────────────────────────────
    audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[player] Guild ${guildId} state: ${oldState.status} -> ${newState.status}`);
      
      if (
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        const s = this.guilds.get(guildId);
        const playbackMs = Number(s && s.resource && s.resource.playbackDuration) || 0;
        const hasActiveProcess = !!(s && s.currentProcess && !s.currentProcess.killed);
        const stallRetryCount = Number(s && s.playing && s.playing._stallRetryCount) || 0;
        const durationSec = Number(s && s.playing && s.playing.duration) || 0;
        const durationMs = durationSec > 0 ? durationSec * 1000 : 0;
        const veryShortKnownTrack = durationSec > 0 && durationSec <= 30;
        const nearNaturalEnd = durationMs > 0 && playbackMs >= Math.max(9000, Math.floor(durationMs * 0.7));

        if (
          s &&
          s.playing &&
          hasActiveProcess &&
          playbackMs >= 1500 &&
          playbackMs <= 12000 &&
          !veryShortKnownTrack &&
          !nearNaturalEnd &&
          stallRetryCount < 1
        ) {
          const retryTrack = { ...s.playing, _stallRetryCount: stallRetryCount + 1 };
          const resumeAt = Math.max(0, Math.floor(playbackMs / 1000) - 1);
          if (resumeAt > 0) retryTrack.resumeAt = resumeAt;

          console.warn(`[player] early idle detected (${playbackMs}ms) while stream is alive; retrying current track once`);

          this._killProcess(guildId);
          s.playing = null;
          s.resource = null;
          s.queue.unshift(retryTrack);
          setImmediate(() => this._playNext(guildId));
          return;
        }

        // Track ended — record it to lastPlayed to avoid radio repeat
        try {
          if (s && s.playing) {
            this._rememberPlayed(s, s.playing);
          }
        } catch (e) {}

        // Kill streaming child process if still running
        this._killProcess(guildId);

        this.emit('idle', guildId);
        // Use setImmediate to avoid synchronous re-entrancy
        setImmediate(() => this._playNext(guildId));
      }
    });

    audioPlayer.on('error', (err) => {
      console.error('[player] Audio player error:', err && err.message ? err.message : err);
      this._killProcess(guildId);
      setImmediate(() => this._playNext(guildId));
    });

    this.guilds.set(guildId, state);
    return state;
  }

  /**
   * Kill the currently running yt-dlp child process for a guild, if any.
   * @param {string} guildId
   */
  _killProcess(guildId) {
    try {
      const s = this.guilds.get(guildId);
      if (s && s.currentProcess) {
        try { s.currentProcess.kill('SIGKILL'); } catch (e) {}
        s.currentProcess = null;
      }
    } catch (e) {}
  }

  // ─── Public API ──────────────────────────────────────────────────────────────

  /**
   * Join a voice channel (or move to it if already connected elsewhere).
   * @param {import('discord.js').VoiceChannel} channel
   */
  async join(channel) {
    const state = this._ensureGuild(channel.guild.id);

    // Already in the same channel — no-op
    if (
      state.connection &&
      state.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      state.connection.joinConfig.channelId === channel.id
    ) {
      return state.connection;
    }

    // If still connected elsewhere, destroy stale connection before joining new one.
    if (
      state.connection &&
      state.connection.state.status !== VoiceConnectionStatus.Destroyed &&
      state.connection.joinConfig.channelId !== channel.id
    ) {
      try { state.connection.destroy(); } catch (e) {}
      state.connection = null;
    }

    const connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf:       true,
    });

    connection.subscribe(state.player);
    state.connection = connection;

    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 15_000);
    } catch (err) {
      console.warn('[player] Voice connection failed to become ready:', err && err.message ? err.message : err);
      if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
        try { connection.destroy(); } catch (e) {}
      }
      state.connection = null;
      throw new Error('Failed to connect to voice channel. Please try again.');
    }

    connection.on('stateChange', async (oldVoiceState, newVoiceState) => {
      if (newVoiceState.status === VoiceConnectionStatus.Disconnected) {
        // Try to reconnect; if it takes too long, destroy the connection
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
          // Reconnected successfully
        } catch {
          if (connection.state.status !== VoiceConnectionStatus.Destroyed) {
            try { connection.destroy(); } catch (e) {}
          }
          state.connection = null;
        }
      } else if (newVoiceState.status === VoiceConnectionStatus.Destroyed) {
        state.connection = null;
      }
    });

    return connection;
  }

  /**
   * Add one or more tracks to the guild queue and start playback if idle.
   * @param {string} guildId
   * @param {Track|Track[]} items
   */
  async enqueue(guildId, items) {
    const state = this._ensureGuild(guildId);
    if (!Array.isArray(items)) items = [items];

    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }

    for (const it of items) {
      if (!it) continue;
      if (it.textChannelId) state.lastTextChannelId = it.textChannelId;
      if (state.queue.length >= state.maxQueue) break;
      
      // If it's a URL and missing metadata, fetch it
      if (it.url && (!it.duration || !it.thumbnail)) {
        const info = await play.getInfo(it.url).catch(() => null);
        if (info) {
          it.title = info.title || it.title;
          it.duration = info.duration || 0;
          it.thumbnail = info.thumbnail || '';
          it.author = info.author || 'Unknown Artist';
        }
      }
      
      state.queue.push(it);
    }

    this._schedulePersist();

    const playerIdle =
      !state.playing &&
      state.player.state.status !== AudioPlayerStatus.Playing &&
      state.player.state.status !== AudioPlayerStatus.Buffering;

    if (playerIdle) {
      if (state._playingNext) {
        state._needsPlayNext = true;
      } else {
        await this._playNext(guildId);
      }
    }
  }

  // ─── Radio & 24/7 ────────────────────────────────────────────────────────────

  setRadio(guildId, enabled, keyword = null) {
    const state = this._ensureGuild(guildId);
    state.radio.enabled = !!enabled;
    state.radio.keyword = keyword;
    this._schedulePersist();
    return state.radio;
  }

  getRadio(guildId) {
    return this._ensureGuild(guildId).radio;
  }

  setStay24h(guildId, enabled) {
    const state = this._ensureGuild(guildId);
    state.stay24h = !!enabled;
    this._schedulePersist();
    return state.stay24h;
  }

  getStay24h(guildId) {
    return this._ensureGuild(guildId).stay24h;
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  /**
   * Search YouTube for a keyword and return a random result, excluding recently played URLs.
   * @param {string} keyword
   * @param {string[]} [exclude]
   * @returns {Promise<{title:string, url:string}|null>}
   */
  async searchTrack(keyword, exclude = []) {
    try {
      if (!keyword) return null;
      const results = await play.search(keyword, { limit: 10 });
      if (!results || results.length === 0) return null;
      const excludeSet = new Set(
        (exclude || [])
          .map((item) => this._trackIdentityKey(item))
          .filter(Boolean)
      );

      const candidates = results.filter((r) => {
        const key = this._trackIdentityKey(r);
        return !key || !excludeSet.has(key);
      });

      const pool = candidates.length ? candidates : results;
      return pool[Math.floor(Math.random() * pool.length)];
    } catch (err) {
      console.error('[player] searchTrack error:', err && err.message ? err.message : err);
      return null;
    }
  }

  _trackIdentityKeyFromString(value) {
    const text = String(value || '').trim();
    if (!text) return null;

    if (/^(?:yt|url|q):/i.test(text)) return text.toLowerCase();

    const videoId = this._extractVideoId(text);
    if (videoId) return `yt:${videoId}`;

    if (/^https?:\/\//i.test(text)) {
      try {
        const parsed = new URL(text);
        const host = String(parsed.hostname || '').replace(/^www\./i, '').toLowerCase();
        const pathname = String(parsed.pathname || '/').replace(/\/+$/, '').toLowerCase() || '/';
        return `url:${host}${pathname}`;
      } catch (e) {
        return `url:${text.toLowerCase()}`;
      }
    }

    const normalized = normalizeMatchText(text);
    if (!normalized) return null;
    return `q:${normalized.slice(0, 180)}`;
  }

  _trackIdentityKey(track) {
    if (!track) return null;
    if (typeof track === 'string') return this._trackIdentityKeyFromString(track);

    const urlKey = this._trackIdentityKeyFromString(track.url);
    if (urlKey) return urlKey;

    return this._trackIdentityKeyFromString(
      track.title || track.search || track.query || null
    );
  }

  _rememberPlayed(state, track) {
    if (!state) return;

    const key = this._trackIdentityKey(track);
    if (!key) return;

    const last = state.lastPlayed[state.lastPlayed.length - 1];
    if (last === key) return;

    state.lastPlayed.push(key);
    if (state.lastPlayed.length > 100) state.lastPlayed.shift();
  }

  _buildAutoplayAvoidSets(state, previousTrack) {
    const hard = new Set();
    const soft = new Set();

    const addHard = (item) => {
      const key = this._trackIdentityKey(item);
      if (key) hard.add(key);
    };

    const addSoft = (item) => {
      const key = this._trackIdentityKey(item);
      if (key) soft.add(key);
    };

    addHard(previousTrack);
    addSoft(previousTrack);

    for (const queued of state.queue || []) {
      addHard(queued);
      addSoft(queued);
    }

    const history = Array.isArray(state.lastPlayed) ? state.lastPlayed : [];
    for (const item of history.slice(-12)) addHard(item);
    for (const item of history.slice(-80)) addSoft(item);

    return { hard, soft };
  }

  _pickAutoplayCandidate(candidates, avoidSets, previousTrack) {
    if (!Array.isArray(candidates) || candidates.length === 0) return null;

    const previousKey = this._trackIdentityKey(previousTrack);
    const hard = avoidSets && avoidSets.hard ? avoidSets.hard : new Set();
    const soft = avoidSets && avoidSets.soft ? avoidSets.soft : new Set();

    const unique = [];
    const seen = new Set();

    for (const candidate of candidates) {
      const key = this._trackIdentityKey(candidate);
      if (!key || key === previousKey || seen.has(key)) continue;
      seen.add(key);
      unique.push({ candidate, key });
    }

    if (unique.length === 0) return null;

    const choose = (pool) => {
      if (!pool || pool.length === 0) return null;
      const head = pool.slice(0, Math.min(6, pool.length));
      return head[Math.floor(Math.random() * head.length)].candidate;
    };

    const softPool = unique.filter((item) => !soft.has(item.key));
    const hardPool = unique.filter((item) => !hard.has(item.key));

    return choose(softPool) || choose(hardPool) || null;
  }

  _buildAutoplayFallbackQueries(previousTrack) {
    if (!previousTrack) return [];

    const rawTitle = previousTrack.spotifyTitle || previousTrack.title || previousTrack.search || previousTrack.query || '';
    const rawArtist = previousTrack.spotifyArtist || previousTrack.author || '';

    const title = String(rawTitle)
      .replace(/\[[^\]]*(official|lyrics?|audio|video|mv|visualizer|live|remix)[^\]]*\]/ig, ' ')
      .replace(/\([^\)]*(official|lyrics?|audio|video|mv|visualizer|live|remix)[^\)]*\)/ig, ' ')
      .replace(/\b(official music video|official video|official audio|lyrics?|audio|videoclip|hd|4k)\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const artist = String(rawArtist)
      .replace(/\s*-\s*topic\b/ig, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const queries = [];
    if (artist && title) queries.push(`${artist} ${title}`);
    if (title) queries.push(title);
    if (previousTrack.search) queries.push(String(previousTrack.search).trim());
    if (artist) queries.push(`${artist} top songs`);

    return Array.from(new Set(queries.filter((q) => q && q.length >= 2))).slice(0, 4);
  }

  _scoreSearchResult(candidate, expectedTitle, expectedArtist) {
    const title = normalizeMatchText(candidate && candidate.title);
    const author = normalizeMatchText(candidate && candidate.author);
    const targetTitle = normalizeMatchText(expectedTitle);
    const targetArtist = normalizeMatchText(expectedArtist);

    const titleTokens = tokenizeMatchText(targetTitle);
    const artistTokens = tokenizeMatchText(targetArtist);

    let score = 0;
    let artistHits = 0;

    if (targetTitle && title.includes(targetTitle)) score += 10;

    for (const tok of titleTokens) {
      if (title.includes(tok)) score += 2;
      else if (author.includes(tok)) score += 0.6;
    }

    if (targetArtist) {
      if (author.includes(targetArtist)) {
        score += 8;
        artistHits += 2;
      }
      if (title.includes(targetArtist)) {
        score += 4;
        artistHits += 1;
      }

      for (const tok of artistTokens) {
        if (author.includes(tok)) {
          score += 3;
          artistHits += 1;
        } else if (title.includes(tok)) {
          score += 2;
          artistHits += 1;
        }
      }
    }

    if (hasVersionPenalty(title)) score -= 4;
    if (/\blive\b/.test(title)) score -= 1;

    return { score, artistHits };
  }

  _pickBestSearchResult(results, expectedTitle, expectedArtist) {
    if (!Array.isArray(results) || results.length === 0) return null;

    const scored = results.map((candidate) => {
      const metrics = this._scoreSearchResult(candidate, expectedTitle, expectedArtist);
      return { candidate, ...metrics };
    }).sort((a, b) => b.score - a.score);

    const best = scored[0];
    if (!best) return null;

    const hasArtistExpectation = !!normalizeMatchText(expectedArtist);
    const minimumScore = hasArtistExpectation ? 8 : 6;

    if (best.score < minimumScore) return null;
    if (hasArtistExpectation && best.artistHits <= 0 && best.score < 14) return null;

    return best.candidate;
  }

  // ─── Playback core ───────────────────────────────────────────────────────────

  /** @private */
  async _playNext(guildId) {
    const state = this._ensureGuild(guildId);

    // Guard: prevent concurrent _playNext calls for the same guild
    if (state._playingNext) return;
    state._playingNext = true;

    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }

    try {
      const previousTrack = state.playing;
      state.playing = null;
      let next = state.queue.shift();

      if (!next) {
        // Queue empty — try Autoplay or radio recommendation
        if (state.autoplay && previousTrack) {
          try {
            const avoidSets = this._buildAutoplayAvoidSets(state, previousTrack);
            let videoId = previousTrack.url ? this._extractVideoId(previousTrack.url) : null;
            let related = [];

            // If we couldn't extract a videoId, try to resolve one by searching the previous
            // track title (fallback for non-YouTube sources or short links).
            if (!videoId && previousTrack.title) {
              try {
                const searchResults = await play.search(previousTrack.title, { limit: 5 });
                const ytCandidate = (searchResults || []).find(r => !!this._extractVideoId(r.url));
                if (ytCandidate && ytCandidate.url) videoId = this._extractVideoId(ytCandidate.url);
              } catch (e) {
                // ignore search fallback errors
              }
            }

            if (videoId) {
              console.log(`[player] Autoplay active, fetching related for: ${videoId}`);
              related = await play.getRelated(videoId, { limit: 20 });
              let pick = this._pickAutoplayCandidate(related, avoidSets, previousTrack);

              if (!pick) {
                const fallbackQueries = this._buildAutoplayFallbackQueries(previousTrack);
                for (const query of fallbackQueries) {
                  const fallbackResults = await play.search(query, { limit: 12 });
                  pick = this._pickAutoplayCandidate(fallbackResults, avoidSets, previousTrack);
                  if (pick) {
                    console.log(`[player] Autoplay fallback from search: ${query}`);
                    break;
                  }
                }
              }

              if (pick) {
                const rec = {
                  ...pick,
                  requestedBy: 'Autoplay 🔁',
                  textChannelId: state.lastTextChannelId,
                };
                this.emit('radioRecommend', guildId, rec); // reuse event name
                state.queue.push(rec);
                state._needsPlayNext = true;
                return;
              }

              if (related.length > 0) {
                console.log('[player] Autoplay skipped: related list exhausted by anti-repeat filter');
              }
            }

            if (!videoId) {
              const fallbackQueries = this._buildAutoplayFallbackQueries(previousTrack);
              for (const query of fallbackQueries) {
                const fallbackResults = await play.search(query, { limit: 12 });
                const pick = this._pickAutoplayCandidate(fallbackResults, avoidSets, previousTrack);
                if (!pick) continue;

                const rec = {
                  ...pick,
                  requestedBy: 'Autoplay 🔁',
                  textChannelId: state.lastTextChannelId,
                };
                this.emit('radioRecommend', guildId, rec);
                state.queue.push(rec);
                state._needsPlayNext = true;
                return;
              }
            }
          } catch (err) {
            console.error('[player] Autoplay error:', err && err.message ? err.message : err);
          }
        }

        if (state.radio && state.radio.enabled) {
          try {
            const exclude = state.lastPlayed || [];
            const pick    = await this.searchTrack(state.radio.keyword, exclude);
            if (pick) {
              const rec = {
                title:         pick.title || 'Unknown Title',
                url:           pick.url   || '',
                requestedBy:   'radio',
                textChannelId: state.lastTextChannelId,
              };
              this.emit('radioRecommend', guildId, rec);
              state.queue.push(rec);
              state._needsPlayNext = true;
              return;
            }
          } catch (err) {
            console.error('[player] Radio recommendation failed:', err && err.message ? err.message : err);
          }
        }

        // Queue might have been filled while this call was running.
        if (state.queue.length > 0) {
          state._needsPlayNext = true;
          return;
        }

        // Nothing to play — leave VC unless 24/7 or radio enabled.
        // Delay leave slightly to avoid races with late-enqueued tracks.
        if (state.connection && !state.stay24h && !(state.radio && state.radio.enabled)) {
          if (!state.disconnectTimer) {
            state.disconnectTimer = setTimeout(() => {
              try {
                state.disconnectTimer = null;

                if (state.queue.length > 0 && !state._playingNext) {
                  setImmediate(() => this._playNext(guildId));
                  return;
                }

                const stillIdle = state.player && state.player.state && state.player.state.status === AudioPlayerStatus.Idle;
                if (
                  state.connection &&
                  !state.playing &&
                  state.queue.length === 0 &&
                  stillIdle &&
                  !state.stay24h &&
                  !(state.radio && state.radio.enabled)
                ) {
                  try { state.connection.destroy(); } catch (e) {}
                  state.connection = null;
                }
              } catch (e) {}
            }, 15000);
          }
        }
        return;
      }

      // ── Handle Loop Mode ───────────────────────────────────────────────────
      if (state.loopMode === 'track') {
        // Put it back at the start for next time
        state.queue.unshift(next);
      } else if (state.loopMode === 'queue') {
        // Put it at the end
        state.queue.push(next);
      }

      // ── Resolve stream ──────────────────────────────────────────────────────
      try {
        const source = next.url || next.search || next.query || '';
        const activePreset = normalizeAudioPresetName(state.audioPreset);
        state.audioPreset = activePreset;
        const resumeAt = Math.max(0, Number(next && next.resumeAt) || 0);
        if (next && Object.prototype.hasOwnProperty.call(next, 'resumeAt')) {
          delete next.resumeAt;
        }

        let streamInfo;
        const validate = play.yt_validate && play.yt_validate(source);

        if (validate === 'video') {
          // Direct YouTube URL
          streamInfo = await play.stream(source, { audioPreset: activePreset, startAtSeconds: resumeAt });
        } else if (/^https?:\/\//i.test(source)) {
          // Other direct URL (SoundCloud, etc.)
          streamInfo = await play.stream(source, { audioPreset: activePreset, startAtSeconds: resumeAt });
        } else {
          // Search query — resolve URL first, then stream
          const strictSpotify = !!(next && next.strictSearch && next.sourceHint === 'spotify');
          const expectedTitle = (next && (next.spotifyTitle || next.title || source)) || source;
          const expectedArtist = (next && next.spotifyArtist) || '';

          const results = await play.search(source, { limit: strictSpotify ? 8 : 1 });
          if (!results || results.length === 0) throw new Error(`No results found for: "${source}"`);

          let picked = results[0];
          if (strictSpotify) {
            let best = this._pickBestSearchResult(results, expectedTitle, expectedArtist);

            // Second pass: query with "topic" hint to bias official artist uploads.
            if (!best && expectedTitle && expectedArtist) {
              const fallbackQuery = `${expectedTitle} ${expectedArtist} topic`;
              const fallback = await play.search(fallbackQuery, { limit: 8 });
              best = this._pickBestSearchResult(fallback, expectedTitle, expectedArtist);
            }

            if (!best) {
              throw new Error(`No close match found for Spotify track: "${expectedTitle}" by "${expectedArtist || 'unknown artist'}"`);
            }

            picked = best;
          }

          streamInfo = await play.stream(picked.url, { audioPreset: activePreset, startAtSeconds: resumeAt });
          // Back-fill resolved metadata onto the track object
          if (!next.url) next.url = picked.url;
          if (!next.title || next.title === source) next.title = picked.title;
          if (!next.author && picked.author) next.author = picked.author;
          if (!next.duration && picked.duration) next.duration = picked.duration;
          if (!next.thumbnail && picked.thumbnail) next.thumbnail = picked.thumbnail;
        }

        const inputStream = streamInfo && streamInfo.stream ? streamInfo.stream : null;
        if (!inputStream) throw new Error('No stream returned for source');

        // Raw PCM is used when ffmpeg audio presets are enabled; otherwise keep arbitrary probing.
        const inputType = streamInfo && streamInfo.type === 'raw_pcm'
          ? StreamType.Raw
          : StreamType.Arbitrary;

        const resource = createAudioResource(inputStream, { 
          inputType,
          inlineVolume: true 
        });

        console.log('[player] Playing:', next.title || next.url || '<unknown>');
        state.player.play(resource);
        state.playing        = next;
        state.resource       = resource;
        state.currentProcess = streamInfo.process || null;
        applyEffectiveVolumeToState(state);

        // Maintain history keys to reduce repeat recommendations.
        this._rememberPlayed(state, next);

        try { this.emit('trackStart', guildId, next); } catch (e) {}
      } catch (err) {
        console.error('[player] Failed to stream track — skipping:', err && err.message ? err.message : err);
        state._needsPlayNext = true;
        return;
      }
    } finally {
      state._playingNext = false;
      this._schedulePersist();

      if (state._needsPlayNext) {
        state._needsPlayNext = false;

        const canAdvance =
          !state.playing &&
          state.queue.length > 0 &&
          state.player &&
          state.player.state &&
          state.player.state.status !== AudioPlayerStatus.Playing &&
          state.player.state.status !== AudioPlayerStatus.Buffering;

        if (canAdvance) {
          setImmediate(() => this._playNext(guildId));
        }
      }
    }
  }

  // ─── Controls ────────────────────────────────────────────────────────────────

  skip(guildId) {
    console.log('[player] Skip requested for guild', guildId);
    this._killProcess(guildId);
    const state = this._ensureGuild(guildId);
    if (state.player) state.player.stop(true);
    // Immediately attempt to play next (helps autoplay trigger on manual skip)
    try { setImmediate(() => this._playNext(guildId)); } catch (e) {}
    this._schedulePersist();
  }

  /**
   * Stop playback and clear the queue.
   * @param {string} guildId
   * @param {{ keepConnection?: boolean, forceLeave?: boolean, keepRadio?: boolean }} [opts]
   */
  stop(guildId, { keepConnection = false, forceLeave = false, keepRadio = false } = {}) {
    console.log('[player] Stop requested for guild', guildId);
    const state = this._ensureGuild(guildId);

    state.queue   = [];
    state.playing = null;
    state.resource = null;
    state.loopMode = 'none';
    state.shuffle = false;
    state._needsPlayNext = false;

    if (state.disconnectTimer) {
      clearTimeout(state.disconnectTimer);
      state.disconnectTimer = null;
    }

    // Stop radio unless caller explicitly wants to keep it (e.g. keepConnection mode with radio)
    if (!keepRadio) {
      state.radio.enabled = false;
      state.radio.keyword = null;
    }

    this._killProcess(guildId);
    state._playingNext = false;
    if (state.player) state.player.stop(true);

    if (state.connection) {
      const shouldDestroy = forceLeave || (!keepConnection && !state.stay24h);
      if (shouldDestroy) {
        try { state.connection.destroy(); } catch (e) {}
        state.connection = null;
      }
    }

    this._schedulePersist();
  }

  pause(guildId) {
    const state = this._ensureGuild(guildId);
    if (state.player) state.player.pause();
  }

  resume(guildId) {
    const state = this._ensureGuild(guildId);
    if (!state.player) return;
    try {
      // If player is idle but we still have a resource, try to resume by replaying the resource.
      if (state.player.state.status === AudioPlayerStatus.Idle) {
        if (state.resource) {
          try {
            state.player.play(state.resource);
            return;
          } catch (e) {}
        }

        // If no resource, but we have a `playing` entry, requeue it and advance.
        if (state.playing) {
          state.queue.unshift(state.playing);
          state.playing = null;
          setImmediate(() => this._playNext(guildId));
          return;
        }
      }

      // Normal unpause path
      if (typeof state.player.unpause === 'function') state.player.unpause();
    } catch (e) {
      console.error('[player] resume error:', e && e.message ? e.message : e);
      try { if (typeof state.player.unpause === 'function') state.player.unpause(); } catch (e2) {}
    }
  }

  /**
   * Return whether the audio player is currently paused for the guild.
   * @param {string} guildId
   * @returns {boolean}
   */
  isPaused(guildId) {
    try {
      const state = this._ensureGuild(guildId);
      return !!(state.player && state.player.state && state.player.state.status === AudioPlayerStatus.Paused);
    } catch (e) {
      return false;
    }
  }

  /**
   * Toggle pause state. Returns the new paused state (true if paused).
   * @param {string} guildId
   * @returns {boolean}
   */
  togglePause(guildId) {
    try {
      if (this.isPaused(guildId)) {
        this.resume(guildId);
        return false;
      }
      this.pause(guildId);
      return true;
    } catch (e) {
      console.error('[player] togglePause error:', e && e.message ? e.message : e);
      return false;
    }
  }

  setVolume(guildId, volumePercent) {
    const state = this._ensureGuild(guildId);
    const vol = Math.max(0, Math.min(100, volumePercent)) / 100;
    state.volume = vol;
    applyEffectiveVolumeToState(state);
    this._schedulePersist();
    return Math.round(vol * 100);
  }

  getVolume(guildId) {
    const state = this._ensureGuild(guildId);
    return Math.round(state.volume * 100);
  }

  setAudioPreset(guildId, presetName) {
    const state = this._ensureGuild(guildId);
    state.audioPreset = normalizeAudioPresetName(presetName);
    applyEffectiveVolumeToState(state);
    this._schedulePersist();
    return state.audioPreset;
  }

  applyAudioPresetNow(guildId) {
    const state = this._ensureGuild(guildId);
    if (!state.playing) return false;

    const current = { ...state.playing };
    const playbackMs = Number(state.resource && state.resource.playbackDuration) || 0;
    // Keep a tiny overlap to mask transition artifacts.
    const resumeAt = Math.max(0, Math.floor(playbackMs / 1000) - 1);
    if (resumeAt > 2) {
      current.resumeAt = resumeAt;
    }

    // In loop modes, remove one mirrored copy first to avoid duplicate growth.
    if (state.loopMode !== 'none' && Array.isArray(state.queue) && state.queue.length > 0) {
      const mirroredIndex = state.queue.findIndex((item) => isSameTrackIdentity(item, current));
      if (mirroredIndex >= 0) {
        state.queue.splice(mirroredIndex, 1);
      }
    }

    state.queue.unshift(current);
    state.playing = null;
    state.resource = null;

    this._killProcess(guildId);
    if (state.player) state.player.stop(true);
    this._schedulePersist();
    return true;
  }

  getAudioPreset(guildId) {
    const state = this._ensureGuild(guildId);
    return normalizeAudioPresetName(state.audioPreset);
  }

  getAudioPresetCatalog() {
    return getAudioPresetEntries();
  }

  setLoopMode(guildId, mode) {
    const state = this._ensureGuild(guildId);
    if (['none', 'track', 'queue'].includes(mode)) {
      state.loopMode = mode;
      this._schedulePersist();
    }
    return state.loopMode;
  }

  toggleAutoplay(guildId) {
    const state = this._ensureGuild(guildId);
    state.autoplay = !state.autoplay;
    this._schedulePersist();
    return state.autoplay;
  }

  toggleShuffle(guildId) {
    const state = this._ensureGuild(guildId);
    state.shuffle = !state.shuffle;
    if (state.shuffle && state.queue.length > 1) {
      // Simple Fisher-Yates shuffle
      for (let i = state.queue.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [state.queue[i], state.queue[j]] = [state.queue[j], state.queue[i]];
      }
    }
    this._schedulePersist();
    return state.shuffle;
  }

  getQueue(guildId) {
    const state = this._ensureGuild(guildId);
    return { 
      playing: state.playing, 
      queue: state.queue.slice(),
      loopMode: state.loopMode,
      shuffle: state.shuffle,
      autoplay: state.autoplay,
      volume: Math.round(state.volume * 100),
      audioPreset: normalizeAudioPresetName(state.audioPreset),
    };
  }

  flushPersistenceNow() {
    this._flushPersistedState();
  }

  getPersistenceInfo() {
    return {
      path: this._persistPath,
      lastPersistAt: this._lastPersistAt,
      activeGuildStates: this.guilds.size,
      pendingSnapshots: this._persistedSnapshots.size,
    };
  }

  getDiagnostics(guildId) {
    const state = this._ensureGuild(guildId);
    const connectionStatus = state.connection && state.connection.state ? state.connection.state.status : 'disconnected';
    const playerStatus = state.player && state.player.state ? state.player.state.status : 'idle';

    return {
      connectionStatus,
      playerStatus,
      queueLength: state.queue.length,
      hasPlaying: !!state.playing,
      playingTitle: state.playing ? (state.playing.title || state.playing.url || 'Unknown') : null,
      volume: Math.round(state.volume * 100),
      loopMode: state.loopMode,
      shuffle: !!state.shuffle,
      autoplay: !!state.autoplay,
      audioPreset: normalizeAudioPresetName(state.audioPreset),
      stay24h: !!state.stay24h,
      radioEnabled: !!(state.radio && state.radio.enabled),
      radioKeyword: state.radio ? state.radio.keyword : null,
      hasStreamProcess: !!(state.currentProcess && !state.currentProcess.killed),
      disconnectPending: !!state.disconnectTimer,
      lastTextChannelId: state.lastTextChannelId,
    };
  }

  _extractVideoId(url) {
    if (!url) return null;
    const match = url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/))([^&?#]+)/);
    return match ? match[1] : null;
  }

  getLastTextChannelId(guildId) {
    return this._ensureGuild(guildId).lastTextChannelId;
  }
}

module.exports = MusicPlayer;
