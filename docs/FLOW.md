# Source-of-truth flow

This file is the canonical behavior for pi-voice-vad-gemma.

```text
continuous mic raw PCM
→ Silero VAD detects speech start
→ buffer utterance audio
→ Silero VAD detects speech end after ~800 ms silence
→ save /tmp/pi-voice/utterance.wav
→ ensure 16 kHz mono WAV PCM via ffmpeg
→ send utterance.wav to Gemma 4 E2B via llama-server input_audio
→ prompt: "Transcribe this speech. Output only the text."
→ Gemma returns text, for example: "pi check the server logs"
→ filter strips leading "pi"
→ pi.sendUserMessage("check the server logs")
```

Manual Ctrl+Space path:

```text
Ctrl+Space
→ start mic recording immediately, bypassing VAD silence auto-stop
→ buffer all mic PCM until second Ctrl+Space or max timer
→ Ctrl+Space again
→ stop mic, normalize/save WAV, transcribe with Gemma, send transcript as user message
```

## Non-goals

- No TTS response path.
- No cloud STT path.
- No Whisper/Deepgram fallback.
- No legacy provider-selection UI.
- No RMS threshold VAD as the primary path.

## Required local services

- `llama-server` on `127.0.0.1:8090`
- Gemma 4 E2B GGUF main model
- Gemma 4 E2B mmproj GGUF

## Current implementation mapping

| Flow step | Code |
|---|---|
| raw PCM capture | `src/audio/mic.ts` |
| Silero VAD | `src/audio/mic.ts` using `silero-realtime-vad` |
| utterance buffering gate | `src/index.ts` `speechActive` |
| manual push-to-talk | `src/index.ts` `ctrl+space`, `manualRecording` |
| WAV normalization/save | `src/gemma-audio.ts` |
| Gemma audio call | `src/gemma-audio.ts` |
| leading `pi` filter | `src/index.ts` `normalizeVoiceMessage()` |
| Pi injection | `src/index.ts` `pi.sendUserMessage()` |
