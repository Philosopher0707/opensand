// Pure model for the Community Agent Store & Template Gallery (Phase 5 Row 20).
// Mirrors the legacy renderer/app.js gallery controller without DOM or bridge code.

export interface GalleryTemplate {
  id: string;
  name?: string;
  role?: string;
  category?: string;
  description?: string;
  tags?: string[];
  rating?: number;
  downloads?: number;
  author?: string;
  isCurated?: boolean;
  installed?: boolean;
  model?: string;
  systemPrompt?: string;
  allowedTools?: string[];
  suggestedTasks?: string[];
  metadata?: {
    category?: string;
    description?: string;
    author?: string;
    version?: string;
    rating?: number;
    downloads?: number;
    installed?: boolean;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface GalleryCardView {
  id: string;
  icon: string;
  title: string;
  role: string;
  description: string;
  tags: string[];
  rating: string;
  downloads: string;
  author: string;
  badge: string;
  badgeClass: string;
  installed: boolean;
}

export interface PreviewView {
  icon: string;
  title: string;
  role: string;
  description: string;
  badges: string[];
  tools: string[];
  tasks: string[];
  prompt: string;
  installed: boolean;
}

export const GALLERY_EMPTY_STATE = "No agent templates found matching criteria. Try adjusting filters or search terms.";
export const GALLERY_LOADING = "Loading community templates…";
export const PUBLISH_VALIDATION_MESSAGE = "Please select an agent persona to publish.";
export const PUBLISH_DEFAULT_AUTHOR = "Local User";
export const PUBLISH_FALLBACK_AUTHOR = "Community Contributor";

export const GALLERY_CATEGORIES = ["all", "engineering", "security", "product", "research", "community"] as const;

export function categoryEmoji(category?: string): string {
  switch (category) {
    case "engineering": return "🛠️";
    case "security": return "🛡️";
    case "product": return "📐";
    case "research": return "🔬";
    case "community": return "🌐";
    default: return "🤖";
  }
}

export function galleryCardView(template: GalleryTemplate): GalleryCardView {
  const meta = template.metadata || {};
  const category = meta.category || template.category || "";
  return {
    id: template.id,
    icon: categoryEmoji(category),
    title: template.name?.trim() || template.id,
    role: template.role?.trim() || category || "General",
    description: template.description?.trim() || meta.description?.trim() || "",
    tags: Array.isArray(template.tags) ? template.tags.slice(0, 4) : [],
    rating: (template.rating ?? meta.rating ?? 5.0).toFixed(1),
    downloads: (template.downloads ?? meta.downloads ?? 0).toLocaleString(),
    author: template.author?.trim() || meta.author?.trim() || "Official",
    badge: template.isCurated ? "Official" : "Community",
    badgeClass: template.isCurated ? "badge-success" : "",
    installed: Boolean(template.installed ?? meta.installed),
  };
}

export function previewView(template: GalleryTemplate): PreviewView {
  const meta = template.metadata || {};
  const badges = [
    meta.category || template.category || "General",
    `Model: ${template.model || "default"}`,
    `Author: ${meta.author || template.author || "Official"}`,
    `v${meta.version || "1.0.0"}`,
    `⭐ ${(meta.rating ?? template.rating ?? 5.0).toFixed(1)}`,
    `📥 ${(meta.downloads ?? template.downloads ?? 0).toLocaleString()} DLs`,
  ];
  return {
    icon: categoryEmoji(meta.category || template.category),
    title: template.name?.trim() || template.id,
    role: template.role?.trim() || meta.category || template.category || "General",
    description: meta.description?.trim() || template.description?.trim() || "",
    badges,
    tools: Array.isArray(template.allowedTools) ? template.allowedTools : [],
    tasks: Array.isArray(template.suggestedTasks) ? template.suggestedTasks : [],
    prompt: template.systemPrompt || "",
    installed: Boolean(meta.installed ?? template.installed),
  };
}

export function parseTags(raw: string): string[] {
  return raw.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean);
}

/** Matches the legacy slug construction from an agent name. */
export function templateSlug(name: string, id: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || id;
}

export function publishDescription(role: string, systemPrompt: string): string {
  return `${role}: ${systemPrompt.slice(0, 160)}...`;
}
