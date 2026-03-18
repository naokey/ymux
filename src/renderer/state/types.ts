export interface BrowserTab {
  id: string;
  url: string;
  title: string;
}

export interface BrowserPaneState {
  tabs: BrowserTab[];
  activeTabId: string;
}

export interface PaneLeaf {
  type: 'leaf';
  id: string;
  sessionId: string;
  paneKind?: 'terminal' | 'browser';
}

export interface PaneSplit {
  type: 'split';
  id: string;
  direction: 'horizontal' | 'vertical';
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export interface Tab {
  id: string;
  label: string;
  rootPane: PaneNode;
  activePaneId: string;
  waitingForInput: boolean;
  userRenamed: boolean;
  zoomedPaneId: string | null;
}

export interface AppState {
  tabs: Tab[];
  activeTabId: string;
  waitingSessions: Set<string>; // sessionIds that are waiting for input
}
