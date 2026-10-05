// 街道底图：拉取高德静态地图，处理成「暗底 + 微亮道路」的线框风格，作为局部地图背景。
// 只在内存里使用，不落盘（服务条款禁止缓存/存储地图数据）。
// 拉取策略很省：移出图片中心 30% 半径或缩放级别变化才重新拉，且至少间隔 20 秒。

import type { AmapClient } from '../amap/api'
import { haversine, metersPerPixel, type LngLat } from '../geo'
import { createCanvas } from '../glasses/display'

export interface Basemap {
  canvas: HTMLCanvasElement
  center: LngLat
  zoom: number
  size: number
  /** 该图每像素代表的米数 */
  mpp: number
}

const SIZE = 512

export class BasemapManager {
  current: Basemap | null = null
  enabled = true
  private loading = false
  private lastAttempt = 0
  private errors = 0
  lastError?: string

  constructor(private api: AmapClient) {}

  /** 固定缩放级别（街道地图页用）；未设置时按速度自动选择 */
  fixedZoom?: number

  zoomFor(speedMps: number): number {
    if (this.fixedZoom !== undefined) return this.fixedZoom
    if (!Number.isFinite(speedMps) || speedMps < 3) return 17
    if (speedMps < 9) return 16
    if (speedMps < 20) return 15
    return 14
  }

  /** 每次定位后调用，按需在后台刷新底图 */
  maybeRefresh(p: LngLat, speed: number): void {
    if (!this.enabled || this.loading || !this.api.hasKey() || this.errors >= 3) return
    const zoom = this.zoomFor(speed)
    const cur = this.current
    if (cur && cur.zoom === zoom) {
      const radius = (cur.size / 2) * cur.mpp
      if (haversine(cur.center, p) < radius * 0.3) return
    }
    if (Date.now() - this.lastAttempt < 20_000 && cur && cur.zoom === zoom) return
    this.lastAttempt = Date.now()
    this.loading = true
    this.api
      .staticMap(p, zoom, SIZE)
      .then((bmp) => {
        this.current = { canvas: processStaticMap(bmp), center: p, zoom, size: SIZE, mpp: metersPerPixel(p[1], zoom) }
        this.errors = 0
        this.lastError = undefined
      })
      .catch((e: Error) => {
        this.errors++
        this.lastError = e.message
        console.warn('basemap', e.message)
      })
      .finally(() => {
        this.loading = false
      })
  }

  clear(): void {
    this.current = null
    this.errors = 0
  }
}

/**
 * 高德静态图是浅色底、白色/黄色道路。这里提取「道路」像素：
 * 高亮且低饱和（普通路）或暖黄色（主干道）→ 映射为暗灰阶；其余（地块、文字、水系）为黑。
 * 文字标注和 POI 图标外圈也是白色描边，用 3×3 开运算去掉细描边，再去掉小于 60 像素的孤立块。
 * （用真实静态图验证：17 级下道路 6–10px 宽，开运算后完整保留。）
 * 若提取比例异常则回退到 Sobel 边缘线框。
 */
export function processStaticMap(bmp: ImageBitmap): HTMLCanvasElement {
  const c = createCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const px = img.data
  const w = c.width
  const h = c.height
  const n = w * h
  const white = new Uint8Array(n)
  const major = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const r = px[i * 4]
    const g = px[i * 4 + 1]
    const b = px[i * 4 + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    if (r > 235 && g > 180 && b < 175 && r - b > 60) major[i] = 1
    else if (min >= 250 && max - min < 8) white[i] = 1
  }
  const roadsW = removeSmall(open3(white, w, h), w, h, 60)
  const roadsM = open3(major, w, h)
  const out = new Uint8ClampedArray(n)
  let roadCount = 0
  for (let i = 0; i < n; i++) {
    if (roadsM[i]) { out[i] = 7 * 17; roadCount++ }
    else if (roadsW[i]) { out[i] = 5 * 17; roadCount++ }
  }
  const ratio = roadCount / n
  if (ratio < 0.02 || ratio > 0.6) sobel(px, out, w, h)
  for (let i = 0; i < n; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = out[i]
    px[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
}

/** 3×3 开运算（先腐蚀后膨胀），去掉 1–2 像素宽的细线 */
function open3(m: Uint8Array, w: number, h: number): Uint8Array {
  const er = new Uint8Array(m.length)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      er[i] = m[i - w - 1] & m[i - w] & m[i - w + 1] & m[i - 1] & m[i] & m[i + 1] & m[i + w - 1] & m[i + w] & m[i + w + 1]
    }
  }
  const di = new Uint8Array(m.length)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      di[i] = er[i - w - 1] | er[i - w] | er[i - w + 1] | er[i - 1] | er[i] | er[i + 1] | er[i + w - 1] | er[i + w] | er[i + w + 1]
    }
  }
  return di
}

/** 去掉面积小于 minArea 的连通块（POI 小图标等） */
function removeSmall(m: Uint8Array, w: number, h: number, minArea: number): Uint8Array {
  const out = new Uint8Array(m.length)
  const seen = new Uint8Array(m.length)
  const stack: number[] = []
  const comp: number[] = []
  for (let s = 0; s < m.length; s++) {
    if (!m[s] || seen[s]) continue
    stack.push(s)
    seen[s] = 1
    comp.length = 0
    while (stack.length) {
      const i = stack.pop()!
      comp.push(i)
      const x = i % w
      const nb = [i - w, i + w, x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1]
      for (const j of nb) {
        if (j >= 0 && j < m.length && m[j] && !seen[j]) {
          seen[j] = 1
          stack.push(j)
        }
      }
    }
    if (comp.length >= minArea) for (const i of comp) out[i] = 1
  }
  void h
  return out
}

function sobel(px: Uint8ClampedArray, out: Uint8ClampedArray, w: number, h: number): void {
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) lum[i] = px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114
  out.fill(0)
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const gx = -lum[i - w - 1] - 2 * lum[i - 1] - lum[i + w - 1] + lum[i - w + 1] + 2 * lum[i + 1] + lum[i + w + 1]
      const gy = -lum[i - w - 1] - 2 * lum[i - w] - lum[i - w + 1] + lum[i + w - 1] + 2 * lum[i + w] + lum[i + w + 1]
      const mag = Math.sqrt(gx * gx + gy * gy)
      out[i] = mag > 60 ? 5 * 17 : mag > 25 ? 3 * 17 : 0
    }
  }
}
