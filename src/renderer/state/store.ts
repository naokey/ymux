import type { AppState, Tab, PaneLeaf, BrowserPaneState, BrowserTab } from './types';

type Listener = () => void;

let nextPaneId = 0;
let nextTabId = 0;

export function generatePaneId(): string {
  return `pane-${nextPaneId++}`;
}

export function generateTabId(): string {
  return `tab-${nextTabId++}`;
}

function createDefaultTab(sessionId: string): Tab {
  const paneId = generatePaneId();
  const tabId = generateTabId();
  return {
    id: tabId,
    label: 'Terminal',
    rootPane: { type: 'leaf', id: paneId, sessionId },
    activePaneId: paneId,
    waitingForInput: false,
    userRenamed: false,
    zoomedPaneId: null,
  };
}

class Store {
  private state: AppState = { tabs: [], activeTabId: '', waitingSessions: new Set() };
  private listeners: Set<Listener> = new Set();

  getState(): AppState {
    return this.state;
  }

  setState(updater: (state: AppState) => AppState): void {
    this.state = updater(this.state);
    this.listeners.forEach(fn => fn());
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  // --- Tab actions ---

  addTab(sessionId: string): Tab {
    const tab = createDefaultTab(sessionId);
    this.setState(s => ({
      ...s,
      tabs: [...s.tabs, tab],
      activeTabId: tab.id,
    }));
    return tab;
  }

  closeTab(tabId: string): string[] {
    const tab = this.state.tabs.find(t => t.id === tabId);
    if (!tab) return [];

    const sessionIds = collectSessionIds(tab.rootPane);
    const remaining = this.state.tabs.filter(t => t.id !== tabId);

    if (remaining.length === 0) {
      // Will need to create a new tab externally
      this.setState(s => ({ ...s, tabs: [], activeTabId: '' }));
    } else {
      const newActive = this.state.activeTabId === tabId
        ? remaining[Math.max(0, this.state.tabs.indexOf(tab) - 1)].id
        : this.state.activeTabId;
      this.setState(s => ({ ...s, tabs: remaining, activeTabId: newActive }));
    }

    return sessionIds;
  }

  switchTab(tabId: string): void {
    if (this.state.tabs.find(t => t.id === tabId)) {
      this.setState(s => ({ ...s, activeTabId: tabId }));
    }
  }

  renameTab(tabId: string, label: string, userRenamed?: boolean): void {
    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, label, userRenamed: userRenamed ?? t.userRenamed } : t),
    }));
  }

  getActiveTab(): Tab | undefined {
    return this.state.tabs.find(t => t.id === this.state.activeTabId);
  }

  // --- Pane actions ---

  setActivePaneId(paneId: string): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tab.id ? { ...t, activePaneId: paneId } : t),
    }));
  }

  splitPane(paneId: string, direction: 'horizontal' | 'vertical', newSessionId: string): string {
    const tab = this.getActiveTab();
    if (!tab) return '';
    const newPaneId = generatePaneId();
    const splitId = generatePaneId();

    const newRoot = replaceNode(tab.rootPane, paneId, (leaf) => ({
      type: 'split' as const,
      id: splitId,
      direction,
      ratio: 0.5,
      first: leaf,
      second: { type: 'leaf' as const, id: newPaneId, sessionId: newSessionId },
    }));

    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tab.id ? { ...t, rootPane: newRoot, activePaneId: newPaneId } : t),
    }));

    return newPaneId;
  }

  closePane(paneId: string): string | null {
    const tab = this.getActiveTab();
    if (!tab) return null;

    const leaf = findLeaf(tab.rootPane, paneId);
    if (!leaf) return null;
    const sessionId = leaf.sessionId;

    // If root is the leaf, return sessionId to close the whole tab
    if (tab.rootPane.type === 'leaf' && tab.rootPane.id === paneId) {
      return sessionId;
    }

    const newRoot = removeNode(tab.rootPane, paneId);
    if (!newRoot) return sessionId;

    const newActive = tab.activePaneId === paneId ? getFirstLeaf(newRoot).id : tab.activePaneId;

    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tab.id ? { ...t, rootPane: newRoot, activePaneId: newActive } : t),
    }));

    return sessionId;
  }

  setTabWaiting(tabId: string, waiting: boolean): void {
    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tabId ? { ...t, waitingForInput: waiting } : t),
    }));
  }

  setSessionWaiting(sessionId: string, waiting: boolean): void {
    this.setState(s => {
      const newSet = new Set(s.waitingSessions);
      if (waiting) {
        newSet.add(sessionId);
      } else {
        newSet.delete(sessionId);
      }
      // Also update the tab's waitingForInput for backward compat (tab blinking)
      const tab = this.findTabBySessionId(sessionId);
      let tabs = s.tabs;
      if (tab) {
        // Tab is waiting if any of its sessions are waiting
        const tabSessionIds = collectSessionIds(tab.rootPane);
        const anyWaiting = tabSessionIds.some(sid => sid === sessionId ? waiting : newSet.has(sid));
        tabs = s.tabs.map(t => t.id === tab.id ? { ...t, waitingForInput: anyWaiting } : t);
      }
      return { ...s, waitingSessions: newSet, tabs };
    });
  }

  isSessionWaiting(sessionId: string): boolean {
    return this.state.waitingSessions.has(sessionId);
  }

  getWaitingCount(): number {
    return this.state.waitingSessions.size;
  }

  findTabBySessionId(sessionId: string): Tab | undefined {
    return this.state.tabs.find(t => containsSession(t.rootPane, sessionId));
  }

  // --- Browser pane actions ---
  private browserPanes = new Map<string, BrowserPaneState>();
  private nextBrowserTabId = 0;

  splitPaneAsBrowser(paneId: string, direction: 'horizontal' | 'vertical'): string {
    const tab = this.getActiveTab();
    if (!tab) return '';
    const newPaneId = generatePaneId();
    const splitId = generatePaneId();
    const browserId = `browser-${newPaneId}`;

    const newRoot = replaceNode(tab.rootPane, paneId, (leaf) => ({
      type: 'split' as const,
      id: splitId,
      direction,
      ratio: 0.5,
      first: leaf,
      second: { type: 'leaf' as const, id: newPaneId, sessionId: browserId, paneKind: 'browser' as const },
    }));

    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tab.id ? { ...t, rootPane: newRoot, activePaneId: newPaneId } : t),
    }));

    // Initialize browser pane state
    const firstTabId = `btab-${this.nextBrowserTabId++}`;
    this.browserPanes.set(newPaneId, {
      tabs: [{ id: firstTabId, url: 'https://www.google.com', title: 'New Tab' }],
      activeTabId: firstTabId,
    });

    return newPaneId;
  }

  addBrowserTab(paneId: string, url?: string): void {
    const bp = this.browserPanes.get(paneId);
    if (!bp) return;
    const tabId = `btab-${this.nextBrowserTabId++}`;
    bp.tabs.push({ id: tabId, url: url || 'https://www.google.com', title: 'New Tab' });
    bp.activeTabId = tabId;
    this.listeners.forEach(fn => fn());
  }

  closeBrowserTab(paneId: string, tabId: string): boolean {
    const bp = this.browserPanes.get(paneId);
    if (!bp) return true;
    bp.tabs = bp.tabs.filter(t => t.id !== tabId);
    if (bp.tabs.length === 0) {
      this.browserPanes.delete(paneId);
      return true; // signal to close the pane
    }
    if (bp.activeTabId === tabId) {
      bp.activeTabId = bp.tabs[0].id;
    }
    this.listeners.forEach(fn => fn());
    return false;
  }

  switchBrowserTab(paneId: string, tabId: string): void {
    const bp = this.browserPanes.get(paneId);
    if (!bp) return;
    bp.activeTabId = tabId;
    this.listeners.forEach(fn => fn());
  }

  updateBrowserTab(paneId: string, tabId: string, updates: Partial<BrowserTab>): void {
    const bp = this.browserPanes.get(paneId);
    if (!bp) return;
    const tab = bp.tabs.find(t => t.id === tabId);
    if (!tab) return;
    // Only notify if something actually changed
    let changed = false;
    for (const [key, value] of Object.entries(updates)) {
      if ((tab as any)[key] !== value) {
        (tab as any)[key] = value;
        changed = true;
      }
    }
    if (changed) this.listeners.forEach(fn => fn());
  }

  getBrowserPaneState(paneId: string): BrowserPaneState | undefined {
    return this.browserPanes.get(paneId);
  }

  destroyBrowserPane(paneId: string): void {
    this.browserPanes.delete(paneId);
  }

  // --- Zoom ---
  toggleZoom(): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    const newZoomed = tab.zoomedPaneId ? null : tab.activePaneId;
    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tab.id ? { ...t, zoomedPaneId: newZoomed } : t),
    }));
  }

  // --- Split at root (full-width bottom pane) ---
  splitRoot(direction: 'horizontal' | 'vertical', newSessionId: string): string {
    const tab = this.getActiveTab();
    if (!tab) return '';
    const newPaneId = generatePaneId();
    const splitId = generatePaneId();

    const newRoot = {
      type: 'split' as const,
      id: splitId,
      direction,
      ratio: 0.7,
      first: tab.rootPane,
      second: { type: 'leaf' as const, id: newPaneId, sessionId: newSessionId } as PaneLeaf,
    };

    this.setState(s => ({
      ...s,
      tabs: s.tabs.map(t => t.id === tab.id ? { ...t, rootPane: newRoot, activePaneId: newPaneId } : t),
    }));

    return newPaneId;
  }

  updateSplitRatio(splitId: string, ratio: number): void {
    const tab = this.getActiveTab();
    if (!tab) return;
    // Mutate ratio in-place to avoid triggering DOM rebuild
    // (ratio changes don't affect tree structure)
    updateRatioInPlace(tab.rootPane, splitId, ratio);
  }
}

// --- Tree utilities ---

import type { PaneNode } from './types';

function collectSessionIds(node: PaneNode): string[] {
  if (node.type === 'leaf') {
    if (node.paneKind === 'browser') return []; // browser panes have no PTY session
    return [node.sessionId];
  }
  return [...collectSessionIds(node.first), ...collectSessionIds(node.second)];
}

function replaceNode(node: PaneNode, targetId: string, replacer: (leaf: PaneLeaf) => PaneNode): PaneNode {
  if (node.type === 'leaf') {
    return node.id === targetId ? replacer(node) : node;
  }
  return {
    ...node,
    first: replaceNode(node.first, targetId, replacer),
    second: replaceNode(node.second, targetId, replacer),
  };
}

function findLeaf(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  return findLeaf(node.first, paneId) || findLeaf(node.second, paneId);
}

function getFirstLeaf(node: PaneNode): PaneLeaf {
  if (node.type === 'leaf') return node;
  return getFirstLeaf(node.first);
}

function removeNode(node: PaneNode, targetId: string): PaneNode | null {
  if (node.type === 'leaf') return null;
  if (node.first.type === 'leaf' && node.first.id === targetId) return node.second;
  if (node.second.type === 'leaf' && node.second.id === targetId) return node.first;

  const newFirst = removeNode(node.first, targetId);
  if (newFirst !== null) return { ...node, first: newFirst };
  const newSecond = removeNode(node.second, targetId);
  if (newSecond !== null) return { ...node, second: newSecond };
  return null;
}

function containsSession(node: PaneNode, sessionId: string): boolean {
  if (node.type === 'leaf') return node.sessionId === sessionId;
  return containsSession(node.first, sessionId) || containsSession(node.second, sessionId);
}

function updateRatioInPlace(node: PaneNode, splitId: string, ratio: number): void {
  if (node.type === 'leaf') return;
  if (node.id === splitId) {
    (node as any).ratio = ratio;
    return;
  }
  updateRatioInPlace(node.first, splitId, ratio);
  updateRatioInPlace(node.second, splitId, ratio);
}

export const store = new Store();
