export interface VoiceConfig {
  endpoint: string;
  model: string;
  apiKey: string;
  ffmpegBinary: string;
  utterancePath: string;
  timeoutMs: number;
  maxTokens: number;
  prompt: string;
  micDevice?: string;
  vadSilenceMs: number;
  sttBackend: "sherpa-moonshine" | "whisper.cpp";
  sherpaMoonshineModelDir: string;
  sherpaThreads: number;
  whisperBinary: string;
  whisperModel: string;
  whisperThreads: number;
  whisperLanguage: string;
  ttsEnabled: boolean;
  ttsBackend: "sherpa-onnx-piper";
  ttsBinary: string;
  ttsModel: string;
  ttsTokens: string;
  ttsDataDir: string;
  ttsThreads: number;
  ttsLengthScale: number;
  ttsMaxChars: number;
  ttsOutputPath: string;
  playbackBinary: string;
  playbackDevice?: string;
}

export interface MicOptions {
  sampleRate: number;
  channels: number;
  bitDepth: number;
  device?: string;
}

export interface MicRecorder {
  start(): Promise<void>;
  stop(): Promise<void>;
  isRecording(): boolean;
  onData(handler: (chunk: Buffer) => void): void;
  onError(handler: (error: Error) => void): void;
  onSpeechStart(handler: (paddingChunk?: Buffer) => void): void;
  onSilence(handler: () => void): void;
  getLevel(): number;
  dispose(): void;
}
