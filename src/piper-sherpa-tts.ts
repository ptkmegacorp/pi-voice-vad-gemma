import { execFile, spawn, type ChildProcess } from "node:child_process";
import { access, copyFile, mkdir, mkdtemp, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { VoiceConfig } from "./types.js";

export class PiperSherpaTts {
  private playback: ChildProcess | null = null;
  private speaking = false;

  constructor(private config: VoiceConfig) {}

  get isSpeaking(): boolean {
    return this.speaking;
  }

  async initialize(): Promise<void> {
    await this.ensurePath(this.config.ttsBinary, "sherpa-onnx-offline-tts");
    await this.ensurePath(this.config.ttsModel, "Piper ONNX model");
    await this.ensurePath(this.config.ttsTokens, "Piper tokens.txt");
    await this.ensurePath(this.config.ttsDataDir, "espeak-ng-data directory");
    await this.ensureBinary(this.config.playbackBinary, ["--help"], "audio playback binary");
  }

  async speak(text: string): Promise<void> {
    const cleaned = text.trim();
    if (!cleaned) return;

    this.stop();
    const tempDir = await mkdtemp(join(tmpdir(), "pig-piper-tts-"));
    const wavPath = join(tempDir, "speech.wav");

    try {
      await this.synthesize(cleaned, wavPath);
      await this.saveDebugSpeech(wavPath);
      await this.playWav(wavPath);
    } finally {
      try { await unlink(wavPath); } catch { /* ignore */ }
      try { await rmdir(tempDir); } catch { /* ignore */ }
    }
  }

  stop(): void {
    if (this.playback) {
      this.playback.kill("SIGTERM");
      this.playback = null;
    }
    this.speaking = false;
  }

  private async synthesize(text: string, wavPath: string): Promise<void> {
    const args = [
      `--vits-model=${this.config.ttsModel}`,
      `--vits-tokens=${this.config.ttsTokens}`,
      `--vits-data-dir=${this.config.ttsDataDir}`,
      `--num-threads=${String(this.config.ttsThreads)}`,
      `--vits-length-scale=${String(this.config.ttsLengthScale)}`,
      `--output-filename=${wavPath}`,
      text,
    ];

    await new Promise<void>((resolve, reject) => {
      execFile(this.config.ttsBinary, args, { timeout: this.config.timeoutMs }, (err, _stdout, stderr) => {
        if (err) reject(new Error(`sherpa-onnx Piper TTS failed: ${stderr || err.message}`));
        else resolve();
      });
    });
  }

  private playWav(wavPath: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const args = this.config.playbackDevice
        ? ["-D", this.config.playbackDevice, wavPath]
        : [wavPath];

      const player = spawn(this.config.playbackBinary, args, { stdio: "ignore" }) as ChildProcess;
      this.playback = player;
      this.speaking = true;

      player.on("error", (err) => {
        this.playback = null;
        this.speaking = false;
        reject(new Error(`${this.config.playbackBinary} playback failed: ${err.message}`));
      });

      player.on("close", (code, signal) => {
        this.playback = null;
        this.speaking = false;
        if (signal === "SIGTERM") resolve();
        else if (code === 0) resolve();
        else reject(new Error(`${this.config.playbackBinary} exited with code ${code ?? "unknown"}`));
      });
    });
  }

  private async saveDebugSpeech(wavPath: string): Promise<void> {
    await mkdir(dirname(this.config.ttsOutputPath), { recursive: true });
    await copyFile(wavPath, this.config.ttsOutputPath);
  }

  private async ensurePath(path: string, label: string): Promise<void> {
    try {
      await access(path);
    } catch {
      throw new Error(`${label} not found at ${path}`);
    }
  }

  private ensureBinary(binary: string, args: string[], label: string): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: 5000 }, (err) => {
        if (err) reject(new Error(`${label} not available at ${binary}: ${err.message}`));
        else resolve();
      });
    });
  }
}
