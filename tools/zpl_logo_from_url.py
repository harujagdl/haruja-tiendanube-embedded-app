#!/usr/bin/env python3
"""Descarga un PNG y lo convierte a bloque ZPL ^GFA sin dependencias externas."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from struct import unpack
from urllib.request import urlopen
import zlib

IMAGE_URL = "https://i.postimg.cc/mZF1T2vN/harujagdl-20250601-143504-0000.png"
OUTPUT_PATH = Path("tools/assets/haruja_logo_gfa.txt")
FALLBACK_LOCAL_PNG = Path("tools/assets/harujagdl_logo.png")
TARGET_WIDTH = 300
THRESHOLD = 128


@dataclass
class RawImage:
    width: int
    height: int
    pixels: list[tuple[int, int, int, int]]  # RGBA por pixel


def paeth_predictor(a: int, b: int, c: int) -> int:
    p = a + b - c
    pa = abs(p - a)
    pb = abs(p - b)
    pc = abs(p - c)
    if pa <= pb and pa <= pc:
        return a
    if pb <= pc:
        return b
    return c


def parse_png(data: bytes) -> RawImage:
    if data[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("Archivo no es PNG válido")

    pos = 8
    width = height = bit_depth = color_type = None
    idat = bytearray()

    while pos < len(data):
        length = unpack(">I", data[pos : pos + 4])[0]
        pos += 4
        chunk_type = data[pos : pos + 4]
        pos += 4
        chunk_data = data[pos : pos + length]
        pos += length
        pos += 4  # CRC

        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filter_method, interlace = unpack(">IIBBBBB", chunk_data
            )
            if compression != 0 or filter_method != 0:
                raise ValueError("PNG con compresión/filtro no soportado")
            if interlace != 0:
                raise ValueError("PNG interlazado no soportado")
            if bit_depth != 8:
                raise ValueError("Solo se soporta PNG de 8 bits por canal")
        elif chunk_type == b"IDAT":
            idat.extend(chunk_data)
        elif chunk_type == b"IEND":
            break

    if None in (width, height, bit_depth, color_type):
        raise ValueError("IHDR faltante")

    bytes_per_pixel = {
        0: 1,  # gris
        2: 3,  # RGB
        4: 2,  # gris+alpha
        6: 4,  # RGBA
    }.get(color_type)

    if bytes_per_pixel is None:
        raise ValueError(f"Color type {color_type} no soportado")

    decompressed = zlib.decompress(bytes(idat))
    stride = width * bytes_per_pixel
    expected = height * (stride + 1)
    if len(decompressed) < expected:
        raise ValueError("Datos IDAT incompletos")

    rgba_pixels: list[tuple[int, int, int, int]] = []
    prev_row = bytearray(stride)
    idx = 0

    for _ in range(height):
        filter_type = decompressed[idx]
        idx += 1
        row = bytearray(decompressed[idx : idx + stride])
        idx += stride

        for x in range(stride):
            left = row[x - bytes_per_pixel] if x >= bytes_per_pixel else 0
            up = prev_row[x]
            up_left = prev_row[x - bytes_per_pixel] if x >= bytes_per_pixel else 0

            if filter_type == 0:
                recon = row[x]
            elif filter_type == 1:
                recon = (row[x] + left) & 0xFF
            elif filter_type == 2:
                recon = (row[x] + up) & 0xFF
            elif filter_type == 3:
                recon = (row[x] + ((left + up) // 2)) & 0xFF
            elif filter_type == 4:
                recon = (row[x] + paeth_predictor(left, up, up_left)) & 0xFF
            else:
                raise ValueError(f"Filtro PNG no soportado: {filter_type}")
            row[x] = recon

        prev_row = row

        for p in range(0, len(row), bytes_per_pixel):
            if color_type == 0:
                g = row[p]
                rgba_pixels.append((g, g, g, 255))
            elif color_type == 2:
                rgba_pixels.append((row[p], row[p + 1], row[p + 2], 255))
            elif color_type == 4:
                g, a = row[p], row[p + 1]
                rgba_pixels.append((g, g, g, a))
            else:  # color_type == 6
                rgba_pixels.append((row[p], row[p + 1], row[p + 2], row[p + 3]))

    return RawImage(width=width, height=height, pixels=rgba_pixels)


def resize_nearest(image: RawImage, target_width: int) -> RawImage:
    if image.width <= target_width:
        return image

    ratio = target_width / image.width
    target_height = max(1, int(round(image.height * ratio)))
    out: list[tuple[int, int, int, int]] = []

    for y in range(target_height):
        src_y = min(image.height - 1, int(y / ratio))
        for x in range(target_width):
            src_x = min(image.width - 1, int(x / ratio))
            out.append(image.pixels[src_y * image.width + src_x])

    return RawImage(width=target_width, height=target_height, pixels=out)


def rgba_to_bw_pixels(image: RawImage, threshold: int) -> list[int]:
    bw = []
    for r, g, b, a in image.pixels:
        # Alpha sobre fondo blanco.
        alpha = a / 255
        r_out = int((r * alpha) + (255 * (1 - alpha)))
        g_out = int((g * alpha) + (255 * (1 - alpha)))
        b_out = int((b * alpha) + (255 * (1 - alpha)))

        gray = int((0.299 * r_out) + (0.587 * g_out) + (0.114 * b_out))
        bw.append(1 if gray < threshold else 0)  # 1=negro, 0=blanco
    return bw


def bw_to_gfa(width: int, height: int, bw_pixels: list[int]) -> str:
    bytes_per_row = (width + 7) // 8
    total_bytes = bytes_per_row * height
    rows: list[str] = []

    for y in range(height):
        row_hex = []
        for byte_index in range(bytes_per_row):
            value = 0
            for bit in range(8):
                x = byte_index * 8 + bit
                if x < width:
                    pixel = bw_pixels[y * width + x]
                    value |= (pixel & 1) << (7 - bit)
            row_hex.append(f"{value:02X}")
        rows.append("".join(row_hex))

    return f"^GFA,{total_bytes},{total_bytes},{bytes_per_row},{''.join(rows)}"


def main() -> None:
    try:
        with urlopen(IMAGE_URL, timeout=30) as response:
            image_data = response.read()
        source = IMAGE_URL
    except Exception:
        image_data = FALLBACK_LOCAL_PNG.read_bytes()
        source = str(FALLBACK_LOCAL_PNG)

    raw = parse_png(image_data)
    resized = resize_nearest(raw, TARGET_WIDTH)
    bw = rgba_to_bw_pixels(resized, THRESHOLD)
    gfa = bw_to_gfa(resized.width, resized.height, bw)

    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT_PATH.write_text(gfa, encoding="utf-8")

    print(f"Generado: {OUTPUT_PATH}")
    print(f"Fuente: {source}")
    print(f"Dimensiones procesadas: {resized.width}x{resized.height}")


if __name__ == "__main__":
    main()
