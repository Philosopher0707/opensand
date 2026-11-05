export interface LanguageMeta {
  label: string;
  icon: string;
  previewable: boolean;
}

export interface DiffRecord {
  type: 'chunk' | 'file-header' | 'add' | 'del' | 'context';
  oldNum: number | null;
  newNum: number | null;
  text: string;
}

/** One tab in the canvas strip — one open file or artifact. */
export interface ArtifactTab {
  key: string;
  title: string;
  filePath: string;
  language: string;
  active: boolean;
  hasDiff: boolean;
}

export interface ArtifactCanvasState {
  isOpen: boolean;
  isFullscreen: boolean;
  activeTab: 'code' | 'preview' | 'diff';
  title: string;
  language: string;
  content: string;
  diff: string;
  filePath: string;
}

export interface ArtifactOptions {
  /** Override the tab identity. Defaults to filePath, then title. */
  key?: string;
  title?: string;
  language?: string;
  content?: string;
  diff?: string;
  filePath?: string;
  defaultTab?: 'code' | 'preview' | 'diff';
  autoPreview?: boolean;
}

export interface ArtifactCanvasElements {
  canvasEl?: HTMLElement | null;
  iconEl?: HTMLElement | null;
  titleEl?: HTMLElement | null;
  badgeEl?: HTMLElement | null;
  tabStripEl?: HTMLElement | null;
  tabCodeBtn?: HTMLButtonElement | null;
  tabPreviewBtn?: HTMLButtonElement | null;
  tabDiffBtn?: HTMLButtonElement | null;
  codePaneEl?: HTMLElement | null;
  previewPaneEl?: HTMLElement | null;
  diffPaneEl?: HTMLElement | null;
  codeContentEl?: HTMLElement | null;
  lineNumbersEl?: HTMLElement | null;
  previewIframeEl?: HTMLIFrameElement | null;
  markdownPreviewEl?: HTMLElement | null;
  diffContentEl?: HTMLElement | null;
  copyBtn?: HTMLButtonElement | null;
  downloadBtn?: HTMLButtonElement | null;
  expandBtn?: HTMLButtonElement | null;
  closeBtn?: HTMLButtonElement | null;
  toggleBtn?: HTMLButtonElement | null;
  renderMarkdownFn?: (md: string) => string;
  escapeHtmlFn?: (str: string) => string;
  onStateChange?: (state: ArtifactCanvasState) => void;
}

export interface ArtifactCanvasController {
  getState: () => ArtifactCanvasState;
  /** Snapshot of the open tabs, in strip order. */
  getTabs: () => ArtifactTab[];
  openArtifact: (artifact?: ArtifactOptions) => void;
  /** Close every tab and hide the canvas. */
  closeArtifact: () => void;
  /** Close one tab by key; activates a neighbour when the active tab closes. */
  closeTab: (key: string) => void;
  /** Focus a tab by key. */
  selectTab: (key: string) => void;
  /** Cycle tabs; -1 for previous, +1 for next. Wraps around. */
  nextTab: (delta: number) => void;
  toggleCanvas: () => void;
  switchTab: (tabName: 'code' | 'preview' | 'diff') => void;
  setFullscreen: (isFullscreen: boolean) => void;
  toggleFullscreen: () => void;
  copyContent: () => Promise<void>;
  downloadContent: () => void;
  updateUi: () => void;
}

export const LANGUAGE_METADATA: Record<string, LanguageMeta>;
export function resolveLanguageMeta(langOrExt: string | null | undefined): LanguageMeta;
export function parseUnifiedDiff(diffText: string): DiffRecord[];
export function renderDiffHtml(diffText: string, escapeHtmlFn?: (str: string) => string): string;
export function generateLineNumbers(text: string): string;
export function createArtifactCanvas(options?: ArtifactCanvasElements): ArtifactCanvasController;
