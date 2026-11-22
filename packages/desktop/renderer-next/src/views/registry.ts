import type { ComponentType } from "preact";
import type { ShellData } from "../data";
import type { ViewId } from "../../../src/shell/navigation-model";
import { RoomsView } from "./RoomsView";
import { RoutinesView } from "./RoutinesView";
import { SkillsView } from "./SkillsView";
import { VaultView } from "./VaultView";

export interface ViewProps {
  data: ShellData;
  active: boolean;
  onSelect: (view: ViewId) => void;
  refreshKey?: number;
}

export const VIEW_COMPONENTS: Partial<Record<ViewId, ComponentType<ViewProps>>> = {
  rooms: RoomsView,
  routines: RoutinesView,
  skills: SkillsView,
  vault: VaultView,
};
