# ymux

A modern terminal multiplexer built with Electron. Designed for orchestrating multiple AI agents (Claude, Codex, etc.) in parallel — with real-time monitoring from your phone.

![macOS](https://img.shields.io/badge/platform-macOS-lightgrey)
![License](https://img.shields.io/badge/license-MIT-blue)

## Features

### Terminal Multiplexer
- **Tabs & Panes** — Split horizontally/vertically, full-width bottom pane, zoom
- **Browser Panes** — Embedded browser within terminal tabs
- **Keyboard-driven** — tmux-inspired shortcuts
- **xterm.js** — GPU-accelerated rendering, search, scrollback (10,000 lines)

### AI Agent Collaboration
- **Waiting Detection** — Automatically detects when an AI agent is waiting for input (silence-based)
- **Inter-pane Communication** — Send keys, capture output between panes via CLI
- **Dock Badge** — Red notification count on macOS dock icon

### Remote Monitoring
- **Web Dashboard** — Real-time pane output streaming on port 3456, accessible from any device on the same network
- **Telegram Bot** — Get notified when agents wait for input, respond directly from your phone

### CLI
```bash
ymux split-window -h            # Split left/right
ymux split-window -v            # Split top/bottom
ymux new-tab                    # New tab
ymux send-keys -t 1 "yes"      # Send text to pane 1
ymux capture-pane -t 0 -l 100  # Capture 100 lines from pane 0
ymux list-panes                 # List all panes
```

## Install

### Homebrew (macOS)

```bash
brew tap naokey/ymux
brew install --cask ymux
```

### Manual

Download the latest `.dmg` from [Releases](https://github.com/naokey/ymux/releases).

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `⌘T` | New Tab |
| `⌘D` | Split Left/Right |
| `⌘⇧D` | Split Top/Bottom |
| `⌘⇧E` | Full-Width Bottom Pane |
| `⌘⇧W` | Close Pane |
| `⌘⇧F` | Zoom Pane |
| `⌘F` | Search |
| `⌘+` / `⌘-` | Font Size |
| `⌘⇧B` | Open Browser Pane |
| `⌘⇧]` / `⌘⇧[` | Next/Previous Tab |
| `⌘⌥↑↓←→` | Navigate Panes |

## Telegram Bot Setup

1. Create a bot via [@BotFather](https://t.me/BotFather) on Telegram
2. Create config file:
   ```json
   // ~/Library/Application Support/ymux/telegram.json
   { "token": "YOUR_BOT_TOKEN" }
   ```
3. Restart ymux, then send any message to your bot
4. Commands: `/status`, `/pane N`, `/send N text`, `/waiting`

## Web Dashboard

Accessible at `http://<your-ip>:3456` when ymux is running. Open it on your phone (same WiFi) to monitor and interact with panes in real-time.

## Development

```bash
npm install
npm start
```

## Build

```bash
npx electron-forge package    # Build .app
npx electron-forge make        # Build .dmg
```

## Disclaimer

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED. THE AUTHORS AND COPYRIGHT HOLDERS SHALL NOT BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY ARISING FROM THE USE OF THIS SOFTWARE. USE AT YOUR OWN RISK.

本ソフトウェアは「現状のまま」提供されます。本ソフトウェアの使用により生じたいかなる損害・問題についても、作者は一切の責任を負いません。自己責任でご利用ください。

## License

MIT
