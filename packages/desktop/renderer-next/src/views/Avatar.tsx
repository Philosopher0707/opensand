// Avatar component: renders an agent's inline logo SVG, or a default
// geometric avatar derived from the agent's initial + logoColor.
// SVG is rendered inline so logoColor tinting applies to accent paths.
import type { AgentRecord } from "@opensand/shared";

interface AvatarProps {
  agent: AgentRecord | null;
  size?: number;
  className?: string;
}

const DEFAULT_AVATAR_SVG = (letter: string, color: string) => `
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">
  <rect width="24" height="24" rx="6" fill="${color}" />
  <text x="12" y="16" font-family="system-ui, sans-serif" font-size="11" font-weight="600" fill="#ffffff" text-anchor="middle" dominant-baseline="middle">${letter}</text>
</svg>
`.trim();

export function Avatar({ agent, size = 32, className }: AvatarProps) {
  const color = agent?.logoColor ?? "#6366f1";
  const letter = agent?.name?.[0]?.toUpperCase() ?? "?";

  if (agent?.logoSvg) {
    return (
      <span class={`avatar ${className ?? ""}`} style={{ width: size, height: size }} aria-label={agent.name}>
        <span
          class="avatar-svg"
          dangerouslySetInnerHTML={{ __html: agent.logoSvg }}
          style={{ width: "100%", height: "100%", display: "block" }}
        />
      </span>
    );
  }

  return (
    <span class={`avatar avatar-default ${className ?? ""}`} style={{ width: size, height: size, backgroundColor: color }} aria-label={agent.name}>
      {DEFAULT_AVATAR_SVG(letter, color)}
    </span>
  );
}
