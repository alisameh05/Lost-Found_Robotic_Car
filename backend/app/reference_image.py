import re
import struct
import zlib
from dataclasses import dataclass
from io import BytesIO

from PIL import Image, ImageOps, UnidentifiedImageError

from .http import HttpError
from .registration_input import Registration, invalid

PIXEL_LIMIT = 20_000_000
PNG = b"\x89PNG\r\n\x1a\n"
JPEG = b"\xff\xd8"
NEXT_JPEG_MARKER = re.compile(rb"\xff+(?![\xff\x00\xd0-\xd7])")
ADAM7 = ((0, 0, 8, 8), (4, 0, 8, 8), (0, 4, 4, 8), (2, 0, 4, 4), (0, 2, 2, 4), (1, 0, 2, 2), (0, 1, 1, 2))


@dataclass(frozen=True)
class Reference:
    content_type: str
    width: int
    height: int
    data: bytes


def check_dimensions(width: int, height: int) -> None:
    if min(width, height) <= 0:
        raise ValueError
    if width * height > PIXEL_LIMIT:
        raise HttpError(413, "PAYLOAD_TOO_LARGE", "The reference image exceeds 20 million pixels.")


def inspect_jpeg(source: bytes) -> bytes:
    offset = 2
    frame = scan = exif = False
    while offset < len(source):
        if source[offset] != 0xff:
            break
        while offset < len(source) and source[offset] == 0xff:
            offset += 1
        if offset >= len(source):
            break
        marker = source[offset]
        offset += 1
        if marker == 0xd9 and frame and scan:
            # A single JPEG ends at EOI. Some cameras append unrelated padding.
            return source[:offset]
        if marker == 0 or 0xd0 <= marker <= 0xd9 or offset + 2 > len(source):
            break
        length, = struct.unpack_from(">H", source, offset)
        end = offset + length
        if length < 2 or end > len(source):
            break
        payload = offset + 2
        if 0xc0 <= marker <= 0xcf and marker not in (0xc4, 0xc8, 0xcc):
            if length < 8 or frame:
                break
            depth, height, width, channels = struct.unpack_from(">BHHB", source, payload)
            if marker not in (0xc0, 0xc2) or depth != 8 or channels not in (1, 3):
                raise invalid("/reference_image", "Use a baseline or progressive 8-bit grayscale or RGB JPEG.")
            if length != 8 + 3 * channels:
                break
            check_dimensions(width, height)
            frame = True
        elif marker == 0xe1 and source.startswith(b"Exif\0\0", payload, end):
            if exif:
                break
            exif = True
        elif marker == 0xe2 and source.startswith(b"MPF\0", payload, end):
            raise invalid("/reference_image", "Multi-picture JPEG references are unsupported.")
        offset = end
        if marker == 0xda:
            if not frame or length < 8 or length != 6 + 2 * source[payload]:
                break
            next_marker = NEXT_JPEG_MARKER.search(source, end)
            if next_marker is None or next_marker.start() == end:
                break
            offset = next_marker.start()
            scan = True
    raise ValueError


def check_png_scanlines(
    compressed: bytearray, width: int, height: int, bits_per_pixel: int, interlace: int,
) -> None:
    layout = ADAM7 if interlace else ((0, 0, 1, 1),)
    passes = []
    for x, y, dx, dy in layout:
        columns = (width - x + dx - 1) // dx
        rows = (height - y + dy - 1) // dy
        if columns > 0 and rows > 0:
            passes.append(((columns * bits_per_pixel + 7) // 8 + 1, rows))
    size = sum(stride * rows for stride, rows in passes)
    decoder = zlib.decompressobj()
    pixels = decoder.decompress(compressed, size + 1)
    if len(pixels) != size or not decoder.eof or decoder.unused_data or decoder.unconsumed_tail:
        raise ValueError
    offset = 0
    for stride, rows in passes:
        end = offset + stride * rows
        if max(pixels[offset:end:stride]) > 4:
            raise ValueError
        offset = end


def inspect_png(source: bytes) -> tuple[bytes, int]:
    if len(source) < 33 or source[8:16] != b"\x00\x00\x00\x0dIHDR":
        raise ValueError
    width, height, depth, color, compression, filtering, interlace = struct.unpack_from(">IIBBBBB", source, 16)
    check_dimensions(width, height)
    if (color == 3 and depth not in (1, 2, 4, 8)) or (color != 3 and (color not in (0, 2, 6) or depth != 8)):
        raise invalid("/reference_image", "Use an 8-bit grayscale, RGB, RGBA, or supported indexed PNG.")
    if compression or filtering or interlace > 1:
        raise ValueError
    palette = 0
    transparency = exif = saw_data = passed_data = False
    image_data = bytearray()
    kept = bytearray(PNG)
    offset = len(PNG)
    while offset + 12 <= len(source):
        length, tag = struct.unpack_from(">I4s", source, offset)
        start = offset + 8
        end = start + length
        if end + 4 > len(source) or zlib.crc32(memoryview(source)[offset + 4:end]) != int.from_bytes(
            source[end:end + 4], "big",
        ):
            break
        if tag == b"IHDR":
            if offset != len(PNG):
                break
        elif tag in (b"acTL", b"fcTL", b"fdAT"):
            raise invalid("/reference_image", "Animated PNG references are unsupported.")
        elif tag == b"eXIf":
            if exif:
                break
            exif = True
        elif tag == b"PLTE":
            if palette or transparency or saw_data or color == 0 or not 0 < length <= 768 or length % 3:
                break
            palette = length // 3
            if color == 3 and palette > 2**depth:
                break
        elif tag == b"tRNS":
            if transparency or saw_data or not length or not {
                0: length == 2, 2: length == 6, 3: length <= palette,
            }.get(color, False):
                break
            transparency = True
        elif tag == b"IDAT":
            if passed_data or (color == 3 and not palette):
                break
            saw_data = True
            image_data.extend(memoryview(source)[start:end])
        elif tag == b"IEND":
            if length or end + 4 != len(source) or not image_data:
                break
            check_png_scanlines(image_data, width, height, {2: 3, 6: 4}.get(color, 1) * depth, interlace)
            kept.extend(source[offset:end + 4])
            return bytes(kept), palette if color == 3 else 0
        elif not re.fullmatch(rb"[a-z][A-Za-z]{3}", tag):
            break
        else:
            # The managed copy never needs ancillary text or compressed profiles.
            passed_data = saw_data
            offset = end + 4
            continue
        passed_data = saw_data and tag != b"IDAT"
        kept.extend(memoryview(source)[offset:end + 4])
        offset = end + 4
    raise ValueError


def decode_reference(source: bytes, kind: str) -> Image.Image:
    if kind == "PNG":
        return Image.open(BytesIO(source), formats=[kind])
    from simplejpeg import decode_jpeg  # type: ignore[import-untyped]

    # Pillow tolerates some incomplete entropy scans. Strict libjpeg warnings must fail admission.
    with Image.open(BytesIO(source), formats=[kind]) as metadata:
        image = Image.fromarray(decode_jpeg(source, strict=True))
        if image.size != metadata.size:
            image.close()
            raise ValueError
        exif = metadata.info.get("exif")
        if exif:
            image.info["exif"] = exif
        return image


def prepare_reference(registration: Registration) -> Reference:
    source = registration.image
    palette = 0
    try:
        if source.startswith(PNG):
            source, palette = inspect_png(source)
            kind = "PNG"
        elif source.startswith(JPEG):
            source = inspect_jpeg(source)
            kind = "JPEG"
        else:
            raise invalid("/reference_image", "Choose a JPEG or PNG reference image.")
        with decode_reference(source, kind) as image:
            image.load()
            if palette:
                extrema = image.getextrema()
                if not extrema or not isinstance(extrema[1], int) or extrema[1] >= palette:
                    raise ValueError
            with ImageOps.exif_transpose(image) as oriented:
                width, height = oriented.size
                roi = registration.roi
                if roi["x"] + roi["width"] > width or roi["y"] + roi["height"] > height:
                    raise invalid("/roi", "Select a nonzero rectangle within the normalized reference.", "OUT_OF_RANGE")
                output = BytesIO()
                with Image.new("RGB", oriented.size, "white") as flattened, oriented.convert("RGBA") as rgba:
                    flattened.paste(rgba, mask=rgba.getchannel("A"))
                    options = {"quality": 95, "subsampling": 0} if kind == "JPEG" else {}
                    flattened.save(output, format=kind, **options)
                return Reference(f"image/{kind.lower()}", width, height, output.getvalue())
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError, struct.error, zlib.error) as exc:
        raise invalid("/reference_image", "The reference image is corrupt or unreadable.") from exc
