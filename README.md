# pi-voice-vad-gemma

Standalone Pig/Pi voice input extension using **Silero VAD** and local STT.

Current Neptune default: **sherpa-onnx Moonshine Tiny** for speech-to-text, then send the transcript into Pig's normal text pipeline. The old Gemma 4 E2B native-audio server path is no longer the active architecture.

This package owns audio/VAD/transcription only. It does not perform intent routing; any deterministic command routing belongs to separately installed Pig input extensions.

## Flow

```text
continuous mic raw PCM
→ Silero VAD detects speech start
→ buffer utterance audio
→ Silero VAD detects speech end after ~800 ms silence
→ save /tmp/pi-voice/utterance.wav for debugging
→ transcribe locally with sherpa-onnx Moonshine Tiny
→ strip leading address prefix "pi"
→ pi.sendUserMessage(cleaned text)
→ Pig handles it through the normal text pipeline
```

Manual push-to-talk:

```text
Ctrl+Space → start recording
Ctrl+Space → stop, transcribe, send transcript as a user message
```

TTS code exists but is disabled by default.

## Commands

```text
Ctrl+Space  toggle manual recording: start, then transcribe/send
/vad start   continuous VAD loop
/vad test    one utterance only
/vad stop    stop listening
/vad status  show runtime status
/vad config  write current/default config
/tts status  TTS status; TTS remains disabled by default
```

## Runtime requirements

- Linux `arecord` or macOS/Windows `sox` for mic capture
- sherpa-onnx-node available from Pi's installed package tree
- Current Neptune Moonshine model dir: `/home/bot/.pi/models/moonshine-tiny`
- Current Neptune USB mic: ALSA `plughw:2,0`

Whisper fallback code remains available:

```text
/home/bot/whisper.cpp/build/bin/whisper-cli
/home/bot/whisper.cpp/models/ggml-base.en.bin
```

## Config

Runtime config path defaults to Pig:

```text
~/.pig/voice-gemma.json
```

Override with:

```text
PI_VOICE_GEMMA_CONFIG=/path/to/voice-gemma.json
```

Defaults live in `src/config.ts`.

Manual recording limits:

```text
PI_VOICE_MANUAL_MAX_MS=120000
PI_VOICE_MAX_AUDIO_SECONDS=120
```

## Important files

```text
src/index.ts             extension entry, Ctrl+Space, /vad, /tts
src/audio/mic.ts         mic capture + Silero VAD
src/sherpa-moonshine.ts  sherpa-onnx Moonshine Tiny STT
src/whisper-cpu.ts       whisper.cpp fallback STT
src/wav.ts               WAV helper
src/config.ts            standalone config
```

## Development

```bash
npm install
npx tsc --noEmit
```
