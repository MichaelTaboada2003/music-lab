"""
tiktok_generator.py
=======================
Genera dos formatos de video independientes:

- Reproductor 16:9: replica el reproductor principal con carátula, metadatos,
  progreso, controles y letras sincronizadas desplazándose a su lado.
- Terminal 9:16: conserva la estética NovaLyrics orientada a TikTok/Reels.

También permite recortar un fragmento del audio (por ejemplo, solo el
coro) con start_time/end_time en segundos: el video dura únicamente ese
fragmento, pero el texto sigue perfectamente sincronizado porque los
tiempos de la letra son absolutos respecto al audio completo.
"""

import argparse
import math
from pathlib import Path

from moviepy import VideoClip, AudioFileClip
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps
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
PLAYER_VIDEO_SIZE = (1920, 1080)

# TikTok reserva una parte importante del lateral derecho y de la zona inferior
# para avatar, acciones y caption. La zona exacta cambia por dispositivo y por
# la longitud del caption; estos límites son deliberadamente conservadores para
# que título y letra respiren dentro del feed LTR sin dejar de usar todo el 9:16.
SAFE_LEFT = 86
SAFE_RIGHT = 886
SAFE_TOP = 164
SAFE_BOTTOM = 1510
SAFE_CONTENT_WIDTH = SAFE_RIGHT - SAFE_LEFT

# Temas de la terminal. Cada render recibe su propia paleta: no se mutan
# variables globales, porque dos exportaciones pueden ejecutarse en paralelo.
VIDEO_THEMES = {
    "terminal": {
        "label": "Terminal Signal",
        "pattern": "grid",
        "window": (7, 11, 15),
        "window_end": (10, 22, 25),
        "glow_a": (12, 112, 91),
        "glow_b": (12, 77, 112),
        "titlebar": (17, 24, 28),
        "titlebar_text": (177, 198, 195),
        "titlebar_line": (54, 108, 105),
        "title": (236, 250, 212),
        "artist": (113, 226, 174),
        "lyric": (76, 232, 202),
        "lyric_current": (228, 255, 255),
        "lyric_future": (80, 111, 112),
        "cursor": (146, 255, 225),
        "prompt": (95, 235, 170),
        "panel_line": (40, 114, 104),
        "grid": (23, 76, 71),
        "scan": (66, 214, 183),
        "status": (105, 255, 184),
    },
    "midnight": {
        "label": "Medianoche Neon",
        "pattern": "circuit",
        "window": (5, 8, 27),
        "window_end": (17, 17, 58),
        "glow_a": (47, 71, 255),
        "glow_b": (188, 49, 255),
        "titlebar": (13, 17, 48),
        "titlebar_text": (199, 207, 255),
        "titlebar_line": (78, 91, 194),
        "title": (236, 239, 255),
        "artist": (152, 165, 255),
        "lyric": (105, 229, 255),
        "lyric_current": (239, 253, 255),
        "lyric_future": (91, 100, 157),
        "cursor": (166, 247, 255),
        "prompt": (170, 143, 255),
        "panel_line": (78, 91, 194),
        "grid": (49, 57, 125),
        "scan": (104, 215, 255),
        "status": (202, 114, 255),
    },
    "sunset": {
        "label": "Atardecer Pulse",
        "pattern": "rays",
        "window": (35, 9, 28),
        "window_end": (84, 24, 39),
        "glow_a": (255, 84, 64),
        "glow_b": (255, 183, 75),
        "titlebar": (64, 20, 43),
        "titlebar_text": (255, 211, 207),
        "titlebar_line": (180, 78, 100),
        "title": (255, 244, 211),
        "artist": (255, 158, 171),
        "lyric": (255, 174, 105),
        "lyric_current": (255, 245, 221),
        "lyric_future": (151, 91, 107),
        "cursor": (255, 213, 144),
        "prompt": (255, 196, 105),
        "panel_line": (176, 76, 94),
        "grid": (122, 48, 68),
        "scan": (255, 148, 91),
        "status": (255, 201, 105),
    },
    "cloud": {
        "label": "Nube Frost",
        "pattern": "dots",
        "window": (226, 235, 242),
        "window_end": (192, 215, 229),
        "glow_a": (111, 208, 222),
        "glow_b": (174, 139, 224),
        "titlebar": (239, 245, 248),
        "titlebar_text": (54, 73, 91),
        "titlebar_line": (130, 159, 178),
        "title": (22, 42, 61),
        "artist": (28, 103, 112),
        "lyric": (18, 98, 118),
        "lyric_current": (5, 37, 51),
        "lyric_future": (93, 122, 139),
        "cursor": (13, 94, 112),
        "prompt": (46, 111, 104),
        "panel_line": (116, 151, 168),
        "grid": (142, 172, 187),
        "scan": (24, 121, 137),
        "status": (24, 121, 112),
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
    "compact": {
        "label": "Compacta",
        "scale": 0.84,
        "title": 54,
        "artist": 30,
        "lyric": {"normal": 58, "dense": 50, "very-dense": 42},
    },
    "balanced": {
        "label": "Equilibrada",
        "scale": 1.0,
        "title": 62,
        "artist": 35,
        "lyric": {"normal": 69, "dense": 55, "very-dense": 47},
    },
    "large": {
        "label": "Grande",
        "scale": 1.20,
        "title": 69,
        "artist": 40,
        "lyric": {"normal": 79, "dense": 62, "very-dense": 53},
    },
}

# Réplica en píxeles de las proporciones usadas por el preview CSS. Mantener
# estos valores explícitos evita que Pillow y el navegador evolucionen como
# dos composiciones diferentes.
CHROME_HEIGHT_RATIO = 0.082
HEADER_TOP_RATIO = 0.14
HEADER_WIDTH_RATIO = 0.80
LYRIC_WIDTH_RATIO = 0.69
LYRIC_CENTER_Y_RATIO = 0.60
LYRIC_LEADING = {"normal": 1.55, "dense": 1.52, "very-dense": 1.48}

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
    return Image.fromarray(pixels)


def _mix_color(a, b, amount):
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))


def _build_theme_background(video_size, theme):
    """Compone profundidad, luz ambiental y una firma gráfica por tema.

    Se calcula una sola vez por exportación. Los frames solo copian esta base y
    dibujan la información que cambia, evitando pagar gradientes complejos 30
    veces por segundo.
    """
    width, height = video_size
    base = np.asarray(
        _vertical_gradient(video_size, theme["window"], theme["window_end"]),
        dtype=np.float32,
    )
    yy, xx = np.ogrid[:height, :width]
    glows = (
        (theme["glow_a"], width * 0.16, height * 0.30, width * 0.48, height * 0.31, 0.22),
        (theme["glow_b"], width * 0.82, height * 0.72, width * 0.54, height * 0.38, 0.17),
    )
    for color, cx, cy, rx, ry, strength in glows:
        distance = ((xx - cx) / rx) ** 2 + ((yy - cy) / ry) ** 2
        weight = (np.exp(-distance * 2.15) * strength)[..., None]
        base = base * (1 - weight) + np.array(color, dtype=np.float32) * weight

    # Viñeta suave: centra atención sin convertir el fondo en una mancha negra.
    nx = (xx - width / 2) / (width / 2)
    ny = (yy - height / 2) / (height / 2)
    vignette = np.clip((nx * nx + ny * ny - 0.30) * 0.10, 0, 0.105)[..., None]
    base *= 1 - vignette
    image = Image.fromarray(np.clip(base, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(image)
    pattern = theme["pattern"]
    grid = _mix_color(theme["grid"], theme["window"], 0.46)

    if pattern == "grid":
        for x in range(30, width, 96):
            draw.line((x, 74, x, height), fill=grid, width=1)
        for y in range(170, height, 96):
            draw.line((0, y, width, y), fill=grid, width=1)
    elif pattern == "circuit":
        for idx, y in enumerate(range(210, height, 190)):
            elbow = 120 + (idx % 4) * 145
            draw.line((0, y, elbow, y, elbow + 72, y + 72, width, y + 72), fill=grid, width=2)
            draw.ellipse((elbow - 4, y - 4, elbow + 4, y + 4), fill=theme["grid"])
    elif pattern == "rays":
        origin = (width // 2, height + 240)
        for x in range(-540, width + 720, 180):
            draw.line((origin[0], origin[1], x, 120), fill=grid, width=2)
        draw.arc((-310, 1040, width + 310, 2200), 190, 350, fill=theme["grid"], width=3)
    elif pattern == "dots":
        for y in range(190, height, 76):
            offset = 28 if (y // 76) % 2 else 0
            for x in range(28 + offset, width, 76):
                draw.ellipse((x - 2, y - 2, x + 2, y + 2), fill=grid)

    return image


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
    left, top, right, bottom = bounds
    width = right - left
    height = bottom - top
    font_bar = fonts["bar"]
    bar_h = round(height * CHROME_HEIGHT_RATIO)
    draw.rectangle([left, top, right, top + bar_h], fill=theme["titlebar"])
    draw.line([left, top + bar_h, right, top + bar_h], fill=theme["titlebar_line"], width=4)
    # Tres puntos estilo macOS
    cy = top + bar_h // 2
    for idx, color in enumerate((COLOR_DOT_RED, COLOR_DOT_YELLOW, COLOR_DOT_GREEN)):
        cx = left + 54 + idx * 66
        r = 16
        draw.ellipse([cx - r, cy - r, cx + r, cy + r], fill=color)
    # El nombre de la terminal es parte de la identidad visual del video;
    # no debe cambiar según la canción ni el estilo de letra seleccionado.
    label = TERMINAL_TITLE
    w = _text_width(draw, label, font_bar)
    draw.text((left + (width - w) / 2, top + (bar_h - font_bar.size) / 2 - 1), label, font=font_bar, fill=theme["titlebar_text"])
    return top + bar_h


def _wrap_header_title(draw, title, font, max_width, prompt_width):
    """Envuelve el título como el span del preview, sin cortarlo con puntos."""
    words = title.split()
    if not words:
        return []
    lines = []
    current = []
    for word in words:
        available = max_width - (prompt_width if not lines else 0)
        candidate = " ".join((*current, word))
        if current and _text_width(draw, candidate, font) > available:
            lines.append(" ".join(current))
            current = [word]
        else:
            current.append(word)
    if current:
        lines.append(" ".join(current))
    if len(lines) <= 2:
        return lines
    # Dos líneas mantienen la jerarquía del preview; solo títulos extremos
    # reciben elipsis en la segunda línea.
    second = " ".join(lines[1:])
    return [lines[0], _truncate_text(draw, second, font, max_width)]


def _crop_rounded_cover(img_path, size=(520, 520), radius=28):
    try:
        raw = Image.open(img_path).convert("RGBA")
        raw = ImageOps.fit(raw, size, method=Image.Resampling.LANCZOS)
        mask = Image.new("L", size, 0)
        draw = ImageDraw.Draw(mask)
        draw.rounded_rectangle((0, 0, size[0], size[1]), radius=radius, fill=255)
        raw.putalpha(mask)
        return raw
    except Exception:
        return None


def _build_player_background(video_size, cover_path):
    """Replica el ambiente del reproductor usando la carátula como escena."""
    width, height = video_size
    try:
        cover = Image.open(cover_path).convert("RGB")
        background = ImageOps.fit(
            cover, (width, height), method=Image.Resampling.LANCZOS
        ).filter(ImageFilter.GaussianBlur(radius=72))
        background = Image.blend(
            background,
            Image.new("RGB", (width, height), (7, 8, 10)),
            0.68,
        )
    except Exception:
        background = _vertical_gradient(
            video_size, (18, 20, 24), (5, 6, 9)
        )

    # La página combina la carátula difuminada con un velo oscuro. Este brillo
    # verde discreto conserva la identidad del reproductor sin competir con la
    # letra activa.
    light = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    light_draw = ImageDraw.Draw(light)
    light_draw.ellipse(
        (-260, -180, 1040, 1160),
        fill=(30, 215, 96, 28),
    )
    light = light.filter(ImageFilter.GaussianBlur(radius=120))
    return Image.alpha_composite(background.convert("RGBA"), light).convert("RGB")


def _player_fonts():
    """Tipografía fija del reproductor; no hereda controles de la terminal."""
    family = FONT_FAMILIES["modern"]
    return {
        "meta": _load_font(family["bold"], 20),
        "title": _load_font(family["bold"], 46),
        "artist": _load_font(family["normal"], 27),
        "time": _load_font(family["normal"], 20),
        "lyric": _load_font(family["bold"], 54),
        "lyric_dim": _load_font(family["bold"], 48),
    }


def _format_clock(seconds):
    seconds = max(0, int(seconds or 0))
    return f"{seconds // 60}:{seconds % 60:02d}"


def _draw_player_controls(draw, center_x, center_y):
    """Controles SVG-equivalentes del reproductor principal."""
    dim = (170, 174, 184)
    accent = (30, 215, 96)
    # Botón anterior.
    x = center_x - 130
    draw.line((x - 14, center_y - 16, x - 14, center_y + 16), fill=dim, width=5)
    draw.line((x + 14, center_y - 18, x - 5, center_y, x + 14, center_y + 18), fill=dim, width=5, joint="curve")
    # Reproducción activa.
    r = 54
    draw.ellipse((center_x - r, center_y - r, center_x + r, center_y + r), fill=accent)
    draw.rounded_rectangle((center_x - 13, center_y - 20, center_x - 4, center_y + 20), radius=4, fill=(2, 12, 7))
    draw.rounded_rectangle((center_x + 4, center_y - 20, center_x + 13, center_y + 20), radius=4, fill=(2, 12, 7))
    # Botón siguiente.
    x = center_x + 130
    draw.line((x + 14, center_y - 16, x + 14, center_y + 16), fill=dim, width=5)
    draw.line((x - 14, center_y - 18, x + 5, center_y, x - 14, center_y + 18), fill=dim, width=5, joint="curve")


def build_player_scene(fonts, title=None, artist=None, video_size=PLAYER_VIDEO_SIZE,
                       theme_name="terminal", cover_path=None, audio_volume=1.0):
    del fonts, theme_name
    width, height = video_size
    fonts = _player_fonts()
    base = _build_player_background(video_size, cover_path)
    draw = ImageDraw.Draw(base)

    # Misma relación de columnas del reproductor principal: tarjeta de control
    # a la izquierda y escenario de karaoke a su lado.
    p_left, p_top, p_right, p_bottom = 40, 28, 690, height - 28
    card_w = p_right - p_left
    card_h = p_bottom - p_top
    card_overlay = Image.new("RGBA", (card_w, card_h), (0, 0, 0, 0))
    c_draw = ImageDraw.Draw(card_overlay)
    c_draw.rounded_rectangle(
        (0, 0, card_w - 1, card_h - 1),
        radius=42,
        fill=(10, 12, 15, 218),
        outline=(255, 255, 255, 30),
        width=2,
    )
    base.paste(card_overlay, (p_left, p_top), card_overlay)

    # Carátula: ocupa exactamente el ancho útil de la tarjeta.
    cover_size = 574
    cover_x = p_left + 38
    cover_y = p_top + 32
    cover_img = _crop_rounded_cover(
        cover_path, size=(cover_size, cover_size), radius=34
    ) if cover_path else None
    if cover_img:
        base.paste(cover_img, (cover_x, cover_y), cover_img)
    else:
        fallback_mask = Image.new("RGBA", (cover_size, cover_size), (24, 30, 38, 240))
        f_draw = ImageDraw.Draw(fallback_mask)
        f_draw.rounded_rectangle((0, 0, cover_size, cover_size), radius=34, fill=(24, 30, 38, 240), outline=(60, 75, 90), width=2)
        initials = "".join([w[0] for w in (title or "ML").split()[:2]]).upper()
        f_font = fonts["title"]
        f_w = _text_width(f_draw, initials, f_font)
        f_draw.text(((cover_size - f_w) / 2, (cover_size - f_font.size) / 2), initials, font=f_font, fill=(180, 200, 220))
        base.paste(fallback_mask, (cover_x, cover_y), fallback_mask)

    # Cabecera de estado idéntica a la tarjeta principal.
    txt_y = cover_y + cover_size + 36
    font_meta = fonts["meta"]
    draw.text((p_left + 38, txt_y), "AHORA SUENA", font=font_meta, fill=(142, 145, 155))
    status = "REPRODUCIENDO"
    status_w = _text_width(draw, status, font_meta)
    status_x = p_right - 38 - status_w
    draw.ellipse((status_x - 24, txt_y + 7, status_x - 12, txt_y + 19), fill=(30, 215, 96))
    draw.text((status_x, txt_y), status, font=font_meta, fill=(170, 173, 183))

    # Título y artista.
    font_title = fonts["title"]
    font_artist = fonts["artist"]
    txt_y += 42
    t_text = _truncate_text(draw, title or "Sin título", font_title, card_w - 76)
    draw.text((p_left + 38, txt_y), t_text, font=font_title, fill=(248, 249, 251))
    txt_y += 58
    a_text = _truncate_text(draw, artist or "", font_artist, card_w - 76)
    draw.text((p_left + 38, txt_y), a_text, font=font_artist, fill=(162, 164, 174))

    # Rieles; el progreso y los tiempos se dibujan por frame.
    prog_y = p_top + 814
    prog_left, prog_right = p_left + 130, p_right - 92
    draw.rounded_rectangle((prog_left, prog_y, prog_right, prog_y + 8), radius=4, fill=(62, 60, 63))
    _draw_player_controls(draw, p_left + card_w // 2, p_top + 906)

    # El riel refleja el volumen real configurado para esta exportación.
    vol_y = p_top + 996
    draw.polygon(
        ((p_left + 40, vol_y), (p_left + 52, vol_y), (p_left + 68, vol_y - 14), (p_left + 68, vol_y + 14), (p_left + 52, vol_y + 3), (p_left + 40, vol_y + 3)),
        fill=(165, 167, 178),
    )
    vol_left, vol_right = p_left + 92, p_right - 38
    volume_ratio = max(0.0, min(1.0, float(audio_volume)))
    draw.rounded_rectangle((vol_left, vol_y - 3, vol_right, vol_y + 5), radius=4, fill=(80, 78, 84))
    knob_x = vol_left + int((vol_right - vol_left) * volume_ratio)
    if knob_x > vol_left:
        draw.rounded_rectangle((vol_left, vol_y - 3, knob_x, vol_y + 5), radius=4, fill=(165, 167, 178))
    draw.ellipse((knob_x - 12, vol_y - 13, knob_x + 12, vol_y + 11), fill=(248, 248, 250))

    # Las dos tarjetas comparten exactamente la misma altura.
    l_left, l_top, l_right, l_bottom = 760, p_top, width - 40, p_bottom
    lyrics_w, lyrics_h = l_right - l_left, l_bottom - l_top
    lyrics_overlay = Image.new("RGBA", (lyrics_w, lyrics_h), (0, 0, 0, 0))
    l_draw = ImageDraw.Draw(lyrics_overlay)
    l_draw.rounded_rectangle(
        (0, 0, lyrics_w - 1, lyrics_h - 1),
        radius=34,
        fill=(12, 14, 18, 232),
        outline=(255, 255, 255, 28),
        width=2,
    )
    base.paste(lyrics_overlay, (l_left, l_top), lyrics_overlay)

    return base


def build_karaoke_scene(fonts, title=None, artist=None, video_size=VIDEO_SIZE,
                        layout_style="player", lyric_style="karaoke", theme_name="terminal",
                        cover_path=None, audio_volume=1.0):
    """Construye la escena base según el layout seleccionado ('player' o 'terminal')."""
    if layout_style == "player":
        return build_player_scene(fonts, title=title, artist=artist, video_size=video_size,
                                  theme_name=theme_name, cover_path=cover_path,
                                  audio_volume=audio_volume)

    theme = _theme_for(theme_name)
    base = _build_theme_background(video_size, theme)
    draw = ImageDraw.Draw(base)
    width, height = video_size
    _draw_window_chrome(draw, fonts, theme=theme, bounds=(0, 0, width, height))

    y = round(height * HEADER_TOP_RATIO)
    header_width = round(width * HEADER_WIDTH_RATIO)
    if title:
        font_title = fonts["title"]
        prompt = ">_ "
        prompt_w = _text_width(draw, prompt, font_title)
        title_lines = _wrap_header_title(draw, title, font_title, header_width, prompt_w)
        for index, title_line in enumerate(title_lines):
            line_prompt_w = prompt_w if index == 0 else 0
            total_w = line_prompt_w + _text_width(draw, title_line, font_title)
            x = (width - total_w) / 2
            if index == 0:
                draw.text((x, y), prompt, font=font_title, fill=theme["prompt"])
            draw.text((x + line_prompt_w, y), title_line, font=font_title, fill=theme["title"])
            y += font_title.size + 8
        y += 16
    if artist:
        font_artist = fonts["artist"]
        text = _truncate_text(draw, artist, font_artist, header_width)
        text_w = _text_width(draw, text, font_artist)
        draw.text(((width - text_w) / 2, y), text, font=font_artist, fill=theme["artist"])

    return base


_LYRIC_LAYOUT_CACHE = {}


def _wrap_stanza(draw, stanza, font, max_width):
    wrapped_lines = []
    space_w = _text_width(draw, " ", font)
    for line in stanza:
        words = line["words"] or [{"text": line["text"], "start": line["start"], "end": line["end"]}]
        current_segment = []
        current_w = 0
        for word in words:
            word_w = _text_width(draw, word["text"], font)
            if current_segment and current_w + space_w + word_w > max_width:
                wrapped_lines.append((current_segment, current_w))
                current_segment = [word]
                current_w = word_w
            else:
                current_w += (space_w + word_w) if current_segment else word_w
                current_segment.append(word)
        if current_segment:
            wrapped_lines.append((current_segment, current_w))
    return wrapped_lines, space_w


def _stanza_density(stanza):
    """Usa exactamente los mismos umbrales que la previsualización web."""
    total_chars = sum(len(line.get("text") or "") for line in stanza)
    estimated_wrapped_lines = sum(
        max(1, math.ceil(len(line.get("text") or "") / 24)) for line in stanza
    )
    if total_chars > 170 or estimated_wrapped_lines > 8:
        return "very-dense"
    if total_chars > 105 or estimated_wrapped_lines > 5:
        return "dense"
    return "normal"


def _fit_lyric_layout(draw, stanza, fonts, max_width, max_lines=5):
    """Selecciona el mismo cuerpo por densidad que usa el preview CSS."""
    del max_lines
    signature = tuple((line.get("text"), line.get("start"), line.get("end")) for line in stanza)
    density = _stanza_density(stanza)
    font = fonts["lyric_by_density"][density]
    key = (signature, font.size, max_width, density)
    if key in _LYRIC_LAYOUT_CACHE:
        return _LYRIC_LAYOUT_CACHE[key]

    lines, space_w = _wrap_stanza(draw, stanza, font, max_width)
    selected = (font, lines, space_w)
    if len(_LYRIC_LAYOUT_CACHE) >= 128:
        _LYRIC_LAYOUT_CACHE.clear()
    _LYRIC_LAYOUT_CACHE[key] = selected
    return selected


def _flatten_lyric_lines(stanzas):
    return [line for stanza in stanzas for line in stanza if line]


def _fit_player_line_font(draw, text, max_width, active=False):
    family = FONT_FAMILIES["modern"]
    sizes = (54, 50, 46, 42, 38) if active else (48, 44, 40, 36, 34)
    for size in sizes:
        font = _load_font(family["bold"], size)
        if _text_width(draw, text, font) <= max_width:
            return font
    return _load_font(family["bold"], sizes[-1])


def _draw_player_dim_line(img, text, center_x, y, max_width, color, blur_radius):
    """Dibuja líneas pasadas/futuras con el desenfoque del karaoke real."""
    probe = ImageDraw.Draw(img)
    font = _fit_player_line_font(probe, text, max_width, active=False)
    text_w = _text_width(probe, text, font)
    layer_w = max_width + 80
    layer_h = 100
    layer = Image.new("RGBA", (layer_w, layer_h), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer)
    layer_draw.text(((layer_w - text_w) / 2, 16), text, font=font, fill=color)
    if blur_radius:
        layer = layer.filter(ImageFilter.GaussianBlur(radius=blur_radius))
    img.paste(layer, (round(center_x - layer_w / 2), round(y - 16)), layer)


def _paste_word_progress(img, x, y, text, font, base, fill, progress):
    """Relleno horizontal por palabra equivalente a --p del karaoke CSS."""
    draw = ImageDraw.Draw(img)
    draw.text((x, y), text, font=font, fill=base)
    if progress <= 0:
        return
    width = max(1, math.ceil(_text_width(draw, text, font)))
    height = max(1, math.ceil(font.size * 1.5))
    layer = Image.new("RGBA", (width + 8, height), (0, 0, 0, 0))
    layer_draw = ImageDraw.Draw(layer)
    layer_draw.text((0, 0), text, font=font, fill=fill)
    clip_width = min(width + 8, max(1, round((width + 8) * min(progress, 1))))
    clipped = layer.crop((0, 0, clip_width, height))
    img.paste(clipped, (round(x), round(y)), clipped)


def _draw_player_active_line(img, line, current_time, center_x, y, max_width):
    draw = ImageDraw.Draw(img)
    text = line.get("text") or ""
    font = _fit_player_line_font(draw, text, max_width, active=True)
    words = line.get("words") or [{
        "text": text,
        "start": line.get("start", 0),
        "end": line.get("end", 0),
    }]
    space_w = _text_width(draw, " ", font)
    widths = [_text_width(draw, word.get("text") or "", font) for word in words]
    total_w = sum(widths) + max(0, len(words) - 1) * space_w
    x = center_x - total_w / 2
    for word, word_w in zip(words, widths):
        start = float(word.get("start", line.get("start", 0)) or 0)
        end = float(word.get("end", line.get("end", start)) or start)
        if current_time >= end:
            progress = 1
        elif current_time <= start:
            progress = 0
        else:
            progress = (current_time - start) / max(0.001, end - start)
        _paste_word_progress(
            img,
            x,
            y,
            word.get("text") or "",
            font,
            base=(177, 179, 187),
            fill=(30, 215, 96),
            progress=progress,
        )
        x += word_w + space_w


def _draw_player_frame_content(img, stanzas, current_time, audio_duration=None):
    """Contenido dinámico del layout horizontal: progreso y letra en scroll."""
    draw = ImageDraw.Draw(img)
    fonts = _player_fonts()

    # Barra temporal sincronizada con la canción completa.
    p_left, p_top, p_right = 40, 28, 690
    prog_y = p_top + 814
    prog_left, prog_right = p_left + 130, p_right - 92
    duration = audio_duration or max(
        (float(line.get("end", 0) or 0) for line in _flatten_lyric_lines(stanzas)),
        default=max(1, current_time),
    )
    ratio = max(0, min(1, current_time / max(0.001, duration)))
    if ratio:
        draw.rounded_rectangle(
            (prog_left, prog_y, prog_left + round((prog_right - prog_left) * ratio), prog_y + 8),
            radius=4,
            fill=(30, 215, 96),
        )
    current_label = _format_clock(current_time)
    duration_label = _format_clock(duration)
    label_y = prog_y - 10
    draw.text((p_left + 38, label_y), current_label, font=fonts["time"], fill=(139, 141, 151))
    duration_w = _text_width(draw, duration_label, fonts["time"])
    draw.text((p_right - 38 - duration_w, label_y), duration_label, font=fonts["time"], fill=(139, 141, 151))

    # Lectura descendente: la línea activa queda cerca del borde superior y
    # las siguientes se distribuyen hacia abajo, sin arrancar en el centro.
    lines = _flatten_lyric_lines(stanzas)
    if not lines:
        return
    active_index = 0
    for index, line in enumerate(lines):
        if float(line.get("start", 0) or 0) <= current_time:
            active_index = index
        else:
            break

    center_x = (760 + 1880) / 2
    active_y = 125
    line_gap = 118
    max_width = 1000
    for index in range(active_index, min(len(lines), active_index + 8)):
        line = lines[index]
        delta = index - active_index
        y = active_y + delta * line_gap
        if delta == 0:
            _draw_player_active_line(img, line, current_time, center_x, y, max_width)
        else:
            distance = delta
            alpha = max(38, 112 - distance * 24)
            color = (164, 166, 176, alpha)
            _draw_player_dim_line(
                img,
                line.get("text") or "",
                center_x,
                y,
                max_width,
                color,
                blur_radius=2.4 + distance * 0.55,
            )


def make_karaoke_frame(stanzas, current_time, fonts, title=None, artist=None,
                       video_size=VIDEO_SIZE, scene_image=None,
                       layout_style="player", lyric_style="karaoke", theme_name="terminal",
                       cover_path=None, audio_duration=None, audio_volume=1.0):
    width, height = video_size
    img = scene_image.copy() if scene_image is not None else build_karaoke_scene(
        fonts, title=title, artist=artist, video_size=video_size,
        layout_style=layout_style, lyric_style=lyric_style, theme_name=theme_name,
        cover_path=cover_path, audio_volume=audio_volume,
    )
    draw = ImageDraw.Draw(img)
    theme = _theme_for(theme_name)

    if layout_style == "player":
        _draw_player_frame_content(
            img, stanzas, current_time, audio_duration=audio_duration
        )
        return np.array(img)

    stanza = _active_stanza(stanzas, current_time)
    if not stanza:
        return np.array(img)

    density = _stanza_density(stanza)
    max_w = round(width * LYRIC_WIDTH_RATIO)
    lyric_left = (width - max_w) / 2
    font_lyric, wrapped_lines, space_w = _fit_lyric_layout(
        draw, stanza, fonts, max_width=max_w,
    )
    lyric_size = font_lyric.size
    line_height = int(lyric_size * LYRIC_LEADING[density])
    n_lines = len(wrapped_lines)
    block_height = n_lines * line_height

    content_center_y = round(height * LYRIC_CENTER_Y_RATIO)

    y_cursor = content_center_y - block_height / 2
    cursor_pos = None

    for seg_words, seg_w in wrapped_lines:
        x = lyric_left + (max_w - seg_w) / 2
        for word in seg_words:
            wtext = word["text"]
            w_width = _text_width(draw, wtext, font_lyric)
            if current_time >= word["end"]:
                draw.text((x, y_cursor), wtext, font=font_lyric, fill=theme["lyric"])
                cursor_pos = (x + w_width + 4, y_cursor)
            elif current_time >= word["start"]:
                draw.text((x + 2, y_cursor + 3), wtext, font=font_lyric, fill=theme["scan"])
                draw.text(
                    (x, y_cursor), wtext, font=font_lyric,
                    fill=theme["lyric_current"], stroke_width=1, stroke_fill=theme["cursor"],
                )
                underline_y = y_cursor + lyric_size + 8
                draw.rounded_rectangle(
                    (x, underline_y, x + w_width, underline_y + 5),
                    radius=3, fill=theme["status"],
                )
                cursor_pos = (x + w_width + 4, y_cursor)
            elif lyric_style == "karaoke":
                draw.text((x, y_cursor), wtext, font=font_lyric, fill=theme["lyric_future"])
            x += w_width + space_w
        y_cursor += line_height

    # Cursor de bloque parpadeante solo para formato terminal
    if cursor_pos and int(current_time / 0.4) % 2 == 0:
        cx, cy = cursor_pos
        block_w = int(lyric_size * 0.55)
        block_h = int(lyric_size * 1.05)
        draw.rectangle([cx, cy + 6, cx + block_w, cy + 6 + block_h], fill=theme["cursor"])

    return np.array(img)


def _build_fonts(font_family="mono", font_size="balanced"):
    family = _font_family_for(font_family)
    preset = _font_size_for(font_size)
    lyric_by_density = {
        density: _load_font(family["bold"], size)
        for density, size in preset["lyric"].items()
    }

    return {
        # El chrome tiene tamaño fijo en CSS; solo cambia de familia.
        "bar": _load_font(family["normal"], 34),
        "meta": _load_font(family["bold"], 22),
        "title": _load_font(family["bold"], preset["title"]),
        "artist": _load_font(family["normal"], preset["artist"]),
        "lyric": lyric_by_density["normal"],
        "lyric_steps": list(lyric_by_density.values()),
        "lyric_by_density": lyric_by_density,
    }


def create_tiktok_video(audio_source, lyrics_path, output_path, language="es",
                         model="small", force_sync=False, start_time=None,
                         end_time=None, title=None, artist=None,
                         vad="auditok", separate_vocals=True,
                         layout_style="player",
                         audio_volume=1.0,
                         lyric_style="karaoke",
                         theme="terminal",
                         font_family="mono", font_size="balanced",
                         progress_cb=None):
    if layout_style not in {"player", "terminal"}:
        raise ValueError("El formato de pantalla debe ser 'player' o 'terminal'.")
    if not 0.0 <= audio_volume <= 1.0:
        raise ValueError("El volumen del audio debe estar entre 0.0 y 1.0.")
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

    # Buscar portada
    cover_path = None
    try:
        from library_artwork import resolve_cover
        cover_path = resolve_cover(Path(audio_path))
    except Exception:
        pass

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

    # 3. Cargar audio y resolver el fragmento a exportar (por defecto, todo).
    audio_clip = AudioFileClip(str(audio_path))
    full_duration = audio_clip.duration
    render_size = PLAYER_VIDEO_SIZE if layout_style == "player" else VIDEO_SIZE
    fonts = (
        _build_fonts(font_family="modern", font_size="balanced")
        if layout_style == "player"
        else _build_fonts(font_family=font_family, font_size=font_size)
    )
    _pc("Componiendo escena", 94)
    scene_image = build_karaoke_scene(
        fonts, title=title, artist=artist, video_size=render_size,
        layout_style=layout_style, lyric_style=lyric_style,
        theme_name=theme, cover_path=cover_path, audio_volume=audio_volume,
    )

    frag_start = max(0.0, start_time) if start_time is not None else 0.0
    frag_end = min(full_duration, end_time) if end_time is not None else full_duration
    if frag_end <= frag_start:
        raise ValueError("El fragmento seleccionado no es válido: el fin debe ser mayor que el inicio.")

    trimmed_audio = audio_clip.subclipped(frag_start, frag_end)
    if audio_volume != 1.0:
        trimmed_audio = trimmed_audio.with_volume_scaled(audio_volume)
    duration = frag_end - frag_start

    print(f"Generando video ({frag_start:.1f}s - {frag_end:.1f}s de {full_duration:.1f}s totales)...")

    # 4. Cada frame usa el tiempo ABSOLUTO respecto al audio original.
    def make_frame(t):
        return make_karaoke_frame(
            stanzas, t + frag_start, fonts, title=title, artist=artist,
            video_size=render_size, scene_image=scene_image,
            layout_style=layout_style,
            lyric_style=lyric_style, theme_name=theme, cover_path=cover_path,
            audio_duration=full_duration, audio_volume=audio_volume,
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
    parser.add_argument("--layout-style", choices=("player", "terminal"), default="player")
    parser.add_argument("--audio-volume", type=float, default=1.0, help="Volumen del audio exportado entre 0.0 y 1.0")
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
        vad=vad_arg, separate_vocals=not args.no_separacion,
        layout_style=args.layout_style, audio_volume=args.audio_volume,
        lyric_style=args.lyric_style,
        theme=args.theme, font_family=args.font_family, font_size=args.font_size,
    )
