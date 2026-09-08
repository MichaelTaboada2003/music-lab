"""Las caches del render existen solo para ganar velocidad: estas pruebas
fijan que no cambien ni un solo píxel del frame resultante."""

import unittest

import numpy as np
from PIL import Image, ImageDraw

import tiktok_generator as generator


def _line(text, start, duration=3.0):
    words = text.split()
    step = duration / max(1, len(words))
    return {
        "text": text,
        "start": start,
        "end": start + duration,
        "words": [
            {
                "text": word,
                "start": start + index * step,
                "end": start + (index + 1) * step,
            }
            for index, word in enumerate(words)
        ],
    }


def _clear_render_caches():
    generator._measure_text_width.cache_clear()
    generator._player_line_font.cache_clear()
    generator._dim_line_layer.cache_clear()
    generator._word_fill_layer.cache_clear()
    generator._player_fonts.cache_clear()


class RenderCacheTests(unittest.TestCase):
    def setUp(self):
        self.stanzas = [
            [
                _line("Ya no me llegan tus cartas", 0.0),
                _line("y yo sigo aquí esperando", 3.0),
                _line("todas las noches de rodillas", 6.0),
            ],
            [
                _line("si me das tu dirección", 9.0),
                _line("yo te mando mil cartas", 12.0),
            ],
        ]
        self.fonts = generator._build_fonts()

    def _render(self, current_time, scene, flow):
        return generator.make_karaoke_frame(
            self.stanzas,
            current_time=current_time,
            fonts=self.fonts,
            title="Yonaguni",
            artist="Bad Bunny",
            video_size=generator.PLAYER_VIDEO_SIZE,
            scene_image=scene,
            layout_style="player",
            audio_duration=15.0,
            lyric_flow=flow,
        )

    def test_las_caches_no_alteran_ningun_pixel(self):
        """Un frame con las caches calientes debe ser idéntico al mismo frame
        calculado desde cero. Es lo que separa cachear de degradar."""
        scene = generator.build_player_scene(
            self.fonts, title="Yonaguni", artist="Bad Bunny"
        )
        # Se muestrean también los instantes de transición entre líneas, donde
        # el alfa de la capa difusa cambia frame a frame.
        times = [0.0, 0.21, 2.9, 3.05, 3.3, 6.1, 9.2, 12.4, 14.9]

        for flow in ("block", "line"):
            with self.subTest(flow=flow):
                _clear_render_caches()
                warm = [self._render(t, scene, flow) for t in times]

                for current_time, expected in zip(times, warm):
                    _clear_render_caches()
                    cold = self._render(current_time, scene, flow)
                    self.assertTrue(
                        np.array_equal(cold, expected),
                        f"el frame en t={current_time} cambia según el estado de la cache",
                    )

    def test_la_cache_de_lineas_difusas_distingue_color_y_radio(self):
        """Si la clave ignorara alfa o radio, las líneas lejanas se dibujarían
        con el desenfoque de las cercanas."""
        text, width = "todas las noches de rodillas", 1000
        base = generator._dim_line_layer(text, width, (164, 166, 176, 112), 2.4)
        otro_alfa = generator._dim_line_layer(text, width, (164, 166, 176, 68), 2.4)
        otro_radio = generator._dim_line_layer(text, width, (164, 166, 176, 112), 2.95)

        self.assertFalse(np.array_equal(np.array(base), np.array(otro_alfa)))
        self.assertFalse(np.array_equal(np.array(base), np.array(otro_radio)))

    def test_el_ancho_cacheado_coincide_con_una_medicion_nueva(self):
        font = generator._load_font(
            generator.FONT_FAMILIES["modern"]["bold"], 54
        )
        draw = ImageDraw.Draw(Image.new("RGBA", (4, 4)))

        for text in ("Yonaguni", "ya no me llegan", " ", "Nagú, ni le he llegado"):
            with self.subTest(text=text):
                bbox = draw.textbbox((0, 0), text, font=font)
                self.assertEqual(
                    generator._measure_text_width(text, font), bbox[2] - bbox[0]
                )


if __name__ == "__main__":
    unittest.main()
