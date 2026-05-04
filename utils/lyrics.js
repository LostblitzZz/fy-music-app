// Credit by Raitzu
'use strict';

const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require('discord.js');

const {
  cleanTitle,
  cleanArtistName,
  cleanLyricsTitle,
  normalizeLookupText,
  tokenizeLookupText,
  tokenOverlapRatio,
  clampText,
  withTimeout,
} = require('./helpers');

// ── Config ────────────────────────────────────────────────────────────────────

const LYRICS_PAGE_MAX_CHARS = 1500;
const LYRICS_MAX_PAGES = 10;
const LYRICS_SESSION_TTL_MS = 12 * 60 * 1000;
const LYRICS_MAX_SESSIONS = 250;

// ── State ─────────────────────────────────────────────────────────────────────

const lyricsSessions = new Map();
let _geniusClient = null;
let _lyricsFinder = null;
let _spotifyFetch = null;

function init({ geniusClient, lyricsFinder, spotifyFetch }) {
  _geniusClient = geniusClient || null;
  _lyricsFinder = lyricsFinder || null;
  _spotifyFetch = spotifyFetch || null;
}

// ── Text helpers ──────────────────────────────────────────────────────────────

function buildArtistVariants(artist) {
  const base = cleanArtistName(artist);
  if (!base) return [];
  const variants = new Set([base]);
  const parts = base
    .split(/\s*(?:,|&|\/|\+|\bx\b|\band\b)\s*/i)
    .map((part) => cleanArtistName(part))
    .filter(Boolean);
  for (const part of parts) variants.add(part);
  const primary = parts[0] || '';
  if (primary) {
    variants.delete(primary);
    return [base, primary, ...Array.from(variants)];
  }
  return Array.from(variants);
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
    const segments = title.split(/\s*-\s*/).map((part) => cleanLyricsTitle(part)).filter(Boolean);
    if (segments.length >= 2 && artistCandidates.length > 0) {
      if (segments.length > 1 && isLikelyArtistSegment(segments[0], artistCandidates)) segments.shift();
      if (segments.length > 1 && isLikelyArtistSegment(segments[segments.length - 1], artistCandidates)) segments.pop();
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

  return { title: title || cleanTitle(track.title || ''), artist };
}

// ── Scoring ───────────────────────────────────────────────────────────────────

function hasLyricsVersionPenalty(text) {
  return /\b(cover|karaoke|instrumental|remix|nightcore|slowed|sped up|8d)\b/i.test(text);
}

function scoreLyricsCandidate(candidate, expectedTitle, expectedArtist) {
  const candidateTitle = normalizeLookupText(candidate && (candidate.title || candidate.fullTitle));
  const candidateArtist = normalizeLookupText(
    candidate && candidate.artist ? (candidate.artist.name || candidate.artist.fullName || candidate.artist) : ''
  );
  const candidateFull = normalizeLookupText([
    candidate && candidate.fullTitle, candidate && candidate.title,
    candidate && candidate.artist && (candidate.artist.name || candidate.artist.fullName || candidate.artist),
  ].filter(Boolean).join(' '));

  const targetTitle = normalizeLookupText(expectedTitle);
  const targetArtist = normalizeLookupText(expectedArtist);
  const titleTokens = tokenizeLookupText(targetTitle);
  const artistTokens = tokenizeLookupText(targetArtist);

  let score = 0, titleHits = 0, artistHits = 0;

  if (targetTitle && candidateTitle === targetTitle) { score += 18; titleHits += 3; }
  else if (targetTitle && candidateTitle.includes(targetTitle)) { score += 12; titleHits += 2; }
  for (const token of titleTokens) { if (candidateTitle.includes(token)) { score += 2; titleHits += 1; } }

  if (targetArtist) {
    if (candidateArtist === targetArtist) { score += 16; artistHits += 3; }
    else if (candidateArtist.includes(targetArtist)) { score += 10; artistHits += 2; }
    if (candidateTitle.includes(targetArtist) || candidateFull.includes(targetArtist)) { score += 3; artistHits += 1; }
    for (const token of artistTokens) {
      if (candidateArtist.includes(token)) { score += 4; artistHits += 1; }
      else if (candidateTitle.includes(token)) { score += 1; artistHits += 0.5; }
    }
  }

  if (hasLyricsVersionPenalty(candidateTitle)) score -= 6;
  if (/\blive\b/.test(candidateTitle)) score -= 2;
  return { score, titleHits, artistHits };
}

function pickBestLyricsCandidate(candidates, expectedTitle, expectedArtist) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null;
  const scored = candidates
    .map((candidate) => ({ candidate, ...scoreLyricsCandidate(candidate, expectedTitle, expectedArtist) }))
    .sort((a, b) => b.score - a.score);
  const best = scored[0];
  if (!best) return null;
  const hasArtist = !!normalizeLookupText(expectedArtist);
  if (best.score < (hasArtist ? 16 : 8)) return null;
  if (best.titleHits <= 0) return null;
  if (hasArtist && best.artistHits < 1) return null;
  return best.candidate;
}

// ── Body normalization ────────────────────────────────────────────────────────

function normalizeLyricsBody(raw) {
  if (!raw) return '';
  let text = String(raw).replace(/\r/g, '').replace(/\n?You might also like[\s\S]*$/i, '').replace(/\n?\d*Embed\s*$/i, '').trim();
  if (/^lyrics\s*$/i.test(text)) return '';
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function isUsableLyricsBody(text) {
  const value = String(text || '').trim();
  if (value.length < 45) return false;
  if (/\b(no lyrics|lyrics not found|not found|instrumental)\b/i.test(value)) return false;
  if (/we are not authorized|copyright/i.test(value)) return false;
  return true;
}

// ── Query builders ────────────────────────────────────────────────────────────

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

// ── Fetch helper ──────────────────────────────────────────────────────────────

async function fetchJsonWithTimeout(url, timeoutMs = 7000) {
  const fetchFn = _spotifyFetch || (typeof globalThis.fetch === 'function' ? globalThis.fetch : null);
  if (!fetchFn) return null;
  let timer = null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  try {
    if (controller) timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchFn(url, {
      signal: controller ? controller.signal : undefined,
      headers: { 'User-Agent': 'fy-music-app/1.0' },
    });
    if (!response || !response.ok) return null;
    return response.json().catch(() => null);
  } catch (err) { return null; }
  finally { if (timer) clearTimeout(timer); }
}

// ── Providers ─────────────────────────────────────────────────────────────────

async function tryGeniusLyrics(target) {
  if (!_geniusClient || !target || !target.title) return null;
  const seen = new Set();
  const queries = buildLyricsQueries(target);
  for (const query of queries) {
    let candidates = [];
    try { candidates = await withTimeout(_geniusClient.songs.search(query), 8500, 'genius-search'); }
    catch (err) { continue; }
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
        lyrics, source: 'Genius',
        matchedTitle: best.title || target.title,
        matchedArtist: cleanArtistName(best.artist && (best.artist.name || best.artist.fullName || best.artist)) || target.artist || '',
      };
    } catch (err) { continue; }
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
      return { lyrics, source: 'lyrics.ovh', matchedTitle: title, matchedArtist: artist };
    }
  }
  return null;
}

async function tryLegacyLyricsFinder(target) {
  if (!_lyricsFinder || !target || !target.title) return null;
  const artistVariants = target.artist ? new Set(buildArtistVariants(target.artist)) : new Set(['']);
  for (const artist of artistVariants) {
    try {
      const rawLyrics = await withTimeout(_lyricsFinder(artist || '', target.title), 9000, 'lyrics-finder');
      const lyrics = normalizeLyricsBody(rawLyrics);
      if (!isUsableLyricsBody(lyrics)) continue;
      return { lyrics, source: 'lyrics-finder', matchedTitle: target.title, matchedArtist: artist || '' };
    } catch (err) { continue; }
  }
  if (!target.artist) {
    try {
      const rawLyrics = await withTimeout(_lyricsFinder('', target.title), 9000, 'lyrics-finder');
      const lyrics = normalizeLyricsBody(rawLyrics);
      if (isUsableLyricsBody(lyrics)) {
        return { lyrics, source: 'lyrics-finder', matchedTitle: target.title, matchedArtist: '' };
      }
    } catch (err) {}
  }
  return null;
}

// ── Main lookup ───────────────────────────────────────────────────────────────

async function getTrackLyricsStrict(track) {
  const target = parseLyricsTarget(track);
  if (!target.title) {
    return { ok: false, target, reason: 'Judul lagu tidak bisa dikenali untuk pencarian lirik.' };
  }
  const providers = [tryGeniusLyrics, tryLyricsOvh, tryLegacyLyricsFinder];
  for (const provider of providers) {
    const result = await provider(target);
    if (result && result.lyrics) return { ok: true, target, ...result };
  }
  const reason = target.artist
    ? `Lirik akurat untuk **${target.title}** - **${target.artist}** belum ditemukan.`
    : `Lirik akurat untuk **${target.title}** belum ditemukan.`;
  return { ok: false, target, reason };
}

// ── Session management ────────────────────────────────────────────────────────

function pruneLyricsSessions() {
  const now = Date.now();
  for (const [sessionId, session] of lyricsSessions.entries()) {
    if (!session || now - session.updatedAt > LYRICS_SESSION_TTL_MS) lyricsSessions.delete(sessionId);
  }
  if (lyricsSessions.size <= LYRICS_MAX_SESSIONS) return;
  const ordered = Array.from(lyricsSessions.entries()).sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
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
  const pushBuffer = () => { if (buffer.trim()) { pages.push(buffer.trim()); buffer = ''; } };
  for (const originalLine of lines) {
    let line = String(originalLine || '');
    if (line.length > maxChars) { pushBuffer(); while (line.length > maxChars) { pages.push(line.slice(0, maxChars).trim()); line = line.slice(maxChars); } buffer = line; continue; }
    const candidate = buffer ? `${buffer}\n${line}` : line;
    if (candidate.length <= maxChars) { buffer = candidate; continue; }
    pushBuffer(); buffer = line;
  }
  pushBuffer();
  const cleanPages = pages.filter((p) => p && p.trim());
  if (cleanPages.length === 0) return ['Lirik kosong.'];
  return cleanPages.slice(0, LYRICS_MAX_PAGES);
}

function getLyricsSession(sessionId) {
  if (!sessionId) return null;
  pruneLyricsSessions();
  const session = lyricsSessions.get(sessionId);
  if (!session) return null;
  if (Date.now() - session.updatedAt > LYRICS_SESSION_TTL_MS) { lyricsSessions.delete(sessionId); return null; }
  return session;
}

function deleteLyricsSession(sessionId) {
  lyricsSessions.delete(sessionId);
}

function makeLyricsNavigationRow(sessionId, pageIndex, totalPages) {
  const current = Math.max(0, Math.min(totalPages - 1, Number(pageIndex) || 0));
  const isSinglePage = totalPages <= 1;
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`lyrics_nav:${sessionId}:prev`).setLabel('⬅️ Prev').setStyle(ButtonStyle.Secondary).setDisabled(isSinglePage || current <= 0),
    new ButtonBuilder().setCustomId(`lyrics_nav:${sessionId}:close`).setLabel('✖ Close').setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`lyrics_nav:${sessionId}:next`).setLabel('Next ➡️').setStyle(ButtonStyle.Secondary).setDisabled(isSinglePage || current >= totalPages - 1)
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
      ? (session.targetArtist ? `Target: **${session.targetTitle}** - **${session.targetArtist}**` : `Target: **${session.targetTitle}**`)
      : null,
    session && session.matchedTitle
      ? `Match: **${session.matchedTitle}**${session.matchedArtist ? ` - **${session.matchedArtist}**` : ''}`
      : null,
    '', body,
  ].filter(Boolean);
  return new EmbedBuilder()
    .setTitle('📃 Lyrics')
    .setDescription(lines.join('\n').substring(0, 4096))
    .setColor(0x1DB954)
    .setFooter({ text: `Sumber: ${session && session.source ? session.source : 'unknown'} • Halaman ${current + 1}/${safeTotal} • strict-filtered` });
}

function makeLyricsResultMessage(track, result, ownerId, guildId) {
  pruneLyricsSessions();
  const target = result && result.target ? result.target : parseLyricsTarget(track);
  const pages = splitLyricsIntoPages(result && result.lyrics ? result.lyrics : '');
  const sessionId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
  lyricsSessions.set(sessionId, {
    ownerId: ownerId || null, guildId: guildId || null,
    displayTitle: clampText((track && track.title) || target.title || 'Unknown Title', 220),
    targetTitle: target && target.title ? target.title : '',
    targetArtist: target && target.artist ? target.artist : '',
    matchedTitle: result && result.matchedTitle ? result.matchedTitle : '',
    matchedArtist: result && result.matchedArtist ? result.matchedArtist : '',
    source: result && result.source ? result.source : 'unknown',
    pages, page: 0, updatedAt: Date.now(),
  });
  const session = getLyricsSession(sessionId);
  if (!session) {
    const { makeEmbed } = require('./embeds');
    return { embeds: [makeEmbed('📃 Lyrics', 'Sesi lirik gagal dibuat. Coba lagi.')] };
  }
  const embed = makeLyricsPageEmbed(session, 0);
  if (session.pages.length <= 1) return { embeds: [embed] };
  return { embeds: [embed], components: [makeLyricsNavigationRow(sessionId, 0, session.pages.length)] };
}

module.exports = {
  init,
  getTrackLyricsStrict,
  getLyricsSession,
  deleteLyricsSession,
  makeLyricsNavigationRow,
  makeLyricsPageEmbed,
  makeLyricsResultMessage,
  parseLyricsTarget,
};
