// Credit by Raitzu
'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const {
  formatTime,
  formatBytes,
  createProgressBar,
  createVolumeBar,
  clampText,
} = require('./helpers');

const path = require('path');

const BOT_ICON_URL = 'https://cdn-icons-png.flaticon.com/512/3844/3844724.png';

function formatAudioPresetLabel(value, labelMap) {
  const key = String(value || 'flat').toLowerCase();
  if (labelMap && labelMap.has(key)) return labelMap.get(key);
  return key
    .split('_')
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Flat';
}

function getAudioPresetListText(catalog) {
  return (catalog || [])
    .map((item) => `• \`${item.value}\` — ${item.label}${item.description ? ` (${item.description})` : ''}`)
    .join('\n');
}

/** Create a simple single-field embed with the bot's brand colour. */
function makeEmbed(title, description) {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(String(description).substring(0, 4096))
    .setColor(0x1DB954);
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

function getQueueRemainingSeconds(player, guildId) {
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

/** Create a premium Spotify-like embed and button rows. */
function makePremiumEmbed(player, guildId, track, presetLabelMap) {
  const q = player.getQueue(guildId);
  const playbackMs = player.guilds.get(guildId)?.resource?.playbackDuration || 0;
  
  const bar = createProgressBar(playbackMs, track.duration);
  const volBar = createVolumeBar(q.volume);
  const timeInfo = `\`${formatTime(playbackMs / 1000)} / ${formatTime(track.duration)}\``;
  const presetLabel = formatAudioPresetLabel(q.audioPreset, presetLabelMap);
  
  const loopLabel = q.loopMode === 'track' ? '🔂' : (q.loopMode === 'queue' ? '🔁' : '➡️');
  const shuffleLabel = q.shuffle ? '✅' : '❌';

  const queueList = q.queue.length > 0 
    ? q.queue.slice(0, 5).map((s, i) => `\`${i + 1}.\` ${String(s.title || s.url).substring(0, 40)}`).join('\n')
    : '_Antrian kosong_';

  const embed = new EmbedBuilder()
    .setAuthor({ name: 'Fy Music APP', iconURL: BOT_ICON_URL })
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
    .setColor(0x1DB954)
    .setFooter({ 
      text: `Requested by ${track.requestedBy || 'Unknown'} • ${new Date().toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' })}`,
      iconURL: track.thumbnail || null
    });

  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('player_pause_resume').setLabel('⏯️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('player_skip').setLabel('⏭️').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('player_stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId('player_loop').setLabel(loopLabel).setStyle(q.loopMode !== 'none' ? ButtonStyle.Success : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('player_shuffle').setLabel('🔀').setStyle(q.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('player_vol_down').setLabel('🔉 -10').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('player_vol_up').setLabel('🔊 +10').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('player_autoplay').setLabel('♾️ Autoplay').setStyle(q.autoplay ? ButtonStyle.Success : ButtonStyle.Secondary)
  );

  const row3 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('player_queue').setLabel('📜 Full Queue').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('player_lyrics').setLabel('📃 Lyrics').setStyle(ButtonStyle.Secondary)
  );

  return { embed, rows: [row1, row2, row3] };
}

function makeQueueOverviewEmbed(player, guildId, presetLabelMap, limit = 20) {
  const q = player.getQueue(guildId);
  const current = q.playing;
  const remainingSecs = getQueueRemainingSeconds(player, guildId);
  const totalTracks = q.queue.length + (current ? 1 : 0);
  const presetLabel = formatAudioPresetLabel(q.audioPreset, presetLabelMap);

  const upNextRaw = q.queue.length > 0
    ? q.queue.slice(0, limit).map((t, i) => {
      const title = clampText(t.title || t.search || t.url || 'Unknown', 58);
      const dur = formatTime(Number(t.duration) || 0);
      return `\`${i + 1}.\` [${dur}] ${title}`;
    }).join('\n')
    : '_Antrian kosong_';
  const upNext = clampText(upNextRaw, 1000);
  const modeLine = `Loop: \`${q.loopMode}\` • Shuffle: ${q.shuffle ? '✅' : '❌'} • Autoplay: ${q.autoplay ? '✅' : '❌'}`;

  return new EmbedBuilder()
    .setAuthor({ name: 'Fy Music APP', iconURL: BOT_ICON_URL })
    .setTitle('📋 Queue Overview')
    .setDescription(
      current
        ? `**Now:** ${clampText(current.title || current.url || 'Unknown', 120)}\nSumber: \`${getTrackSourceLabel(current)}\``
        : 'Belum ada lagu yang sedang diputar.'
    )
    .addFields(
      {
        name: '🎛 Session Stats',
        value: `Total Track: **${totalTracks}**\nSisa Durasi: **${formatTime(remainingSecs)}**\nVolume: **${q.volume}%**\n${modeLine}\nPreset: \`${presetLabel}\``,
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
}

function makeNowPlayingInfoEmbed(player, guildId, presetLabelMap) {
  const q = player.getQueue(guildId);
  const track = q.playing;
  if (!track) return makeEmbed('🎵 Now Playing', 'Nothing is playing right now.');

  const playbackMs = player.guilds.get(guildId)?.resource?.playbackDuration || 0;
  const bar = createProgressBar(playbackMs, track.duration);
  const timeInfo = `\`${formatTime(playbackMs / 1000)} / ${formatTime(track.duration)}\``;
  const modeLine = `Loop: \`${q.loopMode}\` • Shuffle: ${q.shuffle ? '✅' : '❌'} • Autoplay: ${q.autoplay ? '✅' : '❌'}`;
  const presetLabel = formatAudioPresetLabel(q.audioPreset, presetLabelMap);

  return new EmbedBuilder()
    .setAuthor({ name: 'Fy Music APP', iconURL: BOT_ICON_URL })
    .setTitle(clampText(track.title || 'Unknown Title', 250))
    .setURL(track.url || null)
    .setThumbnail(track.thumbnail || null)
    .setDescription(
      `**${track.author || 'Unknown Artist'}**\n${bar}\n${timeInfo}\n\nSumber: \`${getTrackSourceLabel(track)}\``
    )
    .addFields({
      name: '🎚 Playback',
      value: `Volume: **${q.volume}%**\n${modeLine}\nPreset: \`${presetLabel}\``,
      inline: false,
    })
    .setColor(0x1DB954)
    .setFooter({ text: `Requested by ${track.requestedBy || 'Unknown'}` });
}

function makeHealthEmbed(player, client, guildId, presetLabelMap) {
  const diag = player.getDiagnostics(guildId);
  const persist = player.getPersistenceInfo();
  const mem = process.memoryUsage();
  const nowTrack = diag.playingTitle ? clampText(diag.playingTitle, 80) : '-';
  const persistPath = persist.path ? path.relative(process.cwd(), persist.path) : 'data/player-state.json';
  const presetLabel = formatAudioPresetLabel(diag.audioPreset, presetLabelMap);

  return new EmbedBuilder()
    .setAuthor({ name: 'Fy Music APP', iconURL: BOT_ICON_URL })
    .setTitle('🩺 Bot Health')
    .setColor(0x1DB954)
    .addFields(
      {
        name: '⚙️ Runtime',
        value: `Uptime: **${formatTime(Math.floor(process.uptime()))}**\nPing: **${Math.max(0, Math.round(client.ws.ping || 0))} ms**\nNode: **${process.version}**`,
        inline: true,
      },
      {
        name: '🧠 Memory',
        value: `RSS: **${formatBytes(mem.rss)}**\nHeap Used: **${formatBytes(mem.heapUsed)}**\nHeap Total: **${formatBytes(mem.heapTotal)}**`,
        inline: true,
      },
      {
        name: '🔊 Voice Engine',
        value: `Connection: **${diag.connectionStatus}**\nPlayer: **${diag.playerStatus}**\nStream Process: **${diag.hasStreamProcess ? 'ON' : 'OFF'}**\nDisconnect Pending: **${diag.disconnectPending ? 'YES' : 'NO'}**`,
        inline: false,
      },
      {
        name: '🎵 Queue State',
        value: `Now: **${nowTrack}**\nQueued: **${diag.queueLength}**\nVolume: **${diag.volume}%**\nPreset: **${presetLabel}**\nLoop: **${diag.loopMode}** • Shuffle: **${diag.shuffle ? 'ON' : 'OFF'}**`,
        inline: false,
      },
      {
        name: '🛡️ Safety & Recovery',
        value: `Autoplay: **${diag.autoplay ? 'ON' : 'OFF'}**\n24/7: **${diag.stay24h ? 'ON' : 'OFF'}**\nRadio: **${diag.radioEnabled ? `ON (${diag.radioKeyword || '-'})` : 'OFF'}**\nSnapshot: **${persistPath}**`,
        inline: false,
      }
    )
    .setFooter({
      text: `Saved: ${persist.lastPersistAt ? new Date(persist.lastPersistAt).toLocaleString('id-ID') : 'never'} • Guild State: ${persist.activeGuildStates}`,
    });
}

module.exports = {
  makeEmbed,
  makePremiumEmbed,
  makeQueueOverviewEmbed,
  makeNowPlayingInfoEmbed,
  makeHealthEmbed,
  formatAudioPresetLabel,
  getAudioPresetListText,
  getTrackSourceLabel,
};
