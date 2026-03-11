import os
from pathlib import Path

from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent.parent

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434") + "/api/chat"
MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:latest")
# MODEL = os.environ.get("OLLAMA_MODEL", "dolphin-llama3")
# MODEL = os.environ.get("OLLAMA_MODEL", "hf.co/Andycurrent/Gemma-3-4B-VL-it-Gemini-Pro-Heretic-Uncensored-Thinking_GGUF:Q4_K_M")

DEV_MODE = os.environ.get("DEV_MODE", "1") == "1"
NUM_CTX = int(os.environ.get("NUM_CTX", "8096"))
PROMPTS_DIR = BASE_DIR / "prompts"
MAPS_DIR = BASE_DIR / "maps"
MAPS_DIR.mkdir(exist_ok=True)
MAP_SPRITES_DIR = BASE_DIR / "map_sprites"
MAP_SPRITES_DIR.mkdir(exist_ok=True)

STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
