# pi-voice-gemma

Pi voice input using **Silero VAD** and **Gemma 4 native audio** through the local GGUF `llama-server`.

This project is no longer a general STT/TTS voice assistant. The source-of-truth flow is:

```text
continuous mic raw PCM
→ Silero VAD detects speech start
→ buffer utterance audio
→ Silero VAD detects speech end after ~800 ms silence
→ save /tmp/pi-voice/utterance.wav
→ ensure 16 kHz mono WAV PCM via ffmpeg
→ send audio to Gemma 4 E2B through llama-server input_audio
→ prompt: "Transcribe this speech. Output only the text."
→ strip leading address prefix "pi"
→ pi.sendUserMessage(cleaned text)
→ Pi responds in terminal text
```

No TTS is required or expected.

## Runtime assumptions

Local llama-server audio endpoint:

```text
http://127.0.0.1:8090/v1/chat/completions
```

Model runtime:

```text
/home/bot/models/gemma-4-E2B-it-IQ4_NL.gguf
/home/bot/models/mmproj-gemma-4-E2B-it-Q8_0.gguf
```

Pi model id:

```text
gemma-4-e2b-audio-local
```

## Safe llama-server command

```bash
/home/bot/atomic-llama-cpp-turboquant/build/bin/llama-server \
  -m /home/bot/models/gemma-4-E2B-it-IQ4_NL.gguf \
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

Checks:

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/v1/models
pi -p --no-session --no-tools --model gemma-4-e2b-audio-local "Reply with exactly: OK"
```

## Default config behavior

Defaults in `src/config.ts` are set for this flow:

```text
stt.provider = gemma4-audio
stt.mode = vad
stt.autoSend = true
stt.vadSilenceMs = 800
stt.interimResults = false
tts.triggerMode = manual
conversation.enabled = true
conversation.autoListenAfterTTS = false
```

Runtime config lives at:

```text
/home/bot/.pi/voice.json
```

## Important files

```text
src/audio/mic.ts                 Silero VAD integration
src/stt/gemma4-audio.ts          Gemma 4 llama-server audio transcription provider
src/index.ts                     Pi injection and leading "pi" prefix filter
docs/SILERO_VAD.md               VAD source-of-truth details
docs/GEMMA4_AUDIO_BUILD_PLAN.md  Build plan and acceptance criteria
README-GEMMA.md                  Runtime notes
scripts/test-llama-server-audio.py
```

## Development

```bash
npm install
npx tsc --noEmit
```

## Notes

- `-it` means instruction-tuned, not text-only.
- Gemma 4 E2B/E4B support audio input; output is text.
- The mmproj is required for audio; the text GGUF alone is not enough.
- llama.cpp audio support is experimental.
- This remains turn-based at the model boundary: Silero is continuous, Gemma receives per-utterance clips.
