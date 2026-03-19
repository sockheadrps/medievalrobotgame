import os
from pathlib import Path

from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent.parent
ENV_FILE = BASE_DIR.parent / ".env"

if ENV_FILE.exists():
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value

LLM_BASE_URL = os.environ.get("NANO_GPT_BASE_URL", os.environ.get("LLM_BASE_URL", "https://nano-gpt.com/api/v1"))
LLM_API_KEY = os.environ.get("NANO_GPT_API_KEY", os.environ.get("LLM_API_KEY", ""))
LLM_CHAT_URL = f"{LLM_BASE_URL.rstrip('/')}/chat/completions"
MODEL = os.environ.get("NANO_GPT_MODEL", os.environ.get("LLM_MODEL", "tngtech/DeepSeek-TNG-R1T2-Chimera"))
print(f"[config] LLM model: {MODEL}")
print(f"[config] LLM base URL: {LLM_BASE_URL}")
OLLAMA_URL = LLM_CHAT_URL

DEV_MODE = os.environ.get("DEV_MODE", "1") == "1"
SPAWN_AI_PLAYER = os.environ.get("SPAWN_AI_PLAYER", "1") == "1"
NUM_CTX = int(os.environ.get("NUM_CTX", "16384"))
ASSETS_DIR = BASE_DIR.parent / "assets"
WORLD_OBJECTS_DIR = ASSETS_DIR / "world_objects"
EQUIPMENT_DIR = ASSETS_DIR / "equipment"
ITEMS_DIR = ASSETS_DIR / "items"

PROMPTS_DIR = BASE_DIR / "prompts"
MAPS_DIR = BASE_DIR / "maps"
MAPS_DIR.mkdir(exist_ok=True)
MAP_SPRITES_DIR = BASE_DIR / "map_sprites"
MAP_SPRITES_DIR.mkdir(exist_ok=True)

STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
