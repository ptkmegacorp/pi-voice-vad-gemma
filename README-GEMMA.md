# pi-voice-gemma runtime notes

See `docs/FLOW.md` for the source-of-truth behavior.

Pi voice input uses **Silero VAD** plus **Gemma 4 native audio** through the existing local GGUF `llama-server`.

No TTS is required. Pi responses remain text in the terminal.

## Chosen path (source-of-truth summary)

```text
1. Mic records continuously as raw PCM.
2. Silero VAD listens for speech.
3. On speech start, begin buffering audio.
4. When silence lasts about 800 ms, stop buffering.
5. Save the utterance to /tmp/pi-voice/utterance.wav.
6. Ensure the file is 16 kHz mono WAV PCM.
7. Send utterance.wav to Gemma 4 E2B with:
   "Transcribe this speech. Output only the text."
8. Filter layer strips a leading "pi" address prefix.
9. Inject the result with pi.sendUserMessage(...).
```

Current code status:

- Gemma native-audio STT provider exists: `src/stt/gemma4-audio.ts`.
- It writes normalized utterances to `/tmp/pi-voice/utterance.wav`.
- It sends OpenAI-style `input_audio` to `llama-server` on port `8090`.
- It strips leading `pi` before injecting messages into Pi.
- Silence timeout default/config is now `800 ms`.
- Silero VAD is now wired into the mic layer for speech start/end detection.

## Runtime pipeline

```text
mic/VAD → raw PCM buffer → ffmpeg 16 kHz mono WAV → /tmp/pi-voice/utterance.wav → base64 input_audio → llama-server /v1/chat/completions → transcript → strip leading "pi" → Pi
```

## Required llama.cpp setup

Use the safe multimodal test server on `8090`:

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

Check:

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/v1/models
```

Expected model id:

```text
gemma-4-E2B-it-IQ4_NL.gguf
```

Expected capability includes:

```text
multimodal
```

## Pi model config

Pi has a model entry in `/home/bot/.pi/agent/models.json`:

```text
gemma-4-e2b-audio-local → http://127.0.0.1:8090/v1
```

Smoke test:

```bash
pi -p --no-session --no-tools --model gemma-4-e2b-audio-local "Reply with exactly: OK"
```

## pi-voice config

`~/.pi/voice.json` should use:

```jsonc
{
  "stt": {
    "provider": "gemma4-audio",
    "mode": "vad",
    "autoSend": true,
    "vadSilenceMs": 800,
    "interimResults": false,
    "providerOptions": {
      "gemma4-audio": {
        "endpoint": "http://127.0.0.1:8090/v1/chat/completions",
        "model": "gemma-4-E2B-it-IQ4_NL.gguf",
        "api_key": "llama-server",
        "ffmpeg_binary": "ffmpeg",
        "utterance_path": "/tmp/pi-voice/utterance.wav",
        "timeout_ms": 120000,
        "max_tokens": 256,
        "prompt": "Transcribe this speech. Output only the text."
      }
    }
  },
  "tts": { "triggerMode": "manual" },
  "conversation": { "enabled": true, "autoListenAfterTTS": false }
}
```

## Audio test helper

```bash
python scripts/test-llama-server-audio.py sample.wav
```

## Development check

```bash
npm install
npx tsc --noEmit
```

## Silero VAD

See `docs/SILERO_VAD.md` and `docs/FLOW.md`.

## Notes

- `-it` means instruction-tuned, not text-only.
- Gemma 4 E2B/E4B support audio input; output is text.
- Max audio clip length is 30 seconds.
- The extension remains turn-based: continuous mic/VAD, but per-utterance Gemma calls.
- `llama.cpp` audio support is experimental.
