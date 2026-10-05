// 4 位灰度 PNG 编码器（color type 0，bit depth 4）。
//
// Canvas 的 toBlob 只能输出 RGBA PNG：每像素 4 字节、抗锯齿后压缩率差，单块 288×144
// 动辄几十 KB，宿主还要解码并转换成 4 位灰度。这里直接输出眼镜原生的 16 级灰度：
// 原始数据只有 width×height/2 字节，HUD 大面积纯黑，deflate 后通常只有几 KB。

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function adler32(buf: Uint8Array): number {
  let a = 1
  let b = 0
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521
    b = (b + a) % 65521
  }
  return ((b << 16) | a) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  dv.setUint32(8 + data.length, crc32(out, 4, 8 + data.length))
  return out
}

/** zlib 封装的「不压缩」deflate（没有 CompressionStream 时的兜底） */
function zlibStored(raw: Uint8Array): Uint8Array {
  const blocks = Math.ceil(raw.length / 65535) || 1
  const out = new Uint8Array(2 + raw.length + blocks * 5 + 4)
  out[0] = 0x78
  out[1] = 0x01
  let o = 2
  for (let i = 0; i < blocks; i++) {
    const start = i * 65535
    const len = Math.min(65535, raw.length - start)
    out[o++] = i === blocks - 1 ? 1 : 0
    out[o++] = len & 0xff
    out[o++] = (len >>> 8) & 0xff
    out[o++] = ~len & 0xff
    out[o++] = (~len >>> 8) & 0xff
    out.set(raw.subarray(start, start + len), o)
    o += len
  }
  new DataView(out.buffer).setUint32(o, adler32(raw))
  return out
}

async function zlib(raw: Uint8Array): Promise<Uint8Array> {
  const CS = (globalThis as any).CompressionStream
  if (typeof CS !== 'function') return zlibStored(raw)
  try {
    const stream = new Blob([raw as Uint8Array<ArrayBuffer>]).stream().pipeThrough(new CS('deflate'))
    return new Uint8Array(await new Response(stream).arrayBuffer())
  } catch {
    return zlibStored(raw)
  }
}

/**
 * q：每像素 0..15 的灰度级（长度 w*h）。返回 PNG 文件字节。
 * 每行：1 字节滤波类型（0）+ ceil(w/2) 字节（每字节两个像素，高 4 位在前）。
 */
export async function encodeGray4Png(q: Uint8Array, w: number, h: number): Promise<Uint8Array> {
  const rowBytes = Math.ceil(w / 2)
  const raw = new Uint8Array(h * (1 + rowBytes))
  for (let y = 0; y < h; y++) {
    const o = y * (1 + rowBytes)
    raw[o] = 0
    for (let x = 0; x < w; x += 2) {
      const a = q[y * w + x] & 15
      const b = x + 1 < w ? q[y * w + x + 1] & 15 : 0
      raw[o + 1 + (x >> 1)] = (a << 4) | b
    }
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, w)
  dv.setUint32(4, h)
  ihdr[8] = 4 // bit depth
  ihdr[9] = 0 // color type: grayscale
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace
  const idat = await zlib(raw)
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0))
  let off = 0
  for (const p of parts) {
    out.set(p, off)
    off += p.length
  }
  return out
}
