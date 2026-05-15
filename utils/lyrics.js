// Credit by Raitzu
'use strict';

const fs = require('fs');
const path = require('path');

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
const LYRICS_OVERRIDE_FILE = path.join(process.cwd(), 'data', 'lyrics-overrides.json');

// ── State ─────────────────────────────────────────────────────────────────────

const lyricsSessions = new Map();
const lyricsOverrides = new Map();
let _geniusClient = null;
let _lyricsFinder = null;
let _spotifyFetch = null;
let _musixmatchKey = null;
let _resolveTrackInfo = null;

function init({ geniusClient, lyricsFinder, spotifyFetch, musixmatchKey, resolveTrackInfo } = {}) {
  _geniusClient = geniusClient || null;
  _lyricsFinder = lyricsFinder || null;
  _spotifyFetch = spotifyFetch || null;
  _musixmatchKey = musixmatchKey || process.env.MUSIXMATCH_API_KEY || process.env.MUSIXMATCH_KEY || null;
  _resolveTrackInfo = typeof resolveTrackInfo === 'function' ? resolveTrackInfo : null;
}

function loadLyricsOverrides() {
  try {
    if (!fs.existsSync(LYRICS_OVERRIDE_FILE)) return;
    const raw = fs.readFileSync(LYRICS_OVERRIDE_FILE, 'utf8');
    if (!raw || !raw.trim()) return;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return;
    for (const [key, value] of Object.entries(parsed)) {
      if (!key || !value || typeof value !== 'object') continue;
      if (typeof value.lyrics !== 'string' || !value.lyrics.trim()) continue;
      lyricsOverrides.set(String(key), {
        lyrics: String(value.lyrics),
        title: value.title ? String(value.title) : '',
        artist: value.artist ? String(value.artist) : '',
        addedBy: value.addedBy ? String(value.addedBy) : '',
        addedAt: Number(value.addedAt) || 0,
      });
    }
  } catch (err) {
    console.warn('[lyrics] failed to load overrides:', err && err.message ? err.message : err);
  }
}

function saveLyricsOverrides() {
  try {
    fs.mkdirSync(path.dirname(LYRICS_OVERRIDE_FILE), { recursive: true });
    const payload = {};
    for (const [key, value] of lyricsOverrides.entries()) {
      payload[key] = {
        lyrics: value.lyrics,
        title: value.title || '',
        artist: value.artist || '',
        addedBy: value.addedBy || '',
        addedAt: Number(value.addedAt) || 0,
      };
    }
    fs.writeFileSync(LYRICS_OVERRIDE_FILE, JSON.stringify(payload, null, 2), 'utf8');
  } catch (err) {
    console.warn('[lyrics] failed to save overrides:', err && err.message ? err.message : err);
  }
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

function normalizeTitleSeparators(value) {
  return String(value || '')
    .replace(/[:|]/g, '-')
    .replace(/\s*-\s*/g, ' - ')
    .replace(/(?:\s*-\s*){2,}/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();
}

function inferArtistTitleFromName(rawTitle, rawArtistHint) {
  const value = normalizeTitleSeparators(cleanTitle(rawTitle));
  const match = value.match(/^(.{2,90}?)\s*-\s*(.{2,200})$/);
  if (!match) return null;
  const leftRaw = match[1];
  const rightRaw = match[2];

  const leftArtist = cleanArtistName(leftRaw);
  const rightArtist = cleanArtistName(rightRaw);
  const leftTitle = cleanLyricsTitle(leftRaw);
  const rightTitle = cleanLyricsTitle(rightRaw);

  let artist = leftArtist;
  let title = rightTitle;

  const hint = cleanArtistName(rawArtistHint || '');
  if (hint) {
    const hintNorm = normalizeLookupText(hint);
    const leftNorm = normalizeLookupText(leftArtist);
    const rightNorm = normalizeLookupText(rightArtist);
    const leftOverlap = tokenOverlapRatio(hintNorm, leftNorm);
    const rightOverlap = tokenOverlapRatio(hintNorm, rightNorm);
    if (rightOverlap > leftOverlap && rightOverlap >= 0.4) {
      artist = rightArtist || rightTitle;
      title = leftTitle || rightTitle;
    }
  } else {
    const shortLeft = leftTitle && leftTitle.length <= 3;
    const longRight = rightArtist && rightArtist.length >= 4;
    if (shortLeft && longRight) {
      artist = rightArtist || rightTitle;
      title = leftTitle || rightTitle;
    }
  }

  if (!artist || !title) return null;
  return { artist, title };
}

function parseLyricsTarget(track) {
  if (!track) return { title: '', artist: '' };
  const rawTitle = String(track.spotifyTitle || track.title || track.search || '').trim();
  const rawArtist = String(track.spotifyArtist || track.author || '').trim();
  const parsedFromName = inferArtistTitleFromName(track.title || rawTitle, rawArtist);

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

  if (parsedFromName && parsedFromName.artist && parsedFromName.title) {
    const parsedArtist = parsedFromName.artist;
    const parsedTitle = parsedFromName.title;
    const overlap = tokenOverlapRatio(artist, parsedArtist);
    const rawTitleNorm = normalizeLookupText(rawTitle);
    const parsedArtistInTitle = rawTitleNorm && rawTitleNorm.includes(normalizeLookupText(parsedArtist));
    if ((genericArtist || !artist || overlap < 0.35) && parsedArtistInTitle) {
      artist = parsedArtist;
      title = parsedTitle;
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

function makeOverrideKey(title, artist) {
  const t = normalizeLookupText(title || '');
  const a = normalizeLookupText(artist || '');
  if (!t && !a) return '';
  return `${t}::${a}`;
}

function getLyricsOverride(target) {
  if (!target || !target.title) return null;
  const key = makeOverrideKey(target.title, target.artist);
  if (!key) return null;
  const entry = lyricsOverrides.get(key);
  if (!entry || !entry.lyrics) return null;
  return {
    lyrics: entry.lyrics,
    source: 'Manual',
    matchedTitle: entry.title || target.title || '',
    matchedArtist: entry.artist || target.artist || '',
  };
}

async function maybeResolveTrackInfo(track) {
  if (!track || !track.url || !_resolveTrackInfo) return;
  if (track._lyricsInfoResolved) return;
  track._lyricsInfoResolved = true;

  const needsTitle = !track.title || track.title === track.url;
  const needsAuthor = !track.author || /unknown/i.test(String(track.author));
  const needsDuration = !track.duration || Number(track.duration) <= 0;
  if (!needsTitle && !needsAuthor && !needsDuration) return;

  let info = null;
  try {
    info = await withTimeout(_resolveTrackInfo(track.url), 2600, 'lyrics-info');
  } catch (err) {
    return;
  }
  if (!info) return;

  if (needsTitle && info.title) track.title = info.title;
  if (needsAuthor && info.author) track.author = info.author;
  if (needsDuration && info.duration) track.duration = info.duration;
  if (!track.thumbnail && info.thumbnail) track.thumbnail = info.thumbnail;
}

function setLyricsOverride(track, rawLyrics, { title, artist, addedBy } = {}) {
  const text = String(rawLyrics || '').trim();
  if (!text) return { ok: false, reason: 'Lirik kosong tidak bisa disimpan.' };

  let target = { title: cleanLyricsTitle(title || ''), artist: cleanArtistName(artist || '') };
  if (!target.title) target = parseLyricsTarget(track);
  if (!target.title) return { ok: false, reason: 'Judul lagu tidak bisa dikenali untuk override.' };

  const key = makeOverrideKey(target.title, target.artist);
  if (!key) return { ok: false, reason: 'Kunci override tidak valid.' };

  const normalized = normalizeLyricsBody(text) || text;
  const payload = {
    lyrics: normalized,
    title: target.title || '',
    artist: target.artist || '',
    addedBy: addedBy || '',
    addedAt: Date.now(),
  };

  lyricsOverrides.set(key, payload);
  saveLyricsOverrides();

  return {
    ok: true,
    lyrics: payload.lyrics,
    source: 'Manual',
    matchedTitle: payload.title || target.title || '',
    matchedArtist: payload.artist || target.artist || '',
    target,
  };
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
  let text = String(raw)
    .replace(/\r/g, '')
    .replace(/\n?You might also like[\s\S]*$/i, '')
    .replace(/\n?\d*Embed\s*$/i, '')
    .replace(/\*{2,}\s*This Lyrics is NOT for Commercial use\s*\*{2,}.*$/i, '')
    .trim();
  if (/^lyrics\s*$/i.test(text)) return '';
  return text.replace(/\n{3,}/g, '\n\n').trim();
}

function stripLrcTimestamps(raw) {
  if (!raw) return '';
  return String(raw)
    .replace(/^\s*\[(?:\d{1,2}:)?\d{1,2}:\d{2}(?:\.\d{1,2})?\]\s*/gm, '')
    .replace(/^\s*\[(?:ar|ti|al|by|offset|length):[^\]]*\]\s*/gmi, '')
    .trim();
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
  const strippedTitle = stripLyricsSeparators(title);
  const artistVariants = buildArtistVariants(artist);
  const queries = new Set();
  if (title && artistVariants.length > 0) {
    for (const variant of artistVariants.slice(0, 3)) {
      queries.add(`"${title}" "${variant}"`);
      queries.add(`${title} ${variant}`);
      queries.add(`${variant} ${title}`);
      queries.add(`${title} - ${variant}`);
      if (strippedTitle && strippedTitle !== title) {
        queries.add(`"${strippedTitle}" "${variant}"`);
        queries.add(`${strippedTitle} ${variant}`);
        queries.add(`${variant} ${strippedTitle}`);
        queries.add(`${strippedTitle} - ${variant}`);
      }
    }
  }
  if (title) queries.add(title);
  if (title) queries.add(`${title} lyrics`);
  if (strippedTitle && strippedTitle !== title) {
    queries.add(strippedTitle);
    queries.add(`${strippedTitle} lyrics`);
  }
  return Array.from(queries).filter(Boolean).slice(0, 12);
}

function buildLyricsTitleVariants(title) {
  const base = cleanLyricsTitle(title);
  const variants = new Set();
  if (!base) return [];
  variants.add(base);
  const stripped = stripLyricsSeparators(base);
  if (stripped && stripped !== base) variants.add(stripped);
  variants.add(base.replace(/[\u2018\u2019]/g, "'"));
  variants.add(base.replace(/\s*\([^)]*\)\s*/g, ' ').replace(/\s+/g, ' ').trim());
  variants.add(base.replace(/\s+(?:ft|feat)\.?\s+.+$/i, '').trim());
  return Array.from(variants).filter(Boolean);
}

function stripLyricsSeparators(title) {
  const base = cleanLyricsTitle(title);
  if (!base) return '';
  return base
    .replace(/[|:]/g, ' ')
    .replace(/\s+-\s+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

async function tryLrclibLyrics(target) {
  if (!target || !target.title) return null;

  const titleVariants = buildLyricsTitleVariants(target.title).slice(0, 3);
  const artist = cleanArtistName(target.artist || '');
  const duration = Math.max(0, Number(target.duration) || 0);

  const mapLrclibPayload = (payload) => {
    if (!payload || payload.code === 404) return null;
    const rawLyrics = payload.plainLyrics || stripLrcTimestamps(payload.syncedLyrics || '');
    const lyrics = normalizeLyricsBody(rawLyrics);
    if (!isUsableLyricsBody(lyrics)) return null;
    return {
      lyrics,
      source: 'LRCLIB',
      matchedTitle: payload.trackName || target.title || '',
      matchedArtist: payload.artistName || target.artist || '',
    };
  };

  if (artist && duration > 0) {
    for (const title of titleVariants) {
      if (!title) continue;
      const signatureParams = new URLSearchParams({
        track_name: title,
        artist_name: artist,
        duration: String(Math.round(duration)),
      });

      const endpoints = [
        'https://lrclib.net/api/get-cached',
        'https://lrclib.net/api/get',
      ];

      for (const endpoint of endpoints) {
        const json = await fetchJsonWithTimeout(`${endpoint}?${signatureParams.toString()}`, 9000);
        const mapped = mapLrclibPayload(json);
        if (mapped) return mapped;
      }
    }
  }

  const artistVariants = target.artist ? buildArtistVariants(target.artist).slice(0, 3) : [];
  const attempts = [];

  for (const title of titleVariants) {
    if (!title) continue;
    if (artistVariants.length > 0) {
      for (const artist of artistVariants) {
        attempts.push({ track: title, artist, q: `${title} ${artist}`.trim() });
      }
    } else {
      attempts.push({ track: title, artist: '', q: title });
    }
    attempts.push({ track: '', artist: '', q: title });
  }

  const seen = new Set();
  for (const attempt of attempts) {
    const key = `${attempt.track || ''}|${attempt.artist || ''}|${attempt.q || ''}`.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);

    const params = new URLSearchParams();
    if (attempt.track) params.set('track_name', attempt.track);
    if (attempt.artist) params.set('artist_name', attempt.artist);
    if (!attempt.track && attempt.q) params.set('q', attempt.q);

    if (!params.has('track_name') && !params.has('q')) continue;
    const endpoint = `https://lrclib.net/api/search?${params.toString()}`;
    const json = await fetchJsonWithTimeout(endpoint, 8000);
    const list = Array.isArray(json) ? json : [];
    if (list.length === 0) continue;

    const candidates = list.map((item) => ({
      title: item.trackName || '',
      fullTitle: `${item.trackName || ''} ${item.artistName || ''}`.trim(),
      artist: { name: item.artistName || '' },
      _item: item,
    }));

    let picked = pickBestLyricsCandidate(candidates, target.title, target.artist);
    if (!picked && candidates.length > 0) picked = candidates[0];
    const best = picked && picked._item ? picked._item : null;
    if (!best) continue;

    const mapped = mapLrclibPayload(best);
    if (mapped) return mapped;
  }

  return null;
}

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

async function tryMusixmatchLyrics(target) {
  const apiKey = _musixmatchKey ? String(_musixmatchKey).trim() : '';
  if (!apiKey || !target || !target.title) return null;

  const title = cleanLyricsTitle(target.title);
  const artist = cleanArtistName(target.artist || '');
  if (!title) return null;

  const params = new URLSearchParams({
    apikey: apiKey,
    q_track: title,
    f_has_lyrics: '1',
    format: 'json',
  });
  if (artist) params.set('q_artist', artist);

  const endpoint = `https://api.musixmatch.com/ws/1.1/matcher.lyrics.get?${params.toString()}`;
  const json = await fetchJsonWithTimeout(endpoint, 8000);
  const status = Number(json && json.message && json.message.header && json.message.header.status_code) || 0;
  if (status !== 200) return null;

  const lyricsBody = json && json.message && json.message.body && json.message.body.lyrics
    ? json.message.body.lyrics.lyrics_body
    : '';
  const lyrics = normalizeLyricsBody(lyricsBody);
  if (!isUsableLyricsBody(lyrics)) return null;

  return {
    lyrics,
    source: 'Musixmatch',
    matchedTitle: target.title || '',
    matchedArtist: target.artist || '',
  };
}

async function tryMusixmatchSearchLyrics(target) {
  const apiKey = _musixmatchKey ? String(_musixmatchKey).trim() : '';
  if (!apiKey || !target || !target.title) return null;

  const titleVariants = buildLyricsTitleVariants(target.title).slice(0, 3);
  const artistVariantsRaw = target.artist ? buildArtistVariants(target.artist).slice(0, 3) : [];
  const artistVariants = artistVariantsRaw.length > 0
    ? Array.from(new Set([...artistVariantsRaw, '']))
    : [''];
  const attempts = [];
  for (const title of titleVariants) {
    for (const artist of artistVariants) {
      const key = `${title}::${artist}`.toLowerCase();
      attempts.push({ title, artist, key });
    }
  }

  const seen = new Set();
  for (const attempt of attempts) {
    if (!attempt.title || seen.has(attempt.key)) continue;
    seen.add(attempt.key);

    const params = new URLSearchParams({
      apikey: apiKey,
      q_track: attempt.title,
      f_has_lyrics: '1',
      s_track_rating: 'desc',
      page_size: '6',
      format: 'json',
    });
    if (attempt.artist) params.set('q_artist', attempt.artist);

    const endpoint = `https://api.musixmatch.com/ws/1.1/track.search?${params.toString()}`;
    const json = await fetchJsonWithTimeout(endpoint, 8000);
    const status = Number(json && json.message && json.message.header && json.message.header.status_code) || 0;
    if (status !== 200) continue;

    const list = json && json.message && json.message.body && Array.isArray(json.message.body.track_list)
      ? json.message.body.track_list
      : [];
    if (list.length === 0) continue;

    const tracks = list.map((item) => item && item.track).filter(Boolean);
    if (tracks.length === 0) continue;

    const candidates = tracks.map((track) => ({
      title: track.track_name || '',
      fullTitle: `${track.track_name || ''} ${track.artist_name || ''}`.trim(),
      artist: { name: track.artist_name || '' },
      _track: track,
    }));

    let picked = pickBestLyricsCandidate(candidates, target.title, target.artist);
    if (!picked && candidates.length > 0) picked = candidates[0];
    const bestTrack = picked && picked._track ? picked._track : null;
    if (!bestTrack || !bestTrack.track_id) continue;

    const lyricParams = new URLSearchParams({
      apikey: apiKey,
      track_id: String(bestTrack.track_id),
      format: 'json',
    });
    const lyricEndpoint = `https://api.musixmatch.com/ws/1.1/track.lyrics.get?${lyricParams.toString()}`;
    const lyricJson = await fetchJsonWithTimeout(lyricEndpoint, 8000);
    const lyricStatus = Number(lyricJson && lyricJson.message && lyricJson.message.header && lyricJson.message.header.status_code) || 0;
    if (lyricStatus !== 200) continue;

    const lyricsBody = lyricJson && lyricJson.message && lyricJson.message.body && lyricJson.message.body.lyrics
      ? lyricJson.message.body.lyrics.lyrics_body
      : '';
    const lyrics = normalizeLyricsBody(lyricsBody);
    if (!isUsableLyricsBody(lyrics)) continue;

    return {
      lyrics,
      source: 'Musixmatch',
      matchedTitle: bestTrack.track_name || target.title || '',
      matchedArtist: bestTrack.artist_name || target.artist || '',
    };
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
  await maybeResolveTrackInfo(track);
  const target = parseLyricsTarget(track);
  const duration = Math.max(0, Number(track && track.duration) || 0);
  if (duration > 0) target.duration = duration;
  if (!target.title) {
    return { ok: false, target, reason: 'Judul lagu tidak bisa dikenali untuk pencarian lirik.' };
  }
  const override = getLyricsOverride(target);
  if (override) return { ok: true, target, ...override };
  const providers = [tryMusixmatchLyrics, tryMusixmatchSearchLyrics, tryLrclibLyrics, tryGeniusLyrics, tryLyricsOvh, tryLegacyLyricsFinder];
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
  setLyricsOverride,
  getTrackLyricsStrict,
  getLyricsSession,
  deleteLyricsSession,
  makeLyricsNavigationRow,
  makeLyricsPageEmbed,
  makeLyricsResultMessage,
  parseLyricsTarget,
};

loadLyricsOverrides();
