// 生成应用图标（纯色占位图，正式图标后期用 `pnpm tauri icon` 替换）
import zlib from "node:zlib";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const outDir = path.join(root, "src-tauri", "icons");
fs.mkdirSync(outDir, { recursive: true });

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

function solidPng(size, [r, g, b, a]) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const pixel = Buffer.from([r, g, b, a]);
  const rowData = Buffer.concat([Buffer.from([0]), Buffer.concat(Array(size).fill(pixel))]);
  const raw = Buffer.concat(Array(size).fill(rowData));
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const INDIGO = [79, 70, 229, 255];
fs.writeFileSync(path.join(outDir, "32x32.png"), solidPng(32, INDIGO));
fs.writeFileSync(path.join(outDir, "128x128.png"), solidPng(128, INDIGO));
console.log("icons generated:", fs.readdirSync(outDir).join(", "));
