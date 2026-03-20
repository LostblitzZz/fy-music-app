// Credit by Raitzu
'use strict';

require('dotenv').config();

// ── FFmpeg path setup (ffmpeg-static) ─────────────────────────────────────────
try {
  const ffmpegStatic = require('ffmpeg-static');
  const path = require('path');
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
const yts         = require('yt-search');
const lyricsFinder = require('lyrics-finder');

// ── Spotify support ───────────────────────────────────────────────────────────
let getSpotifyData = null;
(async () => {
  try {
    const s       = require('spotify-url-info');
    const factory = s && (s.default || s);
    if (typeof factory === 'function') {
      getSpotifyData = factory(fetch);
    } else if (s && (s.getTracks || s.getData || s.getPreview)) {
      getSpotifyData = s;
    }
  } catch (err) {
    try {
      const mod     = await import('spotify-url-info');
      const factory = mod && (mod.default || mod);
      if (typeof factory === 'function') {
        getSpotifyData = factory(fetch);
      } else if (mod && (mod.getTracks || mod.getData)) {
        getSpotifyData = mod;
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

/** Clean song title from junk like [Official Video], (Lyrics), etc. */
function cleanTitle(title) {
  if (!title) return '';
  return title
    .replace(/\(?(?:official|music|video|audio|lyrics|hd|4k)\)?/gi, '')
    .replace(/[\[\]]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Create a premium Spotify-like embed and button rows. */
function makePremiumEmbed(guildId, track) {
  const q = player.getQueue(guildId);
  const playbackMs = player.guilds.get(guildId)?.resource?.playbackDuration || 0;
  
  const bar = createProgressBar(playbackMs, track.duration);
  const volBar = createVolumeBar(q.volume);
  const timeInfo = `\`${formatTime(playbackMs / 1000)} / ${formatTime(track.duration)}\``;
  
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
      `Loop: \`${q.loopMode}\` • Shuffle: ${shuffleLabel} • Autoplay: ${q.autoplay ? '✅' : '❌'}`
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

function isSpotifyUrl(str) {
  return /open\.spotify\.com\/(track|playlist|album)\/.+/.test(str) || /spotify:track:/.test(str);
}

function isYouTubeUrl(str) {
  return /(?:youtube\.com\/watch\?v=|youtu\.be\/)/.test(str);
}

function isSoundCloudUrl(str) {
  return /soundcloud\.com\/.+/i.test(str);
}

/**
 * Consistently handle Spotify links — shared between prefix and slash handlers.
 * Returns { handled: true } or { handled: false }.
 */
async function handleSpotify(query, guildId, textChannelId, requestedBy, replyFn) {
  if (!isSpotifyUrl(query) || !getSpotifyData) return { handled: false };
  try {
    const data = await getSpotifyData(query);

    // Playlist
    if (data && data.type === 'playlist' && Array.isArray(data.tracks)) {
      const limit = Math.min(50, data.tracks.length);
      const items = [];
      for (let i = 0; i < limit; i++) {
        const t     = data.tracks[i];
        const title = `${t.name}${t.artists ? ' - ' + t.artists.map(a => a.name).join(', ') : ''}`;
        const search = `${t.name} ${t.artists && t.artists.length ? t.artists[0].name : ''}`;
        items.push({ title, search, requestedBy, textChannelId });
      }
      await player.enqueue(guildId, items);
      await replyFn({ embeds: [makeEmbed('✅ Queued', `Added **${limit}** tracks from Spotify playlist.`)] });
      return { handled: true };
    }

    // Single track
    if (data && (data.type === 'track' || data.track || data.name)) {
      const t      = data.track || data;
      const title  = `${t.name}${t.artists ? ' - ' + t.artists.map(a => a.name).join(', ') : ''}`;
      const search = `${t.name} ${t.artists && t.artists.length ? t.artists[0].name : ''}`;
      await player.enqueue(guildId, { title, search, requestedBy, textChannelId });
      await replyFn({ embeds: [makeEmbed('✅ Queued', `Added **${title}** (via Spotify → YouTube).`)] });
      return { handled: true };
    }

    await replyFn({ embeds: [makeEmbed('⚠️ Spotify', 'Could not parse this Spotify link.')] });
    return { handled: true };
  } catch (err) {
    console.error('[bot] Spotify parse error:', err && err.message ? err.message : err);
    await replyFn({ embeds: [makeEmbed('❌ Error', 'Failed to parse Spotify link.')] });
    return { handled: true };
  }
}

// ── Slash command definitions ─────────────────────────────────────────────────

const slashCommands = [
  {
    name: 'play',
    description: 'Play a song — search YouTube or paste a URL',
    options: [{
      name: 'query', type: 3, description: 'Song name or URL', required: true, autocomplete: true,
    }],
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

    // Helper: ensure user in voice for buttons too
    const memberVC = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
    if (!memberVC) return interaction.reply({ content: '❌ You must be in a voice channel to use buttons!', flags: MessageFlags.Ephemeral });

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
        const cleanT = cleanTitle(q.playing.title || '');
        const lyrics = await lyricsFinder(q.playing.author || '', cleanT) || await lyricsFinder('', cleanT) || 'Lirik tidak ditemukan untuk lagu ini.';
        const embed = makeEmbed('📃 Lyrics', `**${q.playing.title}**\n\n${lyrics.substring(0, 4000)}`);
        await interaction.editReply({ embeds: [embed] });
      } else if (customId === 'player_queue') {
        const q = player.getQueue(guildId);
        const lines = [];
        if (q.playing) lines.push(`**Now:** ${q.playing.title || 'Unknown'}`);
        q.queue.slice(0, 10).forEach((t, i) => lines.push(`${i + 1}. ${t.title || t.search || t.url}`));
        if (q.queue.length > 10) lines.push(`…and **${q.queue.length - 10}** more`);
        await interaction.reply({ embeds: [makeEmbed('📋 Queue', lines.join('\n') || 'Queue is empty.')], flags: MessageFlags.Ephemeral });
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
      const query = interaction.options.getFocused();
      if (!query || String(query).length < 2) {
        return interaction.respond([{ name: 'Ketik minimal 2 huruf...', value: 'none' }]).catch(() => {});
      }
      try {
        const res = await Promise.race([
          yts(String(query)),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 1500)),
        ]);
        const videos  = res && res.videos ? res.videos.slice(0, 5) : [];
        const choices = videos.map(v => ({
          name:  (v && v.title ? v.title : 'Unknown').substring(0, 100),
          value: v.url || 'none',
        }));
        await interaction.respond(choices.length ? choices : [{ name: 'Tidak ditemukan', value: 'none' }]).catch(() => {});
      } catch (err) {
        const msg = err && err.message ? err.message : String(err);
        if (msg !== 'timeout') console.error('[bot] Autocomplete error:', msg);
        await interaction.respond([{ name: 'Timeout / error', value: 'none' }]).catch(() => {});
      }
    }
    return;
  }

  // ── Chat input (slash) commands ─────────────────────────────────────────────
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  // Helper: ensure the user is in a voice channel
  const ensureMemberVC = () => {
    const vc = interaction.member && interaction.member.voice ? interaction.member.voice.channel : null;
    if (!vc) throw new Error('You must be in a voice channel to use this command.');
    return vc;
  };

  try {
    // /play
    if (commandName === 'play') {
      const query    = interaction.options.getString('query', true);
      const memberVC = ensureMemberVC();
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });
      await player.join(memberVC);

      // Spotify
      const { handled } = await handleSpotify(
        query, interaction.guildId, interaction.channelId, interaction.user.tag,
        (payload) => interaction.editReply(payload)
      );
      if (handled) return;

      // Direct YouTube / SoundCloud URL
      if (isYouTubeUrl(query) || isSoundCloudUrl(query)) {
        await player.enqueue(interaction.guildId, { title: query, url: query, requestedBy: interaction.user.tag, textChannelId: interaction.channelId });
        return interaction.editReply({ embeds: [makeEmbed('✅ Queued', `Added link: ${query}`)] }); // ephemeral already set via deferReply
      }

      // Search query
      await player.enqueue(interaction.guildId, { title: query, search: query, requestedBy: interaction.user.tag, textChannelId: interaction.channelId });
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
      const q     = player.getQueue(interaction.guildId);
      const lines = [];
      if (q.playing) lines.push(`**Now:** ${q.playing.title || 'Unknown'}`);
      q.queue.slice(0, 20).forEach((t, i) => lines.push(`${i + 1}. ${t.title || t.search || t.url}`));
      if (q.queue.length > 20) lines.push(`…and **${q.queue.length - 20}** more`);
      return interaction.reply({ embeds: [makeEmbed('📋 Queue', lines.join('\n') || 'Queue is empty.')], flags: MessageFlags.Ephemeral });
    }

    // /np
    if (commandName === 'np') {
      const q = player.getQueue(interaction.guildId);
      if (!q.playing) return interaction.reply({ embeds: [makeEmbed('🎵 Now Playing', 'Nothing is playing right now.')], flags: MessageFlags.Ephemeral });
      return interaction.reply({ embeds: [makeEmbed('🎵 Now Playing', q.playing.title || q.playing.url || 'Unknown')], flags: MessageFlags.Ephemeral });
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
      const cleanT = cleanTitle(q.playing.title || '');
      const lyrics = await lyricsFinder(q.playing.author || '', cleanT) || await lyricsFinder('', cleanT) || 'Lirik tidak ditemukan untuk lagu ini.';
      const embed = makeEmbed('📃 Lyrics', `**${q.playing.title}**\n\n${lyrics.substring(0, 4000)}`);
      return interaction.editReply({ embeds: [embed] });
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

    // /help
    if (commandName === 'help') {
      const lines = [
        '`/play <query>` — Play from YouTube/SoundCloud/Spotify',
        '`/skip` — Skip current track',
        '`/stop` — Stop and clear queue',
        '`/pause` / `/resume` — Pause / resume',
        '`/queue` — Show queue',
        '`/np` — Show now playing',
        '`/radio` — Pilih stasiun radio genre',
        '`/autoplay` — Toggle autoplay (related songs)',
        '`/volume <0-100>` — Set bot volume',
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

    // ── !play ──────────────────────────────────────────────────────────────────
    if (cmd === 'play') {
      const query = args.join(' ');
      if (!query) return reply({ embeds: [makeEmbed('❌ Error', 'Please provide a song name or link.')] });

      const memberVC = message.member && message.member.voice ? message.member.voice.channel : null;
      if (!memberVC) return reply({ embeds: [makeEmbed('❌ Error', 'You must be in a voice channel.')] });

      await player.join(memberVC);
      const searching = await reply({ content: '🔍 Searching...' });
      const edit      = (payload) => searching ? searching.edit(payload).catch(() => {}) : Promise.resolve();

      // Spotify
      const { handled } = await handleSpotify(
        query, message.guild.id, message.channel.id, message.author.tag, edit
      );
      if (handled) return;

      // Direct URL
      if (isYouTubeUrl(query) || isSoundCloudUrl(query)) {
        await player.enqueue(message.guild.id, { title: query, url: query, requestedBy: message.author.tag, textChannelId: message.channel.id });
        return edit({ embeds: [makeEmbed('✅ Queued', `Added link: ${query}`)] });
      }

      // Search
      await player.enqueue(message.guild.id, { title: query, search: query, requestedBy: message.author.tag, textChannelId: message.channel.id });
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
      const q     = player.getQueue(message.guild.id);
      const lines = [];
      if (q.playing) lines.push(`**Now:** ${q.playing.title || 'Unknown'}`);
      q.queue.slice(0, 20).forEach((t, i) => lines.push(`${i + 1}. ${t.title || t.search || t.url}`));
      if (q.queue.length > 20) lines.push(`…and **${q.queue.length - 20}** more`);
      return reply({ embeds: [makeEmbed('📋 Queue', lines.join('\n') || 'Queue is empty.')] });
    }

    // ── !nowplaying / !np ──────────────────────────────────────────────────────
    if (cmd === 'nowplaying' || cmd === 'np') {
      const q = player.getQueue(message.guild.id);
      if (!q.playing) return reply({ embeds: [makeEmbed('🎵 Now Playing', 'Nothing is playing right now.')] });
      return reply({ embeds: [makeEmbed('🎵 Now Playing', q.playing.title || q.playing.url || 'Unknown')] });
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
      const cleanT = cleanTitle(q.playing.title || '');
      const lyrics = await lyricsFinder(q.playing.author || '', cleanT) || await lyricsFinder('', cleanT) || 'Lirik tidak ditemukan untuk lagu ini.';
      const embed = makeEmbed('📃 Lyrics', `**${q.playing.title}**\n\n${lyrics.substring(0, 4000)}`);
      return wait ? wait.edit({ content: null, embeds: [embed] }) : reply({ embeds: [embed] });
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

    // ── !help ──────────────────────────────────────────────────────────────────
    if (cmd === 'help' || cmd === 'commands') {
      const lines = [
        '`!play <query|url>` — Play from YouTube/SoundCloud/Spotify',
        '`!skip` — Skip current track',
        '`!stop` — Stop and clear queue',
        '`!pause` / `!resume` — Pause / resume',
        '`!queue` — Show queue',
        '`!nowplaying` / `!np` — Show now playing',
        '`!radio <keyword>` — Start radio autoplay',
        '`!radio stop` — Stop radio',
        '`!autoplay` — Toggle autoplay mode',
        '`!volume <0-100>` — Set bot volume',
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
