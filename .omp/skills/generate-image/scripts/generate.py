#!/usr/bin/env python3
"""Generate images using Google Gemini image generation API."""

import argparse
import base64
import json
import os
import sys
import urllib.request
import urllib.error

DEFAULT_MODEL = "gemini-3.1-flash-image-preview"
DEFAULT_SIZE = "2K"
API_BASE = "https://generativelanguage.googleapis.com/v1beta/models"

ENV_SEARCH_PATHS = [
    os.path.join(os.path.expanduser("~"), ".claude", ".env.skills"),
    os.path.join(os.getcwd(), ".env.skills"),
]


def load_env_file(path: str) -> dict[str, str]:
    """Parse a .env file into a dict. Skips comments and blank lines."""
    env = {}
    if not os.path.isfile(path):
        return env
    with open(path) as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            if "=" in line:
                key, _, value = line.partition("=")
                env[key.strip()] = value.strip().strip("'\"")
    return env


def resolve_api_key() -> str:
    """Resolve GEMINI_API_KEY from env var or .env.skills files."""
    key = os.environ.get("GEMINI_API_KEY")
    if key:
        return key

    for path in ENV_SEARCH_PATHS:
        env = load_env_file(path)
        if "GEMINI_API_KEY" in env:
            return env["GEMINI_API_KEY"]

    print("Error: GEMINI_API_KEY not found.", file=sys.stderr)
    print("Searched: environment, " + ", ".join(ENV_SEARCH_PATHS), file=sys.stderr)
    print("Set it in ~/.claude/.env.skills or export GEMINI_API_KEY='key'", file=sys.stderr)
    print("Get a key at: https://aistudio.google.com/apikey", file=sys.stderr)
    sys.exit(1)


def generate_image(
    prompt: str,
    output: str,
    model: str = DEFAULT_MODEL,
    size: str = DEFAULT_SIZE,
    aspect_ratio: str | None = None,
    source_image: str | None = None,
) -> None:
    api_key = resolve_api_key()

    # Build content parts
    parts = []

    # If source image provided, include it for editing
    if source_image:
        if not os.path.isfile(source_image):
            print(f"Error: Source image not found: {source_image}", file=sys.stderr)
            sys.exit(1)

        ext = os.path.splitext(source_image)[1].lower()
        mime_map = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}
        mime_type = mime_map.get(ext, "image/png")

        with open(source_image, "rb") as f:
            img_b64 = base64.b64encode(f.read()).decode("utf-8")

        parts.append({"inlineData": {"mimeType": mime_type, "data": img_b64}})

    parts.append({"text": prompt})

    # Build image config
    image_config = {"imageSize": size}
    if aspect_ratio:
        image_config["aspectRatio"] = aspect_ratio

    # Build request body
    body = {
        "contents": [{"parts": parts}],
        "generationConfig": {
            "responseModalities": ["TEXT", "IMAGE"],
            "imageConfig": image_config,
        },
    }

    url = f"{API_BASE}/{model}:generateContent"

    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "x-goog-api-key": api_key,
        },
        method="POST",
    )

    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            result = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        error_body = e.read().decode("utf-8", errors="replace")
        try:
            error_json = json.loads(error_body)
            msg = error_json.get("error", {}).get("message", error_body)
        except json.JSONDecodeError:
            msg = error_body
        print(f"API error ({e.code}): {msg}", file=sys.stderr)
        sys.exit(1)

    # Extract image from response
    candidates = result.get("candidates", [])
    if not candidates:
        block_reason = result.get("promptFeedback", {}).get("blockReason", "unknown")
        print(f"No output generated. Block reason: {block_reason}", file=sys.stderr)
        sys.exit(1)

    parts_out = candidates[0].get("content", {}).get("parts", [])
    image_saved = False
    text_response = []

    for part in parts_out:
        if "inlineData" in part:
            img_bytes = base64.b64decode(part["inlineData"]["data"])
            with open(output, "wb") as f:
                f.write(img_bytes)
            image_saved = True
            print(f"Image saved: {output} ({len(img_bytes):,} bytes)")
        elif "text" in part:
            text_response.append(part["text"])

    if text_response:
        print("\n".join(text_response))

    if not image_saved:
        print("Warning: API returned no image data.", file=sys.stderr)
        print("Response parts:", json.dumps(parts_out, indent=2)[:500], file=sys.stderr)
        sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description="Generate images with Gemini API")
    parser.add_argument("prompt", help="Text prompt describing the image to generate")
    parser.add_argument("-o", "--output", default="generated.png", help="Output file path (default: generated.png)")
    parser.add_argument("-m", "--model", default=DEFAULT_MODEL, help=f"Model ID (default: {DEFAULT_MODEL})")
    parser.add_argument("-s", "--size", default=DEFAULT_SIZE, choices=["512", "1K", "2K", "4K"], help=f"Image size (default: {DEFAULT_SIZE})")
    parser.add_argument("-a", "--aspect-ratio", default=None, help="Aspect ratio (e.g., 16:9, 3:2). Omit to let model decide.")
    parser.add_argument("-i", "--source-image", default=None, help="Source image path for editing (optional)")

    args = parser.parse_args()
    generate_image(
        prompt=args.prompt,
        output=args.output,
        model=args.model,
        size=args.size,
        aspect_ratio=args.aspect_ratio,
        source_image=args.source_image,
    )


if __name__ == "__main__":
    main()
