# Discord to WhatsApp Bridge

A Node.js TypeScript application that bridges Discord messages to WhatsApp using unofficial APIs.

## Features

- Connects to WhatsApp using Baileys (lightweight, headless, no browser/Puppeteer)
- Low memory footprint - runs directly on WhatsApp's protocol
- Listens to ALL messages from an entire Discord server
- Forwards Discord messages to a WhatsApp recipient with server and channel info
- Persistent WhatsApp session (no need to scan QR code every time)

## Prerequisites

- Node.js 18+ installed
- A Discord bot token
- WhatsApp account with mobile app

## Setup

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Create a Discord Bot:**
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Create a new application
   - Go to "Bot" section and create a bot
   - Copy the bot token
   - Enable "Message Content Intent" in Bot settings
   - Invite bot to your server with appropriate permissions

3. **Configure environment variables:**
   ```bash
   cp .env.example .env
   ```
   
   Edit `.env` and fill in:
   - `DISCORD_BOT_TOKEN`: Your Discord bot token
   - `DISCORD_SERVER_ID`: The Discord server ID to monitor (right-click server icon → Copy Server ID)
   - `WHATSAPP_RECIPIENT`: WhatsApp number with country code (e.g., 1234567890)

4. **Build the project:**
   ```bash
   npm run build
   ```

## Usage

1. **Start the bridge:**
   ```bash
   npm start
   ```
   
   Or for development with auto-reload:
   ```bash
   npm run dev
   ```

2. **First-time WhatsApp setup:**
   - A QR code will appear in the terminal
   - Open WhatsApp on your phone
   - Go to Settings → Linked Devices → Link a Device
   - Scan the QR code
   - The session will be saved for future use

3. **Send messages:**
   - Send any message in ANY channel in the configured Discord server
   - All messages will be forwarded to the WhatsApp recipient with server and channel info

## How It Works

- **WhatsApp Connection**: Uses `Baileys` - a lightweight, headless library that connects directly to WhatsApp's protocol (no browser overhead)
- **Discord Listener**: Monitors ALL messages from ALL channels in the specified Discord server
- **Message Forwarding**: Formats and sends Discord messages to WhatsApp with server, channel, and sender info

## Notes

- The WhatsApp session is stored locally in `auth_info/` directory
- ALL messages from ALL channels in the configured Discord server are forwarded
- Bot messages are ignored to prevent loops
- The WhatsApp number format should be: country code + number (no + or spaces)
- Very low memory usage compared to browser-based solutions
- Messages include server name, channel name, and sender username

## Troubleshooting

- **QR code not appearing**: Make sure you have a stable internet connection
- **Authentication failed**: Delete `auth_info/` folder and scan QR code again
- **Messages not forwarding**: Check that the Discord server ID and WhatsApp number are correct
- **Discord bot not responding**: Ensure "Message Content Intent" is enabled in Discord Developer Portal
- **Connection issues**: Baileys will automatically reconnect if disconnected

## GitHub Actions Setup

This project includes a GitHub Actions workflow that runs the bridge in a continuous loop - each run lasts 4 minutes, waits 5 minutes, then automatically triggers the next run.

### Setting up GitHub Secrets

1. **Go to your GitHub repository** → Settings → Secrets and variables → Actions

2. **Create the following secrets:**

   **CREDS_JSON**: 
   - After successfully authenticating WhatsApp locally (scanning QR code)
   - Copy the entire content of `auth_info/creds.json`
   - Create a new secret named `CREDS_JSON` and paste the JSON content

   **ENV_FILE**:
   - Copy the entire content of your `.env` file
   - Create a new secret named `ENV_FILE` and paste the content
   - Example format:
     ```
     DISCORD_BOT_TOKEN=your_discord_bot_token_here
     DISCORD_SERVER_ID=your_server_id_here
     WHATSAPP_RECIPIENT=1234567890
     ```

3. **Workflow behavior:**
   - Runs for 4 minutes
   - Waits 5 minutes
   - Automatically triggers the next run (continuous loop)
   - Restores WhatsApp session from secrets each time

### Starting the Loop

Trigger the workflow once manually to start the continuous loop:
1. Go to Actions tab in your repository
2. Select "Discord WhatsApp Bridge" workflow
3. Click "Run workflow"
4. The workflow will keep triggering itself every 5 minutes after each 4-minute run

### Stopping the Loop

To stop the continuous loop, cancel the running workflow from the Actions tab.

## License

MIT
