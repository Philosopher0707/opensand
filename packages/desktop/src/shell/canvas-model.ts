// packages/desktop/src/shell/canvas-model.ts
// Pure model and state logic for the Preact Artifact Canvas split-view.

export interface LanguageMeta {
  label: string;
  icon: string;
  previewable: boolean;
}

export const LANGUAGE_METADATA: Record<string, LanguageMeta> = {
  javascript: { label: "JavaScript", icon: "🟨", previewable: false },
  js: { label: "JavaScript", icon: "🟨", previewable: false },
  typescript: { label: "TypeScript", icon: "🔷", previewable: false },
  ts: { label: "TypeScript", icon: "🔷", previewable: false },
  tsx: { label: "TypeScript React", icon: "⚛️", previewable: false },
  jsx: { label: "JavaScript React", icon: "⚛️", previewable: false },
  html: { label: "HTML Preview", icon: "🌐", previewable: true },
  htm: { label: "HTML Preview", icon: "🌐", previewable: true },
  svg: { label: "SVG Diagram", icon: "🖼️", previewable: true },
  css: { label: "CSS Stylesheet", icon: "🎨", previewable: false },
  scss: { label: "SCSS", icon: "🎨", previewable: false },
  json: { label: "JSON Data", icon: "📋", previewable: false },
  markdown: { label: "Markdown", icon: "📝", previewable: true },
  md: { label: "Markdown", icon: "📝", previewable: true },
  python: { label: "Python", icon: "🐍", previewable: false },
  py: { label: "Python", icon: "🐍", previewable: false },
  rust: { label: "Rust", icon: "🦀", previewable: false },
  rs: { label: "Rust", icon: "🦀", previewable: false },
  go: { label: "Go", icon: "🐹", previewable: false },
  bash: { label: "Shell Script", icon: "🐚", previewable: false },
  sh: { label: "Shell Script", icon: "🐚", previewable: false },
  zsh: { label: "Zsh Script", icon: "🐚", previewable: false },
  sql: { label: "SQL Query", icon: "🗄️", previewable: false },
  diff: { label: "Unified Diff", icon: "🔀", previewable: false },
  patch: { label: "Patch Diff", icon: "🔀", previewable: false },
};

export function resolveLanguageMeta(langOrExt?: string): LanguageMeta {
  const key = (langOrExt || "").toLowerCase().trim().replace(/^\./, "");
  return (
    LANGUAGE_METADATA[key] || {
      label: key ? key.toUpperCase() : "Code",
      icon: "📄",
      previewable: false,
    }
  );
}

export function extOf(fileNameOrPath: string): string {
  const cleaned = String(fileNameOrPath || "").split(/[?#]/)[0];
  const lastDot = cleaned.lastIndexOf(".");
  return lastDot !== -1 ? cleaned.slice(lastDot + 1).toLowerCase() : "text";
}

export interface ArtifactItem {
  id: string;
  title: string;
  filePath?: string;
  language: string;
  content: string;
  diff?: string;
  viewMode: "code" | "preview" | "diff";
}

export interface CanvasState {
  artifacts: ArtifactItem[];
  activeId: string | null;
  isOpen: boolean;
}

export function createInitialCanvasState(): CanvasState {
  return {
    artifacts: [],
    activeId: null,
    isOpen: false,
  };
}

export function openArtifact(
  state: CanvasState,
  input: Partial<ArtifactItem> & { title: string; content: string }
): CanvasState {
  const id = input.id || input.filePath || input.title;
  const lang = input.language || extOf(input.filePath || input.title);
  const meta = resolveLanguageMeta(lang);
  const defaultMode: "code" | "preview" | "diff" =
    input.viewMode || (meta.previewable ? "preview" : "code");

  const existingIndex = state.artifacts.findIndex(
    (a) => a.id === id || (input.filePath && a.filePath === input.filePath)
  );

  let updatedArtifacts: ArtifactItem[];
  if (existingIndex !== -1) {
    const existing = state.artifacts[existingIndex];
    const updated: ArtifactItem = {
      ...existing,
      ...input,
      id: existing.id,
      title: input.title || existing.title,
      language: lang,
      content: input.content,
      diff: input.diff !== undefined ? input.diff : existing.diff,
      viewMode: input.viewMode || existing.viewMode || defaultMode,
    };
    updatedArtifacts = [
      ...state.artifacts.slice(0, existingIndex),
      updated,
      ...state.artifacts.slice(existingIndex + 1),
    ];
  } else {
    const newItem: ArtifactItem = {
      id,
      title: input.title,
      filePath: input.filePath,
      language: lang,
      content: input.content,
      diff: input.diff,
      viewMode: defaultMode,
    };
    updatedArtifacts = [...state.artifacts, newItem];
  }

  return {
    artifacts: updatedArtifacts,
    activeId: id,
    isOpen: true,
  };
}

export function closeTab(state: CanvasState, id: string): CanvasState {
  const tabIndex = state.artifacts.findIndex((a) => a.id === id);
  if (tabIndex === -1) return state;

  const newArtifacts = state.artifacts.filter((a) => a.id !== id);
  if (newArtifacts.length === 0) {
    return {
      artifacts: [],
      activeId: null,
      isOpen: false,
    };
  }

  let newActiveId = state.activeId;
  if (state.activeId === id) {
    const nextIndex = Math.min(tabIndex, newArtifacts.length - 1);
    newActiveId = newArtifacts[nextIndex].id;
  }

  return {
    artifacts: newArtifacts,
    activeId: newActiveId,
    isOpen: true,
  };
}

export function selectTab(state: CanvasState, id: string): CanvasState {
  const exists = state.artifacts.some((a) => a.id === id);
  if (!exists) return state;
  return {
    ...state,
    activeId: id,
    isOpen: true,
  };
}

export function setViewMode(
  state: CanvasState,
  id: string,
  mode: "code" | "preview" | "diff"
): CanvasState {
  return {
    ...state,
    artifacts: state.artifacts.map((a) => (a.id === id ? { ...a, viewMode: mode } : a)),
  };
}

export function closeCanvas(state: CanvasState): CanvasState {
  return {
    ...state,
    isOpen: false,
  };
}

export function generateLineNumbers(text: string): string {
  if (!text) return "1";
  const count = text.split(/\r?\n/).length;
  const lines: string[] = [];
  for (let i = 1; i <= count; i++) {
    lines.push(String(i));
  }
  return lines.join("\n");
}
