import { store } from '../state/store';
import type { PaneNode } from '../state/types';

let statusEl: HTMLElement | null = null;

export function renderStatusBar(container: HTMLElement): void {
  statusEl = container;
  container.className = 'status-bar';
  update();
  store.subscribe(update);
  // Update clock every minute
  setInterval(update, 60000);
}

function update(): void {
  if (!statusEl) return;
  const state = store.getState();
  const tab = state.tabs.find(t => t.id === state.activeTabId);

  const paneCount = tab ? countPanes(tab.rootPane) : 0;
  const tabIndex = tab ? state.tabs.indexOf(tab) + 1 : 0;
  const tabCount = state.tabs.length;
  const isZoomed = tab?.zoomedPaneId ? true : false;
  const now = new Date();
  const time = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

  statusEl.innerHTML = `
    <div class="status-left">
      <span class="status-item">${tabCount} tabs</span>
      <span class="status-item">${paneCount} panes</span>
      ${isZoomed ? '<span class="status-item" style="color: var(--accent);">[ZOOM]</span>' : ''}
    </div>
    <div class="status-center">
      <span class="status-item">[${tabIndex}/${tabCount}] ${tab?.label || ''}</span>
    </div>
    <div class="status-right">
      <span class="status-item">${time}</span>
    </div>
  `;
}

function countPanes(node: PaneNode): number {
  if (node.type === 'leaf') return 1;
  return countPanes(node.first) + countPanes(node.second);
}
