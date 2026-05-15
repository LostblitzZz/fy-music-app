// Credit by Raitzu
'use strict';

// ── Format helpers ────────────────────────────────────────────────────────────

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

function createProgressBar(currentMs, totalSecs) {
  const size = 15;
  const currentSecs = Math.floor(currentMs / 1000);
  const total = totalSecs > 0 ? totalSecs : 1;
  const progress = Math.min(1, currentSecs / total);
  const filledChars = Math.floor(progress * size);
  const emptyChars = size - filledChars;
  return '▬'.repeat(filledChars) + '🔘' + '▬'.repeat(Math.max(0, emptyChars));
}

function createVolumeBar(volume) {
  const totalBars = 10;
  const filled = Math.round(volume / 10);
  const empty = totalBars - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

function formatCooldownSeconds(ms) {
  if (!ms || ms <= 0) return '0.0';
  return ms >= 5000 ? String(Math.ceil(ms / 1000)) : (ms / 1000).toFixed(1);
}

function clampText(input, max) {
  const text = String(input || '');
  if (!max || text.length <= max) return text;
  return `${text.substring(0, Math.max(0, max - 1))}…`;
}

function makeCooldownNotice(ms, actionLabel) {
  return `⏳ Tunggu ${formatCooldownSeconds(ms)} detik sebelum ${actionLabel}.`;
}

// ── Title / artist cleaning ───────────────────────────────────────────────────

function cleanTitle(title) {
  if (!title) return '';
  return String(title)
    .replace(/\[(?:official|video|audio|lyrics?|lirik|terjemahan|translation|hd|4k)[^\]]*\]/gi, ' ')
    .replace(/\((?:official|video|audio|lyrics?|lirik|terjemahan|translation|hd|4k)[^)]*\)/gi, ' ')
    .replace(/\b(official\s+(?:music\s+)?video|official\s+audio|official\s+lyrics?|music\s+video|lyric\s+video|lyrics?\s+video)\b/gi, ' ')
    .replace(/\s*[-|]\s*(?:official|video|audio|lyrics?|lirik|terjemahan|translation).*/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

// ── Text normalization ────────────────────────────────────────────────────────

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

// ── Timeout helper ────────────────────────────────────────────────────────────

function withTimeout(promise, timeoutMs, label) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timeout`)), timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

module.exports = {
  formatTime,
  formatBytes,
  createProgressBar,
  createVolumeBar,
  formatCooldownSeconds,
  clampText,
  makeCooldownNotice,
  cleanTitle,
  cleanArtistName,
  cleanLyricsTitle,
  normalizeLookupText,
  tokenizeLookupText,
  tokenOverlapRatio,
  withTimeout,
};
