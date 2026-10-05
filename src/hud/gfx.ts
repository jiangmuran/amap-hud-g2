// HUD 绘图基础：16 级灰阶、字体、转向图标、科幻装饰元素。
// 眼镜是绿色 micro-LED：黑色 = 不发光，越亮越绿。绘制时只用灰度。

import type { Maneuver } from '../nav/route'

export const CJK = '"PingFang SC","Hiragino Sans GB","Noto Sans CJK SC","Noto Sans SC","Microsoft YaHei",sans-serif'

/** 0..15 灰阶 */
export function L(n: number): string {
  const v = Math.max(0, Math.min(15, Math.round(n))) * 17
  return `rgb(${v},${v},${v})`
}

export const font = {
  num: (size: number, weight = 700) => `${weight} ${size}px Orbitron, ${CJK}`,
  label: (size: number, weight = 600) => `${weight} ${size}px Rajdhani, ${CJK}`,
  cjk: (size: number, weight = 600) => `${weight} ${size}px ${CJK}`,
}

export type Ctx = CanvasRenderingContext2D

export function clear(ctx: Ctx, w: number, h: number): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.globalAlpha = 1
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, w, h)
}

export function text(
  ctx: Ctx, s: string, x: number, y: number,
  opts: { font: string; level?: number; align?: CanvasTextAlign; baseline?: CanvasTextBaseline; maxWidth?: number } ,
): number {
  ctx.font = opts.font
  ctx.fillStyle = L(opts.level ?? 15)
  ctx.textAlign = opts.align ?? 'left'
  ctx.textBaseline = opts.baseline ?? 'alphabetic'
  let str = s
  if (opts.maxWidth) str = ellipsize(ctx, s, opts.maxWidth)
  ctx.fillText(str, x, y)
  return ctx.measureText(str).width
}

export function ellipsize(ctx: Ctx, s: string, maxWidth: number): string {
  if (ctx.measureText(s).width <= maxWidth) return s
  let lo = 0
  let hi = s.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (ctx.measureText(s.slice(0, mid) + '…').width <= maxWidth) lo = mid
    else hi = mid - 1
  }
  return s.slice(0, lo) + '…'
}

export function measure(ctx: Ctx, s: string, f: string): number {
  ctx.font = f
  return ctx.measureText(s).width
}

export function line(ctx: Ctx, x1: number, y1: number, x2: number, y2: number, level: number, width = 1): void {
  ctx.strokeStyle = L(level)
  ctx.lineWidth = width
  ctx.beginPath()
  ctx.moveTo(x1, y1)
  ctx.lineTo(x2, y2)
  ctx.stroke()
}

/** 四角括号框 —— HUD 标志性元素 */
export function brackets(ctx: Ctx, x: number, y: number, w: number, h: number, len: number, level: number, width = 2): void {
  ctx.strokeStyle = L(level)
  ctx.lineWidth = width
  ctx.lineCap = 'square'
  ctx.beginPath()
  const o = width / 2
  ctx.moveTo(x + o, y + len); ctx.lineTo(x + o, y + o); ctx.lineTo(x + len, y + o)
  ctx.moveTo(x + w - len, y + o); ctx.lineTo(x + w - o, y + o); ctx.lineTo(x + w - o, y + len)
  ctx.moveTo(x + w - o, y + h - len); ctx.lineTo(x + w - o, y + h - o); ctx.lineTo(x + w - len, y + h - o)
  ctx.moveTo(x + len, y + h - o); ctx.lineTo(x + o, y + h - o); ctx.lineTo(x + o, y + h - len)
  ctx.stroke()
  ctx.lineCap = 'butt'
}

/** 切角矩形边框 */
export function chamferRect(ctx: Ctx, x: number, y: number, w: number, h: number, c: number, level: number, width = 1, fill?: number): void {
  ctx.beginPath()
  ctx.moveTo(x + c, y)
  ctx.lineTo(x + w, y)
  ctx.lineTo(x + w, y + h - c)
  ctx.lineTo(x + w - c, y + h)
  ctx.lineTo(x, y + h)
  ctx.lineTo(x, y + c)
  ctx.closePath()
  if (fill !== undefined) {
    ctx.fillStyle = L(fill)
    ctx.fill()
  }
  ctx.strokeStyle = L(level)
  ctx.lineWidth = width
  ctx.stroke()
}

/** 分段进度条 */
export function segBar(ctx: Ctx, x: number, y: number, w: number, h: number, value: number, segs: number, on = 15, off = 3): void {
  const gap = 2
  const sw = (w - gap * (segs - 1)) / segs
  const filled = value * segs
  for (let i = 0; i < segs; i++) {
    const f = Math.max(0, Math.min(1, filled - i))
    ctx.fillStyle = L(off)
    ctx.fillRect(x + i * (sw + gap), y, sw, h)
    if (f > 0) {
      ctx.fillStyle = L(on)
      ctx.fillRect(x + i * (sw + gap), y, sw * f, h)
    }
  }
}

/** 电量图标 */
export function battery(ctx: Ctx, x: number, y: number, pct: number | undefined, level = 12): void {
  const w = 22
  const h = 10
  ctx.strokeStyle = L(level)
  ctx.lineWidth = 1.5
  ctx.strokeRect(x + 0.5, y + 0.5, w, h)
  ctx.fillStyle = L(level)
  ctx.fillRect(x + w + 1, y + 3, 2, h - 5)
  if (pct !== undefined) {
    const p = Math.max(0, Math.min(100, pct)) / 100
    ctx.fillStyle = L(pct <= 15 ? 15 : level)
    ctx.fillRect(x + 2.5, y + 2.5, (w - 4) * p, h - 4)
  }
}

/** GPS 信号格：精度越高格数越多 */
export function signal(ctx: Ctx, x: number, y: number, accuracy: number | undefined, level = 12): void {
  const bars = accuracy === undefined ? 0 : accuracy <= 8 ? 4 : accuracy <= 20 ? 3 : accuracy <= 50 ? 2 : 1
  for (let i = 0; i < 4; i++) {
    const h = 3 + i * 3
    ctx.fillStyle = L(i < bars ? level : 3)
    ctx.fillRect(x + i * 5, y + 12 - h, 3, h)
  }
}

function arrowHead(ctx: Ctx, x: number, y: number, angleDeg: number, size: number): void {
  const a = (angleDeg * Math.PI) / 180
  const dx = Math.sin(a)
  const dy = -Math.cos(a)
  const px = -dy
  const py = dx
  ctx.beginPath()
  ctx.moveTo(x + dx * size * 0.6, y + dy * size * 0.6)
  ctx.lineTo(x - dx * size * 0.4 + px * size * 0.55, y - dy * size * 0.4 + py * size * 0.55)
  ctx.lineTo(x - dx * size * 0.4 - px * size * 0.55, y - dy * size * 0.4 - py * size * 0.55)
  ctx.closePath()
  ctx.fill()
}

const TURN_ANGLE: Partial<Record<Maneuver, number>> = {
  straight: 0,
  depart: 0,
  'slight-left': -45,
  left: -90,
  'sharp-left': -135,
  'slight-right': 45,
  right: 90,
  'sharp-right': 135,
  'keep-left': -28,
  'keep-right': 28,
}

/** 转向图标，(cx, cy) 为中心，size 为外接正方形边长 */
export function maneuverIcon(ctx: Ctx, kind: Maneuver, cx: number, cy: number, size: number, level = 15): void {
  const s = size
  const w = Math.max(3, s * 0.13)
  ctx.save()
  ctx.strokeStyle = L(level)
  ctx.fillStyle = L(level)
  ctx.lineWidth = w
  ctx.lineJoin = 'round'
  ctx.lineCap = 'butt'

  if (kind === 'arrive') {
    for (const [r, lv] of [[0.42, level * 0.5], [0.27, level]] as const) {
      ctx.strokeStyle = L(lv)
      ctx.lineWidth = Math.max(2, s * 0.05)
      ctx.beginPath()
      ctx.arc(cx, cy, s * r, 0, Math.PI * 2)
      ctx.stroke()
    }
    ctx.lineWidth = Math.max(2, s * 0.05)
    ctx.strokeStyle = L(level)
    for (const a of [0, 90, 180, 270]) {
      const r = (a * Math.PI) / 180
      ctx.beginPath()
      ctx.moveTo(cx + Math.sin(r) * s * 0.34, cy - Math.cos(r) * s * 0.34)
      ctx.lineTo(cx + Math.sin(r) * s * 0.5, cy - Math.cos(r) * s * 0.5)
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(cx, cy, s * 0.08, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()
    return
  }

  if (kind === 'uturn-left' || kind === 'uturn-right') {
    const m = kind === 'uturn-left' ? 1 : -1
    const r = s * 0.17
    const xr = cx + m * r
    const xl = cx - m * r
    ctx.beginPath()
    ctx.moveTo(xr, cy + s * 0.42)
    ctx.lineTo(xr, cy - s * 0.08)
    ctx.arc(cx, cy - s * 0.08, r, m > 0 ? 0 : Math.PI, m > 0 ? Math.PI : 0, m > 0)
    ctx.lineTo(xl, cy + s * 0.14)
    ctx.stroke()
    arrowHead(ctx, xl, cy + s * 0.24, 180, s * 0.3)
    ctx.restore()
    return
  }

  if (kind === 'roundabout') {
    const r = s * 0.17
    const oy = cy - s * 0.04
    ctx.lineWidth = Math.max(2.5, s * 0.08)
    ctx.beginPath()
    ctx.arc(cx, oy, r, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = w
    ctx.beginPath()
    ctx.moveTo(cx, cy + s * 0.44)
    ctx.lineTo(cx, oy + r)
    ctx.stroke()
    const a = 45
    const ex = cx + Math.sin((a * Math.PI) / 180) * r
    const ey = oy - Math.cos((a * Math.PI) / 180) * r
    ctx.beginPath()
    ctx.moveTo(ex, ey)
    ctx.lineTo(ex + s * 0.14, ey - s * 0.14)
    ctx.stroke()
    arrowHead(ctx, ex + s * 0.2, ey - s * 0.2, a, s * 0.28)
    ctx.restore()
    return
  }

  const ang = TURN_ANGLE[kind] ?? 0
  const jx = cx
  const jy = cy + s * (Math.abs(ang) > 100 ? -0.06 : 0.04)
  const len = s * 0.34
  const rad = (ang * Math.PI) / 180
  const ex = jx + Math.sin(rad) * len
  const ey = jy - Math.cos(rad) * len

  if (kind === 'keep-left' || kind === 'keep-right') {
    // 分叉：暗色直行分支 + 亮色保持分支
    ctx.strokeStyle = L(level * 0.35)
    ctx.beginPath()
    ctx.moveTo(jx, jy)
    ctx.lineTo(jx - Math.sin(rad) * len * 0.9, jy - Math.cos(rad) * len)
    ctx.stroke()
    ctx.strokeStyle = L(level)
  }

  ctx.beginPath()
  ctx.moveTo(cx, cy + s * 0.44)
  ctx.lineTo(jx, jy)
  ctx.lineTo(ex - Math.sin(rad) * s * 0.08, ey + Math.cos(rad) * s * 0.08)
  ctx.stroke()
  arrowHead(ctx, ex, ey, ang, s * 0.32)
  ctx.restore()
}

/**
 * 箭头形状（局部坐标，尖端朝上，尺寸归一化为 1）。
 * 关键约束：尖端到旋转中心的距离必须明显大于两个翼尖，否则小尺寸下翼尖
 * 会比尖端更显眼，看起来像指向别的方向。这里尖端 1.20、翼尖约 0.72。
 * 旋转中心取在图形质心附近（原点），朝不同方向时位置基本不漂移。
 */
const ARROW_SHAPE: [number, number][] = [
  [0, -1.2],
  [0.56, 0.46],
  [0, 0.18],
  [-0.56, 0.46],
]

function arrowPath(ctx: Ctx, size: number): void {
  ctx.beginPath()
  ARROW_SHAPE.forEach(([x, y], i) => (i ? ctx.lineTo(x * size, y * size) : ctx.moveTo(x * size, y * size)))
  ctx.closePath()
}

/** 地图上的用户位置标记：带黑色外描边，便于压在路线上时分辨（描边在填充之下，不侵蚀形状） */
export function chevron(ctx: Ctx, x: number, y: number, size: number, rotDeg: number, level = 15): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((rotDeg * Math.PI) / 180)
  arrowPath(ctx, size)
  ctx.lineJoin = 'round'
  ctx.lineWidth = Math.max(2, size * 0.3)
  ctx.strokeStyle = '#000'
  ctx.stroke()
  ctx.fillStyle = L(level)
  ctx.fill()
  ctx.restore()
}

/**
 * 方向指示箭头（列表、详情卡里用）：实心、无描边。
 * rotDeg 为相对当前朝向的角度，0 = 正前方（向上），顺时针为正。
 */
export function pointer(ctx: Ctx, x: number, y: number, size: number, rotDeg: number, level = 15): void {
  ctx.save()
  ctx.translate(x, y)
  ctx.rotate((rotDeg * Math.PI) / 180)
  arrowPath(ctx, size)
  ctx.fillStyle = L(level)
  ctx.fill()
  ctx.restore()
}

export function diamond(ctx: Ctx, x: number, y: number, r: number, level: number, filled = true): void {
  ctx.beginPath()
  ctx.moveTo(x, y - r)
  ctx.lineTo(x + r, y)
  ctx.lineTo(x, y + r)
  ctx.lineTo(x - r, y)
  ctx.closePath()
  if (filled) {
    ctx.fillStyle = L(level)
    ctx.fill()
  } else {
    ctx.strokeStyle = L(level)
    ctx.lineWidth = 2
    ctx.stroke()
  }
}

/** 目标准星 */
export function reticle(ctx: Ctx, x: number, y: number, r: number, level: number): void {
  ctx.strokeStyle = L(level)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.arc(x, y, r, 0, Math.PI * 2)
  ctx.stroke()
  for (const a of [0, 90, 180, 270]) {
    const t = (a * Math.PI) / 180
    ctx.beginPath()
    ctx.moveTo(x + Math.sin(t) * r * 0.5, y - Math.cos(t) * r * 0.5)
    ctx.lineTo(x + Math.sin(t) * r * 1.5, y - Math.cos(t) * r * 1.5)
    ctx.stroke()
  }
  ctx.fillStyle = L(level)
  ctx.fillRect(x - 1.5, y - 1.5, 3, 3)
}

/** 斜线填充条（装饰） */
export function hatch(ctx: Ctx, x: number, y: number, w: number, h: number, level: number, step = 6): void {
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, w, h)
  ctx.clip()
  ctx.strokeStyle = L(level)
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = -h; i < w; i += step) {
    ctx.moveTo(x + i, y + h)
    ctx.lineTo(x + i + h, y)
  }
  ctx.stroke()
  ctx.restore()
}

/** 数字 + 单位，返回总宽度。align=left|right */
export function numUnit(
  ctx: Ctx, value: string, unit: string, x: number, y: number,
  size: number, opts: { level?: number; unitLevel?: number; align?: 'left' | 'right'; unitSize?: number } = {},
): number {
  const uSize = opts.unitSize ?? Math.round(size * 0.42)
  const vw = measure(ctx, value, font.num(size))
  const uw = unit ? measure(ctx, unit, font.label(uSize, 700)) + 4 : 0
  const total = vw + uw
  const x0 = opts.align === 'right' ? x - total : x
  text(ctx, value, x0, y, { font: font.num(size), level: opts.level ?? 15 })
  if (unit) text(ctx, unit, x0 + vw + 4, y, { font: font.label(uSize, 700), level: opts.unitLevel ?? 9 })
  return total
}
