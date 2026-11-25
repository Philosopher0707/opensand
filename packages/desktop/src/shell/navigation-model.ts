// View registry and URL/deep-link rules for the shell's footer navigation.
// Mirrors the legacy `switchView` mapping in renderer/app.js (L743-873).

export type ViewId =
  | "chat"
  | "welcome"
  | "rooms"
  | "routines"
  | "skills"
  | "vault"
  | "memories"
  | "attachments"
  | "templates"
  | "gallery"
  | "sentinel"
  | "graphs"
  | "boundaries"
  | "webhooks"
  | "connectors"
  | "settings";

export const VIEW_IDS: readonly ViewId[] = [
  "chat",
  "welcome",
  "rooms",
  "routines",
  "skills",
  "vault",
  "memories",
  "attachments",
  "templates",
  "gallery",
  "sentinel",
  "graphs",
  "boundaries",
  "webhooks",
  "connectors",
  "settings",
];

export const VIEW_TITLES: Record<ViewId, string> = {
  chat: "Chat & Dialogue",
  welcome: "Welcome & Setup",
  rooms: "Multi-Agent Collaborative Rooms",
  routines: "Scheduled Background Routines",
  skills: "Modular Recipe Skills Library",
  vault: "Local Encrypted Secrets Vault",
  memories: "7-Layer Discrete Fact Memory",
  attachments: "Staged Context Attachments",
  templates: "Bots & Personas",
  gallery: "Community Agent Store & Template Gallery",
  sentinel: "Workspace Sentinel & Self-Healing",
  graphs: "Agent Graphs & Cyclical Loops",
  boundaries: "Fail-Closed Policy Boundaries",
  webhooks: "Inbound Proactive Webhooks",
  connectors: "3rd-Party App OAuth Connectors",
  settings: "Settings",
};

export type NavGroupId = "templates" | "capabilities" | "connections";

export interface SubnavTab {
  view: ViewId;
  label: string;
}

export interface NavGroup {
  id: NavGroupId;
  /** Footer button that opens this group. */
  buttonId: string;
  buttonLabel: string;
  /** View the footer button switches to. */
  view: ViewId;
  tabs: SubnavTab[];
}

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    id: "templates",
    buttonId: "navBtnBots",
    buttonLabel: "Bots",
    view: "templates",
    tabs: [
      { view: "templates", label: "Local Personas" },
      { view: "gallery", label: "Community Agent Store" },
    ],
  },
  {
    id: "capabilities",
    buttonId: "navBtnCapabilities",
    buttonLabel: "Capabilities",
    view: "skills",
    tabs: [
      { view: "skills", label: "Recipe Skills" },
      { view: "memories", label: "7-Layer Memory" },
      { view: "routines", label: "Scheduled Routines" },
      { view: "vault", label: "Encrypted Vault" },
    ],
  },
  {
    id: "connections",
    buttonId: "navBtnConnections",
    buttonLabel: "Connections",
    view: "boundaries",
    tabs: [
      { view: "boundaries", label: "Fail-Closed Boundaries" },
      { view: "webhooks", label: "Inbound Webhooks" },
      { view: "connectors", label: "3rd-Party Connectors" },
      { view: "attachments", label: "Context Files" },
      { view: "graphs", label: "Agent Graphs" },
      { view: "rooms", label: "Team Rooms" },
    ],
  },
];

const GROUP_BY_VIEW = new Map<ViewId, NavGroup>();
for (const group of NAV_GROUPS) {
  for (const tab of group.tabs) GROUP_BY_VIEW.set(tab.view, group);
}

export function isViewId(value: string | null | undefined): value is ViewId {
  return Boolean(value) && (VIEW_IDS as readonly string[]).includes(value as string);
}

/** Group that owns a view, or null for chat (which has no subnav). */
export function groupForView(view: ViewId): NavGroup | null {
  return GROUP_BY_VIEW.get(view) ?? null;
}

/** True when the footer button for `group` should render active for `view`. */
export function isFooterNavActive(view: ViewId, group: NavGroupId): boolean {
  return groupForView(view)?.id === group;
}

/** DOM id of a view's panel container, e.g. `graphs` -> `viewGraphs`. */
export function viewPanelId(view: ViewId): string {
  return `view${view.charAt(0).toUpperCase()}${view.slice(1)}`;
}

/**
 * View requested by the URL: the hash wins (`#graphs`), then `?view=sentinel`,
 * then the first-run `/welcome` path, then chat. An explicit hash/query always
 * wins over the path, so leaving onboarding by switching views cannot bounce back.
 */
export function parseViewFromLocation(search: string, hash: string, pathname = ""): ViewId {
  const fromHash = (hash || "").replace(/^#/, "").trim();
  if (isViewId(fromHash)) return fromHash;
  const fromQuery = new URLSearchParams(search || "").get("view");
  if (isViewId(fromQuery)) return fromQuery;
  if ((pathname || "").replace(/\/+$/, "").endsWith("/welcome")) return "welcome";
  return "chat";
}

/** Hash to write when a view is chosen, so reloads and history land on it. */
export function viewHash(view: ViewId): string {
  return `#${view}`;
}
