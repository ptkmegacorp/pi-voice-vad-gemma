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
