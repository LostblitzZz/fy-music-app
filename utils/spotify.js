// Credit by Raitzu
'use strict';

const { makeEmbed } = require('./embeds');

let _spotifyClient = null;
let _spotifyFetch = null;

function init({ spotifyClient, spotifyFetch }) {
  _spotifyClient = spotifyClient || null;
  _spotifyFetch = spotifyFetch || null;
}

function setClient(client) { _spotifyClient = client; }
function getClient() { return _spotifyClient; }

function isSpotifyUrl(str) {
  return /open\.spotify\.com\/(track|playlist|album)\/.+/i.test(str) || /spotify:(track|playlist|album):/i.test(str);
}

function isYouTubeUrl(str) {
  return /^(?:https?:\/\/)?(?:www\.)?(?:music\.)?(?:youtube\.com|youtu\.be)\/.+/i.test(String(str));
}

function isSoundCloudUrl(str) {
  return /soundcloud\.com\/.+/i.test(str);
}

function isSoundCloudPlaylistUrl(str) {
  const text = String(str || '').toLowerCase().trim();
  if (!text.includes('soundcloud.com')) return false;
  return /soundcloud\.com\/[^/]+\/sets\//i.test(text);
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
  const search = primaryArtist ? `"${name}" "${primaryArtist}"` : `"${name}"`;
  if (!title && !search) return null;
  return { title: title || search, search: search || title, spotifyTitle: name, spotifyArtist: primaryArtist || artistText || '' };
}

async function spotifyGetData(url) {
  if (!_spotifyClient) return null;
  if (typeof _spotifyClient.getData === 'function') return _spotifyClient.getData(url);
  if (typeof _spotifyClient === 'function') return _spotifyClient(url);
  return null;
}

async function spotifyGetTracks(url, data) {
  if (_spotifyClient && typeof _spotifyClient.getTracks === 'function') {
    const tracks = await _spotifyClient.getTracks(url).catch(() => []);
    if (Array.isArray(tracks) && tracks.length > 0) return tracks;
  }
  if (Array.isArray(data && data.tracks) && data.tracks.length > 0) return data.tracks;
  if (Array.isArray(data && data.trackList) && data.trackList.length > 0) return data.trackList;
  if (Array.isArray(data && data.items) && data.items.length > 0) {
    return data.items.map((it) => (it && (it.track || it))).filter(Boolean);
  }
  return [];
}

async function validateYouTubeMusicLink(url, playShim, { timeoutMs = 1200 } = {}) {
  if (!isYouTubeUrl(url)) return { ok: true, normalizedUrl: url };
  if (!playShim || typeof playShim.getInfo !== 'function') return { ok: true, normalizedUrl: url };

  const safeTimeoutMs = Math.max(0, Number(timeoutMs) || 0);
  let info = null;

  if (safeTimeoutMs > 0) {
    info = await Promise.race([
      playShim.getInfo(url).catch(() => null),
      new Promise((resolve) => setTimeout(() => resolve(null), safeTimeoutMs)),
    ]);
  } else {
    info = await playShim.getInfo(url).catch(() => null);
  }

  if (!info) return { ok: true, normalizedUrl: url };
  return {
    ok: true,
    normalizedUrl: info.url || url,
    title: info.title || '',
    author: info.author || '',
    duration: info.duration || 0,
    thumbnail: info.thumbnail || '',
  };
}

async function handleSpotify(query, guildId, textChannelId, requestedBy, replyFn, player) {
  if (!isSpotifyUrl(query)) return { handled: false };
  if (!_spotifyClient) {
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
        items.push({ title: t.title, search: t.search, spotifyTitle: t.spotifyTitle, spotifyArtist: t.spotifyArtist, sourceHint: 'spotify', strictSearch: true, requestedBy, textChannelId });
      }

      if (items.length === 0) {
        await replyFn({ embeds: [makeEmbed('⚠️ Spotify', 'Playlist/album Spotify ini tidak punya track yang bisa diproses.')] });
        return { handled: true };
      }

      await player.enqueue(guildId, items);
      const sourceLabel = type === 'album' ? 'album Spotify' : 'playlist Spotify';
      const truncatedText = tracks.length > items.length ? `\n\n⚠️ Sebagian lagu tidak dimasukkan karena slot queue tersisa **${availableSlots}**.` : '';
      await replyFn({ embeds: [makeEmbed('✅ Queued', `Berhasil menambahkan **${items.length}** lagu dari ${sourceLabel}.${truncatedText}`)] });
      return { handled: true };
    }

    const normalized = normalizeSpotifyTrack(data && (data.track || data));
    if (normalized) {
      await player.enqueue(guildId, { title: normalized.title, search: normalized.search, spotifyTitle: normalized.spotifyTitle, spotifyArtist: normalized.spotifyArtist, sourceHint: 'spotify', strictSearch: true, requestedBy, textChannelId });
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

module.exports = {
  init, setClient, getClient,
  isSpotifyUrl, isYouTubeUrl, isSoundCloudUrl, isSoundCloudPlaylistUrl,
  getSpotifyUrlType, normalizeSpotifyTrack,
  validateYouTubeMusicLink, handleSpotify,
};
