import https from 'node:https';
import { PtyManager } from './pty-manager';
import { sessionOutputBuffers, waitingSessions } from './web-server';

let botToken: string | null = null;
let chatId: string | null = null;
let pollingTimer: ReturnType<typeof setTimeout> | null = null;
let lastUpdateId = 0;
let ptyManager: PtyManager | null = null;
let consecutiveErrors = 0;

// Config file path
import path from 'node:path';
import fs from 'node:fs';
import { app } from 'electron';

function getConfigPath(): string {
  const userDataPath = app?.getPath?.('userData') || path.join(process.env.HOME || '/', '.ymux');
  return path.join(userDataPath, 'telegram.json');
}

function loadConfig(): { token: string; chatId: string } | null {
  try {
    const configPath = getConfigPath();
    if (fs.existsSync(configPath)) {
      const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
      return data;
    }
  } catch {}
  return null;
}

function saveConfig(token: string, chat: string): void {
  try {
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ token, chatId: chat }, null, 2));
  } catch {}
}

function telegramAPI(method: string, body?: Record<string, any>): Promise<any> {
  return new Promise((resolve, reject) => {
    if (!botToken) return reject(new Error('No bot token'));
    const data = body ? JSON.stringify(body) : '';
    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${botToken}/${method}`,
      method: body ? 'POST' : 'GET',
      headers: body ? {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      } : {},
    };

    const req = https.request(options, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => {
        try {
          resolve(JSON.parse(responseData));
        } catch {
          reject(new Error('Invalid JSON response'));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });
    if (body) req.write(data);
    req.end();
  });
}

async function sendMessage(text: string, parseMode?: string): Promise<void> {
  if (!chatId) return;
  try {
    const body: Record<string, any> = { chat_id: chatId, text };
    if (parseMode) body.parse_mode = parseMode;
    await telegramAPI('sendMessage', body);
  } catch (err) {
    console.error('Telegram sendMessage error:', err);
  }
}

async function pollUpdates(): Promise<void> {
  if (!botToken) return;

  try {
    const result = await telegramAPI('getUpdates', {
      offset: lastUpdateId + 1,
      timeout: 20,
      allowed_updates: ['message'],
    });

    if (result.ok && result.result) {
      consecutiveErrors = 0;
      for (const update of result.result) {
        lastUpdateId = update.update_id;
        if (update.message?.text) {
          await handleMessage(update.message);
        }
      }
    }
  } catch (err) {
    consecutiveErrors++;
    const backoff = Math.min(30000, 1000 * Math.pow(2, consecutiveErrors - 1));
    console.error(`Telegram polling error (retry in ${backoff}ms):`, err);
    pollingTimer = setTimeout(pollUpdates, backoff);
    return;
  }

  // Continue polling
  pollingTimer = setTimeout(pollUpdates, 1000);
}

async function handleMessage(message: any): Promise<void> {
  const text = message.text?.trim() || '';
  const msgChatId = String(message.chat.id);

  // Auto-save chatId from first message
  if (!chatId) {
    chatId = msgChatId;
    if (botToken) saveConfig(botToken, chatId);
    await sendMessage('ymux connected! Use /help to see commands.');
    return;
  }

  // Verify chat ID
  if (msgChatId !== chatId) return;

  if (text === '/help' || text === '/start') {
    await sendMessage(
      `*ymux Bot Commands*\n\n` +
      `/status — Show all panes and their state\n` +
      `/pane N — Show output from pane N\n` +
      `/send N text — Send text to pane N\n` +
      `/waiting — Show panes waiting for input\n` +
      `/help — Show this help`,
      'Markdown'
    );
    return;
  }

  if (text === '/status') {
    const sessions = Array.from(sessionOutputBuffers.keys());
    if (sessions.length === 0) {
      await sendMessage('No active panes.');
      return;
    }
    const lines: string[] = ['*Active Panes:*'];
    sessions.forEach((id, i) => {
      const isWaiting = waitingSessions.has(id);
      const status = isWaiting ? '⏳ Waiting' : '🟢 Running';
      lines.push(`${i}: \`${id}\` ${status}`);
    });
    await sendMessage(lines.join('\n'), 'Markdown');
    return;
  }

  if (text === '/waiting') {
    const waiting = Array.from(waitingSessions);
    if (waiting.length === 0) {
      await sendMessage('No panes waiting for input.');
      return;
    }
    const lines = waiting.map((id, i) => `${i}: \`${id}\``);
    await sendMessage(`*Waiting Panes:*\n${lines.join('\n')}`, 'Markdown');
    return;
  }

  const paneMatch = text.match(/^\/pane\s+(\d+)$/);
  if (paneMatch) {
    const idx = parseInt(paneMatch[1], 10);
    const sessions = Array.from(sessionOutputBuffers.keys());
    if (idx >= sessions.length) {
      await sendMessage(`Pane ${idx} not found. Use /status to see available panes.`);
      return;
    }
    const sessionId = sessions[idx];
    const buf = sessionOutputBuffers.get(sessionId) || [];
    const output = buf.slice(-30).join('\n');
    const cleaned = stripAnsi(output).slice(-3000);
    await sendMessage(`*Pane ${idx}* (\`${sessionId}\`):\n\`\`\`\n${cleaned || '(empty)'}\n\`\`\``,'Markdown');
    return;
  }

  const sendMatch = text.match(/^\/send\s+(\d+)\s+(.+)$/s);
  if (sendMatch) {
    const idx = parseInt(sendMatch[1], 10);
    const sendText = sendMatch[2];
    const sessions = Array.from(sessionOutputBuffers.keys());
    if (idx >= sessions.length) {
      await sendMessage(`Pane ${idx} not found. Use /status to see available panes.`);
      return;
    }
    const sessionId = sessions[idx];
    if (ptyManager) {
      ptyManager.write(sessionId, sendText + '\n');
      await sendMessage(`Sent to pane ${idx}.`);
    } else {
      await sendMessage('PTY manager not available.');
    }
    return;
  }

  // Default: if just text, treat as send to first waiting pane (or first pane)
  if (!text.startsWith('/')) {
    const waitingList = Array.from(waitingSessions);
    const targetId = waitingList[0] || Array.from(sessionOutputBuffers.keys())[0];
    if (targetId && ptyManager) {
      ptyManager.write(targetId, text + '\n');
      await sendMessage(`Sent to \`${targetId}\`.`, 'Markdown');
    } else {
      await sendMessage('No active panes.');
    }
    return;
  }

  await sendMessage(`Unknown command: ${text}\nUse /help to see available commands.`);
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
    .replace(/\x1b\][^\x07]*\x07/g, '')
    .replace(/\x1b[()][0-9A-B]/g, '')
    .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '');
}

// --- Notification for waiting state ---
export function notifyWaiting(sessionId: string, waiting: boolean): void {
  if (!botToken || !chatId) return;
  if (waiting) {
    const buf = sessionOutputBuffers.get(sessionId) || [];
    const lastLines = stripAnsi(buf.slice(-5).join('\n')).slice(-500);
    sendMessage(
      `⏳ *Pane waiting for input*\n\`${sessionId}\`\n\`\`\`\n${lastLines || '...'}\n\`\`\``,
      'Markdown'
    );
  }
}

// --- Public API ---

export function startTelegramBot(pm: PtyManager): void {
  ptyManager = pm;

  const config = loadConfig();
  if (config?.token) {
    botToken = config.token;
    chatId = config.chatId || null;
    console.log('Telegram bot: loaded config, starting polling...');
    pollUpdates();
  } else {
    console.log('Telegram bot: no config found. Set token via ymux settings or create', getConfigPath());
  }
}

export function stopTelegramBot(): void {
  if (pollingTimer) {
    clearTimeout(pollingTimer);
    pollingTimer = null;
  }
  botToken = null;
  chatId = null;
}

export function setTelegramConfig(token: string, chat?: string): void {
  botToken = token;
  chatId = chat || null;
  saveConfig(token, chatId || '');

  // Start polling if not already
  if (pollingTimer) clearTimeout(pollingTimer);
  pollUpdates();
}
