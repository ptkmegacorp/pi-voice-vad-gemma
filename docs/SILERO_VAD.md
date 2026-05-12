# Silero VAD integration

`docs/FLOW.md` is the source of truth for the end-to-end voice flow.

This standalone extension uses Silero VAD for speech start/end detection. RMS threshold silence detection is not used.

## Package

```text
silero-realtime-vad
```

It bundles a Silero ONNX model and uses 16 kHz Float32 PCM frames.

## Audio frame contract

- Mic capture: raw 16 kHz mono signed 16-bit little-endian PCM.
- Conversion for VAD: Int16 PCM -> Float32 samples in `[-1, 1]`.
- Silero frame size at 16 kHz: `512` samples.
- Speech end threshold: default `800 ms` silence.

## Event flow

```text
arecord/sox raw PCM stream
  -> convert chunks to Float32
  -> split into 512-sample Silero frames
  -> Silero SPEECH_STARTED
       -> extension starts buffering utterance audio
       -> optional prefix padding is sent to utterance buffer
  -> Silero SPEECH_ENDED after configured silence
       -> extension stops buffering
       -> Gemma transcription request runs
```

## Code locations

- `src/audio/mic.ts`
  - imports `silero-realtime-vad`
  - emits `speechStart` and `silence`
- `src/index.ts`
  - buffers audio only after `speechStart`
  - stops the utterance on `silence`
- `src/gemma-audio.ts`
  - writes `/tmp/pi-voice/utterance.wav`
  - sends audio to Gemma 4 via llama-server
