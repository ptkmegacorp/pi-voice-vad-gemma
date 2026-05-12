# Gemma 4 native-audio build plan

`docs/FLOW.md` is the source of truth for expected behavior.

## Objective

Implement always-on, turn-based Pi voice input using **one** local Gemma 4 E2B GGUF model loaded in `llama-server`. TTS is out of scope.

## Canonical behavior

From `docs/FLOW.md`, this is the path:

```text
1. Mic records continuously as raw PCM.
2. Silero VAD listens for speech.
3. When speech starts, start buffering audio.
4. When silence lasts ~800 ms, stop buffering.
5. Save the captured utterance as /tmp/pi-voice/utterance.wav.
6. Ensure audio is 16 kHz mono WAV PCM.
7. Send utterance.wav to Gemma 4 E2B with:
   "Transcribe this speech. Output only the text."
8. Gemma returns text, e.g. "pi check the server logs".
9. Filter layer strips leading "pi" → "check the server logs".
10. Inject with pi.sendUserMessage("check the server logs").
```

## Architecture

```text
pi-voice extension
  ├─ mic capture: continuous raw PCM
  ├─ VAD: Silero VAD
  ├─ utterance buffer
  ├─ ffmpeg normalization to 16 kHz mono WAV
  ├─ save debug/latest utterance: /tmp/pi-voice/utterance.wav
  ├─ STT provider: gemma4-audio
  │    └─ POST OpenAI input_audio JSON to llama-server /v1/chat/completions
  ├─ transcript filter
  │    └─ strip leading address prefix: /^pi[,.!?:;\s-]+/i
  └─ pi.sendUserMessage(cleanedTranscript)

single model runtime
  └─ llama-server with Gemma 4 GGUF + multimodal projector
```

## Implemented

- `src/stt/gemma4-audio.ts`
  - accumulates PCM chunks
  - wraps as WAV
  - ffmpeg-normalizes to 16 kHz mono WAV
  - saves `/tmp/pi-voice/utterance.wav`
  - sends `input_audio` to `http://127.0.0.1:8090/v1/chat/completions`
  - default prompt: `Transcribe this speech. Output only the text.`
- `src/index.ts`
  - strips leading `pi` before `pi.sendUserMessage(...)`
- `src/config.ts`
  - default `vadSilenceMs` is `800`
  - `gemma4-audio` provider registered
- `scripts/test-llama-server-audio.py`
  - defaults to port `8090`
- Pi model entry:
  - `/home/bot/.pi/agent/models.json`
  - `gemma-4-e2b-audio-local`
- Runtime voice config:
  - `/home/bot/.pi/voice.json`

## Not yet implemented / next engineering work

### 1. Silero VAD integration

Status: implemented with `silero-realtime-vad` in `src/audio/mic.ts`.

- Int16 PCM chunks are converted to Float32 `[-1, 1]`.
- Audio is processed in 512-sample frames at 16 kHz.
- `SPEECH_STARTED` emits `speechStart` and begins utterance buffering.
- `SPEECH_ENDED` after ~800 ms silence emits `silence` and closes the utterance.
- Silence/noise should not call Gemma because `src/index.ts` only sends audio to STT after `speechStart` in VAD mode.

Remaining: validate thresholds with the real microphone environment.

### 2. End-to-end audio test

Use actual mic or a known WAV:

```bash
python scripts/test-llama-server-audio.py sample.wav
```

Then test via extension:

```text
say: "pi check the server logs"
expect injected Pi message: "check the server logs"
```

### 3. Server operationalization

Current safe test server:

```bash
/home/bot/atomic-llama-cpp-turboquant/build/bin/llama-server \
  -m /home/bot/models/gemma-4-E2B-it-IQ4_NL.gguf \
  --mmproj /home/bot/models/mmproj-gemma-4-E2B-it-Q8_0.gguf \
  --no-mmproj-offload \
  --host 127.0.0.1 --port 8090 \
  -c 24576 -ngl 99 -fa off --parallel 1 -np 1 \
  -t 4 -tb 4 -b 64 -ub 32 \
  -rea off --reasoning-budget 0 --metrics --slots
```

Need a durable launcher script once audio is validated.

## Runtime checks

```bash
curl http://127.0.0.1:8090/health
curl http://127.0.0.1:8090/v1/models
pi -p --no-session --no-tools --model gemma-4-e2b-audio-local "Reply with exactly: OK"
```

Expected `/v1/models` capability includes:

```text
multimodal
```

## Risks / constraints

- Gemma 4 native audio is not an infinite streaming API; this remains per-utterance.
- Max audio clip length is 30 seconds.
- llama.cpp audio support is experimental.
- 4 GiB GTX 1650 requires conservative settings.
- The mmproj is required; text-only GGUF without mmproj cannot accept audio.
