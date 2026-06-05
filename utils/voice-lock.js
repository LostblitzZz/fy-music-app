// Credit by Raitzu
'use strict';

/**
 * Per-guild voice action lock to serialize join/leave/stop operations.
 * Prevents race conditions when rapid commands overlap (e.g. !play + !stop).
 */

const LOCK_TIMEOUT_MS = 30000; // safety net: auto-release after 30s

const locks = new Map(); // guildId -> { promise, release, timer }

/**
 * Enqueue a voice-mutating action for a guild.
 * Actions are serialized — only one runs at a time per guild.
 * @param {string} guildId
 * @param {() => Promise<any>} action
 * @returns {Promise<any>}
 */
function enqueueVoiceAction(guildId, action) {
  const key = guildId ? String(guildId) : '';
  if (!key) return Promise.resolve().then(action);

  const prev = (locks.get(key) && locks.get(key).promise) || Promise.resolve();
  const next = prev.catch(() => {}).then(action);

  const entry = { promise: next };
  locks.set(key, entry);

  next.finally(() => {
    if (locks.get(key) && locks.get(key).promise === next) {
      locks.delete(key);
    }
  });

  return next;
}

/**
 * Check if a guild currently has a voice action in progress.
 * @param {string} guildId
 * @returns {boolean}
 */
function isLocked(guildId) {
  return locks.has(String(guildId || ''));
}

/**
 * Get the number of active locks (for diagnostics).
 * @returns {number}
 */
function getActiveLockCount() {
  return locks.size;
}

module.exports = { enqueueVoiceAction, isLocked, getActiveLockCount };
