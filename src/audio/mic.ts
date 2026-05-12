import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import type SileroVAD from "silero-realtime-vad";
import type { MicRecorder, MicOptions } from "../types.js";

const DEFAULT_MIC_OPTIONS: MicOptions = {
  sampleRate: 16000,
  channels: 1,
  bitDepth: 16,
};

/** Silero speech-end threshold. The project path uses ~800ms. */
const DEFAULT_SILENCE_MS = 800;
const SILERO_FRAME_SAMPLES = 512; // Silero requirement for 16 kHz audio.

// ─── Platform helpers ────────────────────────────────────────────────────

interface SpawnDescriptor {
  command: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}

function buildSpawnDescriptor(
  opts: MicOptions,
  platform: NodeJS.Platform,
): SpawnDescriptor {
  switch (platform) {
    case "linux": {
      const args = [
        "-f", `S${opts.bitDepth}_LE`,
        "-r", String(opts.sampleRate),
        "-c", String(opts.channels),
        "-t", "raw",
      ];
      if (opts.device) {
        args.push("-D", opts.device);
      }
      args.push("-");
      return { command: "arecord", args };
    }
    case "darwin": {
      const args = [
        "-d",
        "-t", "raw",
        "-b", String(opts.bitDepth),
        "-e", "signed-integer",
        "-r", String(opts.sampleRate),
        "-c", String(opts.channels),
      ];
      args.push("-");
      const env = opts.device ? { ...process.env, AUDIODEV: opts.device } : undefined;
      return { command: "sox", args, env };
    }
    case "win32": {
      const args = [
        "-d",
        "-t", "raw",
        "-b", String(opts.bitDepth),
        "-e", "signed-integer",
        "-r", String(opts.sampleRate),
        "-c", String(opts.channels),
        "-",
      ];
      return { command: "sox", args };
    }
    default:
      throw new Error(
        `Unsupported platform "${platform}". ` +
        "Microphone capture requires Linux (arecord), macOS (sox), or Windows (sox).",
      );
  }
}

function toolInstallHint(platform: NodeJS.Platform): string {
  switch (platform) {
    case "linux":
      return 'Install ALSA utilities: sudo apt-get install alsa-utils';
    case "darwin":
      return 'Install SoX: brew install sox';
    case "win32":
      return 'Install SoX: choco install sox.portable   (or download from https://sox.sourceforge.net)';
    default:
      return '';
  }
}

// ─── PCM helpers ─────────────────────────────────────────────────────────

function int16PcmToFloat32(buf: Buffer): Float32Array {
  const sampleCount = Math.floor(buf.length / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = Math.max(-1, Math.min(1, buf.readInt16LE(i * 2) / 32768));
  }
  return out;
}

function float32ToInt16Pcm(samples: Float32Array): Buffer {
  const out = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out.writeInt16LE(v < 0 ? Math.round(v * 32768) : Math.round(v * 32767), i * 2);
  }
  return out;
}

function pcmLevel(buf: Buffer): number {
  const sampleCount = Math.floor(buf.length / 2);
  if (sampleCount === 0) return 0;
  let peak = 0;
  for (let i = 0; i < sampleCount; i++) {
    peak = Math.max(peak, Math.abs(buf.readInt16LE(i * 2)));
  }
  return Math.min(peak / 32767, 1);
}

// ─── Implementation ──────────────────────────────────────────────────────

/**
 * Cross-platform microphone recorder that spawns a system audio-capture
 * process and streams raw PCM data.
 *
 * Supports Linux (`arecord`), macOS (`sox`), and Windows (`sox`).
 */
export function createMicRecorder(
  userOpts?: Partial<MicOptions>,
  silenceMs?: number,
): MicRecorder {
  const opts: MicOptions = { ...DEFAULT_MIC_OPTIONS, ...userOpts };
  const silenceTimeout = silenceMs ?? DEFAULT_SILENCE_MS;
  const platform = process.platform;

  const emitter = new EventEmitter();
  let proc: ChildProcess | null = null;
  let recording = false;
  let stopping = false;
  let disposed = false;
  let currentLevel = 0;
  let vad: SileroVAD | null = null;
  let pendingSamples: Float32Array<ArrayBuffer> = new Float32Array(0);

  // ── Silero VAD tracking ─────────────────────────────────────────────

  function resetVadBuffers(): void {
    pendingSamples = new Float32Array(0);
    vad?.resetContext();
  }

  function appendPendingSamples(next: Float32Array): void {
    if (pendingSamples.length === 0) {
      const copied = new Float32Array(next.length);
      copied.set(next);
      pendingSamples = copied;
      return;
    }
    const merged = new Float32Array(pendingSamples.length + next.length);
    merged.set(pendingSamples, 0);
    merged.set(next, pendingSamples.length);
    pendingSamples = merged;
  }

  async function processVadSamples(samples: Float32Array): Promise<void> {
    if (!vad) return;
    appendPendingSamples(samples);
    while (pendingSamples.length >= SILERO_FRAME_SAMPLES) {
      const frame = pendingSamples.slice(0, SILERO_FRAME_SAMPLES);
      pendingSamples = pendingSamples.slice(SILERO_FRAME_SAMPLES);
      try {
        await vad.processAudio(frame);
      } catch (err) {
        emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
      }
    }
  }

  // ── Process management ──────────────────────────────────────────────

  function killProc(): void {
    if (proc === null) return;
    const p = proc;
    proc = null;

    // Guard against writing to an already-closed stream.
    try {
      if (p.stdin && !p.stdin.destroyed) {
        p.stdin.end();
      }
    } catch {
      // stdin may already be closed — ignore.
    }

    if (!p.killed) {
      stopping = true;
      p.kill("SIGTERM");

      // If the process hasn't exited after 500ms, force-kill.
      const forceKill = setTimeout(() => {
        try {
          if (!p.killed) p.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      }, 500);
      forceKill.unref();
    }
  }

  // ── Public API ──────────────────────────────────────────────────────

  const recorder: MicRecorder = {
    /** Spawn the platform recording process and begin streaming PCM data. */
    async start(): Promise<void> {
      if (disposed) {
        throw new Error("MicRecorder has been disposed");
      }
      if (recording) return;

      let desc: SpawnDescriptor;
      try {
        desc = buildSpawnDescriptor(opts, platform);
      } catch (err) {
        emitter.emit("error", err instanceof Error ? err : new Error(String(err)));
        return;
      }

      try {
        const { default: SileroVADImpl } = await import("silero-realtime-vad");
        vad = new SileroVADImpl({
          sampleRate: 16000,
          minSpeechDuration: 50,
          minSilenceDuration: silenceTimeout,
          prefixPaddingDuration: 300,
          maxBufferedSpeech: 30000,
          activationThreshold: 0.4,
          context: true,
        });
        vad.on("SPEECH_STARTED", ({ paddingBuffer }) => {
          emitter.emit("speechStart", float32ToInt16Pcm(paddingBuffer));
        });
        vad.on("SPEECH_ENDED", () => {
          emitter.emit("silence");
        });
        resetVadBuffers();
      } catch (err) {
        emitter.emit(
          "error",
          new Error(`Failed to initialize Silero VAD: ${err instanceof Error ? err.message : String(err)}`),
        );
        return;
      }

      try {
        proc = spawn(desc.command, desc.args, {
          stdio: ["ignore", "pipe", "pipe"],
          env: desc.env,
        });
      } catch (err) {
        const hint = toolInstallHint(platform);
        const msg =
          `Failed to start "${desc.command}". Is it installed and on PATH?\n` +
          (hint ? `${hint}\n` : "") +
          (err instanceof Error ? err.message : String(err));
        emitter.emit("error", new Error(msg));
        return;
      }

      recording = true;
      stopping = false;
      const thisProc = proc;

      thisProc.stdout!.on("data", (chunk: Buffer) => {
        if (!recording || disposed) return;

        currentLevel = pcmLevel(chunk);
        void processVadSamples(int16PcmToFloat32(chunk));
        emitter.emit("data", chunk);
      });

      thisProc.stderr!.on("data", (data: Buffer) => {
        const msg = data.toString().trim();
        // arecord/sox print informational lines to stderr that are not
        // real errors — only forward lines that look like failures.
        if (
          msg &&
          recording &&
          !stopping &&
          !msg.startsWith("Recording") &&
          !msg.startsWith("Input File")
        ) {
          emitter.emit("error", new Error(`[${desc.command}] ${msg}`));
        }
      });

      thisProc.on("error", (err: Error) => {
        if (proc === thisProc) {
          recording = false;
          resetVadBuffers();
        }
        const hint = toolInstallHint(platform);
        const msg =
          `"${desc.command}" process error: ${err.message}\n` +
          (hint || "");
        emitter.emit("error", new Error(msg));
      });

      thisProc.on("close", (code) => {
        if (proc === thisProc) {
          recording = false;
          resetVadBuffers();
          proc = null;
        }
        const wasStopping = stopping;
        stopping = false;
        // Exit code 0, null (killed by signal), or expected stop are normal stop paths.
        if (!wasStopping && code !== null && code !== 0) {
          emitter.emit(
            "error",
            new Error(`"${desc.command}" exited with code ${code}`),
          );
        }
      });
    },

    /** Stop the recording process and clean up. */
    async stop(): Promise<void> {
      if (!recording) return;
      recording = false;
      resetVadBuffers();
      currentLevel = 0;
      killProc();
    },

    /** Whether the recorder is currently capturing audio. */
    isRecording(): boolean {
      return recording;
    },

    /** Register a handler for incoming PCM audio chunks. */
    onData(handler: (chunk: Buffer) => void): void {
      emitter.on("data", handler);
    },

    /** Register a handler for errors (missing tools, process failures, etc). */
    onError(handler: (error: Error) => void): void {
      emitter.on("error", handler);
    },

    /** Register a handler that fires when Silero VAD detects speech start. */
    onSpeechStart(handler: (paddingChunk?: Buffer) => void): void {
      emitter.on("speechStart", handler);
    },

    /**
     * Register a handler that fires when Silero VAD detects speech end after
     * the configured silence timeout.
     */
    onSilence(handler: () => void): void {
      emitter.on("silence", handler);
    },

    /**
     * Current audio amplitude as a value from 0.0 (silence) to 1.0
     * (full-scale). Updated on every incoming data chunk.
     */
    getLevel(): number {
      return currentLevel;
    },

    /** Stop recording, kill the process, and release all resources. */
    dispose(): void {
      if (disposed) return;
      disposed = true;
      recording = false;
      resetVadBuffers();
      killProc();
      emitter.removeAllListeners();
    },
  };

  return recorder;
}
