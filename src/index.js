import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import {
  ActionRowBuilder, AttachmentBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import Database from 'better-sqlite3';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !clientId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID. See .env.example and README.md.');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const databasePath = path.join(dataDir, 'bot.sqlite');
const restorePath = path.join(dataDir, 'bot.sqlite.restore');
if (fs.existsSync(restorePath)) {
  const restoreDb = new Database(restorePath, { readonly: true, fileMustExist: true });
  const integrity = restoreDb.pragma('integrity_check', { simple: true });
  restoreDb.close();
  if (integrity !== 'ok') throw new Error(`SQLite restore snapshot failed integrity check: ${integrity}`);
  if (fs.existsSync(databasePath)) fs.renameSync(databasePath, `${databasePath}.pre-restore-${Date.now()}`);
  fs.rmSync(`${databasePath}-wal`, { force: true });
  fs.rmSync(`${databasePath}-shm`, { force: true });
  fs.renameSync(restorePath, databasePath);
  console.log('Restored SQLite data from the one-time migration snapshot.');
}
console.log(`SQLite data directory: ${dataDir}`);
const db = new Database(databasePath);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = FULL');
db.exec(`
  CREATE TABLE IF NOT EXISTS automod (
    guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, punishment TEXT NOT NULL,
    duration TEXT NOT NULL, words TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS tickets (
    id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT UNIQUE,
    creator_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open', claimed_by TEXT, created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS timed_bans (
    guild_id TEXT NOT NULL, user_id TEXT NOT NULL, expires_at INTEGER NOT NULL,
    PRIMARY KEY (guild_id, user_id)
  );
  CREATE TABLE IF NOT EXISTS welcome_settings (
    guild_id TEXT PRIMARY KEY, channel_id TEXT NOT NULL, config_json TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS invite_stats (
    guild_id TEXT NOT NULL, inviter_id TEXT NOT NULL,
    invited_count INTEGER NOT NULL DEFAULT 0, left_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (guild_id, inviter_id)
  );
  CREATE TABLE IF NOT EXISTS invite_attribution (
    guild_id TEXT NOT NULL, member_id TEXT NOT NULL, inviter_id TEXT,
    is_present INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (guild_id, member_id)
  );
  CREATE TABLE IF NOT EXISTS channel_lockdowns (
    guild_id TEXT NOT NULL, channel_id TEXT NOT NULL,
    allow_bits TEXT NOT NULL, deny_bits TEXT NOT NULL,
    PRIMARY KEY (guild_id, channel_id)
  );
`);

const durations = [
  { name: '1 day', value: '1d' }, { name: '3 days', value: '3d' },
  { name: '7 days', value: '7d' }, { name: '14 days', value: '14d' },
  { name: '30 days', value: '30d' },
];
const durationDays = { '1d': 1, '3d': 3, '7d': 7, '14d': 14, '30d': 30 };
const punishments = [
  { name: 'Timeout', value: 'timeout' }, { name: 'Ban (temporary)', value: 'ban' },
  { name: 'Kick', value: 'kick' },
];
const commands = [
  new SlashCommandBuilder().setName('embed').setDescription('Create and send a formatted embed in this channel.')
    .addStringOption(o => o.setName('bot_name').setDescription('Embed title or bot name').setMaxLength(256).setRequired(true))
    .addStringOption(o => o.setName('color').setDescription('Embed color as hex, e.g. #5865F2').setMaxLength(7).setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Embed message').setMaxLength(4000).setRequired(true))
    .addAttachmentOption(o => o.setName('image').setDescription('Main image or photo').setRequired(false))
    .addStringOption(o => o.setName('footer').setDescription('Optional footer text').setMaxLength(2048).setRequired(false))
    .addAttachmentOption(o => o.setName('big_thumbnail').setDescription('Large image; used if image is omitted').setRequired(false))
    .addAttachmentOption(o => o.setName('small_thumbnail').setDescription('Small right-side thumbnail').setRequired(false))
    .addAttachmentOption(o => o.setName('footer_thumbnail').setDescription('Small icon beside the footer').setRequired(false))
    .addStringOption(o => o.setName('link').setDescription('Optional HTTP/HTTPS link button below the embed').setMaxLength(512).setRequired(false))
    .addStringOption(o => o.setName('link_title').setDescription('Optional title for the link button (max 80 characters)').setMinLength(1).setMaxLength(80).setRequired(false)),
  new SlashCommandBuilder().setName('automod').setDescription('Configure automatic flag-word moderation for one channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to monitor').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('punishment').setDescription('Action when a flag word is found').addChoices(...punishments).setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('Timeout/ban duration; Discord limits timeouts to 28 days').addChoices(...durations).setRequired(true))
    .addStringOption(o => o.setName('flagwords').setDescription('Comma-separated words or phrases').setMaxLength(1000).setRequired(true)),
  new SlashCommandBuilder().setName('ban').setDescription('Ban a member permanently or for a selected duration.')
    .setDefaultMemberPermissions(PermissionFlagsBits.BanMembers)
    .addUserOption(o => o.setName('user').setDescription('Member to ban').setRequired(true))
    .addStringOption(o => o.setName('time').setDescription('Ban duration').addChoices(...durations, { name: 'Permanent', value: 'permanent' }).setRequired(true))
    .addStringOption(o => o.setName('reason').setDescription('Optional reason').setMaxLength(500).setRequired(false)),
  new SlashCommandBuilder().setName('ticket').setDescription('Post a ticket panel in a channel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel for the ticket panel').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('message').setDescription('Message above the open-ticket button').setMaxLength(2000).setRequired(true))
    .addBooleanOption(o => o.setName('embed').setDescription('Show the panel message in an embed').setRequired(false))
    .addRoleOption(o => o.setName('mention_role').setDescription('Support role to mention and allow into tickets').setRequired(false)),
  new SlashCommandBuilder().setName('welcomer').setDescription('Configure the welcome card, channel mentions, and optional link.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post welcome messages in').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('embed_color').setDescription('Six-digit hex color, e.g. #5865F2').setMaxLength(7).setRequired(true))
    .addAttachmentOption(o => o.setName('big_thumbnail').setDescription('Optional background art for the personalized welcome banner').setRequired(false))
    .addAttachmentOption(o => o.setName('small_thumbnail').setDescription('Optional small circular badge icon; server icon is the default').setRequired(false))
    .addStringOption(o => o.setName('footer').setDescription('Optional embed footer text').setMaxLength(2048).setRequired(false))
    .addAttachmentOption(o => o.setName('footer_thumbnail').setDescription('Small icon beside the footer').setRequired(false))
    .addChannelOption(o => o.setName('dashboard_channel').setDescription('Optional Discord channel for your dashboard').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('rules_channel').setDescription('Optional Discord channel for server rules').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('verification_channel').setDescription('Optional Discord channel for verification').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('updates_channel').setDescription('Optional Discord channel for server updates').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('methods_channel').setDescription('Optional Discord channel for methods').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('tutorial_channel').setDescription('Optional Discord channel for tutorials').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addStringOption(o => o.setName('link_url').setDescription('Optional HTTP/HTTPS URL shown as a button below the embed').setMaxLength(512).setRequired(false))
    .addStringOption(o => o.setName('link_name').setDescription('Optional clickable button name (defaults to Open Link)').setMaxLength(80).setRequired(false)),
  new SlashCommandBuilder().setName('invites').setDescription('Show the tracked invites for a server member.')
    .addUserOption(o => o.setName('user').setDescription('Member whose invite totals you want to check').setRequired(true)),
  new SlashCommandBuilder().setName('disable').setDescription('Emergency-lock public text channels against member messages.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('enable').setDescription('Restore text-channel send permissions saved by /disable.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
  new SlashCommandBuilder().setName('droles').setDescription('Remove Administrator roles from all other members.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('confirmation').setDescription('Type REMOVE ADMIN ROLES to confirm').setMaxLength(40).setRequired(true)),
  new SlashCommandBuilder().setName('purgeall').setDescription('Permanently delete messages in all accessible text channels.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('confirmation').setDescription('Type PURGE ALL MESSAGES to confirm').setMaxLength(40).setRequired(true)),
  new SlashCommandBuilder().setName('cleanup').setDescription('Preview members currently banned from another server, then optionally kick them.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addStringOption(o => o.setName('serverlink').setDescription('Invite link to the reference server; bot must be in it').setMaxLength(200).setRequired(true))
    .addStringOption(o => o.setName('rejoin_link').setDescription('Optional invite back to this server; otherwise one-use links are created').setMaxLength(200).setRequired(false))
    .addIntegerOption(o => o.setName('limit').setDescription('Maximum matches to process after confirmation (default 50; max 100)').setMinValue(1).setMaxValue(100).setRequired(false)),
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const inviteSnapshots = new Map();
const inviteJoinQueues = new Map();
const cleanupPreviews = new Map();
const lockdownPermissions = [
  ['SendMessages', PermissionFlagsBits.SendMessages],
  ['SendMessagesInThreads', PermissionFlagsBits.SendMessagesInThreads],
  ['CreatePublicThreads', PermissionFlagsBits.CreatePublicThreads],
  ['CreatePrivateThreads', PermissionFlagsBits.CreatePrivateThreads],
];
const lockdownChannelTypes = new Set([
  ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildMedia,
].filter(type => type !== undefined));
const isAdmin = member => Boolean(member?.permissions?.has(PermissionFlagsBits.Administrator));
const canManageGuild = member => Boolean(member?.permissions?.has(PermissionFlagsBits.ManageGuild) || isAdmin(member));
const hasPermission = (member, permission) => Boolean(member?.permissions?.has(permission) || isAdmin(member));
const escapeText = value => value.replace(/([_*`~|>])/g, '\\$1');

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(token);
  const globalRoute = Routes.applicationCommands(clientId);
  if (guildId) {
    // Remove any old global copies so a guild-scoped install shows each command only once.
    await rest.put(globalRoute, { body: [] });
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
  } else {
    // Remove old guild-scoped copies before publishing the global command set.
    for (const guild of client.guilds.cache.values()) {
      await rest.put(Routes.applicationGuildCommands(clientId, guild.id), { body: [] });
    }
    await rest.put(globalRoute, { body: commands });
  }
  console.log(`Registered ${commands.length} commands ${guildId ? `in guild ${guildId} (global copies cleared)` : 'globally (guild copies cleared)'}.`);
}
const imageUrl = (interaction, name) => interaction.options.getAttachment(name)?.url;

async function handleEmbed(interaction) {
  const colorText = interaction.options.getString('color', true).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(colorText)) return interaction.reply({ content: 'Color must be six-digit hex, such as `#5865F2`.', ephemeral: true });
  const embed = new EmbedBuilder().setColor(Number.parseInt(colorText, 16))
    .setTitle(interaction.options.getString('bot_name', true))
    .setDescription(interaction.options.getString('message', true));
  const mainImage = imageUrl(interaction, 'image') || imageUrl(interaction, 'big_thumbnail');
  const thumb = imageUrl(interaction, 'small_thumbnail');
  const footerIcon = imageUrl(interaction, 'footer_thumbnail');
  if (mainImage) embed.setImage(mainImage);
  if (thumb) embed.setThumbnail(thumb);
  const footer = interaction.options.getString('footer');
  if (footer || footerIcon) embed.setFooter({ text: footer || '\u200b', ...(footerIcon ? { iconURL: footerIcon } : {}) });
  const link = interaction.options.getString('link')?.trim();
  const linkTitle = interaction.options.getString('link_title')?.trim();
  if (linkTitle && !link) return interaction.reply({ content: 'Set the `link` option too, so I have a URL for that button title.', ephemeral: true });
  let linkButton;
  if (link) {
    try {
      const url = new URL(link);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported URL protocol');
      linkButton = new ButtonBuilder().setLabel(linkTitle || 'Open Link').setStyle(ButtonStyle.Link).setURL(url.toString());
    } catch {
      return interaction.reply({ content: 'Link must be a valid HTTP or HTTPS URL.', ephemeral: true });
    }
  }
  await interaction.channel.send({ embeds: [embed], ...(linkButton ? { components: [new ActionRowBuilder().addComponents(linkButton)] } : {}) });
  await interaction.reply({ content: 'Embed sent to this channel.', ephemeral: true });
}

async function handleWelcomer(interaction) {
  if (!canManageGuild(interaction.member)) return interaction.reply({ content: 'You need Manage Server permission to configure the welcomer.', ephemeral: true });
  const colorText = interaction.options.getString('embed_color', true).trim().replace(/^#/, '');
  if (!/^[0-9a-fA-F]{6}$/.test(colorText)) return interaction.reply({ content: 'Embed color must be six-digit hex, such as `#5865F2`.', ephemeral: true });
  const linkUrl = interaction.options.getString('link_url')?.trim() || null;
  const linkName = interaction.options.getString('link_name')?.trim() || null;
  if (linkName && !linkUrl) return interaction.reply({ content: 'Set `link_url` too when you provide a `link_name`.', ephemeral: true });
  if (linkUrl) {
    try {
      const parsed = new URL(linkUrl);
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Unsupported protocol');
    } catch {
      return interaction.reply({ content: '`link_url` must be a valid HTTP or HTTPS URL.', ephemeral: true });
    }
  }
  const links = {
    dashboard: interaction.options.getChannel('dashboard_channel')?.id ?? null,
    rules: interaction.options.getChannel('rules_channel')?.id ?? null,
    verification: interaction.options.getChannel('verification_channel')?.id ?? null,
    updates: interaction.options.getChannel('updates_channel')?.id ?? null,
    methods: interaction.options.getChannel('methods_channel')?.id ?? null,
    tutorial: interaction.options.getChannel('tutorial_channel')?.id ?? null,
  };
  const channel = interaction.options.getChannel('channel', true);
  const config = {
    color: Number.parseInt(colorText, 16),
    bigThumbnail: interaction.options.getAttachment('big_thumbnail')?.url ?? null,
    smallThumbnail: interaction.options.getAttachment('small_thumbnail')?.url ?? null,
    footer: interaction.options.getString('footer'),
    footerThumbnail: interaction.options.getAttachment('footer_thumbnail')?.url ?? null,
    links,
    link: linkUrl ? { url: new URL(linkUrl).toString(), name: linkName || 'Open Link' } : null,
  };
  db.prepare(`INSERT INTO welcome_settings(guild_id, channel_id, config_json) VALUES(?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, config_json=excluded.config_json`)
    .run(interaction.guildId, channel.id, JSON.stringify(config));
  const selectedLinks = Object.values(links).filter(Boolean).length;
  await interaction.reply({ content: `Welcomer configured for <#${channel.id}> with ${selectedLinks} channel mention${selectedLinks === 1 ? '' : 's'}${config.link ? ` and the **${config.link.name}** button` : ''}. Join cards show the member avatar, join date, inviter, and member number.`, ephemeral: true });
}

function recordInviteJoin(member, inviterId) {
  db.transaction(() => {
    const existing = db.prepare('SELECT is_present FROM invite_attribution WHERE guild_id = ? AND member_id = ?').get(member.guild.id, member.id);
    if (existing?.is_present) return;
    if (inviterId) {
      db.prepare(`INSERT INTO invite_stats(guild_id, inviter_id, invited_count, left_count) VALUES(?, ?, 1, 0)
        ON CONFLICT(guild_id, inviter_id) DO UPDATE SET invited_count=invite_stats.invited_count + 1`)
        .run(member.guild.id, inviterId);
    }
    db.prepare(`INSERT INTO invite_attribution(guild_id, member_id, inviter_id, is_present) VALUES(?, ?, ?, 1)
      ON CONFLICT(guild_id, member_id) DO UPDATE SET inviter_id=excluded.inviter_id, is_present=1`)
      .run(member.guild.id, member.id, inviterId ?? null);
  })();
}

function recordInviteLeave(member) {
  db.transaction(() => {
    const attribution = db.prepare('SELECT inviter_id, is_present FROM invite_attribution WHERE guild_id = ? AND member_id = ?').get(member.guild.id, member.id);
    if (!attribution || !attribution.is_present) return;
    if (attribution.inviter_id) {
      db.prepare(`INSERT INTO invite_stats(guild_id, inviter_id, invited_count, left_count) VALUES(?, ?, 0, 1)
        ON CONFLICT(guild_id, inviter_id) DO UPDATE SET left_count=invite_stats.left_count + 1`)
        .run(member.guild.id, attribution.inviter_id);
    }
    db.prepare('UPDATE invite_attribution SET is_present = 0 WHERE guild_id = ? AND member_id = ? AND is_present = 1')
      .run(member.guild.id, member.id);
  })();
}

async function handleInvites(interaction) {
  const user = interaction.options.getUser('user', true);
  const member = await interaction.guild.members.fetch(user.id).catch(() => null);
  const displayName = member?.displayName || user.globalName || user.username;
  const stats = db.prepare('SELECT invited_count, left_count FROM invite_stats WHERE guild_id = ? AND inviter_id = ?')
    .get(interaction.guildId, user.id) ?? { invited_count: 0, left_count: 0 };
  const invited = stats.invited_count;
  const leaved = stats.left_count;
  const current = Math.max(0, invited - leaved);
  const embed = new EmbedBuilder().setColor(0x5865F2).setTitle(`${displayName}'s Invites`)
    .setThumbnail(user.displayAvatarURL())
    .addFields(
      { name: 'Leaved', value: String(leaved), inline: true },
      { name: 'Invites', value: String(invited), inline: true },
      { name: 'Current Total Invites', value: String(current), inline: true },
    )
    .setFooter({ text: 'Only unambiguous invite joins and recorded departures are counted; past or offline gaps may be unavailable.' });
  await interaction.reply({ embeds: [embed] });
}

function hasAdminAccess(interaction) {
  return interaction.user?.id === interaction.guild?.ownerId || isAdmin(interaction.member);
}

function captureEveryoneBits(channel) {
  const overwrite = channel.permissionOverwrites.cache.get(channel.guild.id);
  let allow = 0n;
  let deny = 0n;
  for (const [, flag] of lockdownPermissions) {
    if (overwrite?.allow.has(flag)) allow |= flag;
    if (overwrite?.deny.has(flag)) deny |= flag;
  }
  return { allowBits: allow.toString(), denyBits: deny.toString() };
}

function restoreEveryoneOptions(allowBits, denyBits) {
  const allow = BigInt(allowBits);
  const deny = BigInt(denyBits);
  return Object.fromEntries(lockdownPermissions.map(([name, flag]) => [
    name,
    (allow & flag) !== 0n ? true : (deny & flag) !== 0n ? false : null,
  ]));
}

async function handleDisable(interaction) {
  if (!hasAdminAccess(interaction)) return interaction.reply({ content: 'Only server administrators can use /disable.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const channels = [...interaction.guild.channels.cache.values()].filter(channel => lockdownChannelTypes.has(channel.type));
  const saveSnapshot = db.prepare('INSERT OR IGNORE INTO channel_lockdowns(guild_id, channel_id, allow_bits, deny_bits) VALUES(?, ?, ?, ?)');
  const getSnapshot = db.prepare('SELECT 1 FROM channel_lockdowns WHERE guild_id = ? AND channel_id = ?');
  let locked = 0;
  let failed = 0;
  for (const channel of channels) {
    if (!getSnapshot.get(interaction.guildId, channel.id)) {
      const { allowBits, denyBits } = captureEveryoneBits(channel);
      saveSnapshot.run(interaction.guildId, channel.id, allowBits, denyBits);
    }
    try {
      await channel.permissionOverwrites.edit(interaction.guildId, {
        SendMessages: false,
        SendMessagesInThreads: false,
        CreatePublicThreads: false,
        CreatePrivateThreads: false,
      }, `Emergency anti-raid lockdown by ${interaction.user.tag}`);
      locked += 1;
    } catch (error) {
      failed += 1;
      console.error(`Could not lock channel ${channel.id}:`, error.message);
    }
  }
  await interaction.editReply(`Lockdown applied to ${locked} text channels${failed ? `; ${failed} failed` : ''}. Run /enable to restore saved @everyone send permissions. Server administrators still bypass channel locks; roles explicitly allowed to send may also retain access.`);
}

async function handleEnable(interaction) {
  if (!hasAdminAccess(interaction)) return interaction.reply({ content: 'Only server administrators can use /enable.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const snapshots = db.prepare('SELECT * FROM channel_lockdowns WHERE guild_id = ?').all(interaction.guildId);
  if (!snapshots.length) return interaction.editReply('No saved /disable lockdown was found for this server.');
  const deleteSnapshot = db.prepare('DELETE FROM channel_lockdowns WHERE guild_id = ? AND channel_id = ?');
  let restored = 0;
  let failed = 0;
  for (const snapshot of snapshots) {
    const channel = interaction.guild.channels.cache.get(snapshot.channel_id)
      ?? await interaction.guild.channels.fetch(snapshot.channel_id).catch(() => null);
    if (!channel) {
      deleteSnapshot.run(interaction.guildId, snapshot.channel_id);
      continue;
    }
    try {
      await channel.permissionOverwrites.edit(interaction.guildId,
        restoreEveryoneOptions(snapshot.allow_bits, snapshot.deny_bits),
        `Restore anti-raid lockdown by ${interaction.user.tag}`);
      deleteSnapshot.run(interaction.guildId, snapshot.channel_id);
      restored += 1;
    } catch (error) {
      failed += 1;
      console.error(`Could not restore channel ${snapshot.channel_id}:`, error.message);
    }
  }
  await interaction.editReply(`Restored saved send permissions in ${restored} channels${failed ? `; ${failed} failed and can be retried` : ''}.`);
}

async function handleDRoles(interaction) {
  if (!hasAdminAccess(interaction)) return interaction.reply({ content: 'Only server administrators can use /droles.', ephemeral: true });
  if (interaction.options.getString('confirmation', true) !== 'REMOVE ADMIN ROLES') {
    return interaction.reply({ content: 'Confirmation did not match. To proceed, type exactly `REMOVE ADMIN ROLES`.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const adminRoleIds = new Set([...interaction.guild.roles.cache.values()]
    .filter(role => role.id !== interaction.guildId && !role.managed && role.permissions.has(PermissionFlagsBits.Administrator))
    .map(role => role.id));
  if (!adminRoleIds.size) return interaction.editReply('No removable Administrator roles were found.');
  let changedMembers = 0;
  let failedMembers = 0;
  let skippedMembers = 0;
  let after;
  try {
    while (true) {
      const page = await interaction.guild.members.list({ limit: 1000, ...(after ? { after } : {}) });
      if (!page.size) break;
      for (const member of page.values()) {
        if (member.id === interaction.user.id || member.id === interaction.guild.ownerId || member.id === client.user.id) {
          skippedMembers += 1;
          continue;
        }
        const rolesToRemove = member.roles.cache.filter(role => adminRoleIds.has(role.id));
        if (!rolesToRemove.size) continue;
        try {
          await member.roles.remove([...rolesToRemove.keys()], `Emergency removal of admin roles by ${interaction.user.tag}`);
          changedMembers += 1;
        } catch (error) {
          failedMembers += 1;
          console.error(`Could not remove admin roles from ${member.id}:`, error.message);
        }
      }
      const last = page.last();
      if (page.size < 1000 || !last) break;
      after = last.id;
    }
  } catch (error) {
    console.error('Could not list all server members for /droles:', error);
    return interaction.editReply(`Role removal stopped while listing members. ${changedMembers} members were updated; check the Server Members intent and bot logs, then retry if needed.`);
  }
  await interaction.editReply(`Removed Administrator roles from ${changedMembers} members. Skipped ${skippedMembers} protected account(s) (command user, server owner, and bot). ${failedMembers} members could not be changed; check Manage Roles and move the bot role above those roles.`);
}

async function collectPurgeTargets(guild) {
  const targets = new Map();
  let unavailableScopes = 0;
  const add = channel => {
    if (channel?.isTextBased?.() && typeof channel.messages?.fetch === 'function') targets.set(channel.id, channel);
  };
  const parents = [...guild.channels.cache.values()].filter(channel => lockdownChannelTypes.has(channel.type));
  for (const channel of parents) add(channel);
  try {
    const active = await guild.channels.fetchActiveThreads();
    for (const thread of active.threads.values()) add(thread);
  } catch (error) {
    unavailableScopes += 1;
    console.error('Could not list active threads for /purgeall:', error.message);
  }
  for (const parent of parents) {
    if (!parent.threads?.fetchArchived) continue;
    for (const type of ['public', 'private']) {
      let before;
      let fallbackPrivate = false;
      while (true) {
        let archived;
        try {
          archived = await parent.threads.fetchArchived({ type, fetchAll: !fallbackPrivate, limit: 100, ...(before ? { before } : {}) });
        } catch (error) {
          if (type === 'private' && !fallbackPrivate) {
            fallbackPrivate = true;
            before = undefined;
            continue;
          }
          unavailableScopes += 1;
          console.error(`Could not list ${type} archived threads for ${parent.id}:`, error.message);
          break;
        }
        for (const thread of archived.threads.values()) add(thread);
        if (!archived.hasMore || !archived.threads.size) break;
        const oldest = archived.threads.last();
        before = type === 'private' && fallbackPrivate ? oldest.id : oldest.archivedAt;
        if (!before) break;
      }
    }
  }
  return { targets: [...targets.values()], unavailableScopes };
}

async function purgeMessageHistory(channel, totals) {
  const bulkDeleteCutoff = 14 * 24 * 60 * 60 * 1000 - 60_000;
  let before;
  while (true) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (!batch.size) break;
    const oldest = batch.last();
    if (!oldest) break;
    before = oldest.id;
    const recent = batch.filter(message => Date.now() - message.createdTimestamp < bulkDeleteCutoff);
    const old = batch.filter(message => Date.now() - message.createdTimestamp >= bulkDeleteCutoff);
    if (recent.size) {
      try {
        const deleted = await channel.bulkDelete(recent, true);
        totals.deleted += deleted.size;
      } catch (error) {
        if (error.code === 50013) throw error;
        for (const message of recent.values()) {
          try { await message.delete(); totals.deleted += 1; }
          catch (deleteError) {
            if (deleteError.code === 50013) throw deleteError;
            totals.skipped += 1;
          }
        }
      }
    }
    for (const message of old.values()) {
      try { await message.delete(); totals.deleted += 1; }
      catch (error) {
        if (error.code === 50013) throw error;
        totals.skipped += 1;
      }
    }
  }
}

async function handlePurgeAll(interaction) {
  if (!hasAdminAccess(interaction)) return interaction.reply({ content: 'Only server administrators can use /purgeall.', ephemeral: true });
  if (interaction.options.getString('confirmation', true) !== 'PURGE ALL MESSAGES') {
    return interaction.reply({ content: 'Confirmation did not match. To proceed, type exactly `PURGE ALL MESSAGES`.', ephemeral: true });
  }
  await interaction.deferReply({ ephemeral: true });
  const { targets, unavailableScopes } = await collectPurgeTargets(interaction.guild);
  const totals = { deleted: 0, skipped: 0, failedChannels: 0 };
  for (let i = 0; i < targets.length; i += 1) {
    try { await purgeMessageHistory(targets[i], totals); }
    catch (error) {
      totals.failedChannels += 1;
      console.error(`Could not purge channel ${targets[i].id}:`, error.message);
    }
    if ((i + 1) % 10 === 0) {
      await interaction.editReply(`Purge in progress: ${i + 1}/${targets.length} accessible text channels/threads checked; ${totals.deleted} messages deleted.`).catch(() => {});
    }
  }
  await interaction.editReply(`Purge finished: ${totals.deleted} messages deleted across ${targets.length} accessible text channels/threads. ${totals.skipped} messages were skipped; ${totals.failedChannels} channels failed; ${unavailableScopes} thread scopes could not be listed. This cannot be undone. Private archived threads may require the bot's Manage Threads permission.`);
}

function cleanupInviteCode(value) {
  const match = value.trim().match(/^(?:https?:\/\/)?(?:www\.)?(?:discord\.gg\/|discord(?:app)?\.com\/invite\/)([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i);
  return match?.[1] ?? null;
}

async function fetchAllGuildBans(guild) {
  const userIds = new Set();
  let after;
  while (true) {
    const page = await guild.bans.fetch({ limit: 1000, cache: false, ...(after ? { after } : {}) });
    if (!page.size) break;
    for (const ban of page.values()) userIds.add(ban.user.id);
    const lastId = page.last()?.user.id;
    if (page.size < 1000 || !lastId || lastId === after) break;
    after = lastId;
  }
  return userIds;
}

async function collectCleanupMatches(guild, bannedIds, limit) {
  const memberIds = [];
  const sampleNames = [];
  let totalMatches = 0;
  let after;
  while (true) {
    const page = await guild.members.list({ limit: 1000, cache: false, ...(after ? { after } : {}) });
    if (!page.size) break;
    for (const member of page.values()) {
      if (!bannedIds.has(member.id) || member.user.bot || member.id === guild.ownerId
        || member.id === client.user.id || member.permissions.has(PermissionFlagsBits.Administrator) || !member.kickable) continue;
      totalMatches += 1;
      if (memberIds.length < limit) memberIds.push(member.id);
      if (sampleNames.length < 10) sampleNames.push(member.displayName || member.user.username);
    }
    const lastId = page.last()?.id;
    if (page.size < 1000 || !lastId || lastId === after) break;
    after = lastId;
  }
  return { memberIds, sampleNames, totalMatches };
}

async function getCleanupInviteChannel(guild, botMember) {
  const channels = [guild.systemChannel, ...guild.channels.cache.values()];
  return channels.find(channel => channel
    && [ChannelType.GuildText, ChannelType.GuildAnnouncement].includes(channel.type)
    && channel.permissionsFor(botMember)?.has(PermissionFlagsBits.CreateInstantInvite)) ?? null;
}

async function handleCleanup(interaction) {
  if (!hasAdminAccess(interaction)) return interaction.reply({ content: 'Only server administrators can use /cleanup.', ephemeral: true });
  await interaction.deferReply({ ephemeral: true });
  const sourceCode = cleanupInviteCode(interaction.options.getString('serverlink', true));
  if (!sourceCode) return interaction.editReply('Enter a Discord invite link such as `https://discord.gg/example` for the reference server.');

  let sourceInvite;
  try { sourceInvite = await client.fetchInvite(sourceCode); }
  catch { return interaction.editReply('That reference-server invite is invalid, expired, or inaccessible.'); }
  const sourceGuildId = sourceInvite.guild?.id;
  if (!sourceGuildId) return interaction.editReply('The invite must point to a server, not a group DM.');
  if (sourceGuildId === interaction.guildId) return interaction.editReply('Use a different reference server; this command checks another server’s current ban list.');

  const sourceGuild = client.guilds.cache.get(sourceGuildId) ?? await client.guilds.fetch(sourceGuildId).catch(() => null);
  if (!sourceGuild) return interaction.editReply('The bot must also be a member of the reference server before it can read that server’s bans.');
  const sourceBotMember = sourceGuild.members.me ?? await sourceGuild.members.fetchMe().catch(() => null);
  if (!sourceBotMember?.permissions.has(PermissionFlagsBits.BanMembers)
    && !sourceBotMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return interaction.editReply('Give the bot **Ban Members** or **View Audit Log** in the reference server so it can read that server’s ban list.');
  }
  const targetBotMember = interaction.guild.members.me ?? await interaction.guild.members.fetchMe().catch(() => null);
  if (!targetBotMember?.permissions.has(PermissionFlagsBits.KickMembers)) {
    return interaction.editReply('The bot needs **Kick Members** in this server to run /cleanup.');
  }

  let rejoinUrl = null;
  let inviteChannelId = null;
  const customRejoinLink = interaction.options.getString('rejoin_link')?.trim();
  if (customRejoinLink) {
    const code = cleanupInviteCode(customRejoinLink);
    if (!code) return interaction.editReply('`rejoin_link` must be a Discord invite URL for this server.');
    const invite = await client.fetchInvite(code).catch(() => null);
    if (invite?.guild?.id !== interaction.guildId) return interaction.editReply('`rejoin_link` must point back to this server.');
    rejoinUrl = `https://discord.gg/${code}`;
  } else {
    const inviteChannel = await getCleanupInviteChannel(interaction.guild, targetBotMember);
    if (!inviteChannel) return interaction.editReply('To DM rejoin links, give the bot **Create Invite** in a text channel or supply `rejoin_link` for this server.');
    inviteChannelId = inviteChannel.id;
  }

  const limit = interaction.options.getInteger('limit') ?? 50;
  let bannedIds;
  let matches;
  try {
    bannedIds = await fetchAllGuildBans(sourceGuild);
    matches = await collectCleanupMatches(interaction.guild, bannedIds, limit);
  } catch (error) {
    console.error('Could not prepare /cleanup preview:', error);
    return interaction.editReply('Could not read the reference ban list or this server’s member list. Check bot permissions and the Server Members intent; no members were kicked.');
  }
  if (!matches.memberIds.length) {
    return interaction.editReply(matches.totalMatches
      ? `Found ${matches.totalMatches} matches, but none can be kicked by the bot because of role hierarchy or protected-account checks.`
      : `No kickable non-admin members in this server are currently on **${escapeText(sourceGuild.name)}**’s ban list.`);
  }

  const token = randomUUID();
  const expiresAt = Date.now() + 120_000;
  cleanupPreviews.set(token, {
    requesterId: interaction.user.id,
    targetGuildId: interaction.guildId,
    sourceGuildId,
    memberIds: matches.memberIds,
    totalMatches: matches.totalMatches,
    rejoinUrl,
    inviteChannelId,
    expiresAt,
  });
  const timeout = setTimeout(() => cleanupPreviews.delete(token), 120_000);
  timeout.unref?.();

  const embed = new EmbedBuilder().setColor(0xED4245).setTitle('Cleanup preview')
    .setDescription(`Reference server: **${escapeText(sourceGuild.name)}**\nCurrent server: **${escapeText(interaction.guild.name)}**\nFound **${matches.totalMatches}** kickable, non-admin match(es). This confirmation processes up to **${matches.memberIds.length}** member(s).`)
    .setFooter({ text: 'Checks current server-specific bans only—not Discord-wide account bans or ban duration. Expires in 2 minutes.' });
  if (matches.sampleNames.length) {
    const names = matches.sampleNames.map(name => `• ${escapeText(name).replaceAll('@', '@\u200b')}`).join('\n');
    embed.addFields({ name: `Sample matched members (${Math.min(10, matches.totalMatches)} max)`, value: names });
  }
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`cleanup:confirm:${token}`).setLabel(`Confirm kick (${matches.memberIds.length})`).setStyle(ButtonStyle.Danger),
    new ButtonBuilder().setCustomId(`cleanup:cancel:${token}`).setLabel('Cancel').setStyle(ButtonStyle.Secondary),
  );
  await interaction.editReply({ embeds: [embed], components: [row] });
}

async function processCleanupPreview(interaction, preview) {
  const targetGuild = client.guilds.cache.get(preview.targetGuildId);
  const sourceGuild = client.guilds.cache.get(preview.sourceGuildId);
  if (!targetGuild || !sourceGuild) return interaction.editReply('A required server is no longer available to the bot; no members were kicked.');
  const sourceBotMember = sourceGuild.members.me ?? await sourceGuild.members.fetchMe().catch(() => null);
  if (!sourceBotMember?.permissions.has(PermissionFlagsBits.BanMembers)
    && !sourceBotMember?.permissions.has(PermissionFlagsBits.ViewAuditLog)) {
    return interaction.editReply('The bot no longer has permission to read the reference ban list; no members were kicked.');
  }
  const targetBotMember = targetGuild.members.me ?? await targetGuild.members.fetchMe().catch(() => null);
  if (!targetBotMember?.permissions.has(PermissionFlagsBits.KickMembers)) {
    return interaction.editReply('The bot no longer has Kick Members permission; no members were kicked.');
  }
  const bannedIds = await fetchAllGuildBans(sourceGuild);
  const counts = { kicked: 0, dmFailed: 0, kickFailed: 0, noLongerBanned: 0, skipped: 0, inviteFailed: 0 };
  for (const userId of preview.memberIds) {
    if (!bannedIds.has(userId)) { counts.noLongerBanned += 1; continue; }
    const member = await targetGuild.members.fetch(userId).catch(() => null);
    if (!member || member.user.bot || member.id === targetGuild.ownerId || member.id === client.user.id
      || member.permissions.has(PermissionFlagsBits.Administrator) || !member.kickable) {
      counts.skipped += 1;
      continue;
    }
    let inviteUrl = preview.rejoinUrl;
    if (!inviteUrl) {
      const inviteChannel = targetGuild.channels.cache.get(preview.inviteChannelId);
      if (!inviteChannel || !inviteChannel.permissionsFor(targetBotMember)?.has(PermissionFlagsBits.CreateInstantInvite)) {
        counts.inviteFailed += 1;
        continue;
      }
      try {
        const invite = await inviteChannel.createInvite({
          maxAge: 7 * 24 * 60 * 60,
          maxUses: 1,
          unique: true,
          reason: `One-use rejoin link for cleanup action by ${interaction.user.tag}`,
        });
        inviteUrl = invite.url;
      } catch (error) {
        counts.inviteFailed += 1;
        console.error(`Could not create rejoin invite for ${userId}:`, error.message);
        continue;
      }
    }
    try {
      await member.kick(`Matched current ban list in reference server ${sourceGuild.name}; cleanup confirmed by ${interaction.user.tag}`);
      counts.kicked += 1;
    } catch (error) {
      counts.kickFailed += 1;
      console.error(`Could not kick cleanup match ${userId}:`, error.message);
      continue;
    }
    const dm = `Hello — you were kicked from **${targetGuild.name}** because our bot found your account on the current ban list of **${sourceGuild.name}**. If you think this is a mistake, you can rejoin this server using this invite: ${inviteUrl}`;
    try { await member.send(dm); }
    catch (error) {
      counts.dmFailed += 1;
      console.warn(`Cleanup kick succeeded but DM failed for ${userId}:`, error.message);
    }
  }
  const unprocessed = Math.max(0, preview.totalMatches - preview.memberIds.length);
  await interaction.editReply(`Cleanup finished. Kicked: **${counts.kicked}**. DM delivery failed: **${counts.dmFailed}**. Kick failed: **${counts.kickFailed}**. Invite creation failed: **${counts.inviteFailed}**. No longer banned: **${counts.noLongerBanned}**. Skipped/protected: **${counts.skipped}**.${unprocessed ? ` ${unprocessed} additional matches were not included because of the per-run limit; run /cleanup again to preview them.` : ''}`);
}

async function handleCleanupButton(interaction) {
  const [, action, token] = interaction.customId.split(':');
  const preview = cleanupPreviews.get(token);
  if (!preview || preview.expiresAt < Date.now()) {
    cleanupPreviews.delete(token);
    return interaction.reply({ content: 'This cleanup preview expired. Run /cleanup again to create a fresh preview.', ephemeral: true });
  }
  if (interaction.user.id !== preview.requesterId || !hasAdminAccess(interaction)) {
    return interaction.reply({ content: 'Only the administrator who created this preview can confirm or cancel it.', ephemeral: true });
  }
  cleanupPreviews.delete(token);
  if (action === 'cancel') return interaction.update({ content: 'Cleanup cancelled; no members were kicked.', embeds: [], components: [] });
  if (action !== 'confirm') return interaction.reply({ content: 'Unknown cleanup action.', ephemeral: true });
  await interaction.update({ content: 'Rechecking the source ban list and processing the confirmed cleanup…', embeds: [], components: [] });
  try { await processCleanupPreview(interaction, preview); }
  catch (error) {
    console.error('Confirmed /cleanup failed:', error);
    await interaction.editReply('Cleanup stopped because of an unexpected error. Check bot logs; some earlier members may already have been kicked.');
  }
}

function ordinal(number) {
  const mod100 = number % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${number}th`;
  switch (number % 10) {
    case 1: return `${number}st`;
    case 2: return `${number}nd`;
    case 3: return `${number}rd`;
    default: return `${number}th`;
  }
}

async function snapshotInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    inviteSnapshots.set(guild.id, new Map(invites.map(invite => [invite.code, { uses: invite.uses ?? 0, inviterId: invite.inviter?.id ?? null }])));
  } catch (error) {
    inviteSnapshots.delete(guild.id);
    console.warn(`Could not read invite list for ${guild.name}; welcome messages will say inviter is unknown. Check Manage Server permission.`, error.message);
  }
}

async function findJoiningInvite(member) {
  const previous = inviteSnapshots.get(member.guild.id);
  if (!previous) {
    await snapshotInvites(member.guild);
    return null;
  }
  try {
    const currentInvites = await member.guild.invites.fetch();
    const increasedInvites = [];
    const next = new Map();
    for (const invite of currentInvites.values()) {
      const uses = invite.uses ?? 0;
      const oldInvite = previous.get(invite.code);
      next.set(invite.code, { uses, inviterId: invite.inviter?.id ?? oldInvite?.inviterId ?? null });
      const increase = uses - (oldInvite?.uses ?? 0);
      if (increase > 0) increasedInvites.push({ invite, increase, inviterId: invite.inviter?.id ?? oldInvite?.inviterId ?? null });
    }
    inviteSnapshots.set(member.guild.id, next);
    if (increasedInvites.length !== 1 || increasedInvites[0].increase !== 1) {
      if (increasedInvites.length) console.warn(`Ambiguous invite-use changes in ${member.guild.name}; this member will not be credited to a guessed inviter.`);
      return null;
    }
    const joiningInvite = increasedInvites[0];
    return joiningInvite.invite.inviter ?? (joiningInvite.inviterId ? await client.users.fetch(joiningInvite.inviterId).catch(() => null) : null);
  } catch (error) {
    console.warn(`Could not identify the invite used in ${member.guild.name}; inviter will be unknown.`, error.message);
    return null;
  }
}

function escapeXml(value) {
  return String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
}

async function fetchImageBuffer(url, maxBytes = 8 * 1024 * 1024) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Image request failed with HTTP ${response.status}`);
  const contentLength = Number(response.headers.get('content-length') || 0);
  if (contentLength > maxBytes) throw new Error('Image is larger than the welcome-card limit');
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.length > maxBytes) throw new Error('Image is larger than the welcome-card limit');
  return sharp(buffer).rotate().png().toBuffer();
}

async function renderWelcomeCard(member, memberCount, config) {
  const avatarUrl = member.user.displayAvatarURL({ extension: 'png', size: 256 });
  const serverIconUrl = config.smallThumbnail || member.guild.iconURL({ extension: 'png', size: 96 });
  const [avatarBuffer, serverIconBuffer, uploadedBackground] = await Promise.all([
    fetchImageBuffer(avatarUrl).catch(error => { console.warn('Welcome avatar unavailable:', error.message); return null; }),
    serverIconUrl ? fetchImageBuffer(serverIconUrl, 4 * 1024 * 1024).catch(error => { console.warn('Welcome server icon unavailable:', error.message); return null; }) : null,
    config.bigThumbnail ? fetchImageBuffer(config.bigThumbnail).catch(error => { console.warn('Welcome background unavailable:', error.message); return null; }) : null,
  ]);
  const width = 960;
  const height = 400;
  const accent = `#${Number(config.color).toString(16).padStart(6, '0').slice(-6)}`;
  const baseSvg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#1b2332"/><stop offset="1" stop-color="#07090f"/></linearGradient><radialGradient id="glow"><stop stop-color="${accent}" stop-opacity=".25"/><stop offset="1" stop-color="${accent}" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#bg)"/><circle cx="840" cy="30" r="360" fill="url(#glow)"/><path d="M0 330 270 0h160L120 400H0z" fill="#fff" opacity=".025"/><path d="M620 400 900 0h60v180L790 400z" fill="${accent}" opacity=".06"/></svg>`);
  let background = uploadedBackground
    ? sharp(uploadedBackground).resize(width, height, { fit: 'cover' }).modulate({ brightness: 0.38, saturation: 0.65 }).png()
    : sharp(baseSvg).png();
  const avatarNode = avatarBuffer
    ? `<image href="data:image/png;base64,${avatarBuffer.toString('base64')}" x="82" y="108" width="184" height="184" preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>`
    : `<text x="174" y="218" fill="#fff" font-size="70" text-anchor="middle" font-family="Arial,sans-serif">?</text>`;
  const serverIconNode = serverIconBuffer
    ? `<image href="data:image/png;base64,${serverIconBuffer.toString('base64')}" x="337" y="275" width="30" height="30" preserveAspectRatio="xMidYMid slice" clip-path="url(#serverClip)"/>`
    : `<circle cx="352" cy="290" r="15" fill="${accent}"/>`;
  const name = escapeXml(member.displayName || member.user.username);
  const svg = Buffer.from(`<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg"><defs><clipPath id="avatarClip"><circle cx="174" cy="200" r="92"/></clipPath><clipPath id="serverClip"><circle cx="352" cy="290" r="15"/></clipPath></defs><rect x="6" y="6" width="948" height="388" rx="28" fill="#090b12" fill-opacity=".42" stroke="#fff" stroke-opacity=".82" stroke-width="5"/><circle cx="174" cy="200" r="101" fill="#111722" stroke="${accent}" stroke-width="6"/>${avatarNode}<text x="326" y="146" fill="${accent}" font-family="Arial,sans-serif" font-size="22" font-weight="700" letter-spacing="5">WELCOME</text><rect x="326" y="162" width="175" height="4" rx="2" fill="${accent}"/><text x="326" y="235" fill="#ffffff" font-family="Arial,sans-serif" font-size="54" font-weight="700" textLength="530" lengthAdjust="spacingAndGlyphs">${name}</text>${serverIconNode}<text x="382" y="298" fill="#d8dce5" font-family="Arial,sans-serif" font-size="23" textLength="490" lengthAdjust="spacingAndGlyphs">INJURIES • Member #${memberCount}</text><text x="326" y="344" fill="#9ba4b5" font-family="Arial,sans-serif" font-size="16" letter-spacing="2">WELCOME TO THE COMMUNITY</text></svg>`);
  return background.composite([{ input: svg, top: 0, left: 0 }]).png().toBuffer();
}

async function sendWelcome(member, inviter) {
  const row = db.prepare('SELECT channel_id, config_json FROM welcome_settings WHERE guild_id = ?').get(member.guild.id);
  if (!row) return;
  const channel = member.guild.channels.cache.get(row.channel_id) ?? await member.guild.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const config = JSON.parse(row.config_json);
  const links = config.links ?? {};
  const memberCount = member.guild.memberCount;
  const memberName = member.displayName || member.user.username;
  const inviterName = inviter ? (inviter.globalName || inviter.username) : null;
  const joinedTimestamp = Math.floor((member.joinedAt?.getTime() || Date.now()) / 1000);
  const description = `Hey @${memberName}! You're member #${memberCount}. Joined on <t:${joinedTimestamp}:D>.\nInvited by ${inviterName ? `@${inviterName}` : 'Unknown (invite could not be identified)'}`;
  const serverIcon = member.guild.iconURL({ extension: 'png', size: 128 });
  const memberAvatar = member.user.displayAvatarURL({ extension: 'png', size: 128 });
  const embed = new EmbedBuilder().setColor(config.color).setTitle('Welcome!').setDescription(description)
    .setAuthor({ name: `INJURIES • Member #${memberCount}`, ...(serverIcon ? { iconURL: serverIcon } : {}) })
    .setThumbnail(memberAvatar);
  if (config.footer || config.footerThumbnail) embed.setFooter({ text: config.footer || '\u200b', ...(config.footerThumbnail ? { iconURL: config.footerThumbnail } : {}) });
  const channelDefinitions = [
    ['Dashboard', links.dashboard],
    ['Rules', links.rules],
    ['Verification', links.verification],
    ['Updates', links.updates],
    ['Methods', links.methods],
    ['Tutorial', links.tutorial],
  ];
  const channelFields = channelDefinitions.filter(([, channelId]) => typeof channelId === 'string' && /^\d{17,20}$/.test(channelId))
    .map(([name, channelId]) => ({ name, value: `<#${channelId}>`, inline: true }));
  if (channelFields.length) embed.addFields(channelFields);
  let files = [];
  const botMember = member.guild.members.me;
  const canAttach = botMember && channel.permissionsFor?.(botMember)?.has(PermissionFlagsBits.AttachFiles);
  if (canAttach === false) {
    console.warn(`Cannot upload personalized welcome card in ${channel.id}; grant Attach Files permission.`);
    if (config.bigThumbnail) embed.setImage(config.bigThumbnail);
  } else {
    try {
      const card = await renderWelcomeCard(member, memberCount, config);
      embed.setImage('attachment://welcome-card.png');
      files = [new AttachmentBuilder(card, { name: 'welcome-card.png' })];
    } catch (error) {
      console.error('Could not render personalized welcome card:', error);
      if (config.bigThumbnail) embed.setImage(config.bigThumbnail);
    }
  }
  const link = config.link;
  const components = [];
  if (link?.url) {
    try {
      const parsed = new URL(link.url);
      if (['http:', 'https:'].includes(parsed.protocol)) {
        components.push(new ActionRowBuilder().addComponents(
          new ButtonBuilder().setLabel((link.name || 'Open Link').slice(0, 80)).setStyle(ButtonStyle.Link).setURL(parsed.toString()),
        ));
      }
    } catch (error) {
      console.warn('Stored welcomer link is invalid; sending without the button.', error.message);
    }
  }
  await channel.send({ embeds: [embed], ...(files.length ? { files } : {}), ...(components.length ? { components } : {}) });
}

async function handleAutoMod(interaction) {
  if (!canManageGuild(interaction.member)) return interaction.reply({ content: 'You need Manage Server permission to configure AutoMod.', ephemeral: true });
  const words = interaction.options.getString('flagwords', true).split(',').map(w => w.trim().toLowerCase()).filter(Boolean);
  if (!words.length || words.some(w => w.length > 100)) return interaction.reply({ content: 'Enter comma-separated flag words/phrases (each at most 100 characters).', ephemeral: true });
  const channel = interaction.options.getChannel('channel', true);
  db.prepare(`INSERT INTO automod(guild_id, channel_id, punishment, duration, words) VALUES(?, ?, ?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, punishment=excluded.punishment,
    duration=excluded.duration, words=excluded.words`)
    .run(interaction.guildId, channel.id, interaction.options.getString('punishment', true), interaction.options.getString('time', true), JSON.stringify(words));
  await interaction.reply({ content: `AutoMod configured for <#${channel.id}>. Running /automod again replaces this server's configuration.`, ephemeral: true });
}

async function banWithExpiry(guild, userId, duration, reason) {
  await guild.members.ban(userId, { reason, deleteMessageSeconds: 0 });
  db.prepare('DELETE FROM timed_bans WHERE guild_id = ? AND user_id = ?').run(guild.id, userId);
  if (duration !== 'permanent') {
    db.prepare('INSERT INTO timed_bans(guild_id, user_id, expires_at) VALUES(?, ?, ?)')
      .run(guild.id, userId, Date.now() + durationDays[duration] * 86_400_000);
  }
}
async function handleBan(interaction) {
  if (!hasPermission(interaction.member, PermissionFlagsBits.BanMembers)) return interaction.reply({ content: 'You need Ban Members permission.', ephemeral: true });
  const user = interaction.options.getUser('user', true);
  if (user.id === interaction.user.id) return interaction.reply({ content: 'You cannot ban yourself.', ephemeral: true });
  const duration = interaction.options.getString('time', true);
  try {
    await banWithExpiry(interaction.guild, user.id, duration, interaction.options.getString('reason') || `Requested by ${interaction.user.tag}`);
    await interaction.reply({ content: `Banned **${escapeText(user.tag)}** ${duration === 'permanent' ? 'permanently' : `for ${duration}`}.`, ephemeral: true });
  } catch (error) {
    console.error('Ban failed:', error);
    await interaction.reply({ content: 'Ban failed. Check the bot role position and Ban Members permission.', ephemeral: true });
  }
}

function adminMentions(guild) {
  const adminRoles = [...guild.roles.cache.values()].filter(role => !role.managed && role.permissions.has(PermissionFlagsBits.Administrator));
  return [`<@${guild.ownerId}>`, ...adminRoles.map(role => `<@&${role.id}>`)].join(' ');
}
async function handleTicketPanel(interaction) {
  if (!canManageGuild(interaction.member)) return interaction.reply({ content: 'You need Manage Server permission to post a ticket panel.', ephemeral: true });
  const channel = interaction.options.getChannel('channel', true);
  const message = interaction.options.getString('message', true);
  const useEmbed = interaction.options.getBoolean('embed') ?? false;
  const mentionRole = interaction.options.getRole('mention_role');
  if (mentionRole?.id === interaction.guild.roles.everyone.id) return interaction.reply({ content: 'Choose a support role, not @everyone.', ephemeral: true });
  const button = new ButtonBuilder().setCustomId(`ticket:open:${mentionRole?.id ?? 'none'}`).setLabel('Open Ticket For Inquiries').setStyle(ButtonStyle.Primary);
  const panel = { components: [new ActionRowBuilder().addComponents(button)] };
  if (useEmbed) panel.embeds = [new EmbedBuilder().setColor(0x5865F2).setTitle('Support & Inquiries').setDescription(message)];
  else panel.content = message;
  await channel.send(panel);
  await interaction.reply({ content: `Ticket panel posted in <#${channel.id}>.`, ephemeral: true });
}
async function openTicket(interaction, selectedRoleId = null) {
  await interaction.deferReply({ ephemeral: true });
  const prior = db.prepare("SELECT channel_id FROM tickets WHERE guild_id = ? AND creator_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(interaction.guildId, interaction.user.id);
  if (prior) {
    const existing = interaction.guild.channels.cache.get(prior.channel_id);
    if (existing) return interaction.editReply(`You already have an open ticket: <#${existing.id}>.`);
    db.prepare("UPDATE tickets SET status = 'closed' WHERE channel_id = ?").run(prior.channel_id);
  }
  const result = db.prepare('INSERT INTO tickets(guild_id, channel_id, creator_id, created_at) VALUES(?, NULL, ?, ?)').run(interaction.guildId, interaction.user.id, Date.now());
  const ticketId = Number(result.lastInsertRowid);
  const name = `ticket-${String(ticketId).padStart(4, '0')}`;
  const supportRole = selectedRoleId && selectedRoleId !== 'none' ? interaction.guild.roles.cache.get(selectedRoleId) : null;
  const overwrite = [
    { id: interaction.guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
    { id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] },
    { id: client.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageChannels, PermissionFlagsBits.ManageMessages] },
  ];
  if (supportRole && supportRole.id !== interaction.guild.roles.everyone.id) {
    overwrite.push({ id: supportRole.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.EmbedLinks] });
  }
  let channel;
  try {
    channel = await interaction.guild.channels.create({
      name, type: ChannelType.GuildText, ...(interaction.channel.parentId ? { parent: interaction.channel.parentId } : {}),
      permissionOverwrites: overwrite, topic: `Ticket #${ticketId} • creator ${interaction.user.id}`,
      reason: `Support ticket opened by ${interaction.user.tag}`,
    });
    db.prepare('UPDATE tickets SET channel_id = ? WHERE id = ?').run(channel.id, ticketId);
  } catch (error) {
    db.prepare('DELETE FROM tickets WHERE id = ?').run(ticketId);
    console.error('Ticket channel creation failed:', error);
    return interaction.editReply('Could not create the private ticket channel. Check Manage Channels permission and the bot role position.');
  }
  const adminRoleIds = [...interaction.guild.roles.cache.values()].filter(r => !r.managed && r.permissions.has(PermissionFlagsBits.Administrator)).map(r => r.id);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('ticket:claim').setLabel('Claim Ticket').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId('ticket:close').setLabel('Close Ticket').setStyle(ButtonStyle.Danger),
  );
  const roleIdsToMention = [...new Set([...adminRoleIds, ...(supportRole ? [supportRole.id] : [])])];
  const supportMention = supportRole ? ` ${supportRole}` : '';
  await channel.send({ content: `${adminMentions(interaction.guild)}${supportMention}\n${interaction.user}, your ticket is open. A server administrator will assist you.\n\nAdministrators: use the buttons below to claim or close this ticket.`, components: [row],
    allowedMentions: { parse: [], users: [interaction.guild.ownerId, interaction.user.id], roles: roleIdsToMention } });
  await interaction.editReply(`Your private ticket is ready: <#${channel.id}>.`);
}
async function handleTicketButton(interaction) {
  if (interaction.customId === 'ticket:open') return openTicket(interaction);
  if (interaction.customId.startsWith('ticket:open:')) return openTicket(interaction, interaction.customId.slice('ticket:open:'.length));
  const ticket = db.prepare('SELECT * FROM tickets WHERE channel_id = ?').get(interaction.channelId);
  if (!ticket || ticket.status !== 'open') return interaction.reply({ content: 'This ticket is no longer open.', ephemeral: true });
  if (interaction.customId === 'ticket:claim') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Only server administrators can claim tickets.', ephemeral: true });
    db.prepare('UPDATE tickets SET claimed_by = ? WHERE channel_id = ?').run(interaction.user.id, interaction.channelId);
    return interaction.reply({ content: `Ticket claimed by ${interaction.user}.` });
  }
  if (interaction.customId === 'ticket:close') {
    if (!isAdmin(interaction.member)) return interaction.reply({ content: 'Only server administrators can close tickets.', ephemeral: true });
    await interaction.deferReply({ ephemeral: true });
    const closing = db.prepare("UPDATE tickets SET status = 'closing' WHERE channel_id = ? AND status = 'open'").run(interaction.channelId);
    if (!closing.changes) return interaction.editReply('This ticket is already closing or closed.');
    try {
      await interaction.channel.delete(`Ticket closed by ${interaction.user.tag}`);
    } catch (error) {
      console.error('Ticket close failed:', error);
      db.prepare("UPDATE tickets SET status = 'open' WHERE channel_id = ? AND status = 'closing'").run(interaction.channelId);
      return interaction.editReply('Could not delete this ticket channel. Check the bot’s Manage Channels permission and role position.');
    }
    db.prepare("UPDATE tickets SET status = 'closed' WHERE channel_id = ? AND status = 'closing'").run(interaction.channelId);
    await interaction.editReply('Ticket closed and its channel deleted.');
  }
}

async function moderateMessage(message) {
  if (!message.guild || message.author.bot) return;
  const setting = db.prepare('SELECT * FROM automod WHERE guild_id = ?').get(message.guild.id);
  if (!setting || setting.channel_id !== message.channelId) return;
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member || member.permissions.has(PermissionFlagsBits.ManageMessages) || isAdmin(member)) return;
  const match = JSON.parse(setting.words).find(word => message.content.toLowerCase().includes(word));
  if (!match) return;
  await message.delete().catch(() => {});
  try {
    const reason = `AutoMod flag word: ${match}`;
    if (setting.punishment === 'timeout') {
      await member.timeout(Math.min(durationDays[setting.duration], 28) * 86_400_000, reason);
    } else if (setting.punishment === 'kick') {
      await member.kick(reason);
    } else {
      await banWithExpiry(message.guild, member.id, setting.duration, reason);
    }
    const label = setting.punishment === 'timeout' && setting.duration === '30d' ? '28-day timeout (Discord maximum)' : `${setting.duration} ${setting.punishment}`;
    const notice = await message.channel.send(`${message.author}, your message matched a server flag word. Action: **${label}**.`).catch(() => null);
    if (notice) setTimeout(() => notice.delete().catch(() => {}), 10_000).unref?.();
  } catch (error) {
    console.error(`AutoMod action ${setting.punishment} failed:`, error);
  }
}
async function unbanExpired() {
  for (const row of db.prepare('SELECT * FROM timed_bans WHERE expires_at <= ?').all(Date.now())) {
    const guild = client.guilds.cache.get(row.guild_id);
    if (guild) await guild.members.unban(row.user_id, 'Temporary ban expired').catch(error => console.error('Auto-unban failed:', error));
    db.prepare('DELETE FROM timed_bans WHERE guild_id = ? AND user_id = ?').run(row.guild_id, row.user_id);
  }
}

client.once('ready', async () => {
  console.log(`Online as ${client.user.tag}`);
  try { await registerCommands(); }
  catch (error) { console.error('Slash command registration failed:', error); process.exit(1); }
  await Promise.all([...client.guilds.cache.values()].map(snapshotInvites));
  await unbanExpired();
  setInterval(unbanExpired, 60_000).unref();
});
client.on('guildCreate', guild => snapshotInvites(guild));
async function processMemberJoin(member) {
  const guildId = member.guild.id;
  const previous = inviteJoinQueues.get(guildId) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(async () => {
    const inviter = await findJoiningInvite(member);
    recordInviteJoin(member, inviter?.id ?? null);
    await sendWelcome(member, inviter);
  });
  inviteJoinQueues.set(guildId, current);
  try {
    await current;
  } finally {
    if (inviteJoinQueues.get(guildId) === current) inviteJoinQueues.delete(guildId);
  }
}
client.on('guildMemberAdd', member => processMemberJoin(member).catch(error => console.error('Member join processing failed:', error)));
client.on('guildMemberRemove', member => {
  try { recordInviteLeave(member); }
  catch (error) { console.error('Invite departure tracking failed:', error); }
});
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'embed') return await handleEmbed(interaction);
      if (interaction.commandName === 'automod') return await handleAutoMod(interaction);
      if (interaction.commandName === 'ban') return await handleBan(interaction);
      if (interaction.commandName === 'ticket') return await handleTicketPanel(interaction);
      if (interaction.commandName === 'welcomer') return await handleWelcomer(interaction);
      if (interaction.commandName === 'invites') return await handleInvites(interaction);
      if (interaction.commandName === 'disable') return await handleDisable(interaction);
      if (interaction.commandName === 'enable') return await handleEnable(interaction);
      if (interaction.commandName === 'droles') return await handleDRoles(interaction);
      if (interaction.commandName === 'purgeall') return await handlePurgeAll(interaction);
      if (interaction.commandName === 'cleanup') return await handleCleanup(interaction);
    }
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('cleanup:')) return await handleCleanupButton(interaction);
      return await handleTicketButton(interaction);
    }
  } catch (error) {
    console.error('Interaction failed:', error);
    const response = { content: 'Something went wrong. Check bot logs and permissions.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});
client.on('messageCreate', message => moderateMessage(message).catch(error => console.error('AutoMod handler error:', error)));
client.on('error', error => console.error('Discord client error:', error));
process.on('SIGTERM', () => {
  try { db.pragma('wal_checkpoint(TRUNCATE)'); }
  catch (error) { console.error('SQLite shutdown checkpoint failed:', error); }
  db.close();
  client.destroy();
  process.exit(0);
});
client.login(token);
