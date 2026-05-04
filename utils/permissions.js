// Credit by Raitzu
'use strict';

const { PermissionsBitField } = require('discord.js');

/**
 * Check if the bot has the required permissions to join and speak in a voice channel.
 * @param {import('discord.js').VoiceChannel} channel
 * @param {import('discord.js').GuildMember} botMember
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkVoicePermissions(channel, botMember) {
  if (!channel) return { ok: false, reason: '❌ Voice channel tidak ditemukan.' };
  if (!botMember) return { ok: true }; // Can't check, allow attempt

  const perms = channel.permissionsFor(botMember);
  if (!perms) return { ok: true };

  if (!perms.has(PermissionsBitField.Flags.Connect)) {
    return { ok: false, reason: `❌ Bot tidak punya izin **Connect** di channel **${channel.name}**.` };
  }
  if (!perms.has(PermissionsBitField.Flags.Speak)) {
    return { ok: false, reason: `❌ Bot tidak punya izin **Speak** di channel **${channel.name}**.` };
  }
  return { ok: true };
}

/**
 * Check if the bot can send messages and embeds in a text channel.
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').GuildMember} botMember
 * @returns {{ ok: boolean, reason?: string }}
 */
function checkTextPermissions(channel, botMember) {
  if (!channel || !botMember) return { ok: true };

  const perms = channel.permissionsFor(botMember);
  if (!perms) return { ok: true };

  if (!perms.has(PermissionsBitField.Flags.SendMessages)) {
    return { ok: false, reason: '❌ Bot tidak punya izin **Send Messages** di channel ini.' };
  }
  if (!perms.has(PermissionsBitField.Flags.EmbedLinks)) {
    return { ok: false, reason: '❌ Bot tidak punya izin **Embed Links** di channel ini.' };
  }
  return { ok: true };
}

module.exports = { checkVoicePermissions, checkTextPermissions };
