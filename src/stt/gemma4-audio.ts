import { execFile } from "node:child_process";
import { mkdir, mkdtemp, writeFile, readFile, unlink, rmdir, copyFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { BaseSTTProvider, writeWavHeader } from "./base.js";
import type { STTConfig, STTProviderName } from "../types.js";

/**
 * Gemma 4 native-audio STT provider.
 *
 * This provider keeps pi-voice's existing mic/VAD/conversation machinery, but
 * replaces external STT with the same local Gemma 4 E2B/E4B llama-server
 * instance used by Pi. Audio is accumulated as raw 16 kHz mono PCM, wrapped as
 * WAV, normalized through ffmpeg, saved to /tmp/pi-voice/utterance.wav for
 * inspection, base64-encoded, then sent to llama.cpp's OpenAI-compatible
 * /v1/chat/completions endpoint using input_audio.
 */
export class Gemma4AudioSTTProvider extends BaseSTTProvider {
  readonly name: STTProviderName = "gemma4-audio";
  readonly displayName = "Gemma 4 Native Audio";
  readonly supportsStreaming = false;
  readonly requiresApiKey = false;

  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;
  private ffmpegBinary = "ffmpeg";

  private static readonly MAX_AUDIO_SECONDS = 30;
  private static readonly SAMPLE_RATE = 16000;
  private static readonly CHANNELS = 1;
  private static readonly BIT_DEPTH = 16;
  private static readonly MAX_AUDIO_BYTES =
    Gemma4AudioSTTProvider.MAX_AUDIO_SECONDS *
    Gemma4AudioSTTProvider.SAMPLE_RATE *
    Gemma4AudioSTTProvider.CHANNELS *
    (Gemma4AudioSTTProvider.BIT_DEPTH / 8);

  async initialize(config: STTConfig): Promise<void> {
    this.config = config;
    const opts = this.providerOptions();
    this.ffmpegBinary = String(opts.ffmpeg_binary ?? "ffmpeg");
    await this.ensureFfmpeg();
  }

  async startListening(): Promise<void> {
    if (this.listening) return;
    this.resetState();
    this.audioChunks = [];
    this.totalAudioBytes = 0;
    this.listening = true;
    this.emit("ready");
  }

  async stopListening(): Promise<string> {
    if (!this.listening) return this.accumulatedTranscript;
    this.listening = false;

    if (this.audioChunks.length === 0) return this.accumulatedTranscript;

    try {
      const transcript = await this.transcribeAudio();
      if (transcript) {
        this.emitTranscript({ text: transcript, isFinal: true, confidence: 1.0 });
      }
    } catch (err) {
      this.emitError(err);
    }

    return this.accumulatedTranscript;
  }

  sendAudio(chunk: Buffer): void {
    if (!this.listening) return;
    this.totalAudioBytes += chunk.length;
    if (this.totalAudioBytes > Gemma4AudioSTTProvider.MAX_AUDIO_BYTES) {
      this.emitError(new Error("Gemma 4 audio clip exceeded 30 seconds; stopping this turn."));
      this.listening = false;
      return;
    }
    this.audioChunks.push(chunk);
  }

  async dispose(): Promise<void> {
    this.listening = false;
    this.audioChunks = [];
  }

  private providerOptions(): Record<string, unknown> {
    return (this.config?.providerOptions?.["gemma4-audio"] as Record<string, unknown>) ?? {};
  }

  private ensureFfmpeg(): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(this.ffmpegBinary, ["-version"], { timeout: 5000 }, (err) => {
        if (err) reject(new Error(`ffmpeg not available: ${err.message}`));
        else resolve();
      });
    });
  }

  private async transcribeAudio(): Promise<string> {
    const pcm = Buffer.concat(this.audioChunks);
    this.audioChunks = [];
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

  private normalizeWithFfmpeg(inputPath: string, outputPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = [
        "-y",
        "-i", inputPath,
        "-ac", "1",
        "-ar", "16000",
        "-sample_fmt", "s16",
        outputPath,
      ];
      execFile(this.ffmpegBinary, args, { timeout: 30000 }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`ffmpeg normalization failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }

  private async saveDebugUtterance(wavPath: string): Promise<void> {
    const opts = this.providerOptions();
    const debugPath = String(opts.utterance_path ?? "/tmp/pi-voice/utterance.wav");
    await mkdir(dirname(debugPath), { recursive: true });
    await copyFile(wavPath, debugPath);
  }

  private async callLlamaServer(wavPath: string): Promise<string> {
    const opts = this.providerOptions();
    const endpoint = String(opts.endpoint ?? "http://127.0.0.1:8090/v1/chat/completions");
    const model = String(opts.model ?? "gemma-4-E2B-it-IQ4_NL.gguf");
    const apiKey = String(opts.api_key ?? "no-key");
    const prompt = String(
      opts.prompt ??
        "Transcribe this speech. Output only the text.",
    );

    const wavBase64 = (await readFile(wavPath)).toString("base64");
    const body = {
      model,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "input_audio",
              input_audio: {
                data: wavBase64,
                format: "wav",
              },
            },
            { type: "text", text: prompt },
          ],
        },
      ],
      temperature: 0,
      max_tokens: Number(opts.max_tokens ?? 256),
      stream: false,
    };

    const controller = new AbortController();
    const timeoutMs = Number(opts.timeout_ms ?? 120000);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`llama-server returned ${res.status}: ${await res.text()}`);
      const json = (await res.json()) as {
        choices?: Array<{ message?: { content?: unknown }; text?: unknown }>;
      };
      const first = json.choices?.[0];
      const content = first?.message?.content ?? first?.text;
      return typeof content === "string" ? content.trim() : "";
    } finally {
      clearTimeout(timer);
    }
  }
}
