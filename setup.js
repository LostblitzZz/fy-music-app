// Credit by Raitzu
// Setup script to initialize the bot environment
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const envPath = path.join(__dirname, '.env');
const examplePath = path.join(__dirname, '.env.example');

console.log('🚀 Starting Fy Music APP Setup...');

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(String(answer || ''));
    });
  });
}

function upsertEnvValue(contents, key, value) {
  const keyPattern = new RegExp(`^\\s*${key}=`);
  const lines = String(contents || '').split(/\r?\n/);
  let found = false;
  const updated = lines.map((line) => {
    if (keyPattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    if (updated.length && updated[updated.length - 1] !== '') updated.push('');
    updated.push(`${key}=${value}`);
  }

  const joined = updated.join('\n');
  return joined.endsWith('\n') ? joined : `${joined}\n`;
}

async function promptOwnerId() {
  if (!process.stdin.isTTY) return;
  if (!fs.existsSync(envPath)) return;

  const answer = await ask('Masukkan OWNER_ID (bisa lebih dari satu, pisahkan koma). Kosongkan untuk skip: ');
  const value = answer.trim();
  if (!value) {
    console.log('ℹ️ OWNER_ID tidak diubah.');
    return;
  }

  const current = fs.readFileSync(envPath, 'utf8');
  const updated = upsertEnvValue(current, 'OWNER_ID', value);
  fs.writeFileSync(envPath, updated, 'utf8');
  console.log('✅ OWNER_ID tersimpan di .env');
}

async function main() {
  if (!fs.existsSync(envPath)) {
    if (fs.existsSync(examplePath)) {
      fs.copyFileSync(examplePath, envPath);
      console.log('✅ Created .env file from .env.example');
    } else {
      console.log('❌ Could not find .env.example. Please create a .env file manually.');
    }
  } else {
    console.log('ℹ️ .env file already exists. Skipping...');
  }

  await promptOwnerId();

  console.log('\n--- Next Steps ---');
  console.log('1. Open the .env file and paste your Discord Bot Token.');
  console.log('2. Run "npm start" to launch the bot.');
  console.log('------------------\n');
}

main().catch((err) => {
  console.error('❌ Setup error:', err && err.message ? err.message : err);
});
