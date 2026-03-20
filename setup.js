// Credit by Raitzu
// Setup script to initialize the bot environment
'use strict';

const fs = require('fs');
const path = require('path');

const envPath = path.join(__dirname, '.env');
const examplePath = path.join(__dirname, '.env.example');

console.log('🚀 Starting Fy Music APP Setup...');

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

console.log('\n--- Next Steps ---');
console.log('1. Open the .env file and paste your Discord Bot Token.');
console.log('2. Run "npm start" to launch the bot.');
console.log('------------------\n');
