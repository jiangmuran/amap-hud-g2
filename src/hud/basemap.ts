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

  zoomFor(speedMps: number): number {
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
    if (Date.now() - this.lastAttempt < 20_000 && cur) return
    this.lastAttempt = Date.now()
    this.loading = true
    this.api
      .staticMap(p, zoom, SIZE)
      .then((bmp) => {
        this.current = { canvas: process(bmp), center: p, zoom, size: SIZE, mpp: metersPerPixel(p[1], zoom) }
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
 * 高亮且低饱和（普通路）或暖黄色（主干道）→ 映射为暗灰阶；
 * 其余（地块、文字、水系）为黑。若提取比例异常则回退到 Sobel 边缘线框。
 */
function process(bmp: ImageBitmap): HTMLCanvasElement {
  const c = createCanvas(bmp.width, bmp.height)
  const ctx = c.getContext('2d', { willReadFrequently: true })!
  ctx.drawImage(bmp, 0, 0)
  const img = ctx.getImageData(0, 0, c.width, c.height)
  const px = img.data
  const n = c.width * c.height
  const out = new Uint8ClampedArray(n)
  let roadCount = 0
  for (let i = 0; i < n; i++) {
    const r = px[i * 4]
    const g = px[i * 4 + 1]
    const b = px[i * 4 + 2]
    const max = Math.max(r, g, b)
    const min = Math.min(r, g, b)
    const isWhite = min >= 250 && max - min < 8
    const isMajor = r > 235 && g > 180 && b < 175 && r - b > 60
    if (isMajor) {
      out[i] = 7 * 17
      roadCount++
    } else if (isWhite) {
      out[i] = 5 * 17
      roadCount++
    }
  }
  const ratio = roadCount / n
  if (ratio < 0.02 || ratio > 0.6) sobel(px, out, c.width, c.height)
  for (let i = 0; i < n; i++) {
    px[i * 4] = px[i * 4 + 1] = px[i * 4 + 2] = out[i]
    px[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  return c
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
