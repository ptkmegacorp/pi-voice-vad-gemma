import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import type { VoiceConfig } from "./types.js";

export const DEFAULT_CONFIG: VoiceConfig = {
  endpoint: "http://127.0.0.1:8090/v1/chat/completions",
  model: "gemma-4-e2b-audio-local",
  apiKey: "llama-server",
  ffmpegBinary: "ffmpeg",
  utterancePath: "/tmp/pi-voice/utterance.wav",
  timeoutMs: 120000,
  maxTokens: 256,
  prompt: "Transcribe this speech. Output only the text.",
  micDevice: "plughw:CARD=Device,DEV=0",
  vadSilenceMs: 800,
};

export function getConfigPath(): string {
  return join(homedir(), ".pi", "voice-gemma.json");
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
