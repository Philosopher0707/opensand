// packages/desktop/src/shell/dictation-model.ts
// Pure model for renderer-next composer voice dictation (Phase 5, Row 7).
// Uses the same Web Speech API path as the legacy composer; no backend or IPC.

export type DictationState = "idle" | "listening";

export interface DictationResultEvent {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}

export interface SpeechRecognitionLike {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  start(): void;
  stop(): void;
  abort(): void;
  onstart: (() => void) | null;
  onresult: ((event: DictationResultEvent) => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
  onend: (() => void) | null;
}

export interface DictationEvents {
  getBaseText(): string;
  onText(text: string): void;
  onState(state: DictationState): void;
  onNotice(message: string): void;
}

export interface DictationController {
  start(): void;
  stop(): void;
  cancel(): void;
}

export const DICTATION_LABELS: Record<DictationState, string> = {
  idle: "Dictate",
  listening: "Listening...",
};

// Fixed messages only: a recognition error's raw text is never rendered.
const NOTICES = {
  denied: "Microphone access was denied. Allow microphone access in your browser settings, then try again.",
  noSpeech: "No speech was heard. Try again.",
  network: "Voice dictation could not reach the speech service. Try again.",
  unavailable: "Voice dictation is not supported in this browser environment.",
  failed: "Voice dictation could not start. Try again.",
};

export function dictationNotice(error?: string): string {
  switch (error) {
    case "not-allowed":
    case "service-not-allowed":
    case "permission-denied":
      return NOTICES.denied;
    case "no-speech":
      return NOTICES.noSpeech;
    case "network":
      return NOTICES.network;
    default:
      return NOTICES.failed;
  }
}

/** Returns null for empty speech so the composer is not touched at all. */
export function dictationText(base: string, final: string, interim: string): string | null {
  const spoken = `${final}${interim}`;
  if (!spoken.trim()) return null;
  const separator = base && !base.endsWith(" ") ? " " : "";
  return base + separator + spoken;
}

export function createDictationController(
  recognition: SpeechRecognitionLike | null,
  events: DictationEvents,
): DictationController {
  let state: DictationState = "idle";
  let base = "";

  const reset = () => {
    if (state === "idle") return;
    state = "idle";
    events.onState("idle");
  };

  if (recognition) {
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";

    recognition.onstart = () => {
      base = events.getBaseText();
      state = "listening";
      events.onState("listening");
      events.onNotice("");
    };

    recognition.onresult = (event) => {
      let final = "";
      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result?.[0]?.transcript || "";
        if (result.isFinal) final += transcript;
        else interim += transcript;
      }
      const text = dictationText(base, final, interim);
      if (text !== null) events.onText(text);
    };

    recognition.onerror = (event) => {
      reset();
      events.onNotice(dictationNotice(event?.error));
    };

    recognition.onend = () => {
      reset();
    };
  }

  return {
    start() {
      if (!recognition) {
        events.onNotice(NOTICES.unavailable);
        return;
      }
      if (state === "listening") return;
      try {
        recognition.start();
      } catch {
        reset();
        events.onNotice(NOTICES.failed);
      }
    },
    stop() {
      if (state !== "listening") return;
      try { recognition!.stop(); } catch { /* a failed stop must not leave the button listening */ }
      reset();
    },
    cancel() {
      if (state !== "listening") return;
      try { recognition!.abort(); } catch { /* same as stop: reset state regardless */ }
      events.onText(base);
      reset();
    },
  };
}
