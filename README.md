# claudebot

Telegram bot for chatting with Claude or ChatGPT, and for driving your local Claude Code sessions from your phone.

## Setup

1. Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token.
2. Claude runs through your local `claude` CLI (Claude Code), using whatever account it's logged into. Make sure `claude -p "hi"` works in a terminal. For ChatGPT, add an OpenAI key.
3. `cp .env.example .env` and fill in `TELEGRAM_BOT_TOKEN` (and `OPENAI_API_KEY` if you want ChatGPT).
4. `npm install && npm start`
5. Send `/whoami` to the bot, put the ID in `ALLOWED_USER_IDS`, restart. **Required** for Claude Code sessions.

The bot must run on the computer where `claude` is installed and logged in.

## Two modes

**Chat** (default): plain conversation with Claude or ChatGPT. Claude here has no tools and no access to your files.

**Claude Code sessions**: real Claude Code on your computer, with tools, in a project folder.

- `/sessions` – lists your recent Claude Code sessions (same ones as `claude --resume`). Tap one to continue it: it runs in that session's folder, and the conversation picks up where it left off.
- `/new <folder>` – starts a fresh Claude Code session in a folder (e.g. `/new ~/Desktop/work/myrepo`).
- While working, a status message updates live with each tool call (🔧 Bash: …, 🔧 Edit: …), and Claude's text replies come through as normal messages.
- `/recap` – the latest messages of the attached session (useful if you also used it in a terminal).
- `/stop` – interrupt Claude mid-task.
- `/exit` – leave the session; it prints the `claude --resume <id>` command to pick it up on your computer.

Sessions started or continued from Telegram are normal Claude Code sessions, so you can resume them in the terminal later.

### Staying in sync with the terminal

- `/sessions` marks sessions that are open right now: 🟢 open in a terminal, 🔵 running in the background (from `claude agents --json`).
- While you're attached, anything that happens in that session outside Telegram (your terminal prompts, Claude's tool calls and replies) shows up in Telegram live, marked 🖥, until you `/exit`.
- If the session moves to a new ID, the bot follows it.
- An open terminal can't receive messages from outside. So if you send from Telegram while the session is open in a terminal, the bot continues in a **forked copy** (`--fork-session`) and gives you the new ID. To keep one shared session, close it in the terminal first, then message from Telegram; reopen it later with `claude --resume <id>` and you'll see everything.
- Which session you're attached to is saved in `data/state.json`, so live updates pick up again after the bot restarts.

## Settings

- `CLAUDE_CODE_PERMISSION_MODE` – `auto` (default, a safety classifier approves or blocks each action), `acceptEdits`, `plan` (read-only planning), `dontAsk`, or `bypassPermissions` (anything goes). There's no way to answer a permission prompt from Telegram, so actions that would prompt are refused.
- `CLAUDE_CODE_DEFAULT_DIR` – folder for `/new` with no argument (default: home).
- `CLAUDE_CODE_TIMEOUT_MS` – max time per message in a Claude Code session (default 30 min).
- `CLAUDE_MODEL` – passed as `--model` (empty = Claude Code's default).
- `CLAUDE_CLI_TOOLS`, `CLAUDE_CLI_ALLOW_MCP` – tools/connectors for *chat* mode only (default none).
- `CLAUDE_BACKEND=api` – chat with Claude via `ANTHROPIC_API_KEY` instead of the CLI (disables Claude Code sessions).

Chat history lives in memory and resets when the bot restarts; Claude Code sessions are stored by Claude Code itself.

## Images, videos and screenshots

- Send a photo, screenshot, image file, video, GIF or an album, with an optional caption as your question. It goes to whichever mode you're in (chat, ChatGPT, or the attached Claude Code session).
- Videos: Claude can't watch video, so the bot extracts `VIDEO_FRAMES` (default 8) evenly spaced frames with ffmpeg and sends those. Telegram only lets bots download files up to 20 MB.
- `/screenshot` captures the Mac screen; `/screenshot zen` captures just that app's window (matches app name or window title); `/screenshot apps` lists open apps. Tap **Ask Claude what's happening** under it to send it to Claude.
- Needs Screen Recording permission for the app the bot was started from (System Settings → Privacy & Security → Screen & System Audio Recording).
- Downloaded media and screenshots are kept in `data/media` for 24 hours.
- `/screenoff` / `/screenon` turn the display off/on; the bot keeps the Mac awake while it runs (`KEEP_AWAKE=false` to disable). Closing a MacBook's lid still sleeps it.
