# Structure

## Layout

```
music-lab/
├── app/                   # FastAPI backend split by domain
│   ├── __init__.py        # creates the FastAPI instance and wires routers
│   ├── config.py          # BASE_DIR, dirs, .env loader, APP_BASE_URL
│   ├── utils.py           # shared helpers (ffprobe duration, path builders)
│   ├── jobs.py            # in-memory background jobs + GET /api/job/{id}
│   └── routers/           # one router per domain
│       ├── frontend.py    # / (index with cache busting), /favicon.ico
│       ├── songs.py       # /api/canciones, /api/descargar, /api/letra
│       ├── karaoke.py     # /api/karaoke, /api/sincronizar
│       ├── video.py       # /api/video, /api/videos
│       └── spotify.py     # /api/spotify/*, /callback (OAuth2)
├── music_lab.py           # Launcher: reads .env, spawns uvicorn, opens browser
├── audio_downloader.py    # Download audio from URLs (yt-dlp) → MP3
├── lyrics_sync.py         # Core: align lyrics (.txt) to audio via Whisper
├── vocal_separator.py     # Isolate vocals with Demucs (cached)
├── tiktok_generator.py    # Render the vertical "terminal-style" lyric video
├── requirements.txt       # Pinned deps (pip freeze from venv)
├── .env                   # Secrets and env config (gitignored)
├── static/                # Frontend (no build step)
│   ├── index.html         # Single-page UI (Reproductor, Letras, Video, Descubrir)
│   ├── js/                # ES modules (no bundler required)
│   │   ├── main.js        # Entry point: init + startup calls
│   │   ├── api.js         # HTTP helpers, setStatus, pollJob, refreshSongSelect
│   │   ├── karaoke.js     # Karaoke engine: wipe, RAF loop, plain lyrics
│   │   ├── player.js      # Audio player, playlist, search
│   │   ├── lyrics.js      # Letras view
│   │   ├── studio.js      # Video view: sync + generation
│   │   ├── discover.js    # Descubrir (Spotify)
│   │   ├── visualizer.js  # Aurora Web Audio visualizer
│   │   └── nav.js         # SPA navigation + hash routing
│   └── style.css
├── canciones/             # Downloaded MP3s (gitignored)
├── letras/                # <song>.txt lyrics + <song>.sync.json sync cache
├── vocals/                # <song>.vocals.wav isolated vocals cache (gitignored)
└── videos/                # Generated MP4s (gitignored)
```

## Backend architecture

- `uvicorn app:app` imports the `app` package. `app/__init__.py` creates the
  FastAPI instance, applies middleware, mounts static dirs (`/canciones`,
  `/videos`, `/static`) and includes routers.
- Each router lives under `app/routers/` and owns one domain. To add a new
  endpoint, put it in the matching router (or create a new one) instead of
  bloating the main app.
- Shared helpers go in `app/utils.py`. Anything env-driven goes in
  `app/config.py`.
- Long-running work (Whisper transcription, MoviePy render) runs in a
  background thread via `app.jobs.start_job(fn)`. The task receives a
  `progress_cb(phase, pct)` callback used to expose live progress at
  `GET /api/job/{id}` for the frontend progress bar.
- Pipeline modules (`audio_downloader`, `lyrics_sync`, `vocal_separator`,
  `tiktok_generator`) stay at the project root. They are dual-use: importable
  libraries AND standalone CLIs (each has an `argparse` block).
- `lyrics_sync.align_lyrics_to_audio(...)` is the heart of the system: both
  the karaoke view and the video renderer consume its output so they always
  show the same thing at the same instant.

## Key conventions

- Songs are identified by their **stem** (filename without extension). A song,
  its lyrics, and its sync cache share the same stem:
  `canciones/<stem>.mp3`, `letras/<stem>.txt`, `letras/<stem>.sync.json`.
- Lyrics files: blank lines separate **stanzas**; each non-empty line is a line.
- The sync data structure is `{"stanzas": [[{text, start, end, words:[...]}]]}`.
  A `words` entry has `{text, start, end, synced}` where `synced` marks whether
  Whisper actually matched the word (reliable) vs. it was interpolated.
- Paths in pipeline modules are made absolute before processing, since Demucs
  may change the working directory.
- Frontend `app.js` is organized by view (Reproductor, Descargar, Letras,
  Karaoke, Video) with clear section banners; keep that structure when editing.

## Adding features

- New API endpoints go in the matching `app/routers/*.py` (or a new one).
  Never grow `app/__init__.py`.
- New processing logic belongs in a focused module at the root (like the
  existing pipeline files), exposed as an importable function and, ideally,
  a CLI entry point.
- Frontend changes are edited directly in `static/` (no bundler).
  New UI logic goes in the matching module under `static/js/`. New views get
  their own module (e.g. `static/js/settings.js`) and are imported in `main.js`.
