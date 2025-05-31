# MTG Wants Bot Setup Guide

A Discord bot for managing Magic: The Gathering card wants lists. Users can add, remove, and track cards they're looking for, with automatic validation using the Scryfall API.

## Features

- ✅ Add/remove MTG cards from personal wants lists
- 🔍 Automatic card name validation via Scryfall API
- 📋 Set-specific card tracking (foil/non-foil)
- 🎯 Fuzzy card name matching
- 📌 Pinned message display of all server wants
- 🔄 Multiple operations in single command
- 💾 Per-server data storage
- ⚡ Both slash commands and legacy text commands

## Prerequisites

- Node.js 16.9.0 or higher
- npm or yarn package manager
- A Discord application and bot token
- Basic command line knowledge

## Installation

### 1. Clone or Download the Bot

Save the bot code as `mtg-wants-bot.js` in a new directory.

### 2. Initialize Node.js Project

```bash
mkdir mtg-wants-bot
cd mtg-wants-bot
npm init -y
```

### 3. Install Dependencies

```bash
npm install discord.js
```

### 4. Create Discord Application

1. Go to [Discord Developer Portal](https://discord.com/developers/applications)
2. Click "New Application"
3. Give it a name (e.g., "MTG Wants Bot")
4. Go to the "Bot" section
5. Click "Add Bot"
6. Copy the bot token (keep this secret!)

### 5. Set Bot Permissions

In the Discord Developer Portal, go to OAuth2 > URL Generator:

**Scopes:**
- `bot`
- `applications.commands`

**Bot Permissions:**
- Send Messages
- Use Slash Commands
- Embed Links
- Read Message History
- Manage Messages (for pinning)
- Add Reactions

Copy the generated URL to invite the bot to your server.

### 6. Configure Bot Token

**Option A: Environment Variable (Recommended)**
```bash
# Linux/macOS
export BOT_TOKEN="your_bot_token_here"

# Windows Command Prompt
set BOT_TOKEN=your_bot_token_here

# Windows PowerShell
$env:BOT_TOKEN="your_bot_token_here"
```

**Option B: Edit Code**
Replace `'YOUR_BOT_TOKEN_HERE'` in the code with your actual bot token.

### 7. Run the Bot

```bash
node mtg-wants-bot.js
```

You should see:
```
[BotName] is online!
Started refreshing application (/) commands.
Successfully reloaded application (/) commands.
Testing Scryfall API connection...
✅ Scryfall API test successful: Lightning Bolt
```

## Usage

### Slash Commands (Recommended)

**Add cards:**
```
/wants + 2 Lightning Bolt
/wants + 1 Lightning Bolt (M25, foil)
/wants + 3 Force of Will (foil)
/wants + 1 Black Lotus (Unlimited)
```

**Remove cards:**
```
/wants - 1 Lightning Bolt (M25, foil)
/wants - 2 Lightning Bolt
```

**Multiple operations:**
```
/wants +1 Lightning Bolt (M25, foil) -2 Opt +3 Island
/wants +2 Force of Will (foil) -1 Brainstorm (EMA)
```

**Clear all wants:**
```
/wants clear
```

**Show help:**
```
/wants help
```

### Legacy Text Commands

All slash commands also work with `!wants` prefix:
```
!wants + 2 Lightning Bolt
!wants - 1 Force of Will (foil)
!wants clear
```

## Set Specifications

You can specify cards in various ways:

- **Any printing:** `Lightning Bolt`
- **Specific set:** `Lightning Bolt (M25)`
- **Foil from any set:** `Lightning Bolt (foil)`
- **Foil from specific set:** `Lightning Bolt (M25, foil)`
- **Set by name:** `Lightning Bolt (Masters 25)`

## Limits

- **Cards per user:** 50 different specifications
- **Copies per card:** 99 maximum
- **Card name length:** 100 characters maximum

## Troubleshooting

### Bot doesn't respond
- Check bot token is correct
- Ensure bot has proper permissions
- Verify bot is online in Discord server member list

### "Card not found" errors
- Check spelling (fuzzy matching helps but isn't perfect)
- Try using full card name
- Verify set code exists (use 3-letter codes like "M25", "EMA")

### Permission errors
- Bot needs "Manage Messages" permission to pin messages
- Bot needs "Send Messages" and "Embed Links" permissions

### API rate limiting
- Bot includes automatic rate limiting for Scryfall API
- If experiencing issues, wait a few minutes and try again

## Advanced Setup

### Running as a Service

**Using PM2 (Linux/macOS):**
```bash
npm install -g pm2
pm2 start mtg-wants-bot.js --name "mtg-bot"
pm2 startup
pm2 save
```

**Using systemd (Linux):**
Create `/etc/systemd/system/mtg-bot.service`:
```ini
[Unit]
Description=MTG Wants Bot
After=network.target

[Service]
Type=simple
User=your-username
WorkingDirectory=/path/to/bot
ExecStart=/usr/bin/node mtg-wants-bot.js
Environment=BOT_TOKEN=your_bot_token_here
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable mtg-bot
sudo systemctl start mtg-bot
```

### Docker Setup

Create `Dockerfile`:
```dockerfile
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY mtg-wants-bot.js ./
CMD ["node", "mtg-wants-bot.js"]
```

Build and run:
```bash
docker build -t mtg-wants-bot .
docker run -e BOT_TOKEN=your_token_here mtg-wants-bot
```

## Data Storage

The bot stores data in memory only. When the bot restarts, all wants lists are lost. For persistent storage, you would need to modify the code to use a database like SQLite, PostgreSQL, or MongoDB.

## Support

- Card data provided by [Scryfall API](https://scryfall.com/docs/api)
- For Discord.js help: [Discord.js Guide](https://discordjs.guide/)
- For Discord bot permissions: [Discord Developer Docs](https://discord.com/developers/docs)

## Notes

- The bot validates all card names against Scryfall's database
- Fuzzy matching means "bolt" will find "Lightning Bolt"
- Each server has its own separate wants list
- The pinned message updates automatically when users modify their wants
