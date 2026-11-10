# Discord Control Bot

A Node.js Discord bot with ten slash commands: `/embed`, `/automod`, `/ban`, `/ticket`, `/welcomer`, `/invites`, `/disable`, `/enable`, `/droles`, and `/purgeall`. It uses SQLite for automod settings, ticket records, welcomer settings, invite attribution/statistics, recoverable channel-lock snapshots, and scheduled temporary unbans.

## Discord setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a bot.
2. Enable the **Message Content Intent** and **Server Members Intent** under the bot's privileged gateway intents. AutoMod needs Message Content to inspect message text; the welcomer needs Server Members to receive join events.
3. Invite the bot using OAuth2 URL Generator with scopes `bot` and `applications.commands`. Grant only the permissions it needs: View Channels, Send Messages, Read Message History, Embed Links, Attach Files (for generated welcome-card PNGs), Manage Messages, Moderate Members, Kick Members, Ban Members, Manage Channels, Manage Roles, and Manage Threads for private archived-thread coverage. For inviter names in welcome messages and `/invites` statistics, also grant **Manage Server** so the bot can read invite-use counts. The bot's role must be positioned above roles it needs to remove. For the raid commands, the bot also needs Manage Channels (`/disable`, `/enable`), Manage Roles (`/droles`), and Manage Messages (`/purgeall`).
4. Copy `.env.example` to `.env` for local use and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and optionally `DISCORD_GUILD_ID`. Never commit `.env` or share the bot token. `DISCORD_GUILD_ID` makes slash-command updates immediate in one server; without it commands register globally and can take time to appear.
5. Run `npm ci` then `npm start`.

## Commands

- `/embed bot_name color message [image] [footer] [big_thumbnail] [small_thumbnail] [footer_thumbnail] [link] [link_title]` sends an embed to the channel where it was invoked. Image inputs are Discord attachment uploads. The main `image` (or `big_thumbnail` if no image is given) becomes the large embed image; `small_thumbnail` is the right-side thumbnail; `footer_thumbnail` is the footer icon. Example color: `#5865F2`. If `link` is provided, the embed gets a button underneath. Set `link_title` to customize its button text (up to 80 characters); if omitted, the label is **Open Link**. Use an HTTP or HTTPS URL. Discord fixes the appearance of URL buttons to its Link style, so their color cannot be customized.
- `/automod channel punishment time flagwords` monitors the selected channel. Enter flag words/phrases as comma-separated text. Available actions: timeout, temporary ban, or kick. One configuration is stored per server; running `/automod` again replaces it. Discord's maximum timeout is 28 days, so a requested 30-day timeout is applied as 28 days. Temporary bans are lifted by the bot after the selected interval.
- `/ban user time reason` applies a permanent ban or a 1, 3, 7, 14, or 30 day temporary ban. Temporary bans are lifted automatically while the bot is online; expiry records are persisted so due bans are processed when it starts again.
- `/ticket channel message [embed] [mention_role]` posts a ticket panel with **Open Ticket For Inquiries**. Set `embed` to true to display the panel message as an embed; false or omitted sends plain text. If `mention_role` is selected, that role is pinged and given access to each ticket along with the creator, bot, and server administrators. Make the role mentionable or give the bot permission to mention it. Each user can have one open ticket per server. The ticket's opening message contains **Claim Ticket** and **Close Ticket** buttons; only server administrators can press either. **Close Ticket permanently deletes the channel and its conversation**, so it cannot be reviewed afterward.
- `/welcomer channel embed_color [big_thumbnail] [small_thumbnail] [footer] [footer_thumbnail] [dashboard_channel] [rules_channel] [verification_channel] [updates_channel] [methods_channel] [tutorial_channel] [link_url] [link_name]` configures automatic join cards. Each join sends an embed titled **Welcome!** with `Hey @member! You're member #N. Joined on [date]. Invited by @inviter`. The bot generates a personalized wide PNG banner: the member's profile picture is shown in a circular frame, the server icon is a small circular badge, and the banner says **INJURIES • Member #N**. `big_thumbnail` is an optional background image for that banner; `small_thumbnail` optionally replaces the little badge icon. Without a background, the bot generates a dark design; if the server has no icon and no custom badge was supplied, it uses a colored badge. Optional Dashboard, Rules, Verification, Updates, Methods, and Tutorial channel selectors appear as Discord channel mentions inside the embed. `link_url` and `link_name` optionally add a clickable URL button beneath the embed; the URL must be HTTP or HTTPS and the button label defaults to **Open Link**. The welcome channel, embed color, images, footer, channel mentions, and link persist in SQLite. Run `/welcomer` again to replace the configuration. The bot needs **Server Members Intent** enabled in the Discord Developer Portal; it also needs **Manage Server** to identify inviters from invite-use changes. If an invite cannot be identified, the card says the inviter is unknown rather than guessing.
- `/invites user` is available to anyone in the server. It shows **Leaved** (tracked invited members who left or were removed), **Invites** (total tracked joins attributed to that user, including leavers and current members), and **Current Total Invites** (`Invites - Leaved`). The bot only credits a join when one invite's use increases unambiguously by exactly one; simultaneous or unknown invite-use changes are not guessed. The bot needs **Manage Server** permission to read invite uses. Discord does not expose member-by-member invite attribution in old logs, so history that was already lost cannot be accurately reconstructed.
- `/disable` locks public text, announcement, forum, and media channels by denying `@everyone` permission to send messages or create threads. It saves the previous `@everyone` send/thread permissions in SQLite. Administrators bypass channel locks, and other roles explicitly allowed to send may still be able to post.
- `/enable` restores the saved `@everyone` send/thread permissions from the most recent `/disable`. The snapshots survive restarts; channels that fail to restore remain saved so an admin can retry.
- `/droles confirmation:"REMOVE ADMIN ROLES"` removes roles with the Administrator permission from every other member, while leaving the command user, server owner, and bot account untouched. Requires the bot's Manage Roles permission, Server Members Intent, and a bot role above the roles being removed. Role hierarchy restrictions may prevent some removals.
- `/purgeall confirmation:"PURGE ALL MESSAGES"` permanently deletes messages in accessible text, announcement, forum, media, and accessible thread channels. Messages newer than 14 days are bulk-deleted; older ones are removed individually. This cannot be undone. The bot may not be able to list private archived threads unless it has Manage Threads access, and missing channel permissions can leave messages behind.

All four raid-response commands are Administrator-only, enforced by both Discord command permissions and bot-side checks. `/droles` and `/purgeall` require the exact typed confirmation shown above to reduce accidental execution. Review the response counts and bot logs if Discord permissions or role hierarchy prevent a complete operation.

The bot does not delete or hide admin audit records. Moderation actions are limited to users below the bot's role hierarchy; Discord will reject actions against higher roles.

## Railway

This repository is configured for Railway's Railpack Node deployment. Add these Railway service variables in the Railway dashboard (do not put secrets in GitHub):

- `DISCORD_TOKEN` — bot token from the Discord Developer Portal.
- `DISCORD_CLIENT_ID` — Discord application ID.
- `DISCORD_GUILD_ID` — optional; recommended for initial testing in one server.
- `DATA_DIR` — optional local/override setting. On Railway, the bot automatically uses `RAILWAY_VOLUME_MOUNT_PATH` when a volume is attached; otherwise it falls back to `./data`.

Attach a Railway Volume to the bot service at **`/app/data`** (the bot's existing default SQLite directory). Railway supplies `RAILWAY_VOLUME_MOUNT_PATH` automatically, and the bot uses it on startup. This keeps welcomer configuration, invite counters, tickets, and moderation state across deployments. Use one service replica with a Railway Volume. Railway bills volume storage by actual use at **$0.15 per GB per month**; the Free plan's volume size is capped at 0.5 GB. Without an attached volume, the container's SQLite file can disappear on redeploy. Enable GitHub-repository deployment in Railway or deploy with the Railway CLI.

Invite counters are only as complete as recorded member-join and member-leave events. Discord's invite API provides per-code aggregate use counts, not a list of who used each invite, and its audit log does not record invite attribution for joins. Joins while the bot is offline, ambiguous simultaneous uses, deleted invites, and old counters that no longer exist in a backup cannot be assigned accurately after the fact.

The bot registers commands in one scope at a time. When `DISCORD_GUILD_ID` is set, startup removes stale global copies and registers the commands only to that server. Without it, startup clears stale per-server copies and registers globally.

## Local checks

```sh
npm ci
npm run check
```

The bot registers its slash commands on startup. For development, set `DISCORD_GUILD_ID` to your test server ID.
