# Silero VAD integration

`docs/FLOW.md` is the source of truth for the end-to-end voice flow.

This fork uses Silero VAD for speech start/end detection. RMS threshold silence detection is not the expected behavior.

## Package

```text
silero-realtime-vad
```

It bundles a Silero ONNX model and uses 16 kHz Float32 PCM frames.

## Audio frame contract

- Mic capture: raw 16 kHz mono signed 16-bit little-endian PCM.
- Conversion for VAD: Int16 PCM -> Float32 samples in `[-1, 1]`.
- Silero frame size at 16 kHz: `512` samples.
- Speech end threshold: `800 ms` silence.

## Event flow

```text
arecord/sox raw PCM stream
  -> convert chunks to Float32
  -> split into 512-sample Silero frames
  -> Silero SPEECH_STARTED
       -> extension starts buffering utterance audio
       -> optional prefix padding is sent to STT buffer
  -> Silero SPEECH_ENDED after ~800 ms silence
       -> extension stops buffering
       -> Gemma transcription request runs
```

## Code locations

- `src/audio/mic.ts`
  - imports `silero-realtime-vad`
  - emits `speechStart` and `silence`
- `src/index.ts`
  - buffers/sends audio to STT only after `speechStart` in VAD mode
  - stops the utterance on `silence`
- `src/stt/gemma4-audio.ts`
  - writes `/tmp/pi-voice/utterance.wav`
  - sends audio to Gemma 4 via llama-server

## Expected behavior

Speech boundaries come from Silero VAD. Silence/noise should not be sent to Gemma. Gemma receives only completed per-utterance clips.
