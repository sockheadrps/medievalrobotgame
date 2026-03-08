from pathlib import Path

from fastapi.templating import Jinja2Templates

BASE_DIR = Path(__file__).resolve().parent.parent

OLLAMA_URL = "http://127.0.0.1:11434/api/chat"
MODEL = "llama3.2:latest"
PROMPTS_DIR = BASE_DIR / "prompts"
MAPS_DIR = BASE_DIR / "maps"
MAPS_DIR.mkdir(exist_ok=True)

STATIC_DIR = BASE_DIR / "static"
TEMPLATES_DIR = BASE_DIR / "templates"

templates = Jinja2Templates(directory=str(TEMPLATES_DIR))
