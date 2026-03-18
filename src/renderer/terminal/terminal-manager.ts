import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebglAddon } from '@xterm/addon-webgl';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SearchAddon } from '@xterm/addon-search';
import { defaultTheme } from './terminal-theme';
import { store } from '../state/store';

declare global {
  interface Window {
    ymuxAPI: import('../../preload/preload').YmuxAPI;
  }
}

interface ManagedTerminal {
  terminal: Terminal;
  fitAddon: FitAddon;
  searchAddon: SearchAddon;
  sessionId: string;
  removeDataListener: () => void;
  removeExitListener: () => void;
}

const terminals = new Map<string, ManagedTerminal>();

// ====== Font size ======
const FONT_SIZE_KEY = 'ymux-font-size';
const DEFAULT_FONT_SIZE = 13;
const MIN_FONT_SIZE = 9;
const MAX_FONT_SIZE = 24;

function getSavedFontSize(): number {
  const saved = localStorage.getItem(FONT_SIZE_KEY);
  return saved ? Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, parseInt(saved, 10))) : DEFAULT_FONT_SIZE;
}

let currentFontSize = getSavedFontSize();

export function changeFontSize(delta: number): void {
  currentFontSize = Math.max(MIN_FONT_SIZE, Math.min(MAX_FONT_SIZE, currentFontSize + delta));
  localStorage.setItem(FONT_SIZE_KEY, String(currentFontSize));
  for (const [, managed] of terminals) {
    managed.terminal.options.fontSize = currentFontSize;
    try { managed.fitAddon.fit(); } catch {}
  }
}

export function getCurrentFontSize(): number {
  return currentFontSize;
}

// ====== Waiting detection (silence-based) ======
// Only for sessions running an AI agent (claude, codex, etc.)
// Regular shell sessions are ignored.
const SILENCE_MS = 5000;
const OUTPUT_AFTER_INPUT_THRESHOLD = 5000; // 5KB of output after user input = agent did real work
const sessionLastOutput = new Map<string, number>();
const agentSessions = new Set<string>();
const sessionOutputSinceInput = new Map<string, number>(); // bytes received since last user input
const sessionDismissed = new Map<string, number>(); // timestamp when user dismissed alert
let silenceInterval: ReturnType<typeof setInterval> | null = null;

const AGENT_PROCESS_NAMES = new Set(['claude', 'codex', 'aider', 'copilot']);

function markAsAgent(sessionId: string): void {
  agentSessions.add(sessionId);
}

function onSessionOutput(sessionId: string, dataLength: number): void {
  sessionLastOutput.set(sessionId, Date.now());
  // Accumulate output since last user input
  sessionOutputSinceInput.set(sessionId,
    (sessionOutputSinceInput.get(sessionId) || 0) + dataLength);
  // New output = not waiting anymore
  if (store.isSessionWaiting(sessionId)) {
    store.setSessionWaiting(sessionId, false);
  }
}

function onUserInput(sessionId: string): void {
  // Reset output counter — agent needs to produce new output after this input
  sessionOutputSinceInput.set(sessionId, 0);
  sessionLastOutput.set(sessionId, Date.now());
}

export function dismissSessionWaiting(sessionId: string): void {
  store.setSessionWaiting(sessionId, false);
  // Reset timers so it doesn't immediately re-trigger
  sessionLastOutput.set(sessionId, Date.now());
  sessionOutputSinceInput.set(sessionId, 0);
  sessionDismissed.set(sessionId, Date.now());
}

function startSilenceDetection(): void {
  if (silenceInterval) return;
  silenceInterval = setInterval(() => {
    const now = Date.now();
    for (const [sessionId, lastTime] of sessionLastOutput) {
      if (store.isSessionWaiting(sessionId)) continue;
      // Only AI agent sessions
      if (!agentSessions.has(sessionId)) continue;
      // Agent must have produced substantial output since last user input
      const outputSinceInput = sessionOutputSinceInput.get(sessionId) || 0;
      if (outputSinceInput < OUTPUT_AFTER_INPUT_THRESHOLD) continue;
      // Don't re-trigger within 10s of dismiss
      const dismissedAt = sessionDismissed.get(sessionId) || 0;
      if (now - dismissedAt < 10000) continue;
      // Silent for 5+ seconds
      if (now - lastTime >= SILENCE_MS) {
        store.setSessionWaiting(sessionId, true);
      }
    }
  }, 1000);
}

function stopSilenceDetection(): void {
  if (silenceInterval) {
    clearInterval(silenceInterval);
    silenceInterval = null;
  }
}

// ====== Tab label auto-detection ======
const PROCESS_LABELS: Record<string, string> = {
  'claude': 'Claude',
  'codex': 'Codex',
  'node': 'Node.js',
  'python': 'Python',
  'python3': 'Python',
  'vim': 'Vim',
  'nvim': 'Neovim',
  'ssh': 'SSH',
  'git': 'Git',
  'npm': 'npm',
  'cargo': 'Cargo',
  'go': 'Go',
  'docker': 'Docker',
  'top': 'top',
  'htop': 'htop',
};

const OUTPUT_LABEL_PATTERNS: Array<{ pattern: RegExp; label: string; isAgent: boolean }> = [
  { pattern: /Advisor/, label: 'Advisor', isAgent: true },
  { pattern: /advisor\.md/, label: 'Advisor', isAgent: true },
  { pattern: /steph\.md/, label: 'Steph', isAgent: true },
  { pattern: /Claude Code/, label: 'Claude Code', isAgent: true },
  { pattern: /claude-code/, label: 'Claude Code', isAgent: true },
  { pattern: /codex/i, label: 'Codex', isAgent: true },
];

const sessionDetectedLabels = new Map<string, string>();
let processPollingInterval: ReturnType<typeof setInterval> | null = null;

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')
            .replace(/\x1b\][^\x07]*\x07/g, '')
            .replace(/\x1b[()][0-9A-B]/g, '')
            .replace(/[\x00-\x09\x0b-\x0c\x0e-\x1f]/g, '');
}

function detectLabelFromOutput(sessionId: string, data: string): void {
  if (sessionDetectedLabels.has(sessionId)) return;
  const clean = stripAnsi(data);
  for (const { pattern, label, isAgent } of OUTPUT_LABEL_PATTERNS) {
    if (pattern.test(clean)) {
      sessionDetectedLabels.set(sessionId, label);
      if (isAgent) markAsAgent(sessionId);
      const tab = store.findTabBySessionId(sessionId);
      if (tab && (tab.label === 'Terminal' || tab.label.startsWith('Shell'))) {
        store.renameTab(tab.id, label);
      }
      return;
    }
  }
}

function startProcessPolling(): void {
  if (processPollingInterval) return;
  processPollingInterval = setInterval(async () => {
    for (const [, managed] of terminals) {
      if (sessionDetectedLabels.has(managed.sessionId)) continue;
      const processName = await window.ymuxAPI.getSessionProcess(managed.sessionId);
      if (!processName) continue;
      const tab = store.findTabBySessionId(managed.sessionId);
      if (!tab) continue;
      const baseName = processName.split('/').pop() || processName;
      // Check if this is an AI agent process
      if (AGENT_PROCESS_NAMES.has(baseName)) {
        markAsAgent(managed.sessionId);
      }
      const displayLabel = PROCESS_LABELS[baseName] || baseName;
      const newLabel = displayLabel === 'zsh' || displayLabel === 'bash' || displayLabel === 'fish'
        ? 'Shell' : displayLabel;
      if (tab.label !== newLabel && !tab.userRenamed) {
        store.renameTab(tab.id, newLabel);
      }
    }
  }, 2000);
}

function stopProcessPolling(): void {
  if (processPollingInterval) {
    clearInterval(processPollingInterval);
    processPollingInterval = null;
  }
}

// ====== Terminal lifecycle ======

export async function createTerminal(
  container: HTMLElement,
  sessionId: string,
  onExit?: (paneId: string) => void,
  paneId?: string,
): Promise<ManagedTerminal> {
  const terminal = new Terminal({
    theme: defaultTheme,
    fontFamily: "'HackGen Console', 'HackGen', Menlo, monospace",
    fontSize: currentFontSize,
    lineHeight: 1.2,
    letterSpacing: 0.5,
    cursorBlink: true,
    cursorStyle: 'block',
    allowProposedApi: true,
    scrollback: 10000,
  });

  const fitAddon = new FitAddon();
  const searchAddon = new SearchAddon();
  terminal.loadAddon(fitAddon);
  terminal.loadAddon(searchAddon);
  terminal.loadAddon(new WebLinksAddon());

  terminal.open(container);

  try {
    terminal.loadAddon(new WebglAddon());
  } catch {
    // WebGL not available
  }

  fitAddon.fit();

  // User input → mark as interacted, clear waiting
  terminal.onData((data) => {
    window.ymuxAPI.writeSession(sessionId, data);
    onUserInput(sessionId);
    if (store.isSessionWaiting(sessionId)) {
      store.setSessionWaiting(sessionId, false);
    }
  });

  // PTY output
  const removeDataListener = window.ymuxAPI.onSessionData((id, data) => {
    if (id === sessionId) {
      terminal.write(data);
      onSessionOutput(sessionId, data.length);
      detectLabelFromOutput(sessionId, data);
    }
  });

  const removeExitListener = window.ymuxAPI.onSessionExit((id, exitCode) => {
    if (id === sessionId) {
      terminal.write(`\r\n[Process exited with code ${exitCode}]\r\n`);
      if (onExit && paneId) {
        terminal.onKey(() => onExit(paneId));
      }
    }
  });

  terminal.onResize(({ cols, rows }) => {
    window.ymuxAPI.resizeSession(sessionId, cols, rows);
  });

  window.ymuxAPI.resizeSession(sessionId, terminal.cols, terminal.rows);

  // Initialize last output time
  sessionLastOutput.set(sessionId, Date.now());

  const managed: ManagedTerminal = {
    terminal,
    fitAddon,
    searchAddon,
    sessionId,
    removeDataListener,
    removeExitListener,
  };

  terminals.set(paneId || sessionId, managed);

  startProcessPolling();
  startSilenceDetection();

  return managed;
}

export function getTerminal(paneId: string): ManagedTerminal | undefined {
  return terminals.get(paneId);
}

export function destroyTerminal(paneId: string): void {
  const managed = terminals.get(paneId);
  if (managed) {
    managed.removeDataListener();
    managed.removeExitListener();
    managed.terminal.dispose();
    terminals.delete(paneId);
    sessionLastOutput.delete(managed.sessionId);
    agentSessions.delete(managed.sessionId);
    sessionOutputSinceInput.delete(managed.sessionId);
    sessionDismissed.delete(managed.sessionId);
    sessionDetectedLabels.delete(managed.sessionId);
    // Clear waiting
    if (store.isSessionWaiting(managed.sessionId)) {
      store.setSessionWaiting(managed.sessionId, false);
    }
  }

  if (terminals.size === 0) {
    stopProcessPolling();
    stopSilenceDetection();
  }
}

export function fitAllTerminals(): void {
  for (const [, managed] of terminals) {
    try { managed.fitAddon.fit(); } catch {}
  }
}

export function fitTerminal(paneId: string): void {
  const managed = terminals.get(paneId);
  if (managed) {
    try { managed.fitAddon.fit(); } catch {}
  }
}

export function focusTerminal(paneId: string): void {
  const managed = terminals.get(paneId);
  if (managed) {
    managed.terminal.focus();
  }
}

// ====== Search ======
export function searchTerminal(paneId: string, query: string): boolean {
  const managed = terminals.get(paneId);
  if (!managed || !query) return false;
  return managed.searchAddon.findNext(query, { caseSensitive: false, regex: false });
}

export function searchTerminalNext(paneId: string, query: string): boolean {
  const managed = terminals.get(paneId);
  if (!managed || !query) return false;
  return managed.searchAddon.findNext(query, { caseSensitive: false, regex: false });
}

export function searchTerminalPrev(paneId: string, query: string): boolean {
  const managed = terminals.get(paneId);
  if (!managed || !query) return false;
  return managed.searchAddon.findPrevious(query, { caseSensitive: false, regex: false });
}

export function clearTerminalSearch(paneId: string): void {
  const managed = terminals.get(paneId);
  if (managed) managed.searchAddon.clearDecorations();
}

// ====== Capture pane output ======
export function capturePane(paneId: string, lines: number): string {
  const managed = terminals.get(paneId);
  if (!managed) return '';
  const term = managed.terminal;
  const buffer = term.buffer.active;
  const totalRows = buffer.length;
  const startRow = Math.max(0, totalRows - lines);
  const result: string[] = [];
  for (let i = startRow; i < totalRows; i++) {
    const line = buffer.getLine(i);
    if (line) result.push(line.translateToString(true));
  }
  return result.join('\n');
}

// ====== Write to pane ======
export function writeToPane(paneId: string, text: string): void {
  const managed = terminals.get(paneId);
  if (!managed) return;
  window.ymuxAPI.writeSession(managed.sessionId, text);
}
