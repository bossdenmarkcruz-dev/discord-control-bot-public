import 'dotenv/config';
import {
  ActionRowBuilder, ButtonBuilder, ButtonStyle, ChannelType, Client, EmbedBuilder,
  GatewayIntentBits, PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
const guildId = process.env.DISCORD_GUILD_ID;
if (!token || !clientId) {
  console.error('Set DISCORD_TOKEN and DISCORD_CLIENT_ID. See .env.example and README.md.');
  process.exit(1);
}

const dataDir = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(dataDir, { recursive: true });
const db = new Database(path.join(dataDir, 'bot.sqlite'));
db.pragma('journal_mode = WAL');
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
  new SlashCommandBuilder().setName('welcomer').setDescription('Configure automatic welcome messages for new members.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .addChannelOption(o => o.setName('channel').setDescription('Channel to post welcome messages in').addChannelTypes(ChannelType.GuildText).setRequired(true))
    .addStringOption(o => o.setName('embed_color').setDescription('Six-digit hex color, e.g. #5865F2').setMaxLength(7).setRequired(true))
    .addAttachmentOption(o => o.setName('big_thumbnail').setDescription('Large image shown on welcome messages').setRequired(false))
    .addAttachmentOption(o => o.setName('small_thumbnail').setDescription('Small right-side thumbnail').setRequired(false))
    .addStringOption(o => o.setName('footer').setDescription('Optional embed footer text').setMaxLength(2048).setRequired(false))
    .addAttachmentOption(o => o.setName('footer_thumbnail').setDescription('Small icon beside the footer').setRequired(false))
    .addChannelOption(o => o.setName('dashboard_channel').setDescription('Optional Discord channel for your dashboard').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('rules_channel').setDescription('Optional Discord channel for server rules').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('tutorial_channel').setDescription('Optional Discord channel for tutorials').addChannelTypes(ChannelType.GuildText).setRequired(false))
    .addChannelOption(o => o.setName('methods_channel').setDescription('Optional Discord channel for methods').addChannelTypes(ChannelType.GuildText).setRequired(false)),
].map(c => c.toJSON());

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });
const inviteSnapshots = new Map();
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
  const links = {
    dashboard: interaction.options.getChannel('dashboard_channel')?.id ?? null,
    rules: interaction.options.getChannel('rules_channel')?.id ?? null,
    tutorial: interaction.options.getChannel('tutorial_channel')?.id ?? null,
    methods: interaction.options.getChannel('methods_channel')?.id ?? null,
  };
  const channel = interaction.options.getChannel('channel', true);
  const config = {
    color: Number.parseInt(colorText, 16),
    bigThumbnail: interaction.options.getAttachment('big_thumbnail')?.url ?? null,
    smallThumbnail: interaction.options.getAttachment('small_thumbnail')?.url ?? null,
    footer: interaction.options.getString('footer'),
    footerThumbnail: interaction.options.getAttachment('footer_thumbnail')?.url ?? null,
    links,
  };
  db.prepare(`INSERT INTO welcome_settings(guild_id, channel_id, config_json) VALUES(?, ?, ?)
    ON CONFLICT(guild_id) DO UPDATE SET channel_id=excluded.channel_id, config_json=excluded.config_json`)
    .run(interaction.guildId, channel.id, JSON.stringify(config));
  const selectedLinks = Object.values(links).filter(Boolean).length;
  await interaction.reply({ content: `Welcomer configured for <#${channel.id}> with ${selectedLinks} optional channel mention${selectedLinks === 1 ? '' : 's'}. Enable Server Members Intent in the Discord Developer Portal to receive join events.`, ephemeral: true });
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
    let joiningInvite = null;
    const next = new Map();
    for (const invite of currentInvites.values()) {
      const uses = invite.uses ?? 0;
      const oldInvite = previous.get(invite.code);
      next.set(invite.code, { uses, inviterId: invite.inviter?.id ?? oldInvite?.inviterId ?? null });
      if (uses > (oldInvite?.uses ?? 0)) joiningInvite = invite;
    }
    inviteSnapshots.set(member.guild.id, next);
    return joiningInvite?.inviter ?? (joiningInvite?.inviterId ? await client.users.fetch(joiningInvite.inviterId).catch(() => null) : null);
  } catch (error) {
    console.warn(`Could not identify the invite used in ${member.guild.name}; inviter will be unknown.`, error.message);
    return null;
  }
}

async function sendWelcome(member) {
  const row = db.prepare('SELECT channel_id, config_json FROM welcome_settings WHERE guild_id = ?').get(member.guild.id);
  if (!row) return;
  const channel = member.guild.channels.cache.get(row.channel_id) ?? await member.guild.channels.fetch(row.channel_id).catch(() => null);
  if (!channel?.isTextBased()) return;
  const config = JSON.parse(row.config_json);
  const inviter = await findJoiningInvite(member);
  const memberName = member.displayName || member.user.username;
  const inviterName = inviter ? (inviter.globalName || inviter.username) : null;
  const description = `Welcome To Our Server @${memberName}\nYou're Our ${ordinal(member.guild.memberCount)} Member On Our Server\nInvited by ${inviterName ? `@${inviterName}` : 'Unknown (invite could not be identified)'}`;
  const embed = new EmbedBuilder().setColor(config.color).setTitle('Welcome to our server!').setDescription(description);
  if (config.bigThumbnail) embed.setImage(config.bigThumbnail);
  if (config.smallThumbnail) embed.setThumbnail(config.smallThumbnail);
  if (config.footer || config.footerThumbnail) embed.setFooter({ text: config.footer || '\u200b', ...(config.footerThumbnail ? { iconURL: config.footerThumbnail } : {}) });
  const linkDefinitions = [
    ['Please Read Our Rules', config.links.rules],
    ['Here’s Our Dashboard', config.links.dashboard],
    ['Join Tutorial If You’re New', config.links.tutorial],
    ['OP Leaked Methods Join Now', config.links.methods],
  ];
  const linkFields = linkDefinitions.filter(([, channelId]) => typeof channelId === 'string' && /^\d{17,20}$/.test(channelId))
    .map(([name, channelId]) => ({ name, value: `<#${channelId}>`, inline: false }));
  if (linkFields.length) embed.addFields(linkFields);
  await channel.send({ embeds: [embed] });
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
client.on('guildMemberAdd', member => sendWelcome(member).catch(error => console.error('Welcome message failed:', error)));
client.on('interactionCreate', async interaction => {
  try {
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === 'embed') return await handleEmbed(interaction);
      if (interaction.commandName === 'automod') return await handleAutoMod(interaction);
      if (interaction.commandName === 'ban') return await handleBan(interaction);
      if (interaction.commandName === 'ticket') return await handleTicketPanel(interaction);
      if (interaction.commandName === 'welcomer') return await handleWelcomer(interaction);
    }
    if (interaction.isButton()) await handleTicketButton(interaction);
  } catch (error) {
    console.error('Interaction failed:', error);
    const response = { content: 'Something went wrong. Check bot logs and permissions.', ephemeral: true };
    if (interaction.deferred || interaction.replied) await interaction.followUp(response).catch(() => {});
    else await interaction.reply(response).catch(() => {});
  }
});
client.on('messageCreate', message => moderateMessage(message).catch(error => console.error('AutoMod handler error:', error)));
client.on('error', error => console.error('Discord client error:', error));
process.on('SIGTERM', () => { db.close(); client.destroy(); process.exit(0); });
client.login(token);
