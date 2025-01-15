from fastapi import FastAPI, Query
from fastapi.staticfiles import StaticFiles
import yt_dlp
import os
import subprocess
import json
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()

# Configura la lista de orígenes permitidos
origins = [
    "http://127.0.0.1:5500",  # Tu front-end (puerto 5500 o donde estés sirviendo el HTML)
    "http://localhost:5500",  # Por si usas localhost en vez de 127.0.0.1
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.mount("/canciones", StaticFiles(directory="canciones"), name="canciones")

ARTISTAS = {
    "Impacto.webm": "Enjambre",
    "did i tell u that i miss u": "adore",
}


@app.get("/")
def read_root():
    return {"Hello": "World"}

@app.get("/descargar_audio_mp3")
def descargar_audio_mp3(
    url: str = Query(..., description="URL"),
    nombre_salida: str = Query("%(title)s", description="Plantilla para el nombre del archivo de salida")
):
    ruta_archivo_salida = os.path.join("canciones", nombre_salida + ".%(ext)s")
    ydl_opts = {
        'format': 'bestaudio/best',          # Mejor formato de audio disponible
        'outtmpl': ruta_archivo_salida,        # Plantilla para el nombre del archivo
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',         # Convertir a MP3
            'preferredquality': '192',       # Bitrate de 192 kbps
        }],
    }

    # Ejecuta la descarga
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            ydl.download([url])
        # Retornamos un mensaje de éxito (o podrías retornar más datos según necesites)
        return {"status": "ok", "message": "Descarga y conversión completa"}
    except Exception as e:
        return {"status": "error", "message": str(e)}
    
    
def obtener_duracion(ruta_archivo):
    try:
        comando = [
            "ffprobe", 
            "-v", "error", 
            "-show_entries", "format=duration", 
            "-of", "json", 
            ruta_archivo
        ]
        resultado = subprocess.run(comando, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if resultado.returncode == 0:
            info = json.loads(resultado.stdout)
            duracion_segundos = float(info['format']['duration'])
            minutos = int(duracion_segundos // 60)
            segundos = int(duracion_segundos % 60)
            return f"{minutos}:{str(segundos).zfill(2)}"
        else:
            return "Desconocida"
    except Exception as e:
        return "Desconocida"

@app.get("/lista_canciones")
def lista_canciones():
    archivos_webm = []
    for nombre in os.listdir("canciones"):
        ruta_archivo = os.path.join("canciones", nombre)
        if os.path.isfile(ruta_archivo) and nombre.endswith(".webm"):
            duracion = obtener_duracion(ruta_archivo)
            artista = ARTISTAS.get(nombre, "Desconocido")  # Obtener el artista del diccionario
            archivos_webm.append({"nombre": nombre, "duracion": duracion, "artista": artista})
    return {"canciones": archivos_webm}