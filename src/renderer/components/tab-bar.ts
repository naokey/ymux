import { store } from '../state/store';
import type { PaneNode } from '../state/types';
import { destroyTerminal } from '../terminal/terminal-manager';
import { destroyBrowserPane } from './browser-pane';

let tabBarEl: HTMLElement | null = null;

export function renderTabBar(
  container: HTMLElement,
  onNewTab: () => void,
): void {
  tabBarEl = container;
  container.className = 'tab-bar';
  update(onNewTab);
  store.subscribe(() => update(onNewTab));
}

function update(onNewTab: () => void): void {
  if (!tabBarEl) return;
  const state = store.getState();

  tabBarEl.innerHTML = '';

  // Add button
  const addBtn = document.createElement('button');
  addBtn.className = 'tab-add';
  addBtn.textContent = '+';
  addBtn.title = 'New Tab (\u2318T)';
  addBtn.addEventListener('click', onNewTab);
  tabBarEl.appendChild(addBtn);

  // Tabs
  const tabsContainer = document.createElement('div');
  tabsContainer.className = 'tabs-container';

  for (let i = 0; i < state.tabs.length; i++) {
    const tab = state.tabs[i];
    const isActive = tab.id === state.activeTabId;
    const tabEl = document.createElement('div');
    let className = 'tab';
    if (isActive) className += ' active';
    if (tab.waitingForInput && !isActive) className += ' waiting';
    tabEl.className = className;
    tabEl.dataset.tabId = tab.id;

    // Tab number
    const num = document.createElement('span');
    num.className = 'tab-num';
    num.textContent = String(i + 1);

    // Tab label (summary)
    const label = document.createElement('span');
    label.className = 'tab-label';
    label.textContent = tab.label;

    // Waiting indicator dot
    if (tab.waitingForInput && !isActive) {
      const dot = document.createElement('span');
      dot.className = 'tab-waiting-dot';
      tabEl.appendChild(dot);
    }

    // Double-click to rename
    tabEl.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      startRename(tabEl, tab.id, tab.label);
    });

    // Right-click context menu
    tabEl.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTabContextMenu(e.clientX, e.clientY, tab.id, tab.label, tabEl, onNewTab);
    });

    const closeBtn = document.createElement('button');
    closeBtn.className = 'tab-close';
    closeBtn.textContent = '\u00d7';
    closeBtn.title = 'Close Tab';
    closeBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      // Clean up all panes (terminals + browsers) before closing tab
      cleanupTabPanes(tab.rootPane, tab.id);
      const sessionIds = store.closeTab(tab.id);
      for (const sid of sessionIds) {
        window.ymuxAPI.killSession(sid);
      }
      if (store.getState().tabs.length === 0) {
        onNewTab();
      }
    });

    tabEl.addEventListener('click', () => {
      store.switchTab(tab.id);
      // Clear waiting state when user switches to this tab
      if (tab.waitingForInput) {
        store.setTabWaiting(tab.id, false);
      }
    });

    tabEl.appendChild(num);
    tabEl.appendChild(label);
    tabEl.appendChild(closeBtn);
    tabsContainer.appendChild(tabEl);
  }

  tabBarEl.appendChild(tabsContainer);

  // Help button at bottom
  const helpBtn = document.createElement('button');
  helpBtn.className = 'tab-help';
  helpBtn.textContent = '?';
  helpBtn.title = 'Keyboard Shortcuts';
  helpBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleHelpPopup(helpBtn);
  });
  tabBarEl.appendChild(helpBtn);
}

let helpPopupEl: HTMLElement | null = null;

function toggleHelpPopup(anchor: HTMLElement): void {
  if (helpPopupEl) {
    helpPopupEl.remove();
    helpPopupEl = null;
    return;
  }

  helpPopupEl = document.createElement('div');
  helpPopupEl.className = 'help-popup';

  const shortcuts = [
    ['⌘T', 'New Tab'],
    ['⌘D', 'Split Left/Right'],
    ['⌘⇧D', 'Split Top/Bottom'],
    ['⌘⇧E', 'Full-Width Bottom Pane'],
    ['⌘⇧W', 'Close Pane'],
    ['⌘⇧F', 'Zoom Pane'],
    ['⌘F', 'Search'],
    ['⌘⇧B', 'Open Browser'],
    ['⌘⇧]', 'Next Tab'],
    ['⌘⇧[', 'Previous Tab'],
    ['⌘⌥↑↓←→', 'Navigate Panes'],
  ];

  const cliCommands = [
    ['ymux split-window -h', 'Split left/right'],
    ['ymux split-window -v', 'Split top/bottom'],
    ['ymux new-tab', 'New tab'],
    ['ymux split-window -h "cmd"', 'Split & run command'],
  ];

  const title = document.createElement('div');
  title.className = 'help-title';
  title.textContent = 'ymux Commands';
  helpPopupEl.appendChild(title);

  const kbdSection = document.createElement('div');
  kbdSection.className = 'help-section';
  kbdSection.innerHTML = '<div class="help-section-title">Keyboard Shortcuts</div>';
  for (const [key, desc] of shortcuts) {
    const row = document.createElement('div');
    row.className = 'help-row';
    row.innerHTML = `<kbd>${key}</kbd><span>${desc}</span>`;
    kbdSection.appendChild(row);
  }
  helpPopupEl.appendChild(kbdSection);

  const cliSection = document.createElement('div');
  cliSection.className = 'help-section';
  cliSection.innerHTML = '<div class="help-section-title">CLI Commands</div>';
  for (const [cmd, desc] of cliCommands) {
    const row = document.createElement('div');
    row.className = 'help-row';
    row.innerHTML = `<code>${cmd}</code><span>${desc}</span>`;
    cliSection.appendChild(row);
  }
  helpPopupEl.appendChild(cliSection);

  document.body.appendChild(helpPopupEl);

  // Position relative to anchor
  const rect = anchor.getBoundingClientRect();
  helpPopupEl.style.left = `${rect.right + 8}px`;
  helpPopupEl.style.bottom = `${window.innerHeight - rect.bottom}px`;

  // Close on click outside
  const closeHandler = (ev: MouseEvent) => {
    if (helpPopupEl && !helpPopupEl.contains(ev.target as Node) && ev.target !== anchor) {
      helpPopupEl.remove();
      helpPopupEl = null;
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function startRename(tabEl: HTMLElement, tabId: string, currentLabel: string): void {
  // Hide existing content
  const num = tabEl.querySelector('.tab-num') as HTMLElement;
  const label = tabEl.querySelector('.tab-label') as HTMLElement;
  const close = tabEl.querySelector('.tab-close') as HTMLElement;
  if (num) num.style.display = 'none';
  if (label) label.style.display = 'none';
  if (close) close.style.display = 'none';

  const input = document.createElement('input');
  input.className = 'tab-rename-input';
  input.value = currentLabel;

  const finish = () => {
    const newLabel = input.value.trim() || currentLabel;
    store.renameTab(tabId, newLabel, true);
    input.remove();
    if (num) num.style.display = '';
    if (label) label.style.display = '';
    if (close) close.style.display = '';
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', (ke) => {
    ke.stopPropagation();
    if (ke.key === 'Enter') input.blur();
    if (ke.key === 'Escape') {
      input.value = currentLabel;
      input.blur();
    }
  });

  tabEl.appendChild(input);
  input.focus();
  input.select();
}

let contextMenuEl: HTMLElement | null = null;

function showTabContextMenu(
  x: number, y: number,
  tabId: string, label: string,
  tabEl: HTMLElement,
  onNewTab: () => void,
): void {
  // Remove existing menu
  if (contextMenuEl) {
    contextMenuEl.remove();
    contextMenuEl = null;
  }

  contextMenuEl = document.createElement('div');
  contextMenuEl.className = 'tab-context-menu';

  const items = [
    { text: 'Rename', action: () => startRename(tabEl, tabId, label) },
    { text: 'Duplicate Tab', action: () => onNewTab() },
    { text: 'separator' },
    { text: 'Close Tab', action: () => {
      const tab = store.getState().tabs.find(t => t.id === tabId);
      if (tab) {
        cleanupTabPanes(tab.rootPane, tabId);
        const sessionIds = store.closeTab(tabId);
        for (const sid of sessionIds) {
          window.ymuxAPI.killSession(sid);
        }
        if (store.getState().tabs.length === 0) {
          onNewTab();
        }
      }
    }, danger: true },
  ];

  for (const item of items) {
    if (item.text === 'separator') {
      const sep = document.createElement('div');
      sep.className = 'context-menu-separator';
      contextMenuEl.appendChild(sep);
      continue;
    }
    const menuItem = document.createElement('div');
    menuItem.className = 'context-menu-item' + ((item as any).danger ? ' danger' : '');
    menuItem.textContent = item.text;
    menuItem.addEventListener('click', () => {
      item.action!();
      contextMenuEl?.remove();
      contextMenuEl = null;
    });
    contextMenuEl.appendChild(menuItem);
  }

  document.body.appendChild(contextMenuEl);

  // Position
  const menuWidth = 160;
  const menuHeight = contextMenuEl.offsetHeight;
  const posX = x + menuWidth > window.innerWidth ? x - menuWidth : x;
  const posY = y + menuHeight > window.innerHeight ? y - menuHeight : y;
  contextMenuEl.style.left = `${posX}px`;
  contextMenuEl.style.top = `${posY}px`;

  // Close on click outside
  const closeHandler = (ev: MouseEvent) => {
    if (contextMenuEl && !contextMenuEl.contains(ev.target as Node)) {
      contextMenuEl.remove();
      contextMenuEl = null;
      document.removeEventListener('click', closeHandler);
    }
  };
  setTimeout(() => document.addEventListener('click', closeHandler), 0);
}

function cleanupTabPanes(node: PaneNode, _tabId: string): void {
  if (node.type === 'leaf') {
    if (node.paneKind === 'browser') {
      destroyBrowserPane(node.id);
    } else {
      destroyTerminal(node.id);
    }
    return;
  }
  cleanupTabPanes(node.first, _tabId);
  cleanupTabPanes(node.second, _tabId);
}
