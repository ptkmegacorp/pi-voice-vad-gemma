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
  let manualRecording = false;
  let transitioning = false;
  let lastLevel = 0;
  let manualTimer: ReturnType<typeof setTimeout> | null = null;
  const manualMaxMs = Number(process.env.PI_VOICE_MANUAL_MAX_MS ?? "120000");

  function notify(message: string, type: "info" | "success" | "warning" | "error" = "info"): void {
    currentCtx?.ui?.notify?.(message, type);
  }

  function normalizeVoiceMessage(text: string): string {
    return text.trim().replace(/^pi[,.!?:;\s-]+/i, "").trim();
  }

  function sendVoiceMessage(text: string): void {
    const cleaned = normalizeVoiceMessage(text);
    if (!cleaned) return;

    // Voice owns audio → text only. pig-classifier-intent-router sits in Pig's
    // input layer and transforms this message if it matches a deterministic affordance.
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
        if (!manualRecording && !speechActive) return;
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
        if (!manualRecording && listening && speechActive) {
          void stopListening(true);
        }
      });

      mic.onError((err) => {
        notify(`Mic error: ${err.message}`, "error");
        clearManualTimer();
        listening = false;
        speechActive = false;
        manualRecording = false;
        transcriber?.clear();
      });
    }
    return mic;
  }

  async function startListening(): Promise<void> {
    if (manualRecording || listening || transitioning) return;
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
    if (manualRecording) {
      await stopManualRecording(transcribe);
      return;
    }
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

  function clearManualTimer(): void {
    if (manualTimer) {
      clearTimeout(manualTimer);
      manualTimer = null;
    }
  }

  async function startManualRecording(): Promise<void> {
    if (transitioning) return;
    if (manualRecording) {
      await stopManualRecording(true);
      return;
    }
    transitioning = true;
    try {
      continuous = false;
      if (listening) {
        listening = false;
        speechActive = false;
        await mic?.stop();
        transcriber?.clear();
      }
      await ensureTranscriber();
      const m = await ensureMic();
      transcriber?.start();
      speechActive = false;
      manualRecording = true;
      listening = true;
      await m.start();
      manualTimer = setTimeout(() => {
        notify("🎙️ Ctrl+Space max recording time reached; transcribing now...", "warning");
        void stopManualRecording(true);
      }, manualMaxMs);
      notify("🎙️ Recording. Press Ctrl+Space again to transcribe and send.", "success");
    } catch (err) {
      clearManualTimer();
      listening = false;
      manualRecording = false;
      notify(`Failed to start recording: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      transitioning = false;
    }
  }

  async function stopManualRecording(transcribe: boolean): Promise<void> {
    if (!manualRecording || transitioning) return;
    transitioning = true;
    clearManualTimer();
    manualRecording = false;
    listening = false;
    speechActive = false;
    try {
      await mic?.stop();
      if (transcribe) {
        notify("🎙️ Transcribing Ctrl+Space recording with Gemma...", "info");
        const transcript = await transcriber?.transcribe();
        if (transcript?.trim()) sendVoiceMessage(transcript);
        else notify("🎙️ No transcript produced.", "warning");
      } else {
        transcriber?.clear();
      }
    } catch (err) {
      notify(`Ctrl+Space recording error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      transitioning = false;
    }
  }

  async function toggleManualRecording(): Promise<void> {
    if (transitioning) return;
    if (manualRecording) await stopManualRecording(true);
    else await startManualRecording();
  }

  function statusText(): string {
    return [
      "🎙️ pi-voice-vad-gemma status",
      `Mic: ${listening ? "🟢 listening" : "⚪ off"}`,
      `Manual Ctrl+Space: ${manualRecording ? "🟢 recording" : "⚪ off"}`,
      `Speech: ${speechActive ? "🟢 active" : "⚪ waiting"}`,
      `Continuous: ${continuous ? "🟢 on" : "⚪ off"}`,
      `Level: ${lastLevel.toFixed(2)}`,
      `Silence: ${config.vadSilenceMs}ms`,
      `Ctrl+Space max: ${Math.round(manualMaxMs / 1000)}s`,
      `Device: ${config.micDevice ?? "default"}`,
      `Endpoint: ${config.endpoint}`,
      `Model: ${config.model}`,
      `Utterance: ${config.utterancePath}`,
      `Routing: handled by pig-classifier-intent-router input extension`,
      `Config: ${getConfigPath()}`,
    ].join("\n");
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    notify("🎙️ pi-voice-vad-gemma ready. Ctrl+Space toggles recording. Use /vad start, /vad test, /vad stop, /vad status.", "info");
  });

  (pi as any).registerShortcut("ctrl+space", {
    description: "Toggle Gemma voice recording: start, then transcribe/send on second press",
    handler: async (ctx: any) => {
      currentCtx = ctx;
      await toggleManualRecording();
    },
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
          notify("Usage: /vad [start|stop|test|status|config]. Ctrl+Space toggles manual recording. Use /intent-route <text> for router diagnostics.", "info");
          break;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    continuous = false;
    clearManualTimer();
    if (listening) await mic?.stop();
    mic?.dispose();
    transcriber?.clear();
  });
}
