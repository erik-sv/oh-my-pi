---
name: generate-image
description: Generate and edit images using Google Gemini's image generation API. Use when the user wants to create, generate, design, or edit an image, icon, logo, banner, mockup, illustration, diagram, or any visual asset — or when they say things like "make me an image", "generate a logo", "create a banner", "design an icon", "edit this image", or "I need a visual for".
argument-hint: "[description of the image to generate]"
allowed-tools: Bash, Read, Write, Glob
---

# Generate Image

Create images using the Gemini image generation API via the bundled script at `${CLAUDE_SKILL_DIR}/scripts/generate.py`.

## Prerequisites

The script uses only Python stdlib (no pip install needed). It resolves `GEMINI_API_KEY` from (in order):
1. `GEMINI_API_KEY` environment variable
2. `~/.claude/.env.skills` (global — works across all projects)
3. `.env.skills` in the current working directory (project-scoped)

If not found in any location, tell the user to add it:
```
echo "GEMINI_API_KEY=their-key" >> ~/.claude/.env.skills
```
Get a key at https://aistudio.google.com/apikey (billing must be enabled for image generation).

## Usage

```bash
python3 ${CLAUDE_SKILL_DIR}/scripts/generate.py "prompt" [options]
```

| Flag | Default | Description |
|---|---|---|
| `-o, --output` | `generated.png` | Output file path |
| `-m, --model` | `gemini-3.1-flash-image-preview` | Model ID |
| `-s, --size` | `2K` | Resolution: `512`, `1K`, `2K`, `4K` |
| `-a, --aspect-ratio` | _(model decides)_ | e.g., `16:9`, `3:2`, `1:1`, `9:16` |
| `-i, --source-image` | _(none)_ | Source image for editing |

## Process

1. **Parse the user's request** into a detailed image generation prompt. Be specific — describe style, lighting, composition, colors, mood. More detail = better results.

2. **Choose output path** based on context:
   - If the user specifies a path, use it
   - If working in a project, save to a sensible location (e.g., `assets/`, `public/images/`, `static/`)
   - Otherwise save to working directory with a descriptive filename

3. **Run the script:**
   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/generate.py "A detailed prompt describing the image" -o output_path.png
   ```

4. **For image editing**, include the source with `-i`:
   ```bash
   python3 ${CLAUDE_SKILL_DIR}/scripts/generate.py "Make the background blue" -i source.png -o edited.png
   ```

5. **Show the result** — use the Read tool to display the generated image to the user.

6. **Iterate** if the user wants changes. For edits to an existing generated image, use `-i` with the previous output as the source.

## Prompt writing tips

- Be visually specific: "a minimalist flat-design icon of a shield with a checkmark, white on deep blue (#1a237e), no background, suitable for a 64px app icon"
- Specify style: photorealistic, watercolor, flat design, isometric, pixel art, line drawing, 3D render
- Specify what you DON'T want: "no text", "no background", "no people"
- For logos/icons: mention intended size, transparency needs, and where it will be used
- For UI assets: mention the design system context, color palette, and neighboring elements

## Available aspect ratios

`1:1`, `1:4`, `1:8`, `2:3`, `3:2`, `3:4`, `4:1`, `4:3`, `4:5`, `5:4`, `8:1`, `9:16`, `16:9`, `21:9`

Omit `-a` to let the model pick the best ratio for the content.

## Model options

| Model | Best for |
|---|---|
| `gemini-3.1-flash-image-preview` | Default. Fast, high-quality, 2K support |
| `gemini-3-pro-image-preview` | Studio-quality 4K, precise text rendering |

Only switch to pro when the user needs maximum quality or accurate text in images.
