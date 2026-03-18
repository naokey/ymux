import type { PaneNode, PaneLeaf } from '../state/types';

function findLeafInTree(node: PaneNode, paneId: string): PaneLeaf | null {
  if (node.type === 'leaf') return node.id === paneId ? node : null;
  return findLeafInTree(node.first, paneId) || findLeafInTree(node.second, paneId);
}

function collectAllLeaves(node: PaneNode): PaneLeaf[] {
  if (node.type === 'leaf') return [node];
  return [...collectAllLeaves(node.first), ...collectAllLeaves(node.second)];
}

import { store } from '../state/store';
import { createTerminal, destroyTerminal, fitTerminal, focusTerminal, getTerminal, dismissSessionWaiting } from '../terminal/terminal-manager';
import { createBrowserPane, destroyBrowserPane, focusBrowserPane } from './browser-pane';

let containerEl: HTMLElement | null = null;
let currentTabId: string | null = null;
let currentActivePaneId: string | null = null;
// Track DOM elements for each tab so we can show/hide instead of re-creating
const tabDomMap = new Map<string, HTMLElement>();
// Track tree structure fingerprint per tab to detect structural changes
const tabTreeFingerprint = new Map<string, string>();

// Serialize tree structure (ignoring ratio/waiting state) for change detection
function treeFingerprint(node: PaneNode, zoomedPaneId: string | null): string {
  if (zoomedPaneId) return `ZOOM:${zoomedPaneId}`;
  if (node.type === 'leaf') return `L:${node.id}:${node.paneKind || 't'}`;
  return `S:${node.id}:${node.direction}(${treeFingerprint(node.first, null)},${treeFingerprint(node.second, null)})`;
}

export function renderPaneContainer(
  container: HTMLElement,
  onClosePane: (paneId: string) => void,
): void {
  containerEl = container;
  container.className = 'pane-container';

  store.subscribe(() => {
    update(onClosePane);
  });

  update(onClosePane);
}

async function update(onClosePane: (paneId: string) => void): Promise<void> {
  if (!containerEl) return;
  const state = store.getState();
  const activeTab = state.tabs.find(t => t.id === state.activeTabId);

  // Hide all tab DOMs and clean up removed tabs
  for (const [tabId, el] of tabDomMap) {
    el.style.display = 'none';
    if (!state.tabs.find(t => t.id === tabId)) {
      el.remove();
      tabDomMap.delete(tabId);
      tabTreeFingerprint.delete(tabId);
    }
  }

  if (!activeTab) return;

  let tabDom = tabDomMap.get(activeTab.id);
  const newFingerprint = treeFingerprint(activeTab.rootPane, activeTab.zoomedPaneId);
  const oldFingerprint = tabTreeFingerprint.get(activeTab.id);
  const structureChanged = newFingerprint !== oldFingerprint;

  if (!tabDom || structureChanged) {
    // Need to (re)build this tab's DOM
    if (tabDom) {
      // Clean up existing browser panes before rebuild
      const oldLeaves = tabDom.querySelectorAll('.pane[data-pane-id]');
      // Browser panes that no longer exist need cleanup
      // (terminals are handled by the Map in terminal-manager)
      tabDom.innerHTML = '';
    } else {
      tabDom = document.createElement('div');
      tabDom.className = 'tab-panes';
      tabDom.style.display = 'flex';
      tabDom.style.width = '100%';
      tabDom.style.height = '100%';
      containerEl.appendChild(tabDom);
      tabDomMap.set(activeTab.id, tabDom);
    }

    // If zoomed, only render the zoomed pane
    if (activeTab.zoomedPaneId) {
      const zoomedLeaf = findLeafInTree(activeTab.rootPane, activeTab.zoomedPaneId);
      if (zoomedLeaf) {
        await buildPaneDOM(tabDom, zoomedLeaf, onClosePane);
      } else {
        await buildPaneDOM(tabDom, activeTab.rootPane, onClosePane);
      }
    } else {
      await buildPaneDOM(tabDom, activeTab.rootPane, onClosePane);
    }
    tabTreeFingerprint.set(activeTab.id, newFingerprint);

    tabDom.style.display = 'flex';

    // Focus after structural change
    const focusPaneId = activeTab.zoomedPaneId || activeTab.activePaneId;
    requestAnimationFrame(() => {
      if (focusPaneId) {
        const leaf = findLeafInTree(activeTab.rootPane, focusPaneId);
        if (leaf && leaf.paneKind === 'browser') {
          focusBrowserPane(focusPaneId);
        } else {
          focusTerminal(focusPaneId);
          fitTerminal(focusPaneId);
        }
      }
    });
    currentActivePaneId = activeTab.activePaneId;
  } else {
    // Structure unchanged — just show and update non-structural state
    tabDom.style.display = 'flex';

    // Update waiting CSS classes in-place (no DOM rebuild)
    updateWaitingState(tabDom, activeTab.rootPane);

    // Focus if active pane changed or tab switched
    if (currentTabId !== activeTab.id || currentActivePaneId !== activeTab.activePaneId) {
      requestAnimationFrame(() => {
        if (activeTab.activePaneId) {
          const leaf = findLeafInTree(activeTab.rootPane, activeTab.activePaneId);
          if (leaf && leaf.paneKind === 'browser') {
            focusBrowserPane(activeTab.activePaneId);
          } else {
            focusTerminal(activeTab.activePaneId);
            fitTerminal(activeTab.activePaneId);
          }
        }
      });
      currentActivePaneId = activeTab.activePaneId;
    }
  }

  currentTabId = activeTab.id;
}

// Update waiting CSS classes without rebuilding DOM
function updateWaitingState(tabDom: HTMLElement, rootPane: PaneNode): void {
  const leaves = collectAllLeaves(rootPane);
  for (const leaf of leaves) {
    const el = tabDom.querySelector(`.pane[data-pane-id="${leaf.id}"]`) as HTMLElement;
    if (!el) continue;
    if (store.isSessionWaiting(leaf.sessionId)) {
      el.classList.add('pane-waiting');
    } else {
      el.classList.remove('pane-waiting');
    }
  }
}

async function buildPaneDOM(
  parent: HTMLElement,
  node: PaneNode,
  onClosePane: (paneId: string) => void,
): Promise<void> {
  if (node.type === 'leaf') {
    const paneEl = document.createElement('div');
    paneEl.className = 'pane';
    paneEl.dataset.paneId = node.id;
    paneEl.dataset.sessionId = node.sessionId;
    paneEl.style.flex = '1';
    paneEl.style.position = 'relative';
    paneEl.style.overflow = 'hidden';

    // Apply waiting state
    if (store.isSessionWaiting(node.sessionId)) {
      paneEl.classList.add('pane-waiting');
    }

    // Focus handling
    paneEl.addEventListener('mousedown', () => {
      store.setActivePaneId(node.id);
      if (store.isSessionWaiting(node.sessionId)) {
        dismissSessionWaiting(node.sessionId);
      }
    });

    parent.appendChild(paneEl);

    if (node.paneKind === 'browser') {
      createBrowserPane(paneEl, node.id);
    } else {
      const existing = getTerminal(node.id);
      if (existing) {
        paneEl.appendChild(existing.terminal.element!);
        requestAnimationFrame(() => fitTerminal(node.id));
      } else {
        await createTerminal(paneEl, node.sessionId, onClosePane, node.id);
      }
    }
    return;
  }

  // Split node
  const isVertical = node.direction === 'vertical';
  parent.style.flexDirection = isVertical ? 'row' : 'column';

  const firstEl = document.createElement('div');
  firstEl.className = 'pane-group';
  firstEl.style.display = 'flex';
  firstEl.style.flex = `${node.ratio}`;
  firstEl.style.overflow = 'hidden';

  const splitter = document.createElement('div');
  splitter.className = `splitter ${isVertical ? 'splitter-vertical' : 'splitter-horizontal'}`;
  splitter.dataset.splitId = node.id;
  setupSplitter(splitter, node.id, isVertical, firstEl);

  const secondEl = document.createElement('div');
  secondEl.className = 'pane-group';
  secondEl.style.display = 'flex';
  secondEl.style.flex = `${1 - node.ratio}`;
  secondEl.style.overflow = 'hidden';

  parent.appendChild(firstEl);
  parent.appendChild(splitter);
  parent.appendChild(secondEl);

  await buildPaneDOM(firstEl, node.first, onClosePane);
  await buildPaneDOM(secondEl, node.second, onClosePane);
}

function setupSplitter(
  splitter: HTMLElement,
  splitId: string,
  isVertical: boolean,
  firstEl: HTMLElement,
): void {
  let startPos = 0;
  let startFlex = 0;
  let parentSize = 0;

  const onMouseMove = (e: MouseEvent) => {
    const delta = isVertical ? e.clientX - startPos : e.clientY - startPos;
    const newRatio = Math.max(0.1, Math.min(0.9, startFlex + delta / parentSize));
    firstEl.style.flex = `${newRatio}`;
    const secondEl = splitter.nextElementSibling as HTMLElement;
    if (secondEl) secondEl.style.flex = `${1 - newRatio}`;
    // Don't update store during drag to avoid triggering rebuilds
  };

  const onMouseUp = () => {
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    // Save final ratio to store
    const finalRatio = parseFloat(firstEl.style.flex) || 0.5;
    store.updateSplitRatio(splitId, finalRatio);
    import('../terminal/terminal-manager').then(m => m.fitAllTerminals());
  };

  splitter.addEventListener('mousedown', (e) => {
    e.preventDefault();
    startPos = isVertical ? e.clientX : e.clientY;
    const parent = splitter.parentElement!;
    parentSize = isVertical ? parent.offsetWidth : parent.offsetHeight;
    startFlex = parseFloat(firstEl.style.flex) || 0.5;
    document.body.style.cursor = isVertical ? 'col-resize' : 'row-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  });
}
