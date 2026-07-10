"""
tiktok_generator.py
=======================
Genera un video vertical (estilo TikTok/Reels) que REPLICA el aspecto de
ejecutar el karaoke en la terminal (lyrics.py): dibuja una ventana de
terminal (barra de título con los tres puntos, fondo oscuro, fuente
monoespaciada) y va revelando la letra palabra por palabra en cian, con un
cursor de bloque parpadeante, igual que la vista de consola.

También permite recortar un fragmento del audio (por ejemplo, solo el
coro) con start_time/end_time en segundos: el video dura únicamente ese
fragmento, pero el texto sigue perfectamente sincronizado porque los
tiempos de la letra son absolutos respecto al audio completo.
"""

import argparse
from pathlib import Path

from moviepy import VideoClip, AudioFileClip
from PIL import Image, ImageDraw, ImageFont
import numpy as np

from lyrics_sync import align_lyrics_to_audio
from audio_downloader import resolve_audio_source

# MoviePy usa proglog para reportar el progreso del render. Con un logger
# a medida traducimos el índice de frames a un porcentaje que enviamos al
# `progress_cb` para que el frontend lo muestre en tiempo real.
try:
    from proglog import ProgressBarLogger
except ImportError:  # pragma: no cover
    ProgressBarLogger = None


class _MoviepyProgressLogger(ProgressBarLogger if ProgressBarLogger else object):
    """Traduce los eventos de proglog en llamadas a `progress_cb(phase, pct)`.
    Solo reacciona al avance del bar principal ("t"/"main") de MoviePy."""

    def __init__(self, progress_cb):
        if ProgressBarLogger:
            super().__init__()
        self._cb = progress_cb

    def bars_callback(self, bar, attr, value, old_value=None):
        if attr != "index":
            return
        info = self.bars.get(bar) or {}
        total = info.get("total") or 0
        if not total:
            return
        pct = max(0.0, min(100.0, value / total * 100.0))
        self._cb("Renderizando video", pct)

VIDEO_SIZE = (1080, 1920)
MARGIN_X = 70

# Paleta estilo terminal / Rich (la que usa lyrics.py en consola).
COLOR_WINDOW = (13, 17, 23)       # fondo de la "ventana" de terminal
COLOR_TITLEBAR = (32, 37, 43)     # barra superior de la ventana
COLOR_TITLEBAR_TEXT = (140, 150, 160)
COLOR_DOT_RED = (255, 95, 86)
COLOR_DOT_YELLOW = (255, 189, 46)
COLOR_DOT_GREEN = (39, 201, 63)
COLOR_TITLE = (240, 200, 40)      # título de la canción (amarillo, como Rich)
COLOR_ARTIST = (110, 210, 130)    # artista (verde)
COLOR_LYRIC = (60, 220, 220)      # letra revelada (cian, "bold cyan" de Rich)
COLOR_CURSOR = (180, 240, 240)
COLOR_PROMPT = (100, 200, 130)

_FONT_MONO_BOLD = ["Menlo-Bold", "DejaVuSansMono-Bold", "Courier New Bold", "CourierNewPS-BoldMT"]
_FONT_MONO = ["Menlo-Regular", "Menlo", "DejaVuSansMono", "Courier New", "CourierNewPSMT"]

_FONT_CACHE = {}


def _load_font(candidates, size):
    key = (tuple(candidates), size)
    if key in _FONT_CACHE:
        return _FONT_CACHE[key]
    font = None
    for name in candidates:
        try:
            font = ImageFont.truetype(name, size)
            break
        except IOError:
            continue
    if font is None:
        font = ImageFont.load_default()
    _FONT_CACHE[key] = font
    return font


def _text_width(draw, text, font):
    bbox = draw.textbbox((0, 0), text, font=font)
    return bbox[2] - bbox[0]


def _fit_lyric_font(draw, stanza, max_width):
    pass # Ya no se usa, el texto ahora hace wrap automático


def _active_stanza(stanzas, current_time):
    """Última estrofa cuya primera palabra ya empezó a sonar (mismo criterio
    que lyrics.py: mantiene la estrofa en pantalla durante los instrumentales
    en vez de avanzar)."""
    active = None
    for stanza in stanzas:
        if not stanza:
            continue
        if stanza[0]["start"] <= current_time:
            active = stanza
        else:
            break
    return active


def _draw_window_chrome(draw, fonts, video_size, subtitle="python lyrics.py"):
    width, _ = video_size
    font_bar = fonts["bar"]
    bar_h = 74
    draw.rectangle([0, 0, width, bar_h], fill=COLOR_TITLEBAR)
    # Tres puntos estilo macOS
    cy = bar_h // 2
    for idx, color in enumerate((COLOR_DOT_RED, COLOR_DOT_YELLOW, COLOR_DOT_GREEN)):
        cx = 40 + idx * 40
        r = 12
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    label = f"music-lab — {subtitle}"
    w = _text_width(draw, label, font_bar)
    draw.text(((width - w) / 2, (bar_h - font_bar.size) / 2 - 2), label, font=font_bar, fill=COLOR_TITLEBAR_TEXT)
    return bar_h


def make_karaoke_frame(stanzas, current_time, fonts, title=None, artist=None,
                       video_size=VIDEO_SIZE):
    width, height = video_size
    img = Image.new("RGB", video_size, color=COLOR_WINDOW)
    draw = ImageDraw.Draw(img)

    _draw_window_chrome(draw, fonts, video_size)

    # Encabezado: prompt + título (amarillo) y artista (verde), como lyrics.py.
    y = 150
    if title:
        font_title = fonts["title"]
        prompt = "> "
        title_text = title
        total_w = _text_width(draw, prompt, font_title) + _text_width(draw, title_text, font_title)
        x = (width - total_w) / 2
        draw.text((x, y), prompt, font=font_title, fill=COLOR_PROMPT)
        x += _text_width(draw, prompt, font_title)
        draw.text((x, y), title_text, font=font_title, fill=COLOR_TITLE)
        y += font_title.size + 18
    if artist:
        font_artist = fonts["artist"]
        text = f"por {artist}"
        w = _text_width(draw, text, font_artist)
        draw.text(((width - w) / 2, y), text, font=font_artist, fill=COLOR_ARTIST)

    stanza = _active_stanza(stanzas, current_time)
    if not stanza:
        return np.array(img)

    font_lyric = fonts.get("lyric")
    lyric_size = font_lyric.size
    line_height = int(lyric_size * 1.7)
    max_w = width - 2 * MARGIN_X
    space_w = _text_width(draw, " ", font_lyric)

    # Pre-envolver las líneas largas
    wrapped_lines = []
    for line in stanza:
        words = line["words"] or [{"text": line["text"], "start": line["start"], "end": line["end"]}]
        current_segment = []
        current_w = 0
        for word in words:
            w_w = _text_width(draw, word["text"], font_lyric)
            if current_segment and current_w + space_w + w_w > max_w:
                wrapped_lines.append((current_segment, current_w))
                current_segment = [word]
                current_w = w_w
            else:
                current_w += (space_w + w_w) if current_segment else w_w
                current_segment.append(word)
        if current_segment:
            wrapped_lines.append((current_segment, current_w))

    n_lines = len(wrapped_lines)
    block_height = n_lines * line_height
    y_cursor = (height - block_height) / 2 + 40
    cursor_pos = None

    for seg_words, seg_w in wrapped_lines:
        x = (width - seg_w) / 2
        for word in seg_words:
            wtext = word["text"]
            w_width = _text_width(draw, wtext, font_lyric)
            if current_time >= word["start"]:
                draw.text((x, y_cursor), wtext, font=font_lyric, fill=COLOR_LYRIC)
                cursor_pos = (x + w_width + 4, y_cursor)
            x += w_width + space_w
        y_cursor += line_height

    # Cursor de bloque parpadeante (0.4s encendido / 0.4s apagado).
    if cursor_pos and int(current_time / 0.4) % 2 == 0:
        cx, cy = cursor_pos
        block_w = int(lyric_size * 0.55)
        block_h = int(lyric_size * 1.05)
        draw.rectangle([cx, cy + 6, cx + block_w, cy + 6 + block_h], fill=COLOR_CURSOR)

    return np.array(img)


def _build_fonts():
    return {
        "bar": _load_font(_FONT_MONO, 26),
        "title": _load_font(_FONT_MONO_BOLD, 52),
        "artist": _load_font(_FONT_MONO, 36),
        "lyric": _load_font(_FONT_MONO_BOLD, 44),
    }


def create_tiktok_video(audio_source, lyrics_path, output_path, language="es",
                         model="small", force_sync=False, start_time=None,
                         end_time=None, title=None, artist=None,
                         vad="auditok", separate_vocals=True,
                         progress_cb=None):
    def _pc(phase, pct=None):
        if progress_cb:
            try:
                progress_cb(phase, pct)
            except Exception:
                pass

    # 1. Resolver el audio (si es URL, se descarga primero como mp3).
    _pc("Preparando audio", 2)
    audio_path = resolve_audio_source(audio_source, output_dir=Path(lyrics_path).parent)

    # 2. Alinear la letra real del .txt con el tiempo real del audio.
    data = align_lyrics_to_audio(
        str(audio_path), lyrics_path, language=language, model_name=model, force=force_sync,
        vad=vad, separate_vocals=separate_vocals,
        progress_cb=progress_cb,
    )
    if not data.get("quality", {}).get("playable"):
        raise ValueError(
            "La sincronización no tiene calidad suficiente para exportar. "
            "Revisa la letra y vuelve a sincronizar antes de generar el video."
        )
    stanzas = data["stanzas"]
    fonts = _build_fonts()

    # 3. Cargar audio y resolver el fragmento a exportar (por defecto, todo).
    audio_clip = AudioFileClip(str(audio_path))
    full_duration = audio_clip.duration

    frag_start = max(0.0, start_time) if start_time is not None else 0.0
    frag_end = min(full_duration, end_time) if end_time is not None else full_duration
    if frag_end <= frag_start:
        raise ValueError("El fragmento seleccionado no es válido: el fin debe ser mayor que el inicio.")

    trimmed_audio = audio_clip.subclipped(frag_start, frag_end)
    duration = frag_end - frag_start

    print(f"Generando video ({frag_start:.1f}s - {frag_end:.1f}s de {full_duration:.1f}s totales)...")

    # 4. Cada frame usa el tiempo ABSOLUTO respecto al audio original, para
    #    que la letra siga sincronizada aunque exportemos solo un fragmento.
    def make_frame(t):
        return make_karaoke_frame(stanzas, t + frag_start, fonts, title=title, artist=artist)

    video_clip = VideoClip(make_frame, duration=duration)
    video_clip = video_clip.with_audio(trimmed_audio)

    # 5. Escribir archivo final. MoviePy usa proglog; con un logger a medida
    #    convertimos el índice de frames en un porcentaje real que el
    #    backend expone al frontend.
    _pc("Renderizando video", 0)
    logger = _MoviepyProgressLogger(_pc) if progress_cb else "bar"
    print(f"Exportando {output_path}...")
    video_clip.write_videofile(
        str(output_path), fps=60, codec="libx264", audio_codec="aac", logger=logger
    )
    print("¡Video generado exitosamente!")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Generador automático de TikToks de canciones (estética terminal)")
    parser.add_argument("audio", help="Ruta local o URL (YouTube, etc.) del audio (mp3, wav)")
    parser.add_argument("letra", help="Ruta al archivo .txt con la letra real de la canción")
    parser.add_argument("-o", "--output", help="Ruta de salida del video mp4", default="tiktok_output.mp4")
    parser.add_argument("-l", "--language", help="Idioma (ej. en, es)", default="es")
    parser.add_argument("-m", "--model", help="Modelo Whisper a usar (tiny, base, small, medium...)", default="small")
    parser.add_argument("--force-sync", action="store_true", help="Fuerza re-transcripción aunque exista cache")
    parser.add_argument("--start", type=float, default=None, help="Segundo de inicio del fragmento a exportar")
    parser.add_argument("--end", type=float, default=None, help="Segundo de fin del fragmento a exportar")
    parser.add_argument("-t", "--titulo", default=None, help="Título a mostrar en el video")
    parser.add_argument("-a", "--artista", default=None, help="Artista a mostrar en el video")
    parser.add_argument("--vad", default="auditok", help="VAD: auditok, silero, o 'none' para desactivar.")
    parser.add_argument("--no-separacion", action="store_true", help="No aislar la voz con Demucs.")

    args = parser.parse_args()
    vad_arg = None if str(args.vad).lower() in ("none", "no", "off", "") else args.vad
    create_tiktok_video(
        args.audio, args.letra, args.output,
        language=args.language, model=args.model, force_sync=args.force_sync,
        start_time=args.start, end_time=args.end, title=args.titulo, artist=args.artista,
        vad=vad_arg, separate_vocals=not args.no_separacion,
    )
