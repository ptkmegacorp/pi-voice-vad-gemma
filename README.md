# pi-voice-vad-gemma

Standalone Pi voice input extension using **Silero VAD** and **Gemma 4 native audio** through a local GGUF `llama-server`.

This is not a general STT/TTS assistant. It has one job: turn spoken utterances into Pi user messages.

```text
continuous mic raw PCM
→ Silero VAD detects speech start
→ buffer utterance audio
→ Silero VAD detects speech end after ~800 ms silence
→ save /tmp/pi-voice/utterance.wav
→ ffmpeg normalizes to 16 kHz mono WAV PCM
→ send audio to Gemma 4 through llama-server input_audio
→ strip leading address prefix "pi"
→ pi.sendUserMessage(cleaned text)
```

No TTS. No cloud STT providers. No Whisper fallback.

## Commands

```text
/vad start   continuous VAD loop
/vad test    one utterance only
/vad stop    stop listening
/vad status  show runtime status
/vad config  write default config to ~/.pi/voice-gemma.json
```

Example:

```text
/vad test
say: "pi check the server logs"
Pi receives: "check the server logs"
```

## Runtime requirements

- `ffmpeg`
- Linux `arecord` or macOS/Windows `sox`
- local `llama-server` on `http://127.0.0.1:8090/v1/chat/completions`
- Gemma 4 audio-capable GGUF and mmproj

Safe local server:

```bash
/home/bot/llama.cpp/build/bin/llama-server \
  -m /home/bot/models/gemma-4-E2B-it-IQ4_NL.gguf \
  -a gemma-4-e2b-audio-local \
  --mmproj /home/bot/models/mmproj-gemma-4-E2B-it-Q8_0.gguf \
  --no-mmproj-offload \
  --host 127.0.0.1 --port 8090 \
  -c 24576 \
  -ngl 99 \
  -fa off \
  --parallel 1 -np 1 \
  -t 4 -tb 4 -b 64 -ub 32 \
  -rea off --reasoning-budget 0 \
  --metrics --slots
```

## Config

Runtime config path:

```text
~/.pi/voice-gemma.json
```

Defaults live in `src/config.ts`.

## Important files

```text
src/index.ts        Pi extension entry and /vad command
src/audio/mic.ts    mic capture + Silero VAD
src/gemma-audio.ts  ffmpeg normalization + llama-server input_audio
src/wav.ts          WAV helper
src/config.ts       standalone config
docs/FLOW.md        source-of-truth flow
```

## Development

```bash
npm install
npx tsc --noEmit
```
