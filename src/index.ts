import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createMicRecorder } from "./audio/mic.js";
import { loadConfig, saveConfig, getConfigPath } from "./config.js";
import { GemmaAudioTranscriber } from "./gemma-audio.js";
import type { MicRecorder, VoiceConfig } from "./types.js";

export default function piVoiceGemma(pi: ExtensionAPI) {
  let config: VoiceConfig = loadConfig();
  let mic: MicRecorder | null = null;
  let transcriber: GemmaAudioTranscriber | null = null;
  let currentCtx: any = null;

  let listening = false;
  let speechActive = false;
  let continuous = false;
  let transitioning = false;
  let lastLevel = 0;

  function notify(message: string, type: "info" | "success" | "warning" | "error" = "info"): void {
    currentCtx?.ui?.notify?.(message, type);
  }

  function normalizeVoiceMessage(text: string): string {
    return text.trim().replace(/^pi[,.!?:;\s-]+/i, "").trim();
  }

  function sendVoiceMessage(text: string): void {
    const cleaned = normalizeVoiceMessage(text);
    if (!cleaned) return;
    currentCtx?.ui?.setEditorText?.("");
    if (currentCtx?.isIdle?.()) {
      pi.sendUserMessage(cleaned);
    } else {
      pi.sendUserMessage(cleaned, { deliverAs: "followUp" });
    }
  }

  async function ensureTranscriber(): Promise<GemmaAudioTranscriber> {
    if (!transcriber) {
      transcriber = new GemmaAudioTranscriber(config);
      await transcriber.initialize();
    }
    return transcriber;
  }

  async function ensureMic(): Promise<MicRecorder> {
    if (!mic) {
      mic = createMicRecorder(
        { sampleRate: 16000, channels: 1, bitDepth: 16, device: config.micDevice },
        config.vadSilenceMs,
      );

      mic.onData((chunk) => {
        lastLevel = mic?.getLevel() ?? 0;
        if (!speechActive) return;
        try {
          transcriber?.addAudio(chunk);
        } catch (err) {
          notify(err instanceof Error ? err.message : String(err), "error");
          void stopListening(false);
        }
      });

      mic.onSpeechStart((paddingChunk) => {
        speechActive = true;
        transcriber?.start();
        if (paddingChunk && paddingChunk.length > 0) {
          try {
            transcriber?.addAudio(paddingChunk);
          } catch (err) {
            notify(err instanceof Error ? err.message : String(err), "error");
          }
        }
      });

      mic.onSilence(() => {
        if (listening && speechActive) {
          void stopListening(true);
        }
      });

      mic.onError((err) => {
        notify(`Mic error: ${err.message}`, "error");
        listening = false;
        speechActive = false;
        transcriber?.clear();
      });
    }
    return mic;
  }

  async function startListening(): Promise<void> {
    if (listening || transitioning) return;
    transitioning = true;
    try {
      await ensureTranscriber();
      const m = await ensureMic();
      speechActive = false;
      listening = true;
      await m.start();
    } catch (err) {
      listening = false;
      notify(`Failed to start VAD: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      transitioning = false;
    }
  }

  async function stopListening(transcribe: boolean): Promise<void> {
    if (!listening || transitioning) return;
    transitioning = true;
    const hadSpeech = speechActive;
    listening = false;
    speechActive = false;

    try {
      await mic?.stop();
      if (transcribe && hadSpeech) {
        notify("🎙️ Transcribing utterance with Gemma...", "info");
        const transcript = await transcriber?.transcribe();
        if (transcript?.trim()) sendVoiceMessage(transcript);
      } else {
        transcriber?.clear();
      }
    } catch (err) {
      notify(`VAD/Gemma error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      transitioning = false;
      if (continuous && currentCtx?.hasUI) {
        setTimeout(() => {
          if (continuous && !listening && !transitioning) void startListening();
        }, 250);
      }
    }
  }

  function statusText(): string {
    return [
      "🎙️ pi-voice-gemma status",
      `Mic: ${listening ? "🟢 listening" : "⚪ off"}`,
      `Speech: ${speechActive ? "🟢 active" : "⚪ waiting"}`,
      `Continuous: ${continuous ? "🟢 on" : "⚪ off"}`,
      `Level: ${lastLevel.toFixed(2)}`,
      `Silence: ${config.vadSilenceMs}ms`,
      `Device: ${config.micDevice ?? "default"}`,
      `Endpoint: ${config.endpoint}`,
      `Model: ${config.model}`,
      `Utterance: ${config.utterancePath}`,
      `Config: ${getConfigPath()}`,
    ].join("\n");
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    notify("🎙️ pi-voice-gemma ready. Use /vad start, /vad test, /vad stop, /vad status.", "info");
  });

  pi.registerCommand("vad", {
    description: "Silero/Gemma voice input — /vad [start|stop|test|status|config]",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcommand = (parts[0] || "start").toLowerCase();

      switch (subcommand) {
        case "start":
        case "on":
          continuous = true;
          await startListening();
          notify("🎙️ VAD started. Say: 'pi check the server logs'.", "success");
          break;

        case "test":
          continuous = false;
          await startListening();
          notify("🎙️ VAD test armed for one utterance.", "info");
          break;

        case "stop":
        case "off":
          continuous = false;
          await stopListening(false);
          notify("🎙️ VAD stopped.", "info");
          break;

        case "status":
          notify(statusText(), "info");
          break;

        case "config":
          saveConfig(config);
          notify(`Wrote config to ${getConfigPath()}`, "success");
          break;

        default:
          notify("Usage: /vad [start|stop|test|status|config]", "info");
          break;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    continuous = false;
    if (listening) await mic?.stop();
    mic?.dispose();
    transcriber?.clear();
  });
}
