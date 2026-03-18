import { store } from '../state/store';
import type { PaneNode, PaneLeaf } from '../state/types';

type ShortcutHandler = () => void;

interface Shortcut {
  key: string;
  meta?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  handler: ShortcutHandler;
}

let shortcuts: Shortcut[] = [];

export function initKeybindings(actions: {
  newTab: () => void;
  splitVertical: () => void;
  splitHorizontal: () => void;
  closePane: () => void;
  openBrowser: () => void;
  toggleZoom: () => void;
  toggleSearch: () => void;
  splitRootHorizontal: () => void;
  fontSizeUp: () => void;
  fontSizeDown: () => void;
}): void {
  const isMac = navigator.platform.includes('Mac');

  shortcuts = [
    // New tab: Cmd+T / Ctrl+Shift+T
    { key: 't', meta: isMac, ctrl: !isMac, shift: !isMac, handler: actions.newTab },
    // Close pane: Cmd+Shift+W / Ctrl+Shift+X
    { key: 'w', meta: isMac, shift: true, handler: actions.closePane },
    // Split vertical: Cmd+D / Ctrl+Shift+D
    { key: 'd', meta: isMac, ctrl: !isMac, shift: !isMac, handler: actions.splitVertical },
    // Split horizontal: Cmd+Shift+D / Ctrl+Shift+H
    { key: isMac ? 'd' : 'h', meta: isMac, shift: true, ctrl: !isMac, handler: actions.splitHorizontal },
    // Split root horizontal (full-width bottom pane): Cmd+Shift+E
    { key: 'e', meta: isMac, shift: true, handler: actions.splitRootHorizontal },
    // Next tab: Cmd+Shift+] / Ctrl+Tab
    { key: ']', meta: isMac, shift: true, handler: () => navigateTab(1) },
    // Prev tab: Cmd+Shift+[ / Ctrl+Shift+Tab
    { key: '[', meta: isMac, shift: true, handler: () => navigateTab(-1) },
    // Open browser: Cmd+Shift+B
    { key: 'b', meta: isMac, shift: true, handler: actions.openBrowser },
    // Zoom toggle: Cmd+Shift+F
    { key: 'f', meta: isMac, shift: true, handler: actions.toggleZoom },
    // Search: Cmd+F
    { key: 'f', meta: isMac, handler: actions.toggleSearch },
    // Font size: Cmd+= / Cmd+-
    { key: '=', meta: isMac, handler: actions.fontSizeUp },
    { key: '-', meta: isMac, handler: actions.fontSizeDown },
    // Navigate panes with Cmd+Alt+Arrow / Alt+Arrow
    { key: 'ArrowUp', meta: isMac, alt: true, handler: () => navigatePane('up') },
    { key: 'ArrowDown', meta: isMac, alt: true, handler: () => navigatePane('down') },
    { key: 'ArrowLeft', meta: isMac, alt: true, handler: () => navigatePane('left') },
    { key: 'ArrowRight', meta: isMac, alt: true, handler: () => navigatePane('right') },
  ];

  window.addEventListener('keydown', handleKeydown, true);
}

function handleKeydown(e: KeyboardEvent): void {
  for (const s of shortcuts) {
    if (
      e.key.toLowerCase() === s.key.toLowerCase() &&
      !!e.metaKey === !!s.meta &&
      !!e.shiftKey === !!s.shift &&
      !!e.ctrlKey === !!s.ctrl &&
      !!e.altKey === !!s.alt
    ) {
      e.preventDefault();
      e.stopPropagation();
      s.handler();
      return;
    }
  }
}

function navigateTab(direction: 1 | -1): void {
  const state = store.getState();
  const idx = state.tabs.findIndex(t => t.id === state.activeTabId);
  if (idx < 0) return;
  const newIdx = (idx + direction + state.tabs.length) % state.tabs.length;
  store.switchTab(state.tabs[newIdx].id);
}

function navigatePane(direction: 'up' | 'down' | 'left' | 'right'): void {
  const tab = store.getActiveTab();
  if (!tab) return;
  const leaves = collectLeaves(tab.rootPane);
  if (leaves.length <= 1) return;

  const currentIdx = leaves.findIndex(l => l.id === tab.activePaneId);
  if (currentIdx < 0) return;

  // Simple round-robin navigation for now
  const nextIdx = (direction === 'right' || direction === 'down')
    ? (currentIdx + 1) % leaves.length
    : (currentIdx - 1 + leaves.length) % leaves.length;

  store.setActivePaneId(leaves[nextIdx].id);
  import('../terminal/terminal-manager').then(m => m.focusTerminal(leaves[nextIdx].id));
}

function collectLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...collectLeaves(node.first), ...collectLeaves(node.second)];
}
