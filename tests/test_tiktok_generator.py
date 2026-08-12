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


class TikTokThemeTests(unittest.TestCase):
    def test_all_themes_render_distinct_full_hd_vertical_frames(self):
        stanzas = [[
            _line("No quiero perder este momento", 0.0),
            _line("quédate solo un poco más", 3.0),
        ]]
        fonts = generator._build_fonts("mono", "balanced")
        signatures = set()

        for theme_name in generator.VIDEO_THEMES:
            with self.subTest(theme=theme_name):
                frame = generator.make_karaoke_frame(
                    stanzas,
                    current_time=1.25,
                    fonts=fonts,
                    title="Ojitos Lindos",
                    artist="Bad Bunny",
                    layout_style="terminal",
                    theme_name=theme_name,
                )
                self.assertEqual(frame.shape, (1920, 1080, 3))
                self.assertEqual(frame.dtype, np.uint8)
                signatures.add(tuple(frame[1000, 980]))

        self.assertEqual(len(signatures), len(generator.VIDEO_THEMES))

    def test_long_hooks_reduce_lyric_size_instead_of_leaving_safe_zone(self):
        stanza = [
            _line("Hace mucho tiempo le hago caso al corazón y pasan los días pensando en tu olor", 0.0),
            _line("Ha llegado el tiempo para usar la razón antes que sea tarde", 3.0),
            _line("Nada más seremos dos en medio del tiempo sin decir adiós", 6.0),
            _line("Y solo mírame con esos ojitos lindos que con eso estoy bien", 9.0),
        ]
        fonts = generator._build_fonts("mono", "large")
        scene = generator.build_karaoke_scene(
            fonts,
            layout_style="terminal",
            theme_name="terminal",
        )
        draw = generator.ImageDraw.Draw(scene)

        selected_font, wrapped_lines, _ = generator._fit_lyric_layout(
            draw,
            stanza,
            fonts,
            generator.SAFE_CONTENT_WIDTH - 112,
        )

        self.assertLessEqual(selected_font.size, fonts["lyric"].size)
        self.assertGreater(len(wrapped_lines), 0)
        self.assertGreater(generator.SAFE_RIGHT, generator.SAFE_LEFT)
        self.assertLess(generator.SAFE_RIGHT, generator.VIDEO_SIZE[0])

    def test_font_scale_changes_content_but_keeps_terminal_chrome_stable(self):
        compact = generator._build_fonts("modern", "compact")
        large = generator._build_fonts("modern", "large")

        for role in ("title", "artist", "lyric"):
            with self.subTest(role=role):
                self.assertGreater(large[role].size, compact[role].size)
        for role in ("bar", "meta"):
            with self.subTest(role=role):
                self.assertEqual(large[role].size, compact[role].size)

    def test_player_layout_is_landscape_and_changes_with_sync_progress(self):
        stanzas = [[
            _line("Hace tiempo le hago caso al corazón", 0.0),
            _line("Y hoy mírame con esos ojitos lindos", 3.0),
        ], [
            _line("Que con eso yo estoy bien", 6.0),
        ]]
        fonts = generator._build_fonts("modern", "balanced")
        scene = generator.build_karaoke_scene(
            fonts,
            title="Ojitos Lindos",
            artist="Bad Bunny (ft Bomba Estéreo)",
            video_size=generator.PLAYER_VIDEO_SIZE,
            layout_style="player",
            audio_volume=0.5,
        )

        first = generator.make_karaoke_frame(
            stanzas,
            current_time=1.0,
            fonts=fonts,
            title="Ojitos Lindos",
            artist="Bad Bunny (ft Bomba Estéreo)",
            video_size=generator.PLAYER_VIDEO_SIZE,
            scene_image=scene,
            layout_style="player",
            audio_duration=12.0,
        )
        second = generator.make_karaoke_frame(
            stanzas,
            current_time=4.0,
            fonts=fonts,
            title="Ojitos Lindos",
            artist="Bad Bunny (ft Bomba Estéreo)",
            video_size=generator.PLAYER_VIDEO_SIZE,
            scene_image=scene,
            layout_style="player",
            audio_duration=12.0,
        )

        self.assertEqual(first.shape, (1080, 1920, 3))
        self.assertEqual(first.dtype, np.uint8)
        self.assertFalse(np.array_equal(first, second))
        self.assertEqual(generator.PLAYER_EXPORT_FPS, 60)
        self.assertEqual(generator.TERMINAL_EXPORT_FPS, 30)

    def test_player_page_stays_fixed_while_filling_down(self):
        rows = dict(generator._player_page_rows(8))

        self.assertEqual(rows[0], 125)
        self.assertEqual(rows[1], 243)
        self.assertEqual(rows[7], 951)
        self.assertEqual(len(rows), generator.PLAYER_PAGE_LINE_CAPACITY)
        self.assertGreater(generator._player_transition_ease(0.5), 0.5)

    def test_player_appends_selected_stanzas_until_page_is_full(self):
        first = [
            _line("Primera linea", 0.0),
            _line("Segunda linea", 3.0),
            _line("Tercera linea", 6.0),
        ]
        second = [
            _line("Nueva estrofa arriba", 12.0),
            _line("Luego continua abajo", 15.0),
            _line("Todavia cabe", 18.0),
        ]
        third = [
            _line("Sigue en la misma pagina", 21.0),
            _line("Octava linea disponible", 24.0),
            _line("Esta abre una pagina nueva", 27.0),
        ]
        stanzas = [first, second, third]

        page, active, page_index = generator._player_page_for_time(
            stanzas, 21.1
        )
        self.assertEqual(page_index, 0)
        self.assertEqual(active, 6)
        self.assertEqual(len(page), 8)

        page, active, page_index = generator._player_page_for_time(
            stanzas, 27.1
        )
        self.assertEqual(page_index, 1)
        self.assertEqual(active, 0)
        self.assertEqual(page[0]["text"], "Esta abre una pagina nueva")
        self.assertEqual(dict(generator._player_page_rows(len(page)))[0], 125)

        selected, active, page_index = generator._player_page_for_time(
            stanzas, 12.1, fragment_start=12.0, fragment_end=30.0
        )
        self.assertEqual(page_index, 0)
        self.assertEqual(active, 0)
        self.assertEqual(selected[0]["text"], "Nueva estrofa arriba")

    def test_single_line_flow_uses_only_the_current_line_in_both_layouts(self):
        first = _line("Primera linea", 0.0)
        second = _line("Segunda linea", 3.0)
        third = _line("Tercera linea", 6.0)
        stanzas = [[first, second], [third]]

        self.assertIs(generator._active_line_for_time(stanzas, 4.0), second)
        self.assertIs(
            generator._active_line_for_time(
                stanzas, 6.1, fragment_start=6.0, fragment_end=9.0
            ),
            third,
        )

        player_fonts = generator._build_fonts("modern", "balanced")
        player_scene = generator.build_karaoke_scene(
            player_fonts,
            video_size=generator.PLAYER_VIDEO_SIZE,
            layout_style="player",
        )
        player_block = generator.make_karaoke_frame(
            stanzas, 4.0, player_fonts,
            video_size=generator.PLAYER_VIDEO_SIZE,
            scene_image=player_scene,
            layout_style="player",
        )
        player_line = generator.make_karaoke_frame(
            stanzas, 4.0, player_fonts,
            video_size=generator.PLAYER_VIDEO_SIZE,
            scene_image=player_scene,
            layout_style="player",
            lyric_flow="line",
        )
        self.assertFalse(np.array_equal(player_block, player_line))

        terminal_fonts = generator._build_fonts("mono", "balanced")
        layout_probe = ImageDraw.Draw(Image.new("RGB", generator.VIDEO_SIZE))
        single_font, single_wrapped, _ = generator._fit_single_line_lyric_layout(
            layout_probe,
            [_line("When you gonna stop breaking my heart", 0.0)],
            terminal_fonts,
            round(generator.VIDEO_SIZE[0] * generator.SINGLE_LINE_LYRIC_WIDTH_RATIO),
        )
        self.assertGreaterEqual(len(single_wrapped), 2)
        self.assertLessEqual(len(single_wrapped), 3)
        self.assertEqual(
            [" ".join(word["text"] for word in row) for row, _ in single_wrapped],
            ["When you gonna", "stop breaking", "my heart"],
        )
        self.assertGreater(
            single_font.size,
            terminal_fonts["lyric_by_density"]["normal"].size,
        )
        terminal_block = generator.make_karaoke_frame(
            stanzas, 4.0, terminal_fonts, layout_style="terminal"
        )
        terminal_line = generator.make_karaoke_frame(
            stanzas, 4.0, terminal_fonts,
            layout_style="terminal", lyric_flow="line"
        )
        self.assertFalse(np.array_equal(terminal_block, terminal_line))

    def test_player_volume_changes_chrome_and_rejects_invalid_values(self):
        fonts = generator._build_fonts("modern", "balanced")
        quiet = np.array(generator.build_karaoke_scene(
            fonts,
            video_size=generator.PLAYER_VIDEO_SIZE,
            layout_style="player",
            audio_volume=0.25,
        ))
        loud = np.array(generator.build_karaoke_scene(
            fonts,
            video_size=generator.PLAYER_VIDEO_SIZE,
            layout_style="player",
            audio_volume=0.75,
        ))

        self.assertFalse(np.array_equal(quiet[1000:1045, 120:660], loud[1000:1045, 120:660]))
        with self.assertRaisesRegex(ValueError, "volumen"):
            generator.create_tiktok_video(
                "missing.mp3",
                "missing.txt",
                "missing.mp4",
                audio_volume=1.1,
            )

    def test_player_volume_icon_has_distinct_mute_low_and_high_states(self):
        fonts = generator._build_fonts("modern", "balanced")
        states = []
        for volume in (0.0, 0.25, 0.75):
            scene = np.array(generator.build_karaoke_scene(
                fonts,
                video_size=generator.PLAYER_VIDEO_SIZE,
                layout_style="player",
                audio_volume=volume,
            ))
            states.append(scene[1000:1050, 60:125])

        self.assertFalse(np.array_equal(states[0], states[1]))
        self.assertFalse(np.array_equal(states[1], states[2]))

    def test_invalid_lyric_flow_is_rejected_before_audio_resolution(self):
        with self.assertRaisesRegex(ValueError, "distribución"):
            generator.create_tiktok_video(
                "missing.mp3",
                "missing.txt",
                "missing.mp4",
                lyric_flow="invalid",
            )


if __name__ == "__main__":
    unittest.main()
