'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const lockFile = path.join(process.cwd(), 'data', 'bot-instance.lock.json');

function removeLockFile() {
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch (e) {}
}

if (!fs.existsSync(lockFile)) {
  console.log('[bot-stop] No active lock file. Bot is already stopped.');
  process.exit(0);
}

let pid = 0;
try {
  const raw = fs.readFileSync(lockFile, 'utf8');
  const data = raw ? JSON.parse(raw) : null;
  pid = Number(data && data.pid) || 0;
} catch (err) {
  removeLockFile();
  console.log('[bot-stop] Lock file was invalid and has been removed.');
  process.exit(0);
}

if (!Number.isInteger(pid) || pid <= 0) {
  removeLockFile();
  console.log('[bot-stop] Lock file had no valid PID and has been removed.');
  process.exit(0);
}

let stopped = false;

if (process.platform === 'win32') {
  const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  stopped = result && result.status === 0;
} else {
  try {
    process.kill(pid, 'SIGTERM');
    stopped = true;
  } catch (e) {
    stopped = false;
  }
}

removeLockFile();

if (stopped) {
  console.log(`[bot-stop] Stopped Fy Music process (PID ${pid}).`);
} else {
  console.log(`[bot-stop] Process PID ${pid} was not running. Cleared stale lock.`);
}
