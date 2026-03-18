import { store } from '../state/store';

interface ManagedBrowser {
  container: HTMLElement;
  paneId: string;
  webviews: Map<string, Electron.WebviewTag>;
  tabBar: HTMLElement;
  webviewContainer: HTMLElement;
  urlBar: HTMLInputElement;
  loadingIndicator: HTMLElement;
  unsubscribe: () => void;
  lastRenderedSnapshot: string; // JSON snapshot to avoid needless re-renders
}

const browsers = new Map<string, ManagedBrowser>();

// Smart URL: detect if input is a URL or search query
function smartUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';
  // Already a full URL
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  // Looks like a domain (has dot, no spaces)
  if (/^[^\s]+\.[^\s]+$/.test(trimmed) && !trimmed.includes(' ')) {
    return 'https://' + trimmed;
  }
  // Otherwise, search
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function createBrowserPane(container: HTMLElement, paneId: string): void {
  // Prevent duplicate creation
  if (browsers.has(paneId)) return;

  const wrapper = document.createElement('div');
  wrapper.className = 'browser-pane';

  // Toolbar
  const toolbar = document.createElement('div');
  toolbar.className = 'browser-toolbar';

  const backBtn = createNavBtn('\u25C0', 'Back', () => {
    const wv = getActiveWebview(paneId);
    if (wv && wv.canGoBack()) wv.goBack();
  });

  const fwdBtn = createNavBtn('\u25B6', 'Forward', () => {
    const wv = getActiveWebview(paneId);
    if (wv && wv.canGoForward()) wv.goForward();
  });

  const reloadBtn = createNavBtn('\u21BB', 'Reload', () => {
    const wv = getActiveWebview(paneId);
    if (wv) wv.reload();
  });

  const urlBar = document.createElement('input');
  urlBar.className = 'browser-url-bar';
  urlBar.type = 'text';
  urlBar.placeholder = 'URL or search...';
  urlBar.spellcheck = false;

  urlBar.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const url = smartUrl(urlBar.value);
      const wv = getActiveWebview(paneId);
      if (wv && url) {
        wv.loadURL(url);
        urlBar.blur();
      }
    }
    if (e.key === 'Escape') {
      urlBar.blur();
      // Restore current URL
      const wv = getActiveWebview(paneId);
      if (wv) urlBar.value = wv.getURL();
    }
    // Prevent keybindings from firing while typing in URL bar
    e.stopPropagation();
  });

  // Select all on focus for easy replacement
  urlBar.addEventListener('focus', () => {
    requestAnimationFrame(() => urlBar.select());
  });

  // Loading indicator
  const loadingIndicator = document.createElement('div');
  loadingIndicator.className = 'browser-loading';
  loadingIndicator.style.display = 'none';

  toolbar.appendChild(backBtn);
  toolbar.appendChild(fwdBtn);
  toolbar.appendChild(reloadBtn);
  toolbar.appendChild(urlBar);

  // Browser tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'browser-tab-bar';

  // Webview container
  const webviewContainer = document.createElement('div');
  webviewContainer.className = 'browser-webview-container';

  wrapper.appendChild(toolbar);
  wrapper.appendChild(loadingIndicator);
  wrapper.appendChild(tabBar);
  wrapper.appendChild(webviewContainer);
  container.appendChild(wrapper);

  const managed: ManagedBrowser = {
    container: wrapper,
    paneId,
    webviews: new Map(),
    tabBar,
    webviewContainer,
    urlBar,
    loadingIndicator,
    unsubscribe: () => {},
    lastRenderedSnapshot: '',
  };
  browsers.set(paneId, managed);

  // Initial render
  renderBrowserTabs(managed);

  // Subscribe — only re-render when this browser's state actually changed
  const unsub = store.subscribe(() => {
    if (!browsers.has(paneId)) return;
    const bp = store.getBrowserPaneState(paneId);
    if (!bp) return;
    const snapshot = JSON.stringify(bp);
    if (snapshot !== managed.lastRenderedSnapshot) {
      renderBrowserTabs(managed);
    }
  });
  managed.unsubscribe = unsub;
}

function createNavBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.className = 'browser-nav-btn';
  btn.textContent = text;
  btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function createWebview(
  managed: ManagedBrowser,
  tabId: string,
  url: string,
): Electron.WebviewTag {
  const wv = document.createElement('webview') as Electron.WebviewTag;
  wv.src = url;
  wv.className = 'browser-webview';
  // Persistent storage (cookies, localStorage, etc.) — like cmux's per-profile WKWebsiteDataStore
  wv.partition = 'persist:ymux-browser';
  wv.setAttribute('allowpopups', 'true');
  // Use standard user agent to avoid sites blocking Electron
  wv.setAttribute('useragent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

  const paneId = managed.paneId;

  // Navigation events — update store but avoid re-render loop by being selective
  wv.addEventListener('did-navigate', () => {
    const currentUrl = wv.getURL();
    store.updateBrowserTab(paneId, tabId, { url: currentUrl });
    syncUrlBar(managed, tabId);
  });

  wv.addEventListener('did-navigate-in-page', () => {
    const currentUrl = wv.getURL();
    store.updateBrowserTab(paneId, tabId, { url: currentUrl });
    syncUrlBar(managed, tabId);
  });

  wv.addEventListener('page-title-updated', (e: any) => {
    store.updateBrowserTab(paneId, tabId, { title: e.title });
  });

  // Loading states
  wv.addEventListener('did-start-loading', () => {
    managed.loadingIndicator.style.display = 'block';
  });

  wv.addEventListener('did-stop-loading', () => {
    managed.loadingIndicator.style.display = 'none';
  });

  // Handle new window requests (target="_blank", window.open, Cmd+click)
  wv.addEventListener('new-window', (e: any) => {
    e.preventDefault();
    const newUrl = e.url;
    if (newUrl && newUrl !== 'about:blank') {
      // Open in a new browser tab within this pane (like cmux)
      store.addBrowserTab(paneId, newUrl);
    }
  });

  // Handle page errors gracefully
  wv.addEventListener('did-fail-load', (e: any) => {
    if (e.errorCode === -3) return; // Aborted (normal for redirects)
    if (e.errorCode === 0) return;
    console.warn(`[browser] Load failed: ${e.errorDescription} (${e.validatedURL})`);
  });

  // Context menu - allow DevTools
  wv.addEventListener('dom-ready', () => {
    // Inject CSS to handle dark mode for about:blank etc.
    wv.insertCSS('html { color-scheme: dark light; }').catch(() => {});
  });

  return wv;
}

function syncUrlBar(managed: ManagedBrowser, tabId: string): void {
  const bp = store.getBrowserPaneState(managed.paneId);
  if (!bp || bp.activeTabId !== tabId) return;
  // Don't update if user is currently typing
  if (document.activeElement === managed.urlBar) return;
  const wv = managed.webviews.get(tabId);
  if (wv) {
    managed.urlBar.value = wv.getURL();
  }
}

function renderBrowserTabs(managed: ManagedBrowser): void {
  const bp = store.getBrowserPaneState(managed.paneId);
  if (!bp) return;

  managed.lastRenderedSnapshot = JSON.stringify(bp);

  const { tabBar, webviewContainer, urlBar, paneId } = managed;

  // Rebuild tab bar
  tabBar.innerHTML = '';
  for (const tab of bp.tabs) {
    const tabEl = document.createElement('div');
    tabEl.className = 'browser-tab' + (tab.id === bp.activeTabId ? ' active' : '');
    tabEl.addEventListener('click', () => store.switchBrowserTab(paneId, tab.id));

    const label = document.createElement('span');
    label.className = 'browser-tab-label';
    label.textContent = tab.title || new URL(tab.url).hostname || tab.url;
    tabEl.appendChild(label);

    if (bp.tabs.length > 1) {
      const closeBtn = document.createElement('button');
      closeBtn.className = 'browser-tab-close';
      closeBtn.textContent = '\u00d7';
      closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const wv = managed.webviews.get(tab.id);
        if (wv) { wv.remove(); managed.webviews.delete(tab.id); }
        const shouldClosePane = store.closeBrowserTab(paneId, tab.id);
        if (shouldClosePane) {
          destroyBrowserPane(paneId);
        }
      });
      tabEl.appendChild(closeBtn);
    }

    tabBar.appendChild(tabEl);
  }

  // Add tab button
  const addBtn = document.createElement('button');
  addBtn.className = 'browser-tab-add';
  addBtn.textContent = '+';
  addBtn.addEventListener('click', () => store.addBrowserTab(paneId));
  tabBar.appendChild(addBtn);

  // Create missing webviews, show/hide based on active tab
  for (const tab of bp.tabs) {
    let wv = managed.webviews.get(tab.id);
    if (!wv) {
      wv = createWebview(managed, tab.id, tab.url);
      webviewContainer.appendChild(wv);
      managed.webviews.set(tab.id, wv);
    }

    if (tab.id === bp.activeTabId) {
      wv.style.display = 'flex';
      // Update URL bar if not focused
      if (document.activeElement !== urlBar) {
        urlBar.value = tab.url || '';
      }
    } else {
      wv.style.display = 'none';
    }
  }

  // Remove webviews for deleted tabs
  for (const [tabId, wv] of managed.webviews) {
    if (!bp.tabs.find(t => t.id === tabId)) {
      wv.remove();
      managed.webviews.delete(tabId);
    }
  }
}

function getActiveWebview(paneId: string): Electron.WebviewTag | null {
  const bp = store.getBrowserPaneState(paneId);
  if (!bp) return null;
  const managed = browsers.get(paneId);
  if (!managed) return null;
  return managed.webviews.get(bp.activeTabId) || null;
}

export function destroyBrowserPane(paneId: string): void {
  const managed = browsers.get(paneId);
  if (managed) {
    managed.unsubscribe();
    for (const wv of managed.webviews.values()) {
      wv.remove();
    }
    managed.webviews.clear();
    browsers.delete(paneId);
  }
  store.destroyBrowserPane(paneId);
}

export function focusBrowserPane(paneId: string): void {
  const wv = getActiveWebview(paneId);
  if (wv) wv.focus();
}
