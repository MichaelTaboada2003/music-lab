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

# Temas de la terminal. Cada render recibe su propia paleta: no se mutan
# variables globales, porque dos exportaciones pueden ejecutarse en paralelo.
VIDEO_THEMES = {
    "terminal": {
        "label": "Terminal clásica",
        "window": (13, 17, 23),
        "window_end": (13, 17, 23),
        "titlebar": (32, 37, 43),
        "titlebar_text": (140, 150, 160),
        "titlebar_line": (103, 126, 157),
        "title": (240, 200, 40),
        "artist": (110, 210, 130),
        "lyric": (60, 220, 220),
        "lyric_current": (228, 255, 255),
        "lyric_future": (76, 91, 111),
        "cursor": (180, 240, 240),
        "prompt": (100, 200, 130),
    },
    "midnight": {
        "label": "Medianoche eléctrica",
        "window": (6, 12, 30),
        "window_end": (17, 43, 82),
        "titlebar": (17, 31, 61),
        "titlebar_text": (176, 201, 242),
        "titlebar_line": (85, 126, 196),
        "title": (192, 215, 255),
        "artist": (111, 220, 255),
        "lyric": (99, 240, 255),
        "lyric_current": (239, 253, 255),
        "lyric_future": (99, 130, 171),
        "cursor": (154, 246, 255),
        "prompt": (137, 189, 255),
    },
    "sunset": {
        "label": "Atardecer",
        "window": (43, 12, 34),
        "window_end": (105, 35, 53),
        "titlebar": (83, 31, 55),
        "titlebar_text": (255, 204, 205),
        "titlebar_line": (223, 104, 131),
        "title": (255, 215, 139),
        "artist": (255, 155, 179),
        "lyric": (255, 173, 116),
        "lyric_current": (255, 245, 221),
        "lyric_future": (181, 112, 127),
        "cursor": (255, 213, 144),
        "prompt": (255, 180, 110),
    },
    "cloud": {
        "label": "Nube clara",
        "window": (245, 243, 237),
        "window_end": (220, 236, 249),
        "titlebar": (255, 255, 255),
        "titlebar_text": (72, 89, 110),
        "titlebar_line": (177, 196, 216),
        "title": (48, 67, 98),
        "artist": (51, 127, 116),
        "lyric": (17, 131, 151),
        "lyric_current": (8, 64, 82),
        "lyric_future": (121, 145, 164),
        "cursor": (22, 113, 133),
        "prompt": (54, 140, 103),
    },
}
COLOR_DOT_RED = (255, 95, 86)
COLOR_DOT_YELLOW = (255, 189, 46)
COLOR_DOT_GREEN = (39, 201, 63)
TERMINAL_TITLE = "NovaLyrics"

# La terminal ocupa el lienzo 9:16 completo: no hay un marco dentro de otro
# ni franjas laterales que TikTok pueda percibir como contenido vacío.
WINDOW_BOUNDS = (0, 0, *VIDEO_SIZE)

_FONT_MONO_BOLD = ["Menlo-Bold", "DejaVuSansMono-Bold", "Courier New Bold", "CourierNewPS-BoldMT"]
_FONT_MONO = ["Menlo-Regular", "Menlo", "DejaVuSansMono", "Courier New", "CourierNewPSMT"]

# Familias disponibles sin depender de descargar fuentes. Las rutas de macOS
# dan resultado consistente localmente; las alternativas DejaVu mantienen la
# exportación portable en otros sistemas.
FONT_FAMILIES = {
    "mono": {
        "label": "Monoespaciada",
        "normal": _FONT_MONO,
        "bold": _FONT_MONO_BOLD,
    },
    "modern": {
        "label": "Moderna",
        "normal": ["/System/Library/Fonts/Avenir.ttc", "Avenir.ttc", "DejaVuSans"],
        "bold": ["/System/Library/Fonts/Avenir Next.ttc", "Avenir Next.ttc", "DejaVuSans-Bold"],
    },
    "editorial": {
        "label": "Editorial",
        "normal": ["/System/Library/Fonts/Supplemental/Georgia.ttf", "Georgia.ttf", "DejaVuSerif"],
        "bold": ["/System/Library/Fonts/Supplemental/Georgia Bold.ttf", "Georgia Bold.ttf", "DejaVuSerif-Bold"],
    },
}

# La escala afecta título, artista y letra. Ajustar todas en conjunto impide
# que los metadatos se vean desproporcionados respecto a la estrofa activa.
FONT_SIZES = {
    "compact": {"label": "Compacta", "scale": 0.84},
    "balanced": {"label": "Equilibrada", "scale": 1.0},
    "large": {"label": "Grande", "scale": 1.20},
}

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


def _truncate_text(draw, text, font, max_width):
    """Evita que metadatos importados invadan el encuadre vertical."""
    if _text_width(draw, text, font) <= max_width:
        return text
    suffix = "..."
    shortened = text
    while shortened and _text_width(draw, shortened + suffix, font) > max_width:
        shortened = shortened[:-1]
    return (shortened.rstrip() + suffix) if shortened else suffix


def _theme_for(name):
    """Devuelve la paleta solicitada o un error claro para la API y CLI."""
    try:
        return VIDEO_THEMES[name]
    except KeyError as exc:
        choices = ", ".join(VIDEO_THEMES)
        raise ValueError(f"El tema debe ser uno de: {choices}.") from exc


def _font_family_for(name):
    try:
        return FONT_FAMILIES[name]
    except KeyError as exc:
        choices = ", ".join(FONT_FAMILIES)
        raise ValueError(f"La fuente debe ser una de: {choices}.") from exc


def _font_size_for(name):
    try:
        return FONT_SIZES[name]
    except KeyError as exc:
        choices = ", ".join(FONT_SIZES)
        raise ValueError(f"El tamaño debe ser uno de: {choices}.") from exc


def _vertical_gradient(video_size, top_color, bottom_color):
    """Crea el fondo vertical de un tema una sola vez por exportación."""
    width, height = video_size
    top = np.array(top_color, dtype=np.float32)
    bottom = np.array(bottom_color, dtype=np.float32)
    blend = np.linspace(0, 1, height, dtype=np.float32)[:, None]
    row = (top + (bottom - top) * blend).astype(np.uint8)
    pixels = np.broadcast_to(row[:, None, :], (height, width, 3)).copy()
    return Image.fromarray(pixels, "RGB")


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


def _draw_window_chrome(draw, fonts, theme, bounds=WINDOW_BOUNDS):
    left, top, right, _ = bounds
    width = right - left
    font_bar = fonts["bar"]
    bar_h = 74
    draw.rectangle([left, top, right, top + bar_h], fill=theme["titlebar"])
    draw.line([left, top + bar_h, right, top + bar_h], fill=theme["titlebar_line"], width=2)
    # Tres puntos estilo macOS
    cy = top + bar_h // 2
    for idx, color in enumerate((COLOR_DOT_RED, COLOR_DOT_YELLOW, COLOR_DOT_GREEN)):
        cx = left + 40 + idx * 40
        r = 12
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    # El nombre de la terminal es parte de la identidad visual del video;
    # no debe cambiar según la canción ni el estilo de letra seleccionado.
    label = TERMINAL_TITLE
    w = _text_width(draw, label, font_bar)
    draw.text((left + (width - w) / 2, top + (bar_h - font_bar.size) / 2 - 2), label, font=font_bar, fill=theme["titlebar_text"])
    return top + bar_h


def build_karaoke_scene(fonts, title=None, artist=None, video_size=VIDEO_SIZE,
                        lyric_style="karaoke", theme_name="terminal"):
    """Construye una terminal full-bleed, idéntica al lienzo final vertical."""
    theme = _theme_for(theme_name)
    base = _vertical_gradient(video_size, theme["window"], theme["window_end"])
    draw = ImageDraw.Draw(base)
    left, top, right, _ = WINDOW_BOUNDS
    _draw_window_chrome(draw, fonts, theme=theme, bounds=WINDOW_BOUNDS)

    y = top + 150
    if title:
        font_title = fonts["title"]
        prompt = "> "
        title_text = _truncate_text(draw, title, font_title, (right - left) * 0.78)
        total_w = _text_width(draw, prompt, font_title) + _text_width(draw, title_text, font_title)
        x = left + (right - left - total_w) / 2
        draw.text((x, y), prompt, font=font_title, fill=theme["prompt"])
        draw.text((x + _text_width(draw, prompt, font_title), y), title_text, font=font_title, fill=theme["title"])
        y += font_title.size + 18
    if artist:
        font_artist = fonts["artist"]
        text = _truncate_text(draw, f"por {artist}", font_artist, (right - left) * 0.72)
        w = _text_width(draw, text, font_artist)
        draw.text((left + (right - left - w) / 2, y), text, font=font_artist, fill=theme["artist"])

    return base


def make_karaoke_frame(stanzas, current_time, fonts, title=None, artist=None,
                       video_size=VIDEO_SIZE, scene_image=None,
                       lyric_style="karaoke", theme_name="terminal"):
    width, height = video_size
    img = scene_image.copy() if scene_image is not None else build_karaoke_scene(
        fonts, title=title, artist=artist, video_size=video_size,
        lyric_style=lyric_style, theme_name=theme_name,
    )
    draw = ImageDraw.Draw(img)
    theme = _theme_for(theme_name)

    stanza = _active_stanza(stanzas, current_time)
    if not stanza:
        return np.array(img)

    font_lyric = fonts.get("lyric")
    lyric_size = font_lyric.size
    line_height = int(lyric_size * 1.7)
    left, _, right, _ = WINDOW_BOUNDS
    max_w = (right - left) - 2 * MARGIN_X
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
        x = left + ((right - left) - seg_w) / 2
        for word in seg_words:
            wtext = word["text"]
            w_width = _text_width(draw, wtext, font_lyric)
            if current_time >= word["end"]:
                draw.text((x, y_cursor), wtext, font=font_lyric, fill=theme["lyric"])
                cursor_pos = (x + w_width + 4, y_cursor)
            elif current_time >= word["start"]:
                draw.text((x, y_cursor), wtext, font=font_lyric, fill=theme["lyric_current"], stroke_width=1, stroke_fill=theme["cursor"])
                cursor_pos = (x + w_width + 4, y_cursor)
            elif lyric_style == "karaoke":
                draw.text((x, y_cursor), wtext, font=font_lyric, fill=theme["lyric_future"])
            x += w_width + space_w
        y_cursor += line_height

    # Cursor de bloque parpadeante (0.4s encendido / 0.4s apagado).
    if cursor_pos and int(current_time / 0.4) % 2 == 0:
        cx, cy = cursor_pos
        block_w = int(lyric_size * 0.55)
        block_h = int(lyric_size * 1.05)
        draw.rectangle([cx, cy + 6, cx + block_w, cy + 6 + block_h], fill=theme["cursor"])

    return np.array(img)


def _build_fonts(font_family="mono", font_size="balanced"):
    family = _font_family_for(font_family)
    scale = _font_size_for(font_size)["scale"]

    def scaled(base_size):
        return max(12, round(base_size * scale))

    return {
        "bar": _load_font(family["normal"], scaled(26)),
        "title": _load_font(family["bold"], scaled(52)),
        "artist": _load_font(family["normal"], scaled(36)),
        "lyric": _load_font(family["bold"], scaled(44)),
    }


def create_tiktok_video(audio_source, lyrics_path, output_path, language="es",
                         model="small", force_sync=False, start_time=None,
                         end_time=None, title=None, artist=None,
                         vad="auditok", separate_vocals=True,
                         lyric_style="karaoke",
                         theme="terminal",
                         font_family="mono", font_size="balanced",
                         progress_cb=None):
    if lyric_style not in {"karaoke", "typing"}:
        raise ValueError("El formato de letra debe ser 'karaoke' o 'typing'.")
    _theme_for(theme)
    _font_family_for(font_family)
    _font_size_for(font_size)
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
    fonts = _build_fonts(font_family=font_family, font_size=font_size)
    _pc("Componiendo escena", 94)
    scene_image = build_karaoke_scene(
        fonts, title=title, artist=artist, lyric_style=lyric_style, theme_name=theme,
    )

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
        return make_karaoke_frame(
            stanzas, t + frag_start, fonts, title=title, artist=artist,
            scene_image=scene_image, lyric_style=lyric_style, theme_name=theme,
        )

    video_clip = VideoClip(make_frame, duration=duration)
    video_clip = video_clip.with_audio(trimmed_audio)

    # 5. Escribir archivo final. MoviePy usa proglog; con un logger a medida
    #    convertimos el índice de frames en un porcentaje real que el
    #    backend expone al frontend.
    _pc("Renderizando video", 0)
    logger = _MoviepyProgressLogger(_pc) if progress_cb else "bar"
    print(f"Exportando {output_path}...")
    video_clip.write_videofile(
        str(output_path), fps=30, codec="libx264", audio_codec="aac",
        ffmpeg_params=["-crf", "18", "-movflags", "+faststart"], logger=logger
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
    parser.add_argument("--lyric-style", choices=("karaoke", "typing"), default="karaoke")
    parser.add_argument("--theme", choices=tuple(VIDEO_THEMES), default="terminal", help="Tema visual del video")
    parser.add_argument("--font-family", choices=tuple(FONT_FAMILIES), default="mono", help="Familia tipográfica de la letra")
    parser.add_argument("--font-size", choices=tuple(FONT_SIZES), default="balanced", help="Escala de tipografía")
    parser.add_argument("--vad", default="auditok", help="VAD: auditok, silero, o 'none' para desactivar.")
    parser.add_argument("--no-separacion", action="store_true", help="No aislar la voz con Demucs.")

    args = parser.parse_args()
    vad_arg = None if str(args.vad).lower() in ("none", "no", "off", "") else args.vad
    create_tiktok_video(
        args.audio, args.letra, args.output,
        language=args.language, model=args.model, force_sync=args.force_sync,
        start_time=args.start, end_time=args.end, title=args.titulo, artist=args.artista,
        vad=vad_arg, separate_vocals=not args.no_separacion, lyric_style=args.lyric_style,
        theme=args.theme, font_family=args.font_family, font_size=args.font_size,
    )
