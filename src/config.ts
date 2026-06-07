import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { VoiceConfig } from "./types.js";

export const DEFAULT_CONFIG: VoiceConfig = {
  // Pig voice now follows the Pi voice direction: local sherpa-onnx Moonshine STT,
  // then send transcribed text into the normal Pig pipeline. No Gemma E2B audio server.
  endpoint: "",
  model: "",
  apiKey: "",
  ffmpegBinary: "ffmpeg",
  utterancePath: "/tmp/pi-voice/utterance.wav",
  timeoutMs: 120000,
  maxTokens: 256,
  prompt: "Transcribe this speech. Output only the text.",
  // Current USB mic is exposed as ALSA card 2, device 0.
  // Use ALSA plughw so ALSA can resample its native stream to 16 kHz for Silero/Whisper.
  micDevice: "plughw:2,0",
  vadSilenceMs: 800,
  sttBackend: "sherpa-moonshine",
  sherpaMoonshineModelDir: "/home/bot/.pi/models/moonshine-tiny",
  sherpaThreads: 4,
  whisperBinary: "/home/bot/whisper.cpp/build/bin/whisper-cli",
  whisperModel: "/home/bot/whisper.cpp/models/ggml-base.en.bin",
  whisperThreads: 4,
  whisperLanguage: "en",
  ttsEnabled: false,
  ttsBackend: "sherpa-onnx-piper",
  ttsBinary: "/home/bot/sherpa-onnx/sherpa-onnx-v1.13.2-linux-x64-static/bin/sherpa-onnx-offline-tts",
  ttsModel: "/home/bot/models/sherpa-tts/vits-piper-en_US-lessac-high-int8/en_US-lessac-high.onnx",
  ttsTokens: "/home/bot/models/sherpa-tts/vits-piper-en_US-lessac-high-int8/tokens.txt",
  ttsDataDir: "/home/bot/models/sherpa-tts/vits-piper-en_US-lessac-high-int8/espeak-ng-data",
  ttsThreads: 4,
  ttsLengthScale: 1,
  ttsMaxChars: 2000,
  ttsOutputPath: "/tmp/pi-voice/response.wav",
  playbackBinary: "aplay",
  // Intel PCH analog output on Neptune; override if default ALSA playback fails.
  playbackDevice: "plughw:1,0",
};

export function getConfigPath(): string {
  if (process.env.PI_VOICE_GEMMA_CONFIG) return process.env.PI_VOICE_GEMMA_CONFIG;
  if (process.env.PIG_CODING_AGENT_DIR) return join(dirname(process.env.PIG_CODING_AGENT_DIR), "voice-gemma.json");
  if (process.env.PI_CODING_AGENT_DIR) return join(dirname(process.env.PI_CODING_AGENT_DIR), "voice-gemma.json");
  return join(homedir(), ".pig", "voice-gemma.json");
}

export function loadConfig(): VoiceConfig {
  const path = getConfigPath();
  if (!existsSync(path)) return { ...DEFAULT_CONFIG };

  try {
    const file = JSON.parse(readFileSync(path, "utf-8")) as Partial<VoiceConfig>;
    return { ...DEFAULT_CONFIG, ...file };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(config: VoiceConfig): void {
  const path = getConfigPath();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2), { encoding: "utf-8", mode: 0o600 });
}
