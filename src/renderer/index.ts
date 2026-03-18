import './styles/main.css';
import '@xterm/xterm/css/xterm.css';
import { store } from './state/store';
import { renderTabBar } from './components/tab-bar';
import { renderPaneContainer } from './components/pane-container';
import { renderStatusBar } from './components/status-bar';
import { initKeybindings } from './shortcuts/keybindings';
import { destroyTerminal, searchTerminal, searchTerminalNext, searchTerminalPrev, clearTerminalSearch, changeFontSize, capturePane, writeToPane } from './terminal/terminal-manager';
import { destroyBrowserPane } from './components/browser-pane';
import type { PaneNode, PaneLeaf } from './state/types';

function findLeafNode(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  return findLeafNode(node.first, paneId) || findLeafNode(node.second, paneId);
}

// Build the app layout
const app = document.getElementById('app')!;

const tabBarEl = document.createElement('div');
const mainArea = document.createElement('div');
mainArea.className = 'main-area';
const paneContainerEl = document.createElement('div');
const statusBarEl = document.createElement('div');

app.appendChild(tabBarEl);
app.appendChild(mainArea);
mainArea.appendChild(paneContainerEl);
mainArea.appendChild(statusBarEl);

// --- Actions ---

async function createNewTab(): Promise<void> {
  const sessionId = await window.ymuxAPI.createSession();
  store.addTab(sessionId);
}

async function splitActive(direction: 'horizontal' | 'vertical'): Promise<void> {
  const tab = store.getActiveTab();
  if (!tab) return;
  const sessionId = await window.ymuxAPI.createSession();
  store.splitPane(tab.activePaneId, direction, sessionId);
}

function openBrowserPane(): void {
  const tab = store.getActiveTab();
  if (!tab) return;
  store.splitPaneAsBrowser(tab.activePaneId, 'vertical');
}

function closeActivePane(): void {
  const tab = store.getActiveTab();
  if (!tab) return;

  // Check if it's a browser pane
  const leaf = findLeafNode(tab.rootPane, tab.activePaneId);
  if (leaf && leaf.paneKind === 'browser') {
    destroyBrowserPane(tab.activePaneId);
    store.closePane(tab.activePaneId);
    if (store.getState().tabs.length === 0) createNewTab();
    return;
  }

  const sessionId = store.closePane(tab.activePaneId);
  if (sessionId) {
    destroyTerminal(tab.activePaneId);
    window.ymuxAPI.killSession(sessionId);
  }

  // If tab became empty (root pane was closed), close the tab
  if (store.getState().tabs.length === 0) {
    createNewTab();
  }
}

function handlePaneClose(paneId: string): void {
  const tab = store.getActiveTab();
  if (!tab) return;
  const leaf = findLeafNode(tab.rootPane, paneId);
  if (leaf && leaf.paneKind === 'browser') {
    destroyBrowserPane(paneId);
    store.closePane(paneId);
  } else {
    const sessionId = store.closePane(paneId);
    if (sessionId) {
      destroyTerminal(paneId);
      window.ymuxAPI.killSession(sessionId);
    }
  }
  if (store.getState().tabs.length === 0) {
    createNewTab();
  }
}

// --- Zoom ---
function toggleZoom(): void {
  store.toggleZoom();
}

// --- Search overlay ---
let searchOverlay: HTMLElement | null = null;
let searchInput: HTMLInputElement | null = null;

function toggleSearch(): void {
  if (searchOverlay) {
    closeSearch();
    return;
  }
  const tab = store.getActiveTab();
  if (!tab) return;

  searchOverlay = document.createElement('div');
  searchOverlay.className = 'search-overlay';

  searchInput = document.createElement('input');
  searchInput.className = 'search-input';
  searchInput.type = 'text';
  searchInput.placeholder = 'Search...';
  searchInput.spellcheck = false;

  const prevBtn = document.createElement('button');
  prevBtn.className = 'search-nav-btn';
  prevBtn.textContent = '\u25B2';
  prevBtn.title = 'Previous (Shift+Enter)';

  const nextBtn = document.createElement('button');
  nextBtn.className = 'search-nav-btn';
  nextBtn.textContent = '\u25BC';
  nextBtn.title = 'Next (Enter)';

  const closeBtn = document.createElement('button');
  closeBtn.className = 'search-nav-btn search-close-btn';
  closeBtn.textContent = '\u00d7';
  closeBtn.title = 'Close (Escape)';

  searchOverlay.appendChild(searchInput);
  searchOverlay.appendChild(prevBtn);
  searchOverlay.appendChild(nextBtn);
  searchOverlay.appendChild(closeBtn);
  mainArea.appendChild(searchOverlay);

  searchInput.focus();

  const getActivePaneId = () => {
    const t = store.getActiveTab();
    return t?.zoomedPaneId || t?.activePaneId || '';
  };

  searchInput.addEventListener('input', () => {
    const paneId = getActivePaneId();
    if (searchInput!.value) {
      searchTerminal(paneId, searchInput!.value);
    } else {
      clearTerminalSearch(paneId);
    }
  });

  searchInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && e.shiftKey) {
      searchTerminalPrev(getActivePaneId(), searchInput!.value);
    } else if (e.key === 'Enter') {
      searchTerminalNext(getActivePaneId(), searchInput!.value);
    } else if (e.key === 'Escape') {
      closeSearch();
    }
  });

  prevBtn.addEventListener('click', () => {
    searchTerminalPrev(getActivePaneId(), searchInput!.value);
  });
  nextBtn.addEventListener('click', () => {
    searchTerminalNext(getActivePaneId(), searchInput!.value);
  });
  closeBtn.addEventListener('click', closeSearch);
}

function closeSearch(): void {
  if (searchOverlay) {
    const tab = store.getActiveTab();
    const paneId = tab?.zoomedPaneId || tab?.activePaneId || '';
    clearTerminalSearch(paneId);
    searchOverlay.remove();
    searchOverlay = null;
    searchInput = null;
  }
}

// --- Split at root ---
async function splitRootHorizontal(): Promise<void> {
  const tab = store.getActiveTab();
  if (!tab) return;
  const sessionId = await window.ymuxAPI.createSession();
  store.splitRoot('horizontal', sessionId);
}

// --- Initialize ---

renderTabBar(tabBarEl, createNewTab);
renderPaneContainer(paneContainerEl, handlePaneClose);
renderStatusBar(statusBarEl);

initKeybindings({
  newTab: createNewTab,
  splitVertical: () => splitActive('vertical'),
  splitHorizontal: () => splitActive('horizontal'),
  closePane: closeActivePane,
  openBrowser: openBrowserPane,
  toggleZoom,
  toggleSearch,
  splitRootHorizontal,
  fontSizeUp: () => changeFontSize(1),
  fontSizeDown: () => changeFontSize(-1),
});

// Create the first tab
createNewTab();

// Handle window resize
window.addEventListener('resize', () => {
  import('./terminal/terminal-manager').then(m => m.fitAllTerminals());
});

// --- Handle external commands (from ymux CLI via socket) ---

window.ymuxAPI.onSplitPane((data) => {
  const tab = store.getActiveTab();
  if (!tab) {
    // No tab exists, create one with this session
    store.addTab(data.sessionId);
    return;
  }
  const direction = (data.direction === 'horizontal' ? 'horizontal' : 'vertical') as 'horizontal' | 'vertical';
  store.splitPane(tab.activePaneId, direction, data.sessionId);
});

window.ymuxAPI.onNewTab((data) => {
  store.addTab(data.sessionId);
});

// --- Inter-pane communication handlers ---

function getLeavesByTab(): PaneLeaf[] {
  const tab = store.getActiveTab();
  if (!tab) return [];
  return collectLeaves(tab.rootPane);
}

function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  if (node.type === 'split') return [...collectLeaves(node.first), ...collectLeaves(node.second)];
  return [];
}

// send-keys: write text to a target pane
window.ymuxAPI.onSendKeys((data) => {
  const leaves = getLeavesByTab();
  const target = leaves[data.target];
  if (target && target.paneKind !== 'browser') {
    writeToPane(target.id, data.text);
  }
});

// capture-pane: read terminal output from a target pane
window.ymuxAPI.onCapturePaneRequest((data) => {
  const leaves = getLeavesByTab();
  const target = leaves[data.target];
  let output = '';
  if (target && target.paneKind !== 'browser') {
    output = capturePane(target.id, data.lines || 50);
  }
  window.ymuxAPI.sendCapturePaneResponse(data.requestId, output);
});

// list-panes: return info about all panes in active tab
window.ymuxAPI.onListPanesRequest((data) => {
  const tab = store.getActiveTab();
  const leaves = getLeavesByTab();
  const panes = leaves.map((leaf, i) => ({
    index: i,
    id: leaf.id,
    sessionId: leaf.sessionId,
    kind: leaf.paneKind || 'terminal',
    label: tab?.label || '',
    active: leaf.id === tab?.activePaneId,
  }));
  window.ymuxAPI.sendListPanesResponse(data.requestId, panes);
});

// --- Sync waiting state to main process (tray + web dashboard) ---
let lastWaitingCount = -1;
let lastWaitingSessions = new Set<string>();
store.subscribe(() => {
  const count = store.getWaitingCount();
  if (count !== lastWaitingCount) {
    lastWaitingCount = count;
    window.ymuxAPI.sendWaitingCount(count);
  }
  // Forward individual session waiting changes
  const currentWaiting = store.getState().waitingSessions;
  for (const sid of currentWaiting) {
    if (!lastWaitingSessions.has(sid)) {
      window.ymuxAPI.sendSessionWaiting(sid, true);
    }
  }
  for (const sid of lastWaitingSessions) {
    if (!currentWaiting.has(sid)) {
      window.ymuxAPI.sendSessionWaiting(sid, false);
    }
  }
  lastWaitingSessions = new Set(currentWaiting);
});
