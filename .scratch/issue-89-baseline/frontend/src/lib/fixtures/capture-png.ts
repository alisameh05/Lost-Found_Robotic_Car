import { decode } from "jpeg-js";
import type { FrameMetadata } from "@/generated/api-v1";

const signature = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

function chunk(type: string, bytes: Uint8Array) {
  const chunk = new Uint8Array(bytes.length + 12);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, bytes.length);
  chunk.set(new TextEncoder().encode(type), 4);
  chunk.set(bytes, 8);
  let crc = 0xffffffff;
  for (const byte of chunk.subarray(4, -4)) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  view.setUint32(chunk.length - 4, crc ^ 0xffffffff);
  return chunk;
}

// Evidence is PNG on the wire. Preserve every decoded pixel of the protected frame.
export async function capturePng(jpeg: Uint8Array, { width, height }: FrameMetadata) {
  const image = decode(jpeg, { useTArray: true, formatAsRGBA: false });
  if (image.width !== width || image.height !== height) throw new Error("Sample frame dimensions changed");
  const stride = width * 3;
  const rows = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    rows.set(image.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const compressed = new Blob([rows]).stream().pipeThrough(new CompressionStream("deflate"));
  const header = new Uint8Array(13);
  const dimensions = new DataView(header.buffer);
  dimensions.setUint32(0, width);
  dimensions.setUint32(4, height);
  header.set([8, 2], 8);
  const png = new Blob([
    signature, chunk("IHDR", header),
    chunk("IDAT", new Uint8Array(await new Response(compressed).arrayBuffer())),
    chunk("IEND", new Uint8Array()),
  ]);
  return new Uint8Array(await png.arrayBuffer());
}
