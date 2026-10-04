import shutil
import subprocess
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from fastapi import HTTPException

import video_library
from app.routers import video as video_router


def _make_video(path: Path, size="108x192", seconds=2):
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"testsrc=size={size}:rate=10:duration={seconds}",
         "-pix_fmt", "yuv420p", str(path)],
        check=True,
    )


class ParseNameTests(unittest.TestCase):
    def test_extrae_formato_y_opciones(self):
        parsed = video_library.parse_video_name("Bad Bunny - Yonaguni (recorte) - reproductor - linea")
        self.assertEqual(parsed["title"], "Bad Bunny - Yonaguni (recorte)")
        self.assertEqual(parsed["kind"], "player")
        self.assertEqual(parsed["tags"], ["Una línea"])

    def test_terminal_distingue_karaoke_y_escritura(self):
        karaoke = video_library.parse_video_name("Tema - karaoke - sunset")
        self.assertEqual((karaoke["kind"], karaoke["tags"]), ("terminal", ["Karaoke", "Atardecer"]))
        escritura = video_library.parse_video_name("Tema - escritura - cloud - mono-large")
        self.assertEqual(escritura["kind"], "terminal")
        self.assertEqual(escritura["tags"], ["Escritura", "Nube", "Monoespaciada grande"])

    def test_color_con_escritura_sigue_siendo_color(self):
        parsed = video_library.parse_video_name("Tema - color - linea - escritura")
        self.assertEqual(parsed["kind"], "color")
        self.assertEqual(parsed["tags"], ["Una línea", "Escritura"])

    def test_nombre_sin_formato_conserva_el_titulo_completo(self):
        parsed = video_library.parse_video_name("Artista - Canción larga")
        self.assertEqual((parsed["title"], parsed["kind"], parsed["tags"]), ("Artista - Canción larga", None, []))


class VideoActionsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        root = Path(self.tmp.name)
        self.videos = root / "videos"
        self.videos.mkdir()
        self._saved = (video_router.VIDEOS_DIR, video_library._INDEX_PATH, video_library.POSTERS_DIR)
        video_router.VIDEOS_DIR = self.videos
        video_library._INDEX_PATH = root / "index.json"
        video_library.POSTERS_DIR = root / "posters"
        video_library.POSTERS_DIR.mkdir()
        _make_video(self.videos / "Mi Tema - color.mp4")

    def tearDown(self):
        video_router.VIDEOS_DIR, video_library._INDEX_PATH, video_library.POSTERS_DIR = self._saved
        self.tmp.cleanup()

    def test_lista_con_metadatos_reales(self):
        data = video_router.api_videos()
        self.assertEqual(data["videos"], ["Mi Tema - color.mp4"])
        item = data["items"][0]
        self.assertEqual((item["kind"], item["orientation"]), ("color", "portrait"))
        self.assertEqual((item["width"], item["height"]), (108, 192))
        self.assertAlmostEqual(item["duration"], 2.0, delta=0.3)
        self.assertEqual(data["total_size"], item["size"])

    def test_portada_se_genera_una_vez(self):
        first = video_router.api_video_poster("Mi Tema - color.mp4")
        again = video_router.api_video_poster("Mi Tema - color.mp4")
        self.assertEqual(first.path, again.path)
        self.assertGreater(Path(first.path).stat().st_size, 500)

    def test_rutas_peligrosas_se_rechazan(self):
        for bad in ("../secreto.mp4", "carpeta/otro.mp4", "video.txt"):
            with self.assertRaises(HTTPException) as ctx:
                video_router._video_path(bad)
            self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            video_router._video_path("no-existe.mp4")
        self.assertEqual(ctx.exception.status_code, 404)

    def test_renombrar_actualiza_archivo_y_caches(self):
        video_router.api_video_poster("Mi Tema - color.mp4")
        item = video_router.api_video_rename("Mi Tema - color.mp4", video_router.RenameRequest(nuevo_nombre="Otro nombre.mp4"))
        self.assertEqual(item["name"], "Otro nombre.mp4")
        self.assertFalse((self.videos / "Mi Tema - color.mp4").exists())
        self.assertTrue((self.videos / "Otro nombre.mp4").is_file())
        self.assertEqual(list(video_library.POSTERS_DIR.glob("*.jpg")), [])

    def test_renombrar_no_pisa_ni_acepta_carpetas(self):
        _make_video(self.videos / "Existente.mp4")
        with self.assertRaises(HTTPException) as ctx:
            video_router.api_video_rename("Mi Tema - color.mp4", video_router.RenameRequest(nuevo_nombre="Existente"))
        self.assertEqual(ctx.exception.status_code, 409)
        with self.assertRaises(HTTPException) as ctx:
            video_router.api_video_rename("Mi Tema - color.mp4", video_router.RenameRequest(nuevo_nombre="../fuera"))
        self.assertEqual(ctx.exception.status_code, 400)

    def test_eliminar_borra_video_portada_y_ficha(self):
        video_router.api_video_poster("Mi Tema - color.mp4")
        video_router.api_video_delete("Mi Tema - color.mp4")
        self.assertEqual(list(self.videos.glob("*.mp4")), [])
        self.assertEqual(list(video_library.POSTERS_DIR.glob("*.jpg")), [])
        self.assertEqual(video_router.api_videos()["items"], [])


if __name__ == "__main__":
    unittest.main()
