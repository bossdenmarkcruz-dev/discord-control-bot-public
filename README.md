# Discord Control Bot

A Node.js Discord bot with four slash commands: `/embed`, `/automod`, `/ban`, and `/ticket`. It uses SQLite for automod settings, ticket records, and scheduled temporary unbans.

## Discord setup

1. In the [Discord Developer Portal](https://discord.com/developers/applications), create an application and add a bot.
2. Enable the **Message Content Intent** under the bot's privileged gateway intents. AutoMod needs this to inspect message text.
3. Invite the bot using OAuth2 URL Generator with scopes `bot` and `applications.commands`. Grant only the permissions it needs: View Channels, Send Messages, Read Message History, Embed Links, Manage Messages, Moderate Members, Kick Members, Ban Members, and Manage Channels. The bot's role must be positioned above users it moderates.
4. Copy `.env.example` to `.env` for local use and fill in `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, and optionally `DISCORD_GUILD_ID`. Never commit `.env` or share the bot token. `DISCORD_GUILD_ID` makes slash-command updates immediate in one server; without it commands register globally and can take time to appear.
5. Run `npm ci` then `npm start`.

## Commands

- `/embed bot_name image color message footer big_thumbnail small_thumbnail footer_thumbnail` sends an embed to the channel where it was invoked. Image inputs are Discord attachment uploads. The main `image` (or `big_thumbnail` if no image is given) becomes the large embed image; `small_thumbnail` is the right-side thumbnail; `footer_thumbnail` is the footer icon. Example color: `#5865F2`.
- `/automod channel punishment time flagwords` monitors the selected channel. Enter flag words/phrases as comma-separated text. Available actions: timeout, temporary ban, or kick. One configuration is stored per server; running `/automod` again replaces it. Discord's maximum timeout is 28 days, so a requested 30-day timeout is applied as 28 days. Temporary bans are lifted by the bot after the selected interval.
- `/ban user time reason` applies a permanent ban or a 1, 3, 7, 14, or 30 day temporary ban. Temporary bans are lifted automatically while the bot is online; expiry records are persisted so due bans are processed when it starts again.
- `/ticket channel message` posts a panel with **Open Ticket For Inquiries**. Each user can have one open ticket per server. A new ticket is private to its creator, bot, and server administrators (Discord Administrator permission bypasses channel overwrites). Admins can claim; the creator or an admin can close. Closing renames and makes the channel read-only rather than deleting it, preserving the conversation for reference.

The bot does not delete or hide admin audit records. Moderation actions are limited to users below the bot's role hierarchy; Discord will reject actions against higher roles.

## Railway

This repository is configured for Railway's Node/Nixpacks deployment. Add these Railway service variables in the Railway dashboard (do not put secrets in GitHub):

- `DISCORD_TOKEN` — bot token from the Discord Developer Portal.
- `DISCORD_CLIENT_ID` — Discord application ID.
- `DISCORD_GUILD_ID` — optional; recommended for initial testing in one server.
- `DATA_DIR=/data` — use with a Railway Volume mounted at `/data` so SQLite settings, tickets, and temporary-ban timers survive redeploys.

After deployment, add a Railway Volume mounted at `/data` and ensure the variables above are set before the service starts. Without a mounted volume, local SQLite data may be lost on redeploy. Enable GitHub-repository deployment in Railway or deploy with the Railway CLI.

## Local checks

```sh
npm ci
npm run check
```

The bot registers its slash commands on startup. For development, set `DISCORD_GUILD_ID` to your test server ID.
