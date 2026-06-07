import { createRequire } from "node:module";
import { copyFile, mkdir, mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import type { VoiceConfig } from "./types.js";
import { writeWavHeader } from "./wav.js";

const requireFromPi = createRequire("/home/bot/.pi/agent/npm/package.json");

export class SherpaMoonshineTranscriber {
  private audioChunks: Buffer[] = [];
  private totalAudioBytes = 0;
  private recognizer: any | null = null;

  private static readonly MAX_AUDIO_SECONDS = Number(process.env.PI_VOICE_MAX_AUDIO_SECONDS ?? "120");
  private static readonly SAMPLE_RATE = 16000;
  private static readonly CHANNELS = 1;
  private static readonly BIT_DEPTH = 16;
  private static readonly MAX_AUDIO_BYTES =
    SherpaMoonshineTranscriber.MAX_AUDIO_SECONDS *
    SherpaMoonshineTranscriber.SAMPLE_RATE *
    SherpaMoonshineTranscriber.CHANNELS *
    (SherpaMoonshineTranscriber.BIT_DEPTH / 8);

  constructor(private config: VoiceConfig) {}

  async initialize(): Promise<void> {
    if (this.recognizer) return;
    const sherpa = requireFromPi("sherpa-onnx-node");
    const dir = this.config.sherpaMoonshineModelDir;
    this.recognizer = new sherpa.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        moonshine: {
          preprocessor: join(dir, "preprocess.onnx"),
          encoder: join(dir, "encode.int8.onnx"),
          uncachedDecoder: join(dir, "uncached_decode.int8.onnx"),
          cachedDecoder: join(dir, "cached_decode.int8.onnx"),
        },
        tokens: join(dir, "tokens.txt"),
        numThreads: this.config.sherpaThreads,
        provider: "cpu",
      },
    });
  }

  start(): void {
    this.audioChunks = [];
    this.totalAudioBytes = 0;
  }

  addAudio(chunk: Buffer): void {
    this.totalAudioBytes += chunk.length;
    if (this.totalAudioBytes > SherpaMoonshineTranscriber.MAX_AUDIO_BYTES) {
      throw new Error(`Moonshine audio clip exceeded ${SherpaMoonshineTranscriber.MAX_AUDIO_SECONDS} seconds; stopping this turn.`);
    }
    this.audioChunks.push(chunk);
  }

  async transcribe(): Promise<string> {
    if (!this.recognizer) await this.initialize();
    const pcm = Buffer.concat(this.audioChunks);
    this.clear();
    if (pcm.length === 0) return "";

    await this.saveDebugUtterance(pcm);
    const samples = pcmToFloat32(pcm);
    const stream = this.recognizer.createStream();
    stream.acceptWaveform({ sampleRate: 16000, samples });
    await this.recognizer.decodeAsync(stream);
    const result = this.recognizer.getResult(stream);
    return (result?.text || "").trim();
  }

  clear(): void {
    this.audioChunks = [];
    this.totalAudioBytes = 0;
  }

  private async saveDebugUtterance(pcm: Buffer): Promise<void> {
    const tempDir = await mkdtemp(join(tmpdir(), "pig-moonshine-stt-"));
    const wavPath = join(tempDir, "utterance.wav");
    try {
      await writeFile(wavPath, writeWavHeader(pcm, 16000, 1, 16));
      await mkdir(dirname(this.config.utterancePath), { recursive: true });
      await copyFile(wavPath, this.config.utterancePath);
    } finally {
      try { await unlink(wavPath); } catch {}
      try { await rmdir(tempDir); } catch {}
    }
  }
}

function pcmToFloat32(buf: Buffer): Float32Array {
  const sampleCount = Math.floor(buf.length / 2);
  const out = new Float32Array(sampleCount);
  for (let i = 0; i < sampleCount; i++) {
    out[i] = Math.max(-1, Math.min(1, buf.readInt16LE(i * 2) / 32768));
  }
  return out;
}
