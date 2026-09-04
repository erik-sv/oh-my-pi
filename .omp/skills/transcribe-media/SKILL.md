---
name: transcribe-media
description: Transcribe any audio or video file to text using DeepInfra's Whisper API. Use when the user uploads an audio or video file (.m4a, .mp3, .wav, .mp4, .mkv, .mov, .webm, .ogg, .flac, .aac), asks to "transcribe", "get the transcript", "convert audio to text", or references needing the contents of a recording, voicemail, meeting, interview, podcast, or voice memo. Handles single-track and multi-track files, chunks large files to stay under API size limits, and produces both SRT and speaker-grouped plain text output.
argument-hint: "[file-path] [optional: -label \"Speaker Name\"]"
allowed-tools: Bash, Read, Write
---

# Transcribe Media

Transcribe any audio or video file to text using DeepInfra's hosted Whisper. Produces SRT (with timestamps) and a speaker-grouped plain-text transcript.

## Process

1. **Verify the file exists and probe it.** Use `ffprobe` to enumerate audio streams:

   ```bash
   ffprobe -v quiet -print_format json -show_streams -select_streams a "<file>"
   ```

   Parse the JSON. Each stream has `index`, optional `tags.title`, and codec info. Count the audio streams.

2. **Verify the API key is available.** The DeepInfra key must be in the environment or an `.env` file that the current working directory can reach:

   ```bash
   grep -l DEEPINFRA_API_KEY .env ~/.env /tmp/.env 2>/dev/null | head -1
   ```

   If absent, ask the user for it before proceeding. Never print the key back to the user.

3. **Decide the extraction strategy based on track count:**
   - **1 track** (most audio files, voice memos, podcasts): extract to MP3 as-is. Use a single label, default `Speaker 1`, or use `-label` if provided.
   - **2 tracks** (dual-mic recordings, split audio): extract both, transcribe independently, merge by timestamp. Label each `Speaker 1` / `Speaker 2` unless `-label` overrides are passed.
   - **3+ tracks** (conference recordings): skip track 1 (usually a pre-mixed stereo mix), extract the individual mic tracks.

4. **Check file size against the API limit.** DeepInfra Whisper accepts files up to ~200 MB, but encode quality and upload time degrade above ~50 MB. If any extracted MP3 is over 50 MB, split with ffmpeg into 10-minute segments:

   ```bash
   ffmpeg -y -i input.mp3 -f segment -segment_time 600 -c copy part_%02d.mp3
   ```

   Track the cumulative time offset so you can re-base SRT timestamps after transcription.

5. **Extract each audio track to MP3** at VBR quality 2 (near-CD, small files):

   ```bash
   ffmpeg -y -v error -i "<input>" -map 0:a:<audio_index> -c:a libmp3lame -q:a 2 "<output>.mp3"
   ```

   Run extractions in parallel when there are multiple tracks (background with `&`, then `wait`).

6. **Call the DeepInfra Whisper endpoint** for each extracted MP3:

   ```bash
   curl -s -X POST "https://api.deepinfra.com/v1/openai/audio/transcriptions" \
     -H "Authorization: Bearer $DEEPINFRA_API_KEY" \
     -F "model=openai/whisper-large-v3-turbo" \
     -F "response_format=srt" \
     -F "file=@<path>.mp3" \
     -o "<path>.srt"
   ```

   Check the response is valid SRT (starts with `1\n`). If the response is JSON with an `error` field, report the error and stop.

7. **Parse and merge SRT entries.** For each SRT file:
   - Extract `(index, start, end, text)` tuples.
   - Prefix each text with the track label: `Speaker 1: ...`.
   - Convert timestamps to seconds for sorting.
   - If the file was chunked, add the chunk's time offset to each timestamp before merging.

8. **Write two outputs** to a sibling directory named `Recording - <basename>/`:
   - `combined_transcript.srt` - chronologically merged, labeled SRT.
   - `<basename>.txt` - speaker-grouped plain text, with short `[MM:SS]` or `[H:MM:SS]` timestamps at each speaker change. Consecutive same-speaker lines merge into a single block.

9. **Report the output paths** and offer to read the `.txt` back into the conversation for analysis.

## Output format

Plain-text transcript format (LLM-optimized, speaker-grouped):

```
[00:00] Speaker 1: Opening sentence. Second sentence from the same speaker merged into one block.

[02:14] Speaker 2: Response from the second speaker.

[02:41] Speaker 1: Back to the first speaker.
```

SRT format (standard, for subtitles or time-stamped analysis):

```
1
00:00:00,000 -> 00:00:04,120
Speaker 1: Opening sentence.

2
00:00:04,120 -> 00:00:07,880
Speaker 1: Second sentence from the same speaker.
```

Final status message:

```
Transcribed N tracks, M minutes total.
SRT:  <path>/combined_transcript.srt
Text: <path>/<basename>.txt
```

## Constraints

- **Never print or log the API key.** DeepInfra keys are bearer tokens - treat them as secrets. Read from env or `.env`, never hardcode.
- **Do not re-download or re-extract on retry.** If intermediate MP3s already exist in the output directory, skip extraction and go straight to transcription. Users re-run this when the transcription step fails; redoing ffmpeg wastes minutes.
- **Preserve timestamps across chunk boundaries.** When splitting a long file, the second chunk's SRT times start at `00:00:00,000` but represent minute 10 of the original. Always offset before merging or the transcript will be out of order.
- **Use `libmp3lame -q:a 2`, not a fixed bitrate.** VBR produces smaller files at the same perceived quality; Whisper does not benefit from higher bitrates.
- **Do not add the `hello.mp3` preamble.** That pattern only matters for dual-speaker alignment with a specific recording workflow. A general transcription skill should not assume preamble files exist.
- **Ask before transcribing files over 30 minutes.** Whisper-large-v3-turbo costs roughly $0.04 per 10 minutes on DeepInfra. Long files can surprise the user. Confirm before billing.
- **For video files (.mp4, .mkv, .mov, .webm), only process audio streams.** Video streams are irrelevant and waste bandwidth if copied. The `-map 0:a:<i>` selector handles this automatically.
- **Fall back gracefully when ffprobe is missing.** If `ffprobe` is not on PATH, assume one audio track and skip stream selection.

## Example invocation

User says: "transcribe /tmp/meeting.m4a"

1. `ffprobe` shows 1 audio stream.
2. File is 49.9 MB, single track - no chunking needed, no track skipping.
3. Extract to `Recording - meeting/track_0_Speaker_1.mp3`.
4. POST to DeepInfra, response_format=srt.
5. Parse SRT, label as `Speaker 1`, write `combined_transcript.srt` and `meeting.txt`.
6. Report both paths, offer to read the `.txt` back.
