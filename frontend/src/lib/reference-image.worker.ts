import { decode as decodeJpeg, encode as encodeJpeg } from "jpeg-js";
import {
  maxReferenceBytes, maxReferencePixels, ReferenceImageError, type ImageDimensions, type NormalizedReference,
  type ReferenceContentType, type ReferenceDecodeRequest, type ReferenceDecodeResponse,
} from "./reference-image-format";

type ScanPass = { width: number; rows: number; rowBytes: number };
type PngData = { compressed: Blob; passes: ScanPass[]; indexed?: { entries: number; depth: number } };
type Source = ImageDimensions & { type: ReferenceContentType; orientation: number; decode: Blob; png?: PngData };

function corrupt(): never {
  throw new ReferenceImageError("The reference image is corrupt or unreadable.", 422);
}

function unsupported(message: string): never {
  throw new ReferenceImageError(message, 422);
}

function checkSize(width: number, height: number) {
  if (!width || !height) corrupt();
  if (width * height > maxReferencePixels) {
    throw new ReferenceImageError("The reference image exceeds 20 million pixels.", 413);
  }
}

function orientationOf(tiff: DataView) {
  if (tiff.byteLength < 8) return 1;
  const order = tiff.getUint16(0);
  if (order !== 0x4949 && order !== 0x4d4d) return 1;
  const little = order === 0x4949;
  if (tiff.getUint16(2, little) !== 42) return 1;
  const ifd = tiff.getUint32(4, little);
  if (ifd > tiff.byteLength - 2) return 1;
  const entries = tiff.getUint16(ifd, little);
  for (let index = 0; index < entries; index++) {
    const start = ifd + 2 + index * 12;
    if (start > tiff.byteLength - 12) break;
    if (tiff.getUint16(start, little) !== 0x0112) continue;
    const value = tiff.getUint16(start + 8, little);
    if (tiff.getUint16(start + 2, little) === 3 && tiff.getUint32(start + 4, little) === 1 &&
        value >= 1 && value <= 8) return value;
  }
  return 1;
}

function inspectJpeg(bytes: Uint8Array<ArrayBuffer>, file: Blob): Source {
  const view = new DataView(bytes.buffer);
  let size: ImageDimensions | undefined;
  let orientation = 1;
  let scanned = false;
  let offset = 2;
  let keptFrom = 0;
  let hasExif = false;
  const parts: Blob[] = [];
  while (offset < bytes.length) {
    const start = offset;
    if (bytes[offset++] !== 0xff) corrupt();
    while (bytes[offset] === 0xff) offset++;
    const marker = bytes[offset++];
    if (marker === 0xd9) {
      if (!size || !scanned) corrupt();
      const decoded = decodeJpeg(bytes.subarray(0, offset), {
        useTArray: true, formatAsRGBA: false, tolerantDecoding: false, maxResolutionInMP: 20, maxMemoryUsageInMB: 512,
      });
      if (decoded.width !== size.width || decoded.height !== size.height) corrupt();
      return { ...size, type: "image/jpeg", orientation,
        decode: new Blob([...parts, file.slice(keptFrom, offset)], { type: "image/jpeg" }) };
    }
    if (!marker || marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd7) || offset + 2 > bytes.length) corrupt();
    const length = view.getUint16(offset);
    const end = offset + length;
    const payload = offset + 2;
    if (length < 2 || end > bytes.length) corrupt();
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      if (length < 8 || size) corrupt();
      const components = bytes[payload + 5];
      if (length !== 8 + components * 3) corrupt();
      if (bytes[payload] !== 8) unsupported("Only 8-bit JPEG references are supported.");
      if (components === 4) unsupported("CMYK JPEG references are unsupported.");
      if (![0xc0, 0xc2].includes(marker) || ![1, 3].includes(components)) {
        unsupported("Use a baseline or progressive grayscale or RGB JPEG.");
      }
      size = { width: view.getUint16(payload + 3), height: view.getUint16(payload + 1) };
      checkSize(size.width, size.height);
    } else if (marker === 0xe1 && length >= 8 && view.getUint32(payload) === 0x45786966 &&
        view.getUint16(payload + 4) === 0) {
      if (hasExif) corrupt();
      hasExif = true;
      orientation = orientationOf(new DataView(bytes.buffer, payload + 6, end - payload - 6));
      parts.push(file.slice(keptFrom, start));
      keptFrom = end;
    } else if (marker === 0xe2 && length >= 6 && view.getUint32(payload) === 0x4d504600) {
      unsupported("Multi-picture JPEG references are unsupported.");
    }
    offset = end;
    if (marker === 0xda) {
      if (!size || length < 8 || length !== 6 + 2 * bytes[payload]) corrupt();
      // Entropy data uses stuffed FF bytes and restart markers. Stop at the next segment.
      const scanStart = offset;
      while (offset < bytes.length) {
        if (bytes[offset++] !== 0xff) continue;
        while (bytes[offset] === 0xff) offset++;
        const next = bytes[offset];
        if (next === 0 || (next >= 0xd0 && next <= 0xd7)) offset++;
        else { offset--; break; }
      }
      if (offset === scanStart) corrupt();
      scanned = true;
    }
  }
  return corrupt();
}

const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

function checksum(bytes: Uint8Array, start: number, end: number) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index++) crc = crcTable[(crc ^ bytes[index]) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes: Uint8Array<ArrayBuffer>): Source {
  const view = new DataView(bytes.buffer);
  let size: ImageDimensions | undefined;
  let passes: ScanPass[] = [];
  let color = 0;
  let depth = 0;
  let paletteEntries = 0;
  let transparency = false;
  let orientation = 1;
  let hasExif = false;
  let offset = 8;
  let keptLength = 8;
  let imageDataLength = 0;
  let sawImageData = false;
  let passedImageData = false;
  const imageData = new Uint8Array(bytes.length);
  const kept = new Uint8Array(bytes.length);
  kept.set(bytes.subarray(0, 8));
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    const start = offset + 8;
    const end = start + length;
    if (end + 4 > bytes.length || checksum(bytes, offset + 4, end) !== view.getUint32(end)) corrupt();
    const tag = String.fromCharCode(...bytes.subarray(offset + 4, start));
    if (!size && tag !== "IHDR") corrupt();
    let keep = true;
    if (tag === "IHDR") {
      if (size || length !== 13) corrupt();
      const dimensions = { width: view.getUint32(start), height: view.getUint32(start + 4) };
      checkSize(dimensions.width, dimensions.height);
      size = dimensions;
      depth = bytes[start + 8];
      color = bytes[start + 9];
      const interlace = bytes[start + 12];
      if (depth > 8) unsupported("Only 8-bit PNG references and supported indexed PNG references are accepted.");
      if (color === 3 ? ![1, 2, 4, 8].includes(depth) : depth !== 8 || ![0, 2, 6].includes(color)) {
        unsupported("Use a grayscale, RGB, RGBA, or supported indexed PNG.");
      }
      if (bytes[start + 10] !== 0 || bytes[start + 11] !== 0 || interlace > 1) corrupt();
      const channels = color === 6 ? 4 : color === 2 ? 3 : 1;
      // Each pass stores an independent run of filter-prefixed scanlines.
      const layout = interlace ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4],
        [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]] : [[0, 0, 1, 1]];
      passes = layout.flatMap(([x, y, dx, dy]) => {
        const width = Math.ceil((dimensions.width - x) / dx);
        const rows = Math.ceil((dimensions.height - y) / dy);
        return width > 0 && rows > 0 ? [{ width, rows, rowBytes: Math.ceil(width * channels * depth / 8) }] : [];
      });
    } else if (["acTL", "fcTL", "fdAT"].includes(tag)) {
      unsupported("Animated PNG references are unsupported.");
    } else if (tag === "eXIf") {
      if (hasExif) corrupt();
      hasExif = true;
      orientation = orientationOf(new DataView(bytes.buffer, start, length));
      keep = false;
    } else if (tag === "PLTE") {
      if (paletteEntries || transparency || sawImageData || color === 0 || !length || length % 3 || length > 768 ||
          (color === 3 && length / 3 > 2 ** depth)) corrupt();
      paletteEntries = length / 3;
    } else if (tag === "tRNS") {
      if (transparency || sawImageData || !length || color === 6 || (color === 3 && length > paletteEntries) ||
          (color === 0 && length !== 2) || (color === 2 && length !== 6)) corrupt();
      transparency = true;
    } else if (tag === "IDAT") {
      if (passedImageData || (color === 3 && !paletteEntries)) corrupt();
      sawImageData = true;
      imageData.set(bytes.subarray(start, end), imageDataLength);
      imageDataLength += length;
    } else if (tag === "IEND") {
      if (!size || !imageDataLength || length !== 0 || end + 4 !== bytes.length) corrupt();
      kept.set(bytes.subarray(offset, end + 4), keptLength);
      const png = { compressed: new Blob([imageData.subarray(0, imageDataLength)]), passes,
        indexed: color === 3 ? { entries: paletteEntries, depth } : undefined };
      return { ...size, type: "image/png", orientation, png,
        decode: new Blob([kept.subarray(0, keptLength + 12)], { type: "image/png" }) };
    } else {
      if (!/^[a-z][A-Za-z]{3}$/.test(tag)) corrupt();
      // Keep the bounded color information and discard text and compressed profiles.
      keep = (tag === "sRGB" && length === 1) || (tag === "gAMA" && length === 4) || (tag === "cHRM" && length === 32);
    }
    if (keep) {
      kept.set(bytes.subarray(offset, end + 4), keptLength);
      keptLength += end + 4 - offset;
    }
    if (sawImageData && tag !== "IDAT") passedImageData = true;
    offset = end + 4;
  }
  return corrupt();
}

function paeth(left: number, above: number, upperLeft: number) {
  const prediction = left + above - upperLeft;
  const a = Math.abs(prediction - left);
  const b = Math.abs(prediction - above);
  const c = Math.abs(prediction - upperLeft);
  return a <= b && a <= c ? left : b <= c ? above : upperLeft;
}

function verifyPaletteRow(row: Uint8Array, previous: Uint8Array, filter: number, width: number, entries: number, depth: number) {
  for (let index = 0; index < row.length; index++) {
    const left = index ? row[index - 1] : 0;
    const above = previous[index];
    const upperLeft = index ? previous[index - 1] : 0;
    switch (filter) {
      case 1: row[index] += left; break;
      case 2: row[index] += above; break;
      case 3: row[index] += (left + above) >>> 1; break;
      case 4: row[index] += paeth(left, above, upperLeft); break;
    }
  }
  const mask = (1 << depth) - 1;
  for (let pixel = 0; pixel < width; pixel++) {
    const bit = pixel * depth;
    if (((row[bit >>> 3] >>> (8 - depth - (bit & 7))) & mask) >= entries) corrupt();
  }
}

async function verifyPng({ compressed, passes, indexed }: PngData) {
  let inputOffset = 0;
  const input = new ReadableStream<Uint8Array<ArrayBuffer>>({
    async pull(controller) {
      const end = Math.min(inputOffset + 16 * 1024, compressed.size);
      controller.enqueue(new Uint8Array(await compressed.slice(inputOffset, end).arrayBuffer()));
      inputOffset = end;
      if (end === compressed.size) controller.close();
    },
  });
  const reader = input.pipeThrough(new DecompressionStream("deflate")).getReader();
  let pass = 0;
  let row = 0;
  let remaining = 0;
  let filter = 0;
  let pixels = new Uint8Array(indexed ? passes[0].rowBytes : 0);
  let previous = new Uint8Array(pixels.length);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let offset = 0;
      while (offset < value.length) {
        if (remaining === 0) {
          if (pass >= passes.length || value[offset] > 4) corrupt();
          filter = value[offset++];
          remaining = passes[pass].rowBytes;
        }
        const count = Math.min(remaining, value.length - offset);
        if (indexed) pixels.set(value.subarray(offset, offset + count), pixels.length - remaining);
        remaining -= count;
        offset += count;
        if (remaining) continue;
        if (indexed) {
          verifyPaletteRow(pixels, previous, filter, passes[pass].width, indexed.entries, indexed.depth);
          const next = previous;
          previous = pixels;
          pixels = next;
        }
        if (++row !== passes[pass].rows) continue;
        pass++;
        row = 0;
        if (indexed && pass < passes.length) {
          pixels = new Uint8Array(passes[pass].rowBytes);
          previous = new Uint8Array(pixels.length);
        }
      }
    }
    if (remaining || pass !== passes.length) corrupt();
  } finally {
    await reader.cancel().catch(() => {});
  }
}

type Transform = readonly [number, number, number, number, number, number];

function drawTile(canvas: OffscreenCanvas, bitmap: ImageBitmap, [a, b, c, d, e, f]: Transform, x = 0, y = 0) {
  const context = canvas.getContext("2d", { alpha: false });
  if (!context) corrupt();
  context.resetTransform();
  context.fillStyle = "white";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.setTransform(a, b, c, d, e - x, f - y);
  context.drawImage(bitmap, 0, 0);
  return context;
}

function pngChunk(name: string, data: Uint8Array) {
  const chunk = new Uint8Array(12 + data.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.length);
  chunk.set(new TextEncoder().encode(name), 4);
  chunk.set(data, 8);
  view.setUint32(8 + data.length, checksum(chunk, 4, 8 + data.length));
  return chunk;
}

// Bitmap dimensions can exceed the canvas encoder's side limit. Export the same
// full-resolution pixels through tiles that the browser can represent.
async function encodeTiled(bitmap: ImageBitmap, transform: Transform, width: number, height: number, type: ReferenceContentType) {
  const png = type === "image/png";
  const channels = png ? 3 : 4;
  const stride = width * channels + (png ? 1 : 0);
  const pixels = new Uint8Array(stride * height);
  const tile = new OffscreenCanvas(1, 1);
  const side = 2048;
  for (let y = 0; y < height; y += side) {
    for (let x = 0; x < width; x += side) {
      tile.width = Math.min(side, width - x);
      tile.height = Math.min(side, height - y);
      const context = drawTile(tile, bitmap, transform, x, y);
      const rgba = context.getImageData(0, 0, tile.width, tile.height).data;
      for (let row = 0; row < tile.height; row++) {
        let target = (y + row) * stride + x * channels + (png ? 1 : 0);
        let source = row * tile.width * 4;
        for (let column = 0; column < tile.width; column++, source += 4) {
          pixels[target++] = rgba[source];
          pixels[target++] = rgba[source + 1];
          pixels[target++] = rgba[source + 2];
          if (!png) pixels[target++] = 255;
        }
      }
    }
  }
  if (!png) return new Blob([Uint8Array.from(encodeJpeg({ width, height, data: pixels }, 95).data)], { type });
  const header = new Uint8Array(13);
  const dimensions = new DataView(header.buffer);
  dimensions.setUint32(0, width);
  dimensions.setUint32(4, height);
  header.set([8, 2], 8);
  const compressed = await new Response(new Blob([pixels]).stream().pipeThrough(new CompressionStream("deflate"))).arrayBuffer();
  return new Blob([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header), pngChunk("IDAT", new Uint8Array(compressed)), pngChunk("IEND", new Uint8Array()),
  ], { type });
}

async function decodeReference(file: Blob, preview: boolean): Promise<NormalizedReference> {
  if (file.size > maxReferenceBytes) throw new ReferenceImageError("The reference image exceeds 10 MiB.", 413);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const source = bytes[0] === 0xff && bytes[1] === 0xd8 ? inspectJpeg(bytes, file)
      : [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte) ? inspectPng(bytes)
      : unsupported("Choose a JPEG or PNG reference image.");

  try {
    if (source.png) await verifyPng(source.png);
    const bitmap = await createImageBitmap(source.decode, { imageOrientation: "none" });
    try {
      const { width: w, height: h, orientation } = source;
      if (bitmap.width !== w || bitmap.height !== h) corrupt();
      const [width, height] = orientation >= 5 ? [h, w] : [w, h];
      const transforms: Transform[] = [
        [1, 0, 0, 1, 0, 0], [-1, 0, 0, 1, w, 0], [-1, 0, 0, -1, w, h], [1, 0, 0, -1, 0, h],
        [0, 1, 1, 0, 0, 0], [0, 1, -1, 0, h, 0], [0, -1, -1, 0, h, w], [0, -1, 1, 0, 0, w],
      ];
      const transform = transforms[orientation - 1];
      const type = preview ? "image/png" : source.type;
      let blob: Blob;
      const canvas = new OffscreenCanvas(width, height);
      try {
        drawTile(canvas, bitmap, transform);
        blob = await canvas.convertToBlob({ type, quality: 0.95 });
      } catch (error) {
        if (!(error instanceof DOMException && error.name === "IndexSizeError")) throw error;
        blob = await encodeTiled(bitmap, transform, width, height, type);
      } finally {
        canvas.width = 1;
        canvas.height = 1;
      }
      if (blob.type !== type || !blob.size) corrupt();
      return { width, height, blob };
    } finally {
      bitmap.close();
    }
  } catch {
    return corrupt();
  }
}

self.onmessage = async ({ data }: MessageEvent<ReferenceDecodeRequest>) => {
  let response: ReferenceDecodeResponse;
  try {
    response = { image: await decodeReference(data.source, data.preview) };
  } catch (error) {
    response = error instanceof ReferenceImageError ? { error: error.message, status: error.status }
      : { error: "The reference image is corrupt or unreadable.", status: 422 };
  }
  self.postMessage(response);
};
