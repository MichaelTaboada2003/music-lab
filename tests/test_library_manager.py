import json
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

import library_manager as manager
import library_metadata
from app.routers import library as router


class _Base(unittest.TestCase):
    def setUp(self):
        self.tmp = TemporaryDirectory()
        root = Path(self.tmp.name)
        self.root = root
        for name in ("canciones", "letras", "vocals", "videos", ".covers"):
            (root / name).mkdir()
        self._saved = {
            key: getattr(manager, key)
            for key in ("BASE_DIR", "CANCIONES_DIR", "LETRAS_DIR", "VOCALS_DIR", "VIDEOS_DIR",
                        "COVERS_DIR", "TRASH_DIR", "QUALITY_PATH")
        }
        manager.BASE_DIR = root
        manager.CANCIONES_DIR = root / "canciones"
        manager.LETRAS_DIR = root / "letras"
        manager.VOCALS_DIR = root / "vocals"
        manager.VIDEOS_DIR = root / "videos"
        manager.COVERS_DIR = root / ".covers"
        manager.TRASH_DIR = root / ".papelera"
        manager.QUALITY_PATH = root / ".audio_quality.json"
        self._meta = library_metadata._METADATA_PATH
        library_metadata._METADATA_PATH = root / "meta.json"
        self._drop = manager.library_artwork.drop_cover
        self.dropped = []
        manager.library_artwork.drop_cover = lambda song: self.dropped.append(song.name)

        self._file("canciones", "Tema.mp3", 1000)
        self._file("letras", "Tema.txt", 50)
        self._file("letras", "Tema.sync.json", 300)
        self._file("vocals", "Tema.vocals.flac", 4000)
        self._file("vocals", "Tema.instrumental.wav", 3000)
        self._file("canciones", "Otro.mp3", 800)

    def tearDown(self):
        for key, value in self._saved.items():
            setattr(manager, key, value)
        library_metadata._METADATA_PATH = self._meta
        manager.library_artwork.drop_cover = self._drop
        self.tmp.cleanup()

    def _file(self, folder, name, size):
        (self.root / folder / name).write_bytes(b"x" * size)


class InventoryTests(_Base):
    def test_tamano_de_cada_parte_y_totales(self):
        inv = manager.inventory()
        tema = next(s for s in inv["songs"] if s["stem"] == "Tema")
        self.assertEqual({k: (v or {}).get("size") for k, v in tema["parts"].items()},
                         {"audio": 1000, "lyrics": 50, "sync": 300, "vocals": 4000, "instrumental": 3000})
        self.assertEqual(tema["total_size"], 8350)
        self.assertEqual(tema["parts"]["instrumental"]["ext"], "wav")
        otro = next(s for s in inv["songs"] if s["stem"] == "Otro")
        self.assertIsNone(otro["parts"]["lyrics"])
        self.assertEqual(inv["totals"]["stems"], 7000)
        self.assertEqual(inv["totals"]["audio"], 1800)

    def test_detecta_archivos_sin_cancion(self):
        self._file("letras", "Borrada.txt", 10)
        self._file("vocals", "Borrada.vocals.flac", 20)
        self._file("letras", "Tema.before-correction.txt", 5)
        orphans = {o["name"]: o["reason"] for o in manager.inventory()["orphans"]}
        self.assertEqual(orphans["Borrada.txt"], "Letra sin canción")
        self.assertEqual(orphans["Borrada.vocals.flac"], "Stem sin canción")
        self.assertEqual(orphans["Tema.before-correction.txt"], "Copia de seguridad")
        self.assertNotIn("Tema.txt", orphans)


class DeleteAndRestoreTests(_Base):
    def test_borrar_la_letra_arrastra_la_sincronizacion(self):
        entry = manager.delete_parts("Tema", ["lyrics"])
        self.assertEqual(entry["parts"], ["lyrics", "sync"])
        self.assertFalse((self.root / "letras" / "Tema.txt").exists())
        self.assertFalse((self.root / "letras" / "Tema.sync.json").exists())
        self.assertTrue((self.root / "canciones" / "Tema.mp3").exists())
        self.assertTrue((self.root / "vocals" / "Tema.vocals.flac").exists())

    def test_borrar_solo_los_stems_conserva_audio_y_letra(self):
        manager.delete_parts("Tema", ["vocals", "instrumental"])
        self.assertEqual(list((self.root / "vocals").iterdir()), [])
        self.assertTrue((self.root / "letras" / "Tema.txt").exists())

    def test_borrar_el_audio_elimina_todo_y_guarda_la_ficha(self):
        library_metadata.set_override("Tema", {"title": "Mi título", "artist": "Yo"})
        entry = manager.delete_parts("Tema", ["audio"])
        self.assertEqual(entry["parts"], list(manager.PARTS))
        self.assertEqual([p.name for p in (self.root / "canciones").iterdir()], ["Otro.mp3"])
        self.assertEqual(list((self.root / "letras").iterdir()), [])
        self.assertEqual(list((self.root / "vocals").iterdir()), [])
        self.assertEqual(entry["state"]["metadata"]["title"], "Mi título")
        self.assertNotIn("Tema", json.loads((self.root / "meta.json").read_text()))
        self.assertEqual(self.dropped, ["Tema.mp3"])

    def test_restaurar_devuelve_archivos_y_ficha(self):
        library_metadata.set_override("Tema", {"title": "Mi título", "artist": "Yo"})
        entry = manager.delete_parts("Tema", ["audio"])
        manager.restore(entry["id"])
        self.assertEqual((self.root / "canciones" / "Tema.mp3").stat().st_size, 1000)
        self.assertEqual((self.root / "vocals" / "Tema.instrumental.wav").stat().st_size, 3000)
        self.assertEqual(library_metadata.display_info("Tema")["title"], "Mi título")
        self.assertEqual(manager.list_trash(), [])

    def test_restaurar_no_pisa_archivos_existentes(self):
        entry = manager.delete_parts("Tema", ["lyrics"])
        self._file("letras", "Tema.txt", 7)
        with self.assertRaises(manager.LibraryError) as ctx:
            manager.restore(entry["id"])
        self.assertEqual(ctx.exception.status, 409)
        self.assertEqual((self.root / "letras" / "Tema.txt").stat().st_size, 7)

    def test_purgar_y_vaciar_liberan_espacio(self):
        first = manager.delete_parts("Tema", ["vocals"])
        manager.delete_parts("Otro", ["audio"])
        self.assertEqual(manager.purge(first["id"]), 4000)
        self.assertEqual(manager.empty_trash(), 800)
        self.assertEqual(manager.list_trash(), [])

    def test_sin_archivos_no_crea_entrada(self):
        self.assertIsNone(manager.delete_parts("Otro", ["lyrics"]))
        self.assertEqual(manager.list_trash(), [])

    def test_huerfanos_pasan_por_la_papelera(self):
        self._file("letras", "Borrada.txt", 10)
        entry = manager.delete_orphans([{"dir": "letras", "name": "Borrada.txt"}])
        self.assertEqual(entry["parts"], ["orphans"])
        manager.restore(entry["id"])
        self.assertTrue((self.root / "letras" / "Borrada.txt").exists())


class ValidationTests(_Base):
    def test_rechaza_rutas_y_partes_invalidas(self):
        for bad in ("../x", "a/b", ".oculto", ""):
            with self.assertRaises(manager.LibraryError):
                manager.delete_parts(bad, ["audio"])
        with self.assertRaises(manager.LibraryError):
            manager.delete_parts("Tema", ["portada"])
        with self.assertRaises(manager.LibraryError):
            manager.delete_orphans([{"dir": "letras", "name": "../meta.json"}])
        with self.assertRaises(manager.LibraryError):
            manager.delete_orphans([{"dir": "canciones", "name": "Tema.mp3"}])
        for bad_id in ("../..", "20260101-000000-zzzz", "x"):
            with self.assertRaises(manager.LibraryError):
                manager.purge(bad_id)

    def test_endpoint_traduce_errores_a_http(self):
        from fastapi import HTTPException
        with self.assertRaises(HTTPException) as ctx:
            router.api_biblioteca_eliminar(router.DeleteRequest(items=[{"stem": "../x", "parts": ["audio"]}]))
        self.assertEqual(ctx.exception.status_code, 400)
        with self.assertRaises(HTTPException) as ctx:
            router.api_papelera_restaurar("20260101-000000-abcd")
        self.assertEqual(ctx.exception.status_code, 404)
        data = router.api_biblioteca()
        self.assertEqual(len(data["songs"]), 2)
        self.assertEqual(data["trash"], [])


if __name__ == "__main__":
    unittest.main()
