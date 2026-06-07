import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VoiceConfig } from "./types.js";
import { writeWavHeader } from "./wav.js";

export class WhisperCpuTranscriber {
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;

  private static readonly MAX_AUDIO_SECONDS = Number(process.env.PI_VOICE_MAX_AUDIO_SECONDS ?? "120");
  private static readonly SAMPLE_RATE = 16000;
  private static readonly CHANNELS = 1;
  private static readonly BIT_DEPTH = 16;
  private static readonly MAX_AUDIO_BYTES =
    WhisperCpuTranscriber.MAX_AUDIO_SECONDS *
    WhisperCpuTranscriber.SAMPLE_RATE *
    WhisperCpuTranscriber.CHANNELS *
    (WhisperCpuTranscriber.BIT_DEPTH / 8);

  constructor(private config: VoiceConfig) {}

  async initialize(): Promise<void> {
    await this.ensureBinary(this.config.ffmpegBinary, ["-version"], "ffmpeg");
    await this.ensureBinary(this.config.whisperBinary, ["--help"], "whisper.cpp whisper-cli");
  }

  start(): void {
    this.audioChunks = [];
    this.totalAudioBytes = 0;
  }

  addAudio(chunk: Buffer): void {
    this.totalAudioBytes += chunk.length;
    if (this.totalAudioBytes > WhisperCpuTranscriber.MAX_AUDIO_BYTES) {
      throw new Error(`Whisper audio clip exceeded ${WhisperCpuTranscriber.MAX_AUDIO_SECONDS} seconds; stopping this turn.`);
    }
    this.audioChunks.push(chunk);
  }

  async transcribe(): Promise<string> {
    const pcm = Buffer.concat(this.audioChunks);
    this.clear();
    if (pcm.length === 0) return "";

    const tempDir = await mkdtemp(join(tmpdir(), "pig-whisper-stt-"));
    const rawWavPath = join(tempDir, "raw.wav");
    const normalizedWavPath = join(tempDir, "whisper-input.wav");

    try {
      await writeFile(rawWavPath, writeWavHeader(pcm, 16000, 1, 16));
      await this.normalizeWithFfmpeg(rawWavPath, normalizedWavPath);
      await this.saveDebugUtterance(normalizedWavPath);
      return (await this.callWhisper(normalizedWavPath)).trim();
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

  private ensureBinary(binary: string, args: string[], label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: 5000 }, (err) => {
        if (err) reject(new Error(`${label} not available at ${binary}: ${err.message}`));
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

  private callWhisper(wavPath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const args = [
        "-m", this.config.whisperModel,
        "-f", wavPath,
        "-t", String(this.config.whisperThreads),
        "-l", this.config.whisperLanguage,
        "-nt",
        "-np",
        "-ng",
      ];
      execFile(this.config.whisperBinary, args, { timeout: this.config.timeoutMs }, (err, stdout, stderr) => {
        if (err) reject(new Error(`whisper.cpp failed: ${stderr || err.message}`));
        else resolve(cleanWhisperText(stdout));
      });
    });
  }
}

function cleanWhisperText(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
