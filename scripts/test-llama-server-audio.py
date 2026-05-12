#!/usr/bin/env python3
"""Test llama-server Gemma 4 audio transcription with a local WAV/MP3 file."""

from __future__ import annotations

import argparse
import base64
import json
import mimetypes
import urllib.request


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio_file")
    parser.add_argument("--endpoint", default="http://127.0.0.1:8090/v1/chat/completions")
    parser.add_argument("--model", default="gemma-4-E2B-it")
    parser.add_argument("--api-key", default="no-key")
    args = parser.parse_args()

    with open(args.audio_file, "rb") as f:
        data = base64.b64encode(f.read()).decode("ascii")

    mime, _ = mimetypes.guess_type(args.audio_file)
    fmt = "mp3" if mime in ("audio/mpeg", "audio/mp3") or args.audio_file.lower().endswith(".mp3") else "wav"

    payload = {
        "model": args.model,
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "input_audio", "input_audio": {"data": data, "format": fmt}},
                    {"type": "text", "text": "Transcribe this speech. Output only the text."},
                ],
            }
        ],
        "temperature": 0,
        "max_tokens": 256,
        "stream": False,
    }

    req = urllib.request.Request(
        args.endpoint,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {args.api_key}",
        },
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        obj = json.loads(res.read().decode("utf-8"))
    print(obj["choices"][0]["message"]["content"])


if __name__ == "__main__":
    main()
