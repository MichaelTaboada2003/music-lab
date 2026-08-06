import unittest

import numpy as np

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


if __name__ == "__main__":
    unittest.main()
