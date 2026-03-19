import json
import os
from pathlib import Path

import requests
from requests.exceptions import RequestException


def load_env_file():
    env_path = Path(__file__).resolve().parents[1] / ".env"
    if not env_path.exists():
        return
    for raw_line in env_path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip().strip('"').strip("'")
        if key and key not in os.environ:
            os.environ[key] = value


load_env_file()

BASE_URL = os.getenv("NANO_GPT_BASE_URL", "https://nano-gpt.com/api/v1")
API_KEY = os.getenv("NANO_GPT_API_KEY")
MODEL = os.getenv("NANO_GPT_MODEL", "tngtech/DeepSeek-TNG-R1T2-Chimera")


def stream_chat_completion(messages, model=MODEL):
    """Send a streaming chat completion request using the OpenAI-compatible endpoint."""
    if not API_KEY:
        raise RuntimeError("Missing NANO_GPT_API_KEY environment variable.")

    headers = {
        "Authorization": f"Bearer {API_KEY}",
        "Content-Type": "application/json",
        "Accept": "text/event-stream",
    }

    data = {
        "model": model,
        "messages": messages,
        "stream": True,
    }

    response = requests.post(
        f"{BASE_URL}/chat/completions",
        headers=headers,
        json=data,
        stream=True,
        timeout=(15, 60),
    )

    if response.status_code != 200:
        raise RuntimeError(f"Error: {response.status_code} {response.text}")

    for line in response.iter_lines():
        if not line:
            continue
        line = line.decode("utf-8")
        if line.startswith("data: "):
            line = line[6:]
        if line == "[DONE]":
            break
        try:
            chunk = json.loads(line)
            content = chunk["choices"][0]["delta"].get("content")
            if content:
                yield content
        except (json.JSONDecodeError, KeyError, IndexError, TypeError):
            continue


def main():
    messages = [
        {"role": "system", "content": "You are a helpful assistant."},
        {"role": "user", "content": "Please explain the concept of artificial intelligence."},
    ]

    print(f"Using model: {MODEL}")
    print(f"Base URL: {BASE_URL}")
    print("Assistant's Response:")
    try:
        saw_content = False
        for content_chunk in stream_chat_completion(messages):
            saw_content = True
            print(content_chunk, end="", flush=True)
        if not saw_content:
            print("\n[No streamed content received]")
        else:
            print("")
    except KeyboardInterrupt:
        print("\nInterrupted while waiting for streamed response.")
    except RequestException as exc:
        print(f"\nNetwork error: {exc}")
    except Exception as exc:
        print(f"\nError: {exc}")


if __name__ == "__main__":
    main()
