import { appendFileSync, readFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createMicRecorder } from "./audio/mic.js";
import { loadConfig, saveConfig, getConfigPath } from "./config.js";
import { PiperSherpaTts } from "./piper-sherpa-tts.js";
import { extractAssistantSpeechText } from "./text-for-speech.js";
import { WhisperCpuTranscriber } from "./whisper-cpu.js";
import { SherpaMoonshineTranscriber } from "./sherpa-moonshine.js";
import type { MicRecorder, VoiceConfig } from "./types.js";

export default function piVoiceGemma(pi: ExtensionAPI) {
  let config: VoiceConfig = loadConfig();
  let mic: MicRecorder | null = null;
  let transcriber: SherpaMoonshineTranscriber | WhisperCpuTranscriber | null = null;
  let tts: PiperSherpaTts | null = null;
  let currentCtx: any = null;

  let listening = false;
  let speechActive = false;
  let continuous = false;
  let manualRecording = false;
  let transitioning = false;
  let ttsBusy = false;
  let lastLevel = 0;
  let manualTimer: ReturnType<typeof setTimeout> | null = null;
  let statusPollTimer: ReturnType<typeof setInterval> | null = null;
  const manualMaxMs = Number(process.env.PI_VOICE_MANUAL_MAX_MS ?? "120000");
  const manualTailMs = Number(process.env.PI_VOICE_MANUAL_TAIL_MS ?? "700");
  const voiceStatusScript = "/home/bot/voice-router-pipecat/voice_status.py";
  const voiceStatusFile = "/home/bot/.cache/pipecat-voice/status.json";

  function notify(message: string, type: "info" | "success" | "warning" | "error" = "info"): void {
    try {
      appendFileSync("/tmp/pig-voice-vad-gemma.log", `${new Date().toISOString()} [${type}] ${message}\n`);
    } catch {
      // Best-effort diagnostics only.
    }
    currentCtx?.ui?.notify?.(message, type);
  }

  function normalizeVoiceMessage(text: string): string {
    return text.trim().replace(/^pi[,.!?:;\s-]+/i, "").trim();
  }

  function setVoiceStatus(key: "enabled" | "hearing" | "mode", value: string): void {
    spawnSync(voiceStatusScript, [key, value], { stdio: "ignore" });
  }

  function getVoiceStatusEnabled(): boolean {
    try {
      const status = JSON.parse(readFileSync(voiceStatusFile, "utf8"));
      return !!status.enabled;
    } catch {
      return false;
    }
  }

  function openYoutubeSearch(query: string): void {
    const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query).replace(/%20/g, "+")}`;
    spawn("i3-msg", ["exec", `firefox --new-window ${url}`], { detached: true, stdio: "ignore" }).unref();
  }

  function scrollFocused(direction: "up" | "down"): void {
    const button = direction === "down" ? "5" : "4";
    spawn("xdotool", ["click", "--repeat", "5", button], { detached: true, stdio: "ignore" }).unref();
  }

  function listRoutedCommands(): string {
    return [
      "direct routed voice commands:",
      "scroll down / page down / go down",
      "scroll up / page up / go up",
      "make full screen / fullscreen",
      "exit fullscreen / leave fullscreen",
      "open youtube and search for ...",
      "list all routed commands",
      "anything else goes to Pig/main LLM",
    ].join("\n");
  }

  function handleDirectVoiceRoute(cleaned: string): boolean {
    const t = cleaned.toLowerCase().replace(/-/g, " ").replace(/\s+/g, " ").trim();

    if (["scroll down", "go down", "page down", "move down"].includes(t)) {
      scrollFocused("down");
      notify("🎙️ routed: scroll down", "info");
      return true;
    }

    if (["scroll up", "go up", "page up", "move up"].includes(t)) {
      scrollFocused("up");
      notify("🎙️ routed: scroll up", "info");
      return true;
    }

    if (["make full screen", "make fullscreen", "fullscreen", "full screen", "toggle full screen", "toggle fullscreen"].includes(t)) {
      spawn("i3-msg", ["fullscreen", "toggle"], { detached: true, stdio: "ignore" }).unref();
      notify("🎙️ routed: fullscreen toggle", "info");
      return true;
    }

    if (["exit fullscreen", "exit full screen", "leave fullscreen", "leave full screen", "disable fullscreen", "disable full screen"].includes(t)) {
      spawn("i3-msg", ["fullscreen", "disable"], { detached: true, stdio: "ignore" }).unref();
      notify("🎙️ routed: exit fullscreen", "info");
      return true;
    }

    if (["list all routed commands", "list routed commands", "what commands can i say", "show routed commands", "show voice commands"].includes(t)) {
      notify(listRoutedCommands(), "info");
      return true;
    }

    const youtubePrefix = "open youtube and search for ";
    if (t.startsWith(youtubePrefix)) {
      const query = cleaned.slice(youtubePrefix.length).trim();
      if (query) {
        openYoutubeSearch(query);
        notify(`🎙️ routed: YouTube search for ${query}`, "info");
        return true;
      }
    }

    return false;
  }

  function sendVoiceMessage(text: string): void {
    const cleaned = normalizeVoiceMessage(text);
    if (!cleaned) return;

    setVoiceStatus("mode", "thinking");
    if (handleDirectVoiceRoute(cleaned)) {
      setVoiceStatus("mode", "idle");
      return;
    }

    currentCtx?.ui?.setEditorText?.("");
    if (currentCtx?.isIdle?.()) {
      pi.sendUserMessage(cleaned);
    } else {
      pi.sendUserMessage(cleaned, { deliverAs: "followUp" });
    }
  }

  async function ensureTranscriber(): Promise<SherpaMoonshineTranscriber | WhisperCpuTranscriber> {
    if (!transcriber) {
      transcriber = config.sttBackend === "sherpa-moonshine"
        ? new SherpaMoonshineTranscriber(config)
        : new WhisperCpuTranscriber(config);
      await transcriber.initialize();
    }
    return transcriber;
  }

  async function ensureTts(): Promise<PiperSherpaTts> {
    if (!tts) {
      tts = new PiperSherpaTts(config);
      await tts.initialize();
    }
    return tts;
  }

  function stopTtsPlayback(): void {
    tts?.stop();
    ttsBusy = false;
  }

  async function speakAssistantText(text: string): Promise<void> {
    if (!config.ttsEnabled || !text.trim() || ttsBusy) return;

    ttsBusy = true;
    try {
      const speaker = await ensureTts();
      setVoiceStatus("mode", "speaking");
      notify("🔊 Speaking response...", "info");
      await speaker.speak(text);
    } catch (err) {
      notify(`TTS error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      ttsBusy = false;
      setVoiceStatus("mode", continuous ? "idle" : "off");
    }
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
        stopTtsPlayback();
        setVoiceStatus("hearing", "on");
        setVoiceStatus("mode", "listening");
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
        setVoiceStatus("hearing", "off");
        if (!manualRecording && listening && speechActive) {
          void stopListening(true);
        }
      });

      mic.onError((err) => {
        notify(`Mic error: ${err.message}`, "error");
        setVoiceStatus("mode", "error");
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
      setVoiceStatus("enabled", "on");
      setVoiceStatus("mode", "idle");
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
    setVoiceStatus("hearing", "off");

    try {
      await mic?.stop();
      if (transcribe && hadSpeech) {
        setVoiceStatus("mode", "thinking");
        notify(`🎙️ Transcribing utterance with ${config.sttBackend}...`, "info");
        const transcript = await transcriber?.transcribe();
        if (transcript?.trim()) sendVoiceMessage(transcript);
      } else {
        transcriber?.clear();
      }
    } catch (err) {
      notify(`VAD/Gemma error: ${err instanceof Error ? err.message : String(err)}`, "error");
    } finally {
      transitioning = false;
      if (!continuous) setVoiceStatus("mode", "idle");
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
    stopTtsPlayback();
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
      setVoiceStatus("enabled", "on");
      setVoiceStatus("mode", "listening");
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
    setVoiceStatus("hearing", "off");
    setVoiceStatus("mode", "thinking");
    try {
      if (transcribe && manualTailMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, manualTailMs));
      }
      await mic?.stop();
      if (transcribe) {
        setVoiceStatus("mode", "thinking");
        notify(`🎙️ Transcribing Ctrl+Space recording with ${config.sttBackend}...`, "info");
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
      `TTS: ${config.ttsEnabled ? "🟢 on" : "⚪ off"} (${config.ttsBackend}${ttsBusy || tts?.isSpeaking ? ", speaking" : ""})`,
      `Level: ${lastLevel.toFixed(2)}`,
      `Silence: ${config.vadSilenceMs}ms`,
      `Ctrl+Space max: ${Math.round(manualMaxMs / 1000)}s`,
      `Device: ${config.micDevice ?? "default"}`,
      `STT: ${config.sttBackend}`,
      `Moonshine model dir: ${config.sherpaMoonshineModelDir}`,
      `Sherpa threads: ${config.sherpaThreads}`,
      `Whisper binary: ${config.whisperBinary}`,
      `Whisper model: ${config.whisperModel}`,
      `TTS binary: ${config.ttsBinary}`,
      `TTS model: ${config.ttsModel}`,
      `Playback: ${config.playbackBinary}${config.playbackDevice ? ` (${config.playbackDevice})` : ""}`,
      `Utterance: ${config.utterancePath}`,
      `Routing: normal Pig input pipeline`,
      `Config: ${getConfigPath()}`,
    ].join("\n");
  }

  pi.on("session_start", async (_event, ctx) => {
    currentCtx = ctx;
    notify("🎙️ Pig voice ready. Ctrl+Space toggles recording. Use /vad and /tts commands. Rofi Pipecat toggle controls continuous VAD.", "info");

    statusPollTimer = setInterval(() => {
      const shouldBeEnabled = getVoiceStatusEnabled();
      if (shouldBeEnabled && !continuous && !manualRecording) {
        continuous = true;
        void startListening();
      } else if (!shouldBeEnabled && continuous) {
        continuous = false;
        void stopListening(false);
      }
    }, 1000);
  });

  pi.on("turn_end", async (event) => {
    if (!config.ttsEnabled || event.message.role !== "assistant") return;
    if (event.message.stopReason === "error" || event.message.stopReason === "aborted") return;

    const speechText = extractAssistantSpeechText(event.message.content, config.ttsMaxChars);
    if (!speechText) return;

    await speakAssistantText(speechText);
  });

  (pi as any).registerShortcut("ctrl+space", {
    description: "Toggle Gemma voice recording: start, then transcribe/send on second press",
    handler: async (ctx: any) => {
      currentCtx = ctx;
      await toggleManualRecording();
    },
  });

  pi.registerCommand("tts", {
    description: "Local Piper TTS via sherpa-onnx — /tts [on|off|test|stop|status]",
    handler: async (args, ctx) => {
      currentCtx = ctx;
      const parts = (args ?? "").trim().split(/\s+/).filter(Boolean);
      const subcommand = (parts[0] || "status").toLowerCase();
      const testText = parts.slice(1).join(" ").trim();

      switch (subcommand) {
        case "on":
        case "enable":
          config.ttsEnabled = true;
          notify("🔊 TTS enabled.", "success");
          break;

        case "off":
        case "disable":
          config.ttsEnabled = false;
          stopTtsPlayback();
          notify("🔊 TTS disabled.", "info");
          break;

        case "test": {
          const text = testText || "Hello from Pig. Piper text to speech is working.";
          await speakAssistantText(text);
          break;
        }

        case "stop":
          stopTtsPlayback();
          notify("🔊 TTS playback stopped.", "info");
          break;

        case "status":
          notify(statusText(), "info");
          break;

        default:
          notify("Usage: /tts [on|off|test [text]|stop|status]", "info");
          break;
      }
    },
  });

  pi.registerCommand("vad", {
    description: "Silero voice input with Whisper/Gemma STT — /vad [start|stop|test|status|config]",
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
          notify("Usage: /vad [start|stop|test|status|config]. Ctrl+Space toggles manual recording.", "info");
          break;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    continuous = false;
    if (statusPollTimer) {
      clearInterval(statusPollTimer);
      statusPollTimer = null;
    }
    clearManualTimer();
    stopTtsPlayback();
    setVoiceStatus("enabled", "off");
    if (listening) await mic?.stop();
    mic?.dispose();
    transcriber?.clear();
  });
}
