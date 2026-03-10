import argparse
import base64
import json
import re
import struct
import zlib
from pathlib import Path


TILE_SIZE = 16
RGBA_LEN = TILE_SIZE * TILE_SIZE * 4
ID_RE = re.compile(r"^[A-Za-z0-9_-]+$")
DATA_URL_PREFIX = "data:image/png;base64,"


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return (
        struct.pack(">I", len(data))
        + tag
        + data
        + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)
    )


def rgba_to_png_bytes(width: int, height: int, rgba: bytes) -> bytes:
    rows = []
    stride = width * 4
    for y in range(height):
        start = y * stride
        rows.append(b"\x00" + rgba[start : start + stride])  # filter byte 0 per row
    compressed = zlib.compress(b"".join(rows), level=9)

    signature = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0)
    return (
        signature
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", compressed)
        + png_chunk(b"IEND", b"")
    )


def parse_pixels(pixels) -> bytes | None:
    if not isinstance(pixels, list) or len(pixels) != RGBA_LEN:
        return None
    out = bytearray(RGBA_LEN)
    for i, value in enumerate(pixels):
        try:
            n = int(value)
        except Exception:
            return None
        if n < 0:
            n = 0
        elif n > 255:
            n = 255
        out[i] = n
    return bytes(out)


def decode_png_data_url(data_url: str) -> bytes | None:
    if not isinstance(data_url, str) or not data_url.startswith(DATA_URL_PREFIX):
        return None
    try:
        return base64.b64decode(data_url[len(DATA_URL_PREFIX) :], validate=True)
    except Exception:
        return None


def migrate_map_file(map_path: Path, sprites_dir: Path, dry_run: bool) -> dict:
    text = map_path.read_text(encoding="utf-8")
    data = json.loads(text)
    sprites = data.get("customSprites")
    if not isinstance(sprites, list) or not sprites:
        return {"map": map_path.name, "changed": False, "converted": 0, "kept": 0, "errors": 0}

    map_name = map_path.stem
    converted = 0
    kept = 0
    errors = 0
    changed = False
    new_sprites = []

    for sprite in sprites:
        if not isinstance(sprite, dict):
            errors += 1
            continue

        sprite_id = sprite.get("id")
        if not isinstance(sprite_id, str) or not ID_RE.fullmatch(sprite_id):
            errors += 1
            continue

        filename = f"{map_name}__{sprite_id}.png"
        out_path = sprites_dir / filename

        png_bytes = None
        if isinstance(sprite.get("pngFile"), str):
            existing_path = sprites_dir / sprite["pngFile"]
            if existing_path.exists():
                kept += 1
                new_sprites.append({"id": sprite_id, "pngFile": sprite["pngFile"]})
                continue
        if "pngDataUrl" in sprite:
            png_bytes = decode_png_data_url(sprite.get("pngDataUrl"))
        if png_bytes is None and "pixels" in sprite:
            rgba = parse_pixels(sprite.get("pixels"))
            if rgba is not None:
                png_bytes = rgba_to_png_bytes(TILE_SIZE, TILE_SIZE, rgba)

        if png_bytes is None:
            errors += 1
            continue

        converted += 1
        changed = True
        new_sprites.append({"id": sprite_id, "pngFile": filename})
        if not dry_run:
            out_path.write_bytes(png_bytes)

    if changed:
        data["customSprites"] = new_sprites
        if not dry_run:
            backup = map_path.with_suffix(map_path.suffix + ".bak_pre_png_migration")
            if not backup.exists():
                backup.write_text(text, encoding="utf-8")
            map_path.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")

    return {
        "map": map_path.name,
        "changed": changed,
        "converted": converted,
        "kept": kept,
        "errors": errors,
    }


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Migrate map customSprites from inline pixels/data URLs to PNG files."
    )
    parser.add_argument("--maps-dir", default="maps", help="Path to maps directory.")
    parser.add_argument(
        "--sprites-dir",
        default="map_sprites",
        help="Path to output sprite PNG directory.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Show changes without writing files.",
    )
    args = parser.parse_args()

    maps_dir = Path(args.maps_dir)
    sprites_dir = Path(args.sprites_dir)
    sprites_dir.mkdir(parents=True, exist_ok=True)

    results = []
    for map_path in sorted(maps_dir.glob("*.json")):
        result = migrate_map_file(map_path, sprites_dir, dry_run=args.dry_run)
        results.append(result)

    total_changed = sum(1 for r in results if r["changed"])
    total_converted = sum(r["converted"] for r in results)
    total_kept = sum(r["kept"] for r in results)
    total_errors = sum(r["errors"] for r in results)

    for r in results:
        print(
            f"{r['map']}: changed={r['changed']} converted={r['converted']} "
            f"kept={r['kept']} errors={r['errors']}"
        )

    print(
        f"SUMMARY maps={len(results)} changed={total_changed} "
        f"converted={total_converted} kept={total_kept} errors={total_errors}"
    )


if __name__ == "__main__":
    main()
