import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VoiceConfig } from "./types.js";
import { writeWavHeader } from "./wav.js";

export class GemmaAudioTranscriber {
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;

  private static readonly MAX_AUDIO_SECONDS = Number(process.env.PI_VOICE_MAX_AUDIO_SECONDS ?? "120");
  private static readonly SAMPLE_RATE = 16000;
  private static readonly CHANNELS = 1;
  private static readonly BIT_DEPTH = 16;
  private static readonly MAX_AUDIO_BYTES =
    GemmaAudioTranscriber.MAX_AUDIO_SECONDS *
    GemmaAudioTranscriber.SAMPLE_RATE *
    GemmaAudioTranscriber.CHANNELS *
    (GemmaAudioTranscriber.BIT_DEPTH / 8);

  constructor(private config: VoiceConfig) {}

  async initialize(): Promise<void> {
    await this.ensureFfmpeg();
  }

  start(): void {
    this.audioChunks = [];
    this.totalAudioBytes = 0;
  }

  addAudio(chunk: Buffer): void {
    this.totalAudioBytes += chunk.length;
    if (this.totalAudioBytes > GemmaAudioTranscriber.MAX_AUDIO_BYTES) {
      throw new Error(`Gemma 4 audio clip exceeded ${GemmaAudioTranscriber.MAX_AUDIO_SECONDS} seconds; stopping this turn.`);
    }
    this.audioChunks.push(chunk);
  }

  async transcribe(): Promise<string> {
    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
    this.totalAudioBytes = 0;
    if (pcm.length === 0) return "";

    const tempDir = await mkdtemp(join(tmpdir(), "pi-gemma4-audio-"));
    const rawWavPath = join(tempDir, "raw.wav");
    const normalizedWavPath = join(tempDir, "gemma4-input.wav");

    try {
      await writeFile(rawWavPath, writeWavHeader(pcm, 16000, 1, 16));
      await this.normalizeWithFfmpeg(rawWavPath, normalizedWavPath);
      await this.saveDebugUtterance(normalizedWavPath);
      return (await this.callLlamaServer(normalizedWavPath)).trim();
    } finally {
      for (const f of [rawWavPath, normalizedWavPath]) {
        try { await unlink(f); } catch { /* ignore */ }
      }
      try { await rmdir(tempDir); } catch { /* ignore */ }
    }
  }

  clear(): void {
    this.audioChunks = [];
    this.totalAudioBytes = 0;
  }

  private ensureFfmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.config.ffmpegBinary, ["-version"], { timeout: 5000 }, (err) => {
        if (err) reject(new Error(`ffmpeg not available: ${err.message}`));
        else resolve();
      });
    });
  }

  private normalizeWithFfmpeg(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = ["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", "-sample_fmt", "s16", outputPath];
      execFile(this.config.ffmpegBinary, args, { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg normalization failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }

  private async saveDebugUtterance(wavPath: string): Promise<void> {
    await mkdir(dirname(this.config.utterancePath), { recursive: true });
    await copyFile(wavPath, this.config.utterancePath);
  }

  private async callLlamaServer(wavPath: string): Promise<string> {
    const wavBase64 = (await readFile(wavPath)).toString("base64");
    const body = {
      model: this.config.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "input_audio", input_audio: { data: wavBase64, format: "wav" } },
            { type: "text", text: this.config.prompt },
          ],
        },
      ],
      temperature: 0,
      max_tokens: this.config.maxTokens,
      stream: false,
    };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
    try {
      const res = await fetch(this.config.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${this.config.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`llama-server returned ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown }; text?: unknown }> };
      const first = json.choices?.[0];
      const content = first?.message?.content ?? first?.text;
      return typeof content === "string" ? content.trim() : "";
    } finally {
      clearTimeout(timer);
    }
  }
}
