# pi-voice-vad-gemma runtime notes

See `docs/FLOW.md` for the canonical behavior.

This standalone extension uses Silero VAD to segment microphone audio and Gemma 4 native audio through local `llama-server` to transcribe each utterance. Pi responses remain terminal text; there is no TTS path.

## Pipeline

```text
mic/VAD → raw PCM buffer → ffmpeg 16 kHz mono WAV → /tmp/pi-voice/utterance.wav → base64 input_audio → llama-server /v1/chat/completions → transcript → strip leading "pi" → Pi
```

## Commands

```text
/vad start
/vad test
/vad stop
/vad status
/vad config
```

## Config

```text
~/.pi/voice-gemma.json
```

Defaults:

```json
{
  "endpoint": "http://127.0.0.1:8090/v1/chat/completions",
  "model": "gemma-4-e2b-audio-local",
  "apiKey": "llama-server",
  "ffmpegBinary": "ffmpeg",
  "utterancePath": "/tmp/pi-voice/utterance.wav",
  "timeoutMs": 120000,
  "maxTokens": 256,
  "prompt": "Transcribe this speech. Output only the text.",
  "micDevice": "plughw:CARD=Device,DEV=0",
  "vadSilenceMs": 800
}
```

## Audio test helper

```bash
python scripts/test-llama-server-audio.py sample.wav
```

## Development check

```bash
npx tsc --noEmit
```
