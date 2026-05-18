# Gemma 4 native-audio implementation notes

`docs/FLOW.md` is the source of truth for runtime behavior.

## Objective

Standalone Pi extension for turn-based voice input using:

- raw microphone capture
- Silero VAD speech boundaries
- local Gemma 4 native audio through `llama-server`
- text injection into Pi with `pi.sendUserMessage(...)`

TTS, cloud STT providers, Whisper, and legacy provider-selection UI are intentionally out of scope.

## Implemented architecture

```text
pi-voice-vad-gemma
  ├─ src/index.ts        /vad command and Pi message injection
  ├─ src/audio/mic.ts    arecord/sox capture + Silero VAD events
  ├─ src/gemma-audio.ts  WAV normalization + llama-server input_audio call
  ├─ src/wav.ts          PCM WAV helper
  ├─ src/config.ts       tiny standalone config loader
  └─ src/types.ts        local minimal types
```

## Runtime path

```text
continuous mic raw PCM
→ Silero VAD detects speech start
→ buffer utterance audio
→ Silero VAD detects speech end after ~800 ms silence
→ save /tmp/pi-voice/utterance.wav
→ ensure 16 kHz mono WAV PCM via ffmpeg
→ send audio to Gemma 4 E2B via llama-server input_audio
→ prompt: "Transcribe this speech. Output only the text."
→ strip leading address prefix "pi"
→ pi.sendUserMessage(cleaned text)
```

## Local llama-server

```bash
$HOME/llama.cpp/build/bin/llama-server \
  -m $HOME/models/gemma-4-E2B-it-IQ4_NL.gguf \
  -a gemma-4-e2b-audio-local \
  --mmproj $HOME/models/mmproj-gemma-4-E2B-it-Q8_0.gguf \
  --no-mmproj-offload \
  --host 127.0.0.1 --port 8090 \
  -c 24576 -ngl 99 -fa off --parallel 1 -np 1 \
  -t 4 -tb 4 -b 64 -ub 32 \
  -rea off --reasoning-budget 0 --metrics --slots
```

## Validation

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/v1/models
npx tsc --noEmit
python scripts/test-llama-server-audio.py sample.wav
```

Extension test:

```text
/vad test
say: "pi check the server logs"
expect injected prompt: "check the server logs"
```

## Constraints

- Gemma 4 native audio is per-utterance, not infinite streaming.
- Maximum buffered utterance length is 30 seconds.
- The mmproj is required for audio input.
- llama.cpp audio support is experimental.
