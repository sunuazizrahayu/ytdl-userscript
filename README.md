# YTDL

A Tampermonkey userscript that adds a format picker above the YouTube player. Pick a quality, download video and audio separately, or let the script merge them into a single MP4 — no ffmpeg, no re-encoding.

> Use this only for content you own or have permission to download.

## Features

- **Download button above the video** — placed outside the player frame, follows the normal, theater, and fullscreen layouts.
- **Complete format list** — every available video quality (144p–4K), video-only, audio-only, and pre-muxed streams, with codec, FPS, resolution, and size.
- **Automatic video + audio merge** — downloads the best MP4 video and AAC audio, then muxes them into one standard progressive MP4 in the browser.
- **Original audio only** — videos with YouTube auto-dubbing expose several audio tracks with the same itag. The script keeps the original-language track and never silently selects a dubbed one.
- **Persistent progress** — download progress stays visible after closing/reopening the panel, on SPA navigation, and while other downloads run.
- **Concurrent downloads** — start multiple rows at once; the UI does not block with modal toasts.
- **Resilient transfers** — mid-download `403` responses refresh the media URL and continue from the same byte offset; `NetworkError` retries preserve received data. Whole-file restart is a last resort.
- **Hideable button** — close it with `✕`; restore via the `⬇` pill in the bottom-right corner, `Alt+Shift+D`, or `Alt+D`.

## Installation

1. Install [Tampermonkey](https://www.tampermonkey.net/) (or a compatible userscript manager).
2. Add the script — either:
   - copy the contents of [`ytdl.js`](./ytdl.js) and paste them into a new Tampermonkey script, or
   - open the [latest release](https://github.com/sunuazizrahayu/ytdl-userscript/releases/latest/download/ytdl.user.js) and confirm the installation.
3. Open YouTube. The console should show a `[YT-DL] v… active on …` banner.

> The repository file stays `ytdl.js` for source browsing. One-click install and updates use the `ytdl.user.js` asset attached to each release.

### Requirements

- A Chromium-based browser or Firefox with Tampermonkey.
- Network access to `cdn.jsdelivr.net` — the script loads `mp4box@0.5.2` via `@require` to build the merged MP4.

## Updates

The script header points `@updateURL` and `@downloadURL` at the latest release asset, so Tampermonkey keeps the script up to date automatically (daily by default). To force a check: Tampermonkey dashboard → **Installed userscripts** → **YTDL** → **Check for updates**.

## Usage

1. Open any YouTube watch page.
2. Click **Download** above the player.
3. Choose a row:
   - **Video + Audio · automatic merge (MP4)** — best choice for a single playable file.
   - **Video + Audio · ready to use** — pre-muxed stream, usually 360p.
   - **Video only · no audio** — asks for confirmation before downloading.
   - **Audio only · M4A / Opus** — audio track only.
4. Progress is shown on the row and in the status chip. The result is saved with a filename like:
   `Title [1080p (video+audio)][137].mp4`

If the format list is empty or some rows have no URL, let the video play for a few seconds so YouTube publishes the stream URLs, then click `⟳`.

## How it works

- **Format sources** — the script queries YouTube's InnerTube player API with multiple clients and merges the responses. Client-specific URLs are matched per format identity (`itag` + audio track id + dubbing flag), not by itag alone.
- **Audio selection** — tracks marked `isAutoDubbed` are filtered out while an original track exists. `audioIsDefault` is only used for ordering, because some clients mark the dubbed track as default.
- **Progressive MP4 muxer** — the script writes a normal MP4 (`ftyp` + full `moov` + single `mdat`) with complete `stts`, `ctts`, `stsc`, `stsz`, `stco`, and `stss` tables. Samples are interleaved by decode time. This avoids the fragmented-MP4 layout that makes some TVs, phones, and desktop players drop the audio track.
- **No re-encoding** — video and audio bytes are copied as-is; only container tables are built.

## Limitations

- DRM-protected, rental, premiere, and some live streams are not supported.
- Files larger than 4 GB are rejected because the muxer uses 32-bit chunk offsets.
- A full page reload or closing the tab cancels in-flight downloads; SPA navigation does not.
- Merged output is MP4/H.264 or AV1 + AAC. If your player cannot handle AV1, pick an H.264 row (e.g. 1080p or lower, depending on the video).

## Development

The script is a single file: [`ytdl.js`](./ytdl.js).

- The source keeps a placeholder version (`0.0.0`). The release workflow injects the version from the tag into both `@version` and `const VERSION` before building `ytdl.user.js` (`v1.2.3` → `1.2.3`). Tag `vX.Y.Z` to publish.
- Diagnostics are available in the console via `window.__ytdl` (`version`, `state`, `captured`, `itags`).
- Set `const DEBUG = true` for verbose logging.
- Syntax check: `node --check ytdl.js`.

## Acknowledgements

Created by [@sunuazizrahayu](https://github.com/sunuazizrahayu), built with assistance from [OpenCode](https://opencode.ai).

## License

Released under the [MIT License](./LICENSE).

Copyright (c) 2026 sunuazizrahayu.
