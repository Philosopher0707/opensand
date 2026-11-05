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
  openArtifact: (artifact?: ArtifactOptions) => void;
  closeArtifact: () => void;
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
