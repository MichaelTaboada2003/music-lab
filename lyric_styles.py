"""Renderizadores de los formatos 9:16 Color y Terminal.

- Color ("póster tipográfico"): letra grande alineada a la izquierda con
  desplazamiento suave entre líneas, mini portada, tiempos y barra de progreso.
- Terminal ("editor de código"): líneas numeradas, línea activa resaltada,
  cursor de bloque con brillo, barra de estado con modo y progreso, y un
  acabado CRT sutil.

Todo es una función pura de ``(letra, tiempo, opciones)``: el mismo código
alimenta la exportación y la previsualización del Estudio, de modo que lo que se
ve al ajustar es exactamente lo que se exporta.
"""

import math
import re
import unicodedata
from functools import lru_cache
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

_AVENIR_NEXT = "/System/Library/Fonts/Avenir Next.ttc"
_GEORGIA = "/System/Library/Fonts/Supplemental/Georgia.ttf"
_GEORGIA_BOLD = "/System/Library/Fonts/Supplemental/Georgia Bold.ttf"
_MENLO = "/System/Library/Fonts/Menlo.ttc"

# (ruta, índice dentro del .ttc) por familia y peso. Los nombres sueltos son el
# respaldo portable cuando el sistema no trae las fuentes de macOS.
_FACES = {
    "modern": {
        "display": (_AVENIR_NEXT, 8), "bold": (_AVENIR_NEXT, 0), "demi": (_AVENIR_NEXT, 2),
        "medium": (_AVENIR_NEXT, 5), "regular": (_AVENIR_NEXT, 7),
    },
    "editorial": {
        "display": (_GEORGIA_BOLD, 0), "bold": (_GEORGIA_BOLD, 0), "demi": (_GEORGIA_BOLD, 0),
        "medium": (_GEORGIA, 0), "regular": (_GEORGIA, 0),
    },
    "mono": {
        "display": (_MENLO, 1), "bold": (_MENLO, 1), "demi": (_MENLO, 1),
        "medium": (_MENLO, 0), "regular": (_MENLO, 0),
    },
}
_FALLBACKS = {
    "modern": ("DejaVuSans-Bold", "DejaVuSans"),
    "editorial": ("DejaVuSerif-Bold", "DejaVuSerif"),
    "mono": ("DejaVuSansMono-Bold", "DejaVuSansMono"),
}
_BOLD_WEIGHTS = {"display", "bold", "demi"}

# Escala del cuerpo de letra según la opción "Tamaño de letra" y la familia
# (la monoespaciada es más ancha y necesita menos puntos para el mismo ancho).
SIZE_STEPS = {"compact": 0.85, "balanced": 1.0, "large": 1.18}
FAMILY_SCALE = {"modern": 1.0, "editorial": 0.94, "mono": 0.78}


def _rgb(value):
    return tuple(int(v) for v in value)


def mix(a, b, amount):
    amount = max(0.0, min(1.0, amount))
    return tuple(round(x + (y - x) * amount) for x, y in zip(a, b))


def _luminance(color):
    channels = [c / 255 for c in color]
    channels = [c / 12.92 if c <= 0.03928 else ((c + 0.055) / 1.055) ** 2.4 for c in channels]
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]


def clamp01(value):
    return max(0.0, min(1.0, value))


def ease_out_cubic(p):
    return 1 - (1 - clamp01(p)) ** 3


def ease_in_out(p):
    p = clamp01(p)
    return p * p * (3 - 2 * p)


@lru_cache(maxsize=512)
def face(family, weight, size):
    path, index = _FACES[family][weight]
    try:
        return ImageFont.truetype(path, size, index=index)
    except OSError:
        pass
    fallbacks = _FALLBACKS[family]
    for name in (fallbacks[0] if weight in _BOLD_WEIGHTS else fallbacks[1], *fallbacks):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


@lru_cache(maxsize=32768)
def text_w(text, font):
    return font.getlength(text)


def ellipsize(text, font, max_width):
    if text_w(text, font) <= max_width:
        return text
    cut = text
    while cut and text_w(cut + "…", font) > max_width:
        cut = cut[:-1]
    return cut.rstrip() + "…"


def clock(seconds):
    seconds = max(0, int(seconds))
    return f"{seconds // 60}:{seconds % 60:02d}"


# ---------------------------------------------------------------- letra ------

def line_words(line):
    words = line.get("words") or [{
        "text": line.get("text") or "", "start": line.get("start", 0), "end": line.get("end", 0),
    }]
    return [w for w in words if w.get("text")]


def fragment_lines(stanzas, fragment_start=None, fragment_end=None):
    lines = [line for stanza in stanzas for line in stanza if line and line_words(line)]
    return [
        line for line in lines
        if not (fragment_start is not None and float(line.get("end", 0) or 0) <= fragment_start)
        and not (fragment_end is not None and float(line.get("start", 0) or 0) >= fragment_end)
    ]


def active_index(lines, t):
    index = 0
    for i, line in enumerate(lines):
        if float(line.get("start", 0) or 0) <= t:
            index = i
        else:
            break
    return index


def _greedy_rows(words, font, max_w):
    space = text_w(" ", font)
    rows, current, width = [], [], 0.0
    for word in words:
        w = text_w(word["text"], font)
        add = w if not current else space + w
        if current and width + add > max_w:
            rows.append((current, width))
            current, width = [word], w
        else:
            current.append(word)
            width += add
    if current:
        rows.append((current, width))
    return rows


def balanced_rows(line, font, max_w):
    """Parte un verso en filas parejas (sin una palabra huérfana al final)."""
    words = line_words(line)
    rows = _greedy_rows(words, font, max_w)
    if len(rows) > 1:
        lo, hi = max_w * 0.45, max_w
        for _ in range(8):
            mid = (lo + hi) / 2
            if len(_greedy_rows(words, font, mid)) <= len(rows):
                hi = mid
            else:
                lo = mid
        rows = _greedy_rows(words, font, hi)
    return rows


_ROW_CACHE = {}


def rows_for(line, family, weight, size, max_w):
    key = (line.get("text"), line.get("start"), family, weight, size, round(max_w))
    rows = _ROW_CACHE.get(key)
    if rows is None:
        if len(_ROW_CACHE) > 4096:
            _ROW_CACHE.clear()
        rows = balanced_rows(line, face(family, weight, size), max_w)
        _ROW_CACHE[key] = rows
    return rows


@lru_cache(maxsize=2048)
def _word_layer(text, font, fill):
    width = math.ceil(text_w(text, font)) + 12
    height = math.ceil(font.size * 1.6)
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    ImageDraw.Draw(layer).text((6, 0), text, font=font, fill=fill)
    return layer


def draw_wipe_word(img, x, y, text, font, base, fill, progress):
    """Palabra con relleno horizontal de izquierda a derecha (karaoke suave)."""
    draw = ImageDraw.Draw(img)
    if progress <= 0:
        draw.text((x, y), text, font=font, fill=base)
        return
    if progress >= 1:
        draw.text((x, y), text, font=font, fill=fill)
        return
    draw.text((x, y), text, font=font, fill=base)
    layer = _word_layer(text, font, tuple(fill))
    clip = max(1, round(6 + (layer.width - 12) * progress))
    img.paste(layer.crop((0, 0, clip, layer.height)), (round(x) - 6, round(y)), layer.crop((0, 0, clip, layer.height)))


# --------------------------------------------------------------- fondos ------

_NOISE = {}


def _grain(size, sigma):
    key = (size, sigma)
    if key not in _NOISE:
        rng = np.random.default_rng(7)
        w, h = size
        _NOISE[key] = (rng.standard_normal((h, w)).astype(np.float32) * sigma)[..., None]
    return _NOISE[key]


def _radial(size, cx, cy, radius, power=2.0):
    w, h = size
    ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
    dist = np.sqrt((xs - cx * w) ** 2 + (ys - cy * h) ** 2) / (radius * w)
    return np.clip(1.0 - dist, 0.0, 1.0) ** power


def _finish_background(arr, size, vignette, grain):
    w, h = size
    if vignette:
        ys, xs = np.mgrid[0:h, 0:w].astype(np.float32)
        edge = np.sqrt(((xs - w / 2) / (w / 2)) ** 2 + ((ys - h / 2) / (h / 2)) ** 2) / 1.414
        arr = arr * (1.0 - vignette * edge ** 2.2)[..., None]
    if grain:
        arr = arr + _grain(size, grain)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


# ------------------------------------------------------------ rounded img ----

@lru_cache(maxsize=8)
def _cover_tile(path, mtime, side, radius):
    with Image.open(path) as src:
        src = src.convert("RGB")
        edge = min(src.size)
        left, top = (src.width - edge) // 2, (src.height - edge) // 2
        tile = src.crop((left, top, left + edge, top + edge)).resize((side, side), Image.LANCZOS)
    scale = 4
    mask = Image.new("L", (side * scale, side * scale), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, side * scale - 1, side * scale - 1), radius * scale, fill=255)
    return tile, mask.resize((side, side), Image.LANCZOS)


def paste_cover(img, path, x, y, side, radius, shadow=True):
    try:
        p = Path(path)
        tile, mask = _cover_tile(str(p), p.stat().st_mtime_ns, side, radius)
    except (OSError, TypeError, ValueError):
        return False
    if shadow:
        glow = Image.new("L", img.size, 0)
        ImageDraw.Draw(glow).rounded_rectangle((x, y + 8, x + side, y + side + 8), radius, fill=120)
        glow = glow.filter(ImageFilter.GaussianBlur(14))
        img.paste(Image.new("RGB", img.size, (0, 0, 0)), (0, 0), glow)
    img.paste(tile, (x, y), mask)
    return True


# =============================================================== COLOR =======

COLOR_MARGIN_L = 96
COLOR_TEXT_W = 804
COLOR_FOCUS_Y = 880
COLOR_NEIGHBOR = 0.58
COLOR_DIM = 0.30
COLOR_TRANSITION = 0.42
COLOR_ANTICIPATION = 0.12
COLOR_ACTIVE_SIZE = 96
COLOR_LEADING = 1.08
COLOR_HEADER_Y = 176
COLOR_COVER = 132
COLOR_FOOTER_Y = 1412

_SCENES = {}


def _remember(cache, key, build, limit=6):
    if key not in cache:
        if len(cache) >= limit:
            cache.pop(next(iter(cache)))
        cache[key] = build()
    return cache[key]


def build_color_scene(size, bg, text, title=None, artist=None, cover_path=None):
    """Capa fija: fondo con luz y viñeta, portada, título y artista."""

    def build():
        w, h = size
        base = np.empty((h, w, 3), dtype=np.float32)
        base[:] = bg
        glow = mix(bg, text, 0.16)
        base += (_radial(size, 0.12, 0.10, 1.05)[..., None]) * (np.array(glow, dtype=np.float32) - np.array(bg, dtype=np.float32))
        shade = mix(bg, (0, 0, 0), 0.5)
        base += (_radial(size, 0.9, 1.0, 0.9)[..., None]) * (np.array(shade, dtype=np.float32) - np.array(bg, dtype=np.float32)) * 0.45
        img = _finish_background(base, size, vignette=0.16 * (1.0 - 0.75 * _luminance(bg)), grain=1.7)
        draw = ImageDraw.Draw(img)

        x = COLOR_MARGIN_L
        has_cover = bool(cover_path) and paste_cover(img, cover_path, x, COLOR_HEADER_Y, COLOR_COVER, 28)
        text_x = x + (COLOR_COVER + 30 if has_cover else 0)
        max_w = 900 - text_x - 70
        title_font = face("modern", "demi", 40)
        artist_font = face("modern", "medium", 31)
        block_h = 40 * 1.25 + 8 + 31 * 1.25
        top = COLOR_HEADER_Y + (COLOR_COVER - block_h) / 2 if has_cover else COLOR_HEADER_Y + 4
        if title:
            draw.text((text_x, top), ellipsize(title, title_font, max_w), font=title_font, fill=mix(bg, text, 0.96))
        if artist:
            draw.text((text_x, top + 40 * 1.25 + 8), ellipsize(artist, artist_font, max_w),
                      font=artist_font, fill=mix(bg, text, 0.62))
        return img

    key = ("color", size, tuple(bg), tuple(text), title, artist, str(cover_path or ""))
    return _remember(_SCENES, key, build)


def _color_word_colors(bg, text, alpha):
    sung = mix(bg, text, alpha)
    unsung = mix(bg, text, min(alpha, COLOR_DIM))
    return sung, unsung


def _draw_color_line(img, line, k, i, t, x, y, size, alpha, family, bg, text, lyric_style):
    """Dibuja un verso (todas sus filas) y devuelve su alto."""
    rows = rows_for(line, family, "display", size, COLOR_TEXT_W)
    font = face(family, "display", size)
    row_h = size * COLOR_LEADING
    sung_col, unsung_col = _color_word_colors(bg, text, alpha)
    space = text_w(" ", font)
    for r, (words, _w) in enumerate(rows):
        cx = x
        ry = y + r * row_h
        for word in words:
            wt = word["text"]
            ww = text_w(wt, font)
            start, end = float(word["start"]), float(word["end"])
            if k < i or (k == i and t >= end):
                draw_wipe_word(img, cx, ry, wt, font, sung_col, sung_col, 1.0)
            elif k == i and t >= start:
                if lyric_style == "typing":
                    draw_wipe_word(img, cx, ry, wt, font, sung_col, sung_col, 1.0)
                else:
                    draw_wipe_word(img, cx, ry, wt, font, unsung_col, sung_col,
                                   (t - start) / max(0.001, end - start))
            elif lyric_style == "karaoke":
                draw_wipe_word(img, cx, ry, wt, font, unsung_col, unsung_col, 0.0)
            cx += ww + space
    return len(rows) * row_h


def _line_height(line, family, size):
    return len(rows_for(line, family, "display", size, COLOR_TEXT_W)) * size * COLOR_LEADING


def render_color_frame(stanzas, t, *, size, bg, text, title=None, artist=None, cover_path=None,
                       font_family="modern", font_size="balanced", lyric_style="karaoke",
                       lyric_flow="block", fragment_start=None, fragment_end=None):
    bg, text = _rgb(bg), _rgb(text)
    w, h = size
    img = build_color_scene(size, bg, text, title, artist, cover_path).copy()
    draw = ImageDraw.Draw(img)
    lines = fragment_lines(stanzas, fragment_start, fragment_end)

    _draw_color_progress(img, draw, t, bg, text, lines, fragment_start, fragment_end)
    _draw_equalizer(draw, t, bg, text, w)
    if not lines:
        return np.asarray(img)

    family = font_family if font_family in FAMILY_SCALE else "modern"
    active_size = round(COLOR_ACTIVE_SIZE * SIZE_STEPS.get(font_size, 1.0) * FAMILY_SCALE[family] / 2) * 2
    i = active_index(lines, t)

    if lyric_flow == "line":
        _render_color_single(img, lines, i, t, family, active_size, bg, text, lyric_style)
        return np.asarray(img)

    start_i = float(lines[i].get("start", 0) or 0)
    e = ease_out_cubic((t - (start_i - COLOR_ANTICIPATION)) / COLOR_TRANSITION) if i > 0 else 1.0
    f = (i - 1) + e if i > 0 else 0.0

    # Alto y posición de cada verso visible; los tamaños dependen de la
    # distancia al foco, por lo que se mueven y se escalan de forma continua.
    items = []
    y = 0.0
    for k in range(max(0, i - 3), min(len(lines), i + 5)):
        d = abs(k - f)
        q = max(24, round(active_size * (1 - (1 - COLOR_NEIGHBOR) * min(d, 1.0)) / 2) * 2)
        height = _line_height(lines[k], family, q)
        items.append({"k": k, "d": d, "q": q, "y": y, "h": height})
        y += height + q * 0.42
    lo, hi = math.floor(f), math.ceil(f)
    centers = {it["k"]: it["y"] + it["h"] / 2 for it in items}
    c_lo = centers.get(lo, centers.get(min(centers)))
    c_hi = centers.get(hi, c_lo)
    shift = COLOR_FOCUS_Y - (c_lo + (c_hi - c_lo) * (f - lo))

    for it in items:
        top = it["y"] + shift
        mid = top + it["h"] / 2
        fade_y = clamp01((mid - 300) / 220) * clamp01((COLOR_FOOTER_Y - 40 - mid) / 220)
        alpha = (1 - (1 - COLOR_DIM) * min(it["d"], 1.0)) * clamp01(2.4 - it["d"]) * fade_y
        if alpha <= 0.02:
            continue
        _draw_color_line(img, lines[it["k"]], it["k"], i, t, COLOR_MARGIN_L, top, it["q"], alpha,
                         family, bg, text, lyric_style)
    return np.asarray(img)


def _render_color_single(img, lines, i, t, family, active_size, bg, text, lyric_style):
    """Un verso por pantalla: entra deslizando desde abajo y el anterior sale hacia arriba."""
    big = round(active_size * 1.22 / 2) * 2
    cur = lines[i]
    start = float(cur.get("start", 0) or 0)
    p = ease_out_cubic((t - start) / 0.30) if i > 0 else 1.0
    for k, offset, alpha in ((i - 1, -70 * p, (1 - p)), (i, 70 * (1 - p), p)):
        if k < 0 or alpha <= 0.02:
            continue
        q = big
        while q > 56 and len(rows_for(lines[k], family, "display", q, COLOR_TEXT_W)) > 5:
            q -= 4
        height = _line_height(lines[k], family, q)
        top = COLOR_FOCUS_Y - height / 2 + offset
        _draw_color_line(img, lines[k], k, i, t, COLOR_MARGIN_L, top, q, alpha, family, bg, text, lyric_style)


def _draw_color_progress(img, draw, t, bg, text, lines, fragment_start, fragment_end):
    start = fragment_start if fragment_start is not None else (float(lines[0]["start"]) if lines else 0.0)
    end = fragment_end if fragment_end is not None else (float(lines[-1]["end"]) if lines else start + 1)
    total = max(0.001, end - start)
    progress = clamp01((t - start) / total)
    x0, x1, y = COLOR_MARGIN_L, 900, COLOR_FOOTER_Y
    draw.rounded_rectangle((x0, y, x1, y + 6), 3, fill=mix(bg, text, 0.20))
    filled = round((x1 - x0) * progress)
    if filled >= 6:
        draw.rounded_rectangle((x0, y, x0 + filled, y + 6), 3, fill=text)
    knob = x0 + filled
    draw.ellipse((knob - 9, y - 6, knob + 9, y + 12), fill=text)
    label = face("modern", "medium", 27)
    dim = mix(bg, text, 0.62)
    draw.text((x0, y + 30), clock(t - start), font=label, fill=dim)
    right = clock(total)
    draw.text((x1 - text_w(right, label), y + 30), right, font=label, fill=dim)


def _draw_equalizer(draw, t, bg, text, width):
    base_y = COLOR_HEADER_Y + 46
    x = 900 - 4 * 16 + 8
    col = mix(bg, text, 0.85)
    for j in range(4):
        height = 10 + 30 * abs(math.sin(t * (2.6 + j * 1.15) + j * 1.7))
        draw.rounded_rectangle((x + j * 16, base_y - height, x + j * 16 + 8, base_y), 4, fill=col)


# ============================================================== TERMINAL =====

TERM_FONT = 56
TERM_LEADING = 1.58
TERM_GUTTER_RIGHT = 150
TERM_TEXT_X = 188
TERM_TEXT_W = 1080 - 188 - 96
TERM_FOCUS_Y = 900
TERM_AREA = (350, 1404)
TERM_TRANSITION = 0.2
TERM_TAB_Y = 168
TERM_STATUS_Y = 1440


def _slug(text):
    text = unicodedata.normalize("NFKD", text or "lyrics")
    text = "".join(c for c in text if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", "_", text).strip("_")[:22] or "lyrics"


def build_terminal_scene(size, theme, title=None, artist=None):
    def build():
        w, h = size
        win, win2 = _rgb(theme["window"]), _rgb(theme["window_end"])
        blend = np.linspace(0, 1, h, dtype=np.float32)[:, None, None]
        base = np.array(win, dtype=np.float32) + (np.array(win2, dtype=np.float32) - np.array(win, dtype=np.float32)) * blend
        base = np.broadcast_to(base, (h, w, 3)).copy()
        light = _luminance(win) > 0.5
        for (cx, cy, rad, key, gain) in ((0.10, 0.20, 0.95, "glow_a", 0.9), (0.95, 0.82, 0.95, "glow_b", 0.8)):
            col = np.array(_rgb(theme[key]), dtype=np.float32)
            base += _radial(size, cx, cy, rad)[..., None] * (col - base) * (0.32 * gain)
        img = _finish_background(base, size, vignette=0.0 if light else 0.30, grain=1.5)

        arr = np.asarray(img).astype(np.float32)
        arr[::4] *= 0.955 if not light else 0.975          # líneas de barrido CRT
        img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
        draw = ImageDraw.Draw(img)

        bar = _rgb(theme["titlebar"])
        dim = mix(bar, _rgb(theme["titlebar_text"]), 0.55)
        status = _rgb(theme["status"])
        mono_r, mono_b = face("mono", "regular", 31), face("mono", "bold", 31)

        # Pestañas
        draw.rectangle((0, TERM_TAB_Y, w, TERM_TAB_Y + 74), fill=bar)
        tab_w = 430
        tab_bg = mix(bar, win, 0.55)
        draw.rectangle((44, TERM_TAB_Y + 10, 44 + tab_w, TERM_TAB_Y + 74), fill=tab_bg)
        draw.rectangle((44, TERM_TAB_Y + 10, 44 + tab_w, TERM_TAB_Y + 14), fill=status)
        draw.ellipse((66, TERM_TAB_Y + 36, 82, TERM_TAB_Y + 52), fill=status)
        draw.text((100, TERM_TAB_Y + 25), ellipsize(f"{_slug(title)}.lrc", mono_b, tab_w - 80), font=mono_b,
                  fill=_rgb(theme["title"]))
        draw.line((0, TERM_TAB_Y + 74, w, TERM_TAB_Y + 74), fill=_rgb(theme["titlebar_line"]), width=2)
        # Ruta
        crumb = " > ".join(p for p in ("lyrics", artist, title) if p)
        draw.text((TERM_GUTTER_RIGHT - 106, TERM_TAB_Y + 110), ellipsize(crumb, mono_r, w - 150 - 60), font=mono_r,
                  fill=mix(win, _rgb(theme["titlebar_text"]), 0.62))
        # Canal de números
        draw.line((TERM_TEXT_X - 22, TERM_AREA[0] - 10, TERM_TEXT_X - 22, TERM_AREA[1] + 10),
                  fill=mix(win, _rgb(theme["panel_line"]), 0.55), width=2)
        # Barra de estado
        draw.rectangle((0, TERM_STATUS_Y, w, TERM_STATUS_Y + 78), fill=bar)
        draw.line((0, TERM_STATUS_Y, w, TERM_STATUS_Y), fill=_rgb(theme["titlebar_line"]), width=2)
        return img

    key = ("terminal", size, id(theme), title, artist)
    return _remember(_SCENES, key, build)


def _terminal_font_size(font_family, font_size):
    return round(TERM_FONT * SIZE_STEPS.get(font_size, 1.0) * (1.0 if font_family == "mono" else 1.08))


def _add_glow(img, box, text, font, color, strength=0.9, radius=14):
    x, y, w, h = box
    pad = radius * 3
    left, top = max(0, int(x - pad)), max(0, int(y - pad))
    right, bottom = min(img.width, int(x + w + pad)), min(img.height, int(y + h + pad))
    if right <= left or bottom <= top:
        return
    mask = Image.new("L", (right - left, bottom - top), 0)
    ImageDraw.Draw(mask).text((x - left, y - top), text, font=font, fill=255)
    mask = mask.filter(ImageFilter.GaussianBlur(radius))
    region = np.asarray(img.crop((left, top, right, bottom))).astype(np.float32)
    glow = (np.asarray(mask, dtype=np.float32) / 255.0)[..., None] * strength
    region = region + glow * np.array(color, dtype=np.float32)
    img.paste(Image.fromarray(np.clip(region, 0, 255).astype(np.uint8)), (left, top))


def render_terminal_frame(stanzas, t, *, size, theme, title=None, artist=None, cover_path=None,
                          font_family="mono", font_size="balanced", lyric_style="karaoke",
                          lyric_flow="block", fragment_start=None, fragment_end=None):
    w, h = size
    img = build_terminal_scene(size, theme, title, artist).copy()
    draw = ImageDraw.Draw(img)
    win = _rgb(theme["window"])
    lines = fragment_lines(stanzas, fragment_start, fragment_end)
    light = _luminance(win) > 0.5

    colors = {
        "past": mix(win, _rgb(theme["lyric"]), 0.62),
        "sung": _rgb(theme["lyric"]),
        "current": _rgb(theme["lyric_current"]),
        "future": _rgb(theme["lyric_future"]),
        "cursor": _rgb(theme["cursor"]),
        "status": _rgb(theme["status"]),
        "gutter": mix(win, _rgb(theme["titlebar_text"]), 0.42),
        "gutter_on": _rgb(theme["title"]),
        "band": mix(win, _rgb(theme["lyric_current"]), 0.075 if not light else 0.06),
    }
    start = fragment_start if fragment_start is not None else (float(lines[0]["start"]) if lines else 0.0)
    end = fragment_end if fragment_end is not None else (float(lines[-1]["end"]) if lines else start + 1)
    i = active_index(lines, t) if lines else 0
    _draw_terminal_status(img, draw, theme, colors, t, start, end, i, len(lines), title)
    if not lines:
        return np.asarray(img)

    family = font_family if font_family in FAMILY_SCALE else "mono"
    base_size = _terminal_font_size(family, font_size)
    single = lyric_flow == "line"
    q = round(base_size * (1.32 if single else 1.0))
    font = face(family, "bold", q)
    row_h = q * TERM_LEADING
    max_w = TERM_TEXT_W
    num_font = face("mono", "regular", 34)
    num_font_on = face("mono", "bold", 34)

    if single:
        k_range = [i]
        f = float(i)
    else:
        start_i = float(lines[i].get("start", 0) or 0)
        e = ease_in_out((t - start_i + 0.04) / TERM_TRANSITION) if i > 0 else 1.0
        f = (i - 1) + e if i > 0 else 0.0
        k_range = list(range(max(0, i - 9), min(len(lines), i + 10)))

    layout, y = {}, 0.0
    for k in k_range:
        rows = rows_for(lines[k], family, "bold", q, max_w)
        layout[k] = (y, rows)
        y += len(rows) * row_h + 16
    centers = {k: layout[k][0] + len(layout[k][1]) * row_h / 2 for k in layout}
    lo, hi = math.floor(f), math.ceil(f)
    c_lo = centers.get(lo, centers[min(centers)])
    c_hi = centers.get(hi, c_lo)
    shift = TERM_FOCUS_Y - (c_lo + (c_hi - c_lo) * (f - lo))
    # Como en un editor, el archivo no se desplaza más allá de su primera línea.
    shift = min(shift, TERM_AREA[0] + 16 - layout[min(layout)][0])

    fade_in = ease_out_cubic((t - float(lines[i].get("start", 0) or 0)) / 0.16) if single and i > 0 else 1.0
    area_top, area_bottom = TERM_AREA
    cursor_xy = None
    for k, (ly, rows) in layout.items():
        top = ly + shift
        block_h = len(rows) * row_h
        if top + block_h < area_top - 20 or top > area_bottom + 20:
            continue
        edge = clamp01((top + block_h / 2 - area_top) / 120) * clamp01((area_bottom - (top + block_h / 2)) / 120)
        if edge <= 0.02:
            continue
        active = k == i
        if active:
            band_top, band_bottom = max(top - 10, area_top), min(top + block_h + 6, area_bottom)
            draw.rectangle((0, band_top, w, band_bottom), fill=colors["band"])
            draw.rectangle((0, band_top, 8, band_bottom), fill=colors["status"])
        label = str(k + 1)
        nf = num_font_on if active else num_font
        draw.text((TERM_GUTTER_RIGHT - text_w(label, nf), top + (row_h - 34) / 2 - 2), label, font=nf,
                  fill=colors["gutter_on"] if active else mix(win, colors["gutter"], edge))
        space = text_w(" ", font)
        for r, (words, _w) in enumerate(rows):
            cx, ry = TERM_TEXT_X, top + r * row_h
            # Cada fila se atenúa por su propia posición: un verso largo no debe
            # invadir la ruta de arriba ni la barra de estado al desplazarse.
            row_mid = ry + row_h / 2
            row_edge = clamp01((row_mid - area_top) / 90) * clamp01((area_bottom - row_mid) / 90)
            if row_edge <= 0.02:
                continue
            for word in words:
                wt = word["text"]
                ww = text_w(wt, font)
                ws, we = float(word["start"]), float(word["end"])
                if k < i:
                    col, show = colors["past"], True
                elif k > i:
                    col, show = colors["future"], lyric_style == "karaoke"
                elif t >= we:
                    col, show = colors["sung"], True
                elif t >= ws:
                    col, show = colors["current"], True
                else:
                    col, show = colors["future"], lyric_style == "karaoke"
                if show:
                    col = mix(win, col, row_edge * (fade_in if active else 1.0))
                    draw.text((cx, ry), wt, font=font, fill=col)
                if active and ws <= t:
                    cursor_xy = (cx + ww, ry)
                    if ws <= t < we and row_edge > 0.5:
                        draw.rounded_rectangle((cx, ry + q * 1.12, cx + ww, ry + q * 1.12 + 5), 2, fill=colors["status"])
                        if not light:
                            _add_glow(img, (cx, ry, ww, q * 1.2), wt, font, colors["cursor"])
                            draw = ImageDraw.Draw(img)
                cx += ww + space
        if active and cursor_xy is None:
            cursor_xy = (TERM_TEXT_X - space * 0.0, top)
    if cursor_xy and int(t / 0.45) % 2 == 0:
        cx, cy = cursor_xy
        cx += text_w(" ", font) * 0.15
        draw.rectangle((cx, cy + q * 0.10, cx + q * 0.58, cy + q * 1.18), fill=colors["cursor"])
    return np.asarray(img)


def _draw_terminal_status(img, draw, theme, colors, t, start, end, i, total, title):
    w = img.width
    y = TERM_STATUS_Y
    bar = _rgb(theme["titlebar"])
    status = colors["status"]
    ink = mix(_rgb(theme["window"]), (0, 0, 0), 0.55) if _luminance(status) > 0.3 else (250, 250, 250)
    label = face("mono", "bold", 31)
    reg = face("mono", "regular", 31)
    total_t = max(0.001, end - start)
    progress = clamp01((t - start) / total_t)

    # Línea de reproducción (playhead) sobre la barra de estado
    draw.rectangle((0, y - 8, w, y - 2), fill=mix(bar, _rgb(theme["panel_line"]), 0.6))
    filled = round(w * progress)
    if filled > 0:
        draw.rectangle((0, y - 8, filled, y - 2), fill=status)
        draw.rectangle((max(0, filled - 6), y - 12, filled, y + 2), fill=colors["cursor"])

    # Modo
    pill_w = 250
    draw.rectangle((0, y, pill_w, y + 78), fill=status)
    cy = y + 39
    draw.polygon([(34, cy - 13), (34, cy + 13), (58, cy)], fill=ink)
    draw.text((76, cy - 19), "PLAYING", font=label, fill=ink)
    draw.polygon([(pill_w, y), (pill_w + 32, cy), (pill_w, y + 78)], fill=status)
    draw.text((pill_w + 56, cy - 19), ellipsize(f"{_slug(title)}.lrc", reg, 330), font=reg,
              fill=mix(bar, _rgb(theme["titlebar_text"]), 0.85))
    # Posición y tiempo
    right = f"{clock(t - start)} / {clock(total_t)}"
    rw = text_w(right, label)
    draw.rectangle((w - rw - 92, y, w, y + 78), fill=mix(bar, _rgb(theme["panel_line"]), 0.45))
    draw.polygon([(w - rw - 92, y), (w - rw - 124, cy), (w - rw - 92, y + 78)], fill=mix(bar, _rgb(theme["panel_line"]), 0.45))
    draw.text((w - rw - 54, cy - 19), right, font=label, fill=_rgb(theme["title"]))
    pos = f"Ln {min(total, i + 1)}/{total}"
    draw.text((w - rw - 124 - text_w(pos, reg) - 24, cy - 19), pos, font=reg,
              fill=mix(bar, _rgb(theme["titlebar_text"]), 0.7))
