from core.config import PROMPTS_DIR


def load_prompt(category: str) -> str:
    path = PROMPTS_DIR / f"{category}.txt"
    if not path.exists():
        path = PROMPTS_DIR / "fallback.txt"
    return path.read_text(encoding="utf-8")
