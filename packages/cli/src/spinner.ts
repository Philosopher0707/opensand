/**
 * Minimal TTY spinner — paints a single status line in place.
 * Silent when stdout is not a TTY (piped output), so tool call/result
 * lines are not interleaved with phase labels.
 */

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

export type SpinnerPhase = "thinking" | "tool";

interface ActiveSpinner {
  label: string;
  frameIdx: number;
  timer: NodeJS.Timeout;
  startedAt: number;
}

export class TerminalSpinner {
  private active: ActiveSpinner | null = null;

  /** Whether live in-place animation is available. */
  get animated(): boolean {
    return Boolean(process.stdout.isTTY);
  }

  start(label: string, phase: SpinnerPhase = "thinking"): void {
    this.onPhaseChange(label, phase);
  }

  onPhaseChange(label: string, phase: SpinnerPhase = "thinking"): void {
    void phase;
    // In non-TTY mode, stay silent: printing "Thinking"/"Running tool"
    // lines here would interleave junk between tool call/result lines.
    if (!this.animated) {
      this.active = null;
      return;
    }
    this.stopLineOnly();
    const startedAt = Date.now();
    const spinner: ActiveSpinner = {
      label,
      frameIdx: 0,
      startedAt,
      timer: setInterval(() => {
        spinner.frameIdx = (spinner.frameIdx + 1) % FRAMES.length;
        this.paint(spinner);
      }, 80),
    };
    this.active = spinner;
    this.paint(spinner);
  }

  /** Clear the current spinner line without printing anything. */
  clear(): void {
    this.stopLineOnly();
  }

  /** Clear the spinner and print a final line (e.g. tool result). */
  finish(line: string): void {
    this.stopLineOnly();
    if (line) console.log(line);
  }

  private paint(spinner: ActiveSpinner): void {
    const elapsed = ((Date.now() - spinner.startedAt) / 1000).toFixed(0);
    process.stdout.write(`\r${FRAMES[spinner.frameIdx]} ${DIM}${spinner.label} (${elapsed}s)…${RESET}\x1b[K`);
  }

  private stopLineOnly(): void {
    if (this.active) {
      clearInterval(this.active.timer);
      this.active = null;
      if (this.animated) process.stdout.write("\r\x1b[K");
    }
  }
}
