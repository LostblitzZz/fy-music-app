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
  }

  // ─── Internal helpers ────────────────────────────────────────────────────────

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
        radio:          { enabled: false, keyword: null },
        stay24h:        false,
        lastPlayed:     [],
        lastTextChannelId: null,
        maxQueue:       500,
        _playingNext:   false,   // guard against re-entrant _playNext calls
      };

    // ── Audio player state events ────────────────────────────────────────────
    audioPlayer.on('stateChange', (oldState, newState) => {
      console.log(`[player] Guild ${guildId} state: ${oldState.status} -> ${newState.status}`);
      
      if (
        oldState.status !== AudioPlayerStatus.Idle &&
        newState.status === AudioPlayerStatus.Idle
      ) {
        // Track ended — record it to lastPlayed to avoid radio repeat
        try {
          const s = this.guilds.get(guildId);
          if (s && s.playing) {
            const key = s.playing.url || s.playing.title || null;
            if (key) {
              s.lastPlayed.push(key);
              if (s.lastPlayed.length > 100) s.lastPlayed.shift();
            }
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

    const connection = joinVoiceChannel({
      channelId:      channel.id,
      guildId:        channel.guild.id,
      adapterCreator: channel.guild.voiceAdapterCreator,
      selfDeaf:       true,
    });

    connection.subscribe(state.player);
    state.connection = connection;

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

    const playerIdle =
      !state.playing &&
      state.player.state.status !== AudioPlayerStatus.Playing &&
      state.player.state.status !== AudioPlayerStatus.Buffering;

    if (playerIdle && !state._playingNext) {
      await this._playNext(guildId);
    }
  }

  // ─── Radio & 24/7 ────────────────────────────────────────────────────────────

  setRadio(guildId, enabled, keyword = null) {
    const state = this._ensureGuild(guildId);
    state.radio.enabled = !!enabled;
    state.radio.keyword = keyword;
    return state.radio;
  }

  getRadio(guildId) {
    return this._ensureGuild(guildId).radio;
  }

  setStay24h(guildId, enabled) {
    const state = this._ensureGuild(guildId);
    state.stay24h = !!enabled;
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
      const candidates = results.filter(r => {
        const key = r.url || r.title;
        return !exclude.includes(key);
      });
      const pool = candidates.length ? candidates : results;
      return pool[Math.floor(Math.random() * pool.length)];
    } catch (err) {
      console.error('[player] searchTrack error:', err && err.message ? err.message : err);
      return null;
    }
  }

  // ─── Playback core ───────────────────────────────────────────────────────────

  /** @private */
  async _playNext(guildId) {
    const state = this._ensureGuild(guildId);

    // Guard: prevent concurrent _playNext calls for the same guild
    if (state._playingNext) return;
    state._playingNext = true;

    try {
      const previousTrack = state.playing;
      state.playing = null;
      let next = state.queue.shift();

      if (!next) {
        // Queue empty — try Autoplay or radio recommendation
        if (state.autoplay && previousTrack) {
          try {
            let videoId = previousTrack.url ? this._extractVideoId(previousTrack.url) : null;

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
              const related = await play.getRelated(videoId, { limit: 10 });
              const pick = (related || []).find(r => !state.lastPlayed.includes(r.url)) || (related && related[0]);
              if (pick) {
                const rec = {
                  ...pick,
                  requestedBy: 'Autoplay 🔁',
                  textChannelId: state.lastTextChannelId,
                };
                this.emit('radioRecommend', guildId, rec); // reuse event name
                state.queue.push(rec);
                state._playingNext = false;
                return this._playNext(guildId);
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
              state._playingNext = false;
              return this._playNext(guildId);
            }
          } catch (err) {
            console.error('[player] Radio recommendation failed:', err && err.message ? err.message : err);
          }
        }

        // Nothing to play — leave VC unless 24/7 or radio enabled
        if (state.connection && !state.stay24h && !(state.radio && state.radio.enabled)) {
          try { state.connection.destroy(); } catch (e) {}
          state.connection = null;
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

        let streamInfo;
        const validate = play.yt_validate && play.yt_validate(source);

        if (validate === 'video') {
          // Direct YouTube URL
          streamInfo = await play.stream(source);
        } else if (/^https?:\/\//i.test(source)) {
          // Other direct URL (SoundCloud, etc.)
          streamInfo = await play.stream(source);
        } else {
          // Search query — resolve URL first, then stream
          const results = await play.search(source, { limit: 1 });
          if (!results || results.length === 0) throw new Error(`No results found for: "${source}"`);
          streamInfo = await play.stream(results[0].url);
          // Back-fill resolved metadata onto the track object
          if (!next.url)   next.url   = results[0].url;
          if (!next.title || next.title === source) next.title = results[0].title;
        }

        const inputStream = streamInfo && streamInfo.stream ? streamInfo.stream : null;
        if (!inputStream) throw new Error('No stream returned for source');

        // On Windows and with yt-dlp, it's safer to let ffmpeg handle the stream (Arbitrary)
        // because the stream type might not be raw opus packets.
        const inputType = StreamType.Arbitrary;

        const resource = createAudioResource(inputStream, { 
          inputType,
          inlineVolume: true 
        });

        if (resource.volume) resource.volume.setVolume(state.volume);

        console.log('[player] Playing:', next.title || next.url || '<unknown>');
        state.player.play(resource);
        state.playing        = next;
        state.resource       = resource;
        state.currentProcess = streamInfo.process || null;

        // Maintain history (last 20 URLs)
        if (next.url) {
          state.lastPlayed.push(next.url);
          if (state.lastPlayed.length > 20) state.lastPlayed.shift();
        }

        try { this.emit('trackStart', guildId, next); } catch (e) {}
      } catch (err) {
        console.error('[player] Failed to stream track — skipping:', err && err.message ? err.message : err);
        state._playingNext = false;
        setImmediate(() => this._playNext(guildId));
        return;
      }
    } finally {
      state._playingNext = false;
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
    if (state.resource && state.resource.volume) {
      state.resource.volume.setVolume(vol);
    }
    return Math.round(vol * 100);
  }

  getVolume(guildId) {
    const state = this._ensureGuild(guildId);
    return Math.round(state.volume * 100);
  }

  setLoopMode(guildId, mode) {
    const state = this._ensureGuild(guildId);
    if (['none', 'track', 'queue'].includes(mode)) {
      state.loopMode = mode;
    }
    return state.loopMode;
  }

  toggleAutoplay(guildId) {
    const state = this._ensureGuild(guildId);
    state.autoplay = !state.autoplay;
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
      volume: Math.round(state.volume * 100)
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
