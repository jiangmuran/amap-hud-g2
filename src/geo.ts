// 坐标与几何工具。全项目统一使用 [lng, lat]（与高德接口一致）。

export type LngLat = [number, number]

const R_EARTH = 6378137
const RAD = Math.PI / 180

export function toRad(d: number): number {
  return d * RAD
}

export function normDeg(d: number): number {
  return ((d % 360) + 360) % 360
}

/** 两个角度的有符号差值 b - a，范围 (-180, 180] */
export function angleDiff(a: number, b: number): number {
  let d = normDeg(b - a)
  if (d > 180) d -= 360
  return d
}

export function haversine(a: LngLat, b: LngLat): number {
  const dLat = (b[1] - a[1]) * RAD
  const dLng = (b[0] - a[0]) * RAD
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(dLng / 2) ** 2
  return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(s)))
}

/** a → b 的初始方位角，正北为 0，顺时针 */
export function bearing(a: LngLat, b: LngLat): number {
  const φ1 = a[1] * RAD
  const φ2 = b[1] * RAD
  const Δλ = (b[0] - a[0]) * RAD
  const y = Math.sin(Δλ) * Math.cos(φ2)
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ)
  return normDeg(Math.atan2(y, x) / RAD)
}

export function parseLngLat(s: string | undefined | null): LngLat | null {
  if (!s || typeof s !== 'string') return null
  const [a, b] = s.split(',').map(Number)
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  return [a, b]
}

export function fmtLngLat(p: LngLat): string {
  return `${p[0].toFixed(6)},${p[1].toFixed(6)}`
}

/** 解析高德 polyline："lng,lat;lng,lat;..." */
export function parsePolyline(s: string | undefined | null): LngLat[] {
  if (!s) return []
  const out: LngLat[] = []
  for (const part of s.split(';')) {
    const p = parseLngLat(part)
    if (p) out.push(p)
  }
  return out
}

/** 等距圆柱局部投影：把经纬度转成以 origin 为原点的米制平面坐标（x 向东，y 向北） */
export class LocalProjector {
  private readonly kx: number
  private readonly ky: number
  constructor(readonly origin: LngLat) {
    this.ky = R_EARTH * RAD
    this.kx = this.ky * Math.cos(origin[1] * RAD)
  }
  toXY(p: LngLat): [number, number] {
    return [(p[0] - this.origin[0]) * this.kx, (p[1] - this.origin[1]) * this.ky]
  }
  toLngLat(x: number, y: number): LngLat {
    return [this.origin[0] + x / this.kx, this.origin[1] + y / this.ky]
  }
}

/** 点到线段的投影，返回参数 t∈[0,1] 与距离平方 */
export function projectToSegment(
  px: number, py: number, ax: number, ay: number, bx: number, by: number,
): { t: number; d2: number; x: number; y: number } {
  const dx = bx - ax
  const dy = by - ay
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  const x = ax + t * dx
  const y = ay + t * dy
  return { t, d2: (px - x) ** 2 + (py - y) ** 2, x, y }
}

// ── WGS-84 → GCJ-02 ─────────────────────────────────────────────
// 手机系统定位通常是 WGS-84，高德数据是 GCJ-02，不转换会偏几百米。
// 本地算法转换，不消耗高德「坐标转换」配额。

const GCJ_A = 6378245.0
const GCJ_EE = 0.00669342162296594323

export function outOfChina(lng: number, lat: number): boolean {
  return lng < 72.004 || lng > 137.8347 || lat < 0.8293 || lat > 55.8271
}

function transformLat(x: number, y: number): number {
  let r = -100 + 2 * x + 3 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(y * Math.PI) + 40 * Math.sin((y / 3) * Math.PI)) * 2) / 3
  r += ((160 * Math.sin((y / 12) * Math.PI) + 320 * Math.sin((y * Math.PI) / 30)) * 2) / 3
  return r
}

function transformLng(x: number, y: number): number {
  let r = 300 + x + 2 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x))
  r += ((20 * Math.sin(6 * x * Math.PI) + 20 * Math.sin(2 * x * Math.PI)) * 2) / 3
  r += ((20 * Math.sin(x * Math.PI) + 40 * Math.sin((x / 3) * Math.PI)) * 2) / 3
  r += ((150 * Math.sin((x / 12) * Math.PI) + 300 * Math.sin((x / 30) * Math.PI)) * 2) / 3
  return r
}

export function wgs84ToGcj02(p: LngLat): LngLat {
  const [lng, lat] = p
  if (outOfChina(lng, lat)) return [lng, lat]
  let dLat = transformLat(lng - 105, lat - 35)
  let dLng = transformLng(lng - 105, lat - 35)
  const radLat = lat * RAD
  let magic = Math.sin(radLat)
  magic = 1 - GCJ_EE * magic * magic
  const sqrtMagic = Math.sqrt(magic)
  dLat = (dLat * 180) / (((GCJ_A * (1 - GCJ_EE)) / (magic * sqrtMagic)) * Math.PI)
  dLng = (dLng * 180) / ((GCJ_A / sqrtMagic) * Math.cos(radLat) * Math.PI)
  return [lng + dLng, lat + dLat]
}

/** 近似逆变换（迭代一次，误差 < 1m），用于把 GCJ 坐标还原给模拟器生成 WGS 定位 */
export function gcj02ToWgs84(p: LngLat): LngLat {
  const g = wgs84ToGcj02(p)
  return [p[0] * 2 - g[0], p[1] * 2 - g[1]]
}

// ── Web 墨卡托（静态地图底图对齐用）─────────────────────────────

export function mercatorPx(p: LngLat, zoom: number): [number, number] {
  const scale = 256 * 2 ** zoom
  const x = ((p[0] + 180) / 360) * scale
  const s = Math.sin(p[1] * RAD)
  const y = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale
  return [x, y]
}

export function metersPerPixel(lat: number, zoom: number): number {
  return (Math.cos(lat * RAD) * 2 * Math.PI * R_EARTH) / (256 * 2 ** zoom)
}

const COMPASS_8 = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW']
const COMPASS_8_ZH = ['北', '东北', '东', '东南', '南', '西南', '西', '西北']

export function compass8(deg: number, zh = false): string {
  const i = Math.round(normDeg(deg) / 45) % 8
  return (zh ? COMPASS_8_ZH : COMPASS_8)[i]
}
