// 模板页：页面结构（原生文本控件 + 少量小图片）只建一次，之后只发送变化的内容。
// 原生文本由眼镜固件渲染：字号固定（约 18px，行高约 24–27px），只有 0–4 五档亮度，
// 字符集有限（箭头 ↑↗→↘↓↙←↖、★☆、━─、●○、· ¥ ° 可用，emoji 不可用）。
// 图片只用在变化很少的地方（转向箭头、罗盘、雷达、方向指针），并对角度做量化，避免频繁重发。

import type { TemplateSpec } from '../glasses/display'
import { createCanvas } from '../glasses/display'
import { angleDiff, bearing, compass8, haversine, LocalProjector, mercatorPx, metersPerPixel, normDeg, type LngLat } from '../geo'
import { MANEUVER_LABEL, MODE_LABEL, type Maneuver } from '../nav/route'
import { brackets, chevron, diamond, L, maneuverIcon, pointer, reticle, type Ctx } from './gfx'
import { fmtClock, fmtDistStr, fmtDurationZh, fmtSpeed } from './format'
import { displayHeading, MAP_ZOOMS, QUICK_TAG_LABEL, RADAR_CATEGORIES, VIEW_LABEL, type HudModel, type ViewId } from './model'
import type { Basemap } from './basemap'

export interface TemplateFrame {
  texts: Record<string, string>
  images: Record<string, HTMLCanvasElement>
}

const ARROWS = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖']
/** 相对方向 → 箭头字符 */
export function dirGlyph(rel: number): string {
  return ARROWS[Math.round(normDeg(rel) / 45) % 8]
}

const MANEUVER_GLYPH: Record<Maneuver, string> = {
  depart: '↑', straight: '↑', 'slight-left': '↖', left: '←', 'sharp-left': '↙',
  'slight-right': '↗', right: '→', 'sharp-right': '↘', 'keep-left': '↖', 'keep-right': '↗',
  'uturn-left': '↓', 'uturn-right': '↓', roundabout: '○', arrive: '●',
}

function pageDots(m: HudModel, label = true): string {
  let s = ''
  for (let i = 0; i < m.viewCount; i++) s += i === m.viewIndex ? '●' : '○'
  return label ? `${s}  ${VIEW_LABEL[m.view === 'focus' ? 'nav' : m.view]}` : s
}

/** 估算原生字体下的文本宽度（中文约 19px、ASCII 约 10px） */
function textWidth(s: string): number {
  let w = 0
  for (const ch of s) w += /[\u0000-\u00ff]/.test(ch) ? 10 : 19
  return w
}

/** 眼镜与戒指电量：「眼镜 86%  戒指 72%」，充电中加 ↑ */
export function batteryText(m: HudModel, compact = false): string {
  const parts: string[] = []
  const g = compact ? '眼' : '眼镜 '
  const r = compact ? '戒' : '戒指 '
  if (m.glasses.battery !== undefined) parts.push(`${g}${m.glasses.battery}%${m.glasses.charging ? '↑' : ''}`)
  if (m.ring?.battery !== undefined) parts.push(`${r}${m.ring.battery}%${m.ring.charging ? '↑' : ''}`)
  return parts.join(compact ? ' ' : '  ')
}

/**
 * 底栏（一行）：时钟 · 附加信息 · 电量 · 页码。放不下时依次去掉页码标签、附加信息，电量始终保留。
 */
function statusLine(m: HudModel, extra = '', withBattery = true, width = 556): string {
  if (m.toast) return `※ ${m.toast}`
  const build = (ex: string, batt: string, label: boolean) =>
    [fmtClock(m.now) + (ex ? `  ·  ${ex}` : ''), batt].filter(Boolean).join('  ·  ') + `    ${pageDots(m, label)}`
  const full = withBattery ? batteryText(m) : ''
  const compact = withBattery ? batteryText(m, true) : ''
  const tries: [string, string, boolean][] = [
    [extra, full, true], [extra, compact, true], [extra, compact, false], ['', compact, false],
  ]
  for (const [ex, b, label] of tries) {
    const s = build(ex, b, label)
    if (textWidth(s) <= width) return s
  }
  return build('', compact, false)
}

function bar(p: number, n = 22): string {
  const k = Math.max(0, Math.min(n, Math.round(p * n)))
  return '━'.repeat(k) + '─'.repeat(n - k)
}

function canvasCache() {
  const cache = new Map<string, { key: string; c: HTMLCanvasElement }>()
  return (name: string, w: number, h: number, key: string, draw: (ctx: Ctx) => void): HTMLCanvasElement => {
    let e = cache.get(name)
    if (!e) {
      e = { key: '', c: createCanvas(w, h) }
      cache.set(name, e)
    }
    if (e.key !== key) {
      e.key = key
      const ctx = e.c.getContext('2d', { willReadFrequently: true })!
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      ctx.fillStyle = '#000'
      ctx.fillRect(0, 0, w, h)
      draw(ctx)
    }
    return e.c
  }
}
const img = canvasCache()

/**
 * 图片刷新节流：内容键（已量化的位置/角度/缩放）变化后，至少间隔 minMs 才真正重画。
 * force=true（如用户缩放）时立即重画。返回本次应使用的键：被节流时沿用旧键，图片不变就不会发送。
 */
const gates = new Map<string, { key: string; t: number }>()
function gatedKey(name: string, key: string, minMs: number, force = false): string {
  const g = gates.get(name)
  const now = Date.now()
  if (!g || force || (g.key !== key && now - g.t >= minMs)) {
    gates.set(name, { key, t: now })
    return key
  }
  return g.key
}

/** 根据实测单张图片耗时得到图片最小刷新间隔：链路越慢，间隔越长 */
function imageInterval(m: HudModel, factor: number, min: number, max: number): number {
  return Math.round(Math.min(max, Math.max(min, m.linkMs * factor)))
}

/** 把底图按「以 me 为中心、每像素 mpp 米、旋转 rot 度（车头朝上用 -heading）」画到 ctx 的 (cx, cy) */
function drawBasemap(ctx: Ctx, bm: Basemap, me: LngLat, cx: number, cy: number, mpp: number, rot: number, boost = 1): void {
  const [bx, by] = mercatorPx(bm.center, bm.zoom)
  const [ux, uy] = mercatorPx(me, bm.zoom)
  // 用户在底图像素坐标中的位置
  const px = bm.size / 2 + (ux - bx)
  const py = bm.size / 2 + (uy - by)
  const k = bm.mpp / mpp
  ctx.save()
  ctx.translate(cx, cy)
  ctx.rotate((rot * Math.PI) / 180)
  ctx.scale(k, k)
  ctx.imageSmoothingEnabled = true
  ctx.drawImage(bm.canvas, -px, -py)
  // 提亮：用 lighter 叠画（ctx.filter 在部分 iOS WebView 上不可用）
  for (let b = boost - 1; b > 0.01; b -= 1) {
    ctx.globalCompositeOperation = 'lighter'
    ctx.globalAlpha = Math.min(1, b)
    ctx.drawImage(bm.canvas, -px, -py)
  }
  ctx.restore()
}

/** 在本地投影下画路线（已走暗、未走亮） */
function drawRouteOn(ctx: Ctx, m: HudModel, me: LngLat, cx: number, cy: number, mpp: number, rot: number, width = 4): void {
  const route = m.route
  if (!route) return
  const proj = new LocalProjector(me)
  const r = (rot * Math.PI) / 180
  const cos = Math.cos(r), sin = Math.sin(r)
  const toS = (p: LngLat): [number, number] => {
    const [x, y] = proj.toXY(p)
    return [cx + (x * cos - y * sin) / mpp, cy - (x * sin + y * cos) / mpp]
  }
  const s0 = m.nav?.s ?? 0
  let split = route.cum.findIndex((c) => c > s0)
  if (split < 0) split = route.points.length - 1
  const stroke = (i0: number, i1: number, lw: number, lv: number) => {
    ctx.beginPath()
    for (let i = i0; i <= i1; i++) {
      const [x, y] = toS(route.points[i])
      if (i === i0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.strokeStyle = L(lv)
    ctx.lineWidth = lw
    ctx.stroke()
  }
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  if (split > 0) stroke(0, split, 2, 5)
  stroke(Math.max(0, split - 1), route.points.length - 1, width + 4, 4)
  stroke(Math.max(0, split - 1), route.points.length - 1, width, 15)
  const [dx, dy] = toS(route.destination)
  reticle(ctx, dx, dy, 6, 15)
}

/** 位置标记：朝向已知画箭头，未知画圆点（避免指向一个假方向） */
function posMarker(ctx: Ctx, m: HudModel, x: number, y: number, size: number, rot: number): void {
  if (m.headingSource === 'none') {
    ctx.fillStyle = '#000'
    ctx.beginPath()
    ctx.arc(x, y, size * 0.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.strokeStyle = L(15)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(x, y, size * 0.7, 0, Math.PI * 2)
    ctx.stroke()
    ctx.fillStyle = L(15)
    ctx.beginPath()
    ctx.arc(x, y, size * 0.32, 0, Math.PI * 2)
    ctx.fill()
  } else chevron(ctx, x, y, size, rot, 15)
}

const HEADING_SRC: Record<HudModel['headingSource'], string> = { gps: 'GPS', phone: '手机', route: '路线', none: '未知' }

/** 「东北 030° · 手机」 */
function headingText(m: HudModel): string {
  if (m.headingSource === 'none') return '方向未知'
  const h = displayHeading(m)
  return `${compass8(h, true)} ${String(Math.round(normDeg(h) / 5) * 5).padStart(3, '0')}°  ·  ${HEADING_SRC[m.headingSource]}`
}

function scaleText(meters: number): string {
  return meters >= 1000 ? `${meters / 1000}KM` : `${meters}M`
}

// ── 页面结构 ──────────────────────────────────────────────────────
// 每页最多 4 张图片、7 个文本（另有 1 个全屏透明文本负责接收输入）。

// 统一网格：外边距 6px，卡片间距 6px，三列卡片宽 184px。卡片 = 圆角边框文本框（标签一行 + 数值一行）。
const M = 6
const CARD = { y: 150, w: 184, h: 78 }
const card = (name: string, col: number, y = CARD.y, h = CARD.h) =>
  ({ name, x: M + col * (CARD.w + 6), y, w: CARD.w, h, color: 4, border: 1, borderColor: 7, radius: 8, padding: 8 })
const STATUS = { name: 'status', x: M, y: 250, w: 564, h: 36, color: 1 }

export const TEMPLATES: Partial<Record<ViewId, TemplateSpec>> = {
  nav: {
    key: 'nav',
    images: [{ name: 'arrow', x: M, y: M, w: 136, h: 136 }],
    texts: [
      { name: 'main', x: 152, y: 8, w: 418, h: 62, color: 4 },
      { name: 'then', x: 152, y: 74, w: 418, h: 34, color: 2 },
      { name: 'prog', x: 152, y: 108, w: 418, h: 34, color: 3 },
      card('c0', 0), card('c1', 1), card('c2', 2),
      STATUS,
    ],
  },
  cruise: {
    key: 'cruise',
    images: [{ name: 'minimap', x: M, y: M, w: 136, h: 136 }],
    texts: [
      { name: 'title', x: 152, y: 8, w: 418, h: 32, color: 2 },
      { name: 'place', x: 152, y: 42, w: 418, h: 62, color: 4 },
      { name: 'heading', x: 152, y: 108, w: 418, h: 34, color: 3 },
      card('c0', 0), card('c1', 1), card('c2', 2),
      STATUS,
    ],
  },
  telemetry: {
    key: 'telemetry',
    images: [],
    texts: [
      card('c0', 0, M, 76), card('c1', 1, M, 76), card('c2', 2, M, 76),
      card('c3', 0, 88, 76), card('c4', 1, 88, 76), card('c5', 2, 88, 76),
      { name: 'status', x: M, y: 172, w: 564, h: 114, color: 2, padding: 4 },
    ],
  },
  roadbook: {
    key: 'roadbook',
    images: [],
    texts: [
      { name: 'title', x: M, y: M, w: 564, h: 32, color: 2 },
      { name: 'cur', x: M, y: 40, w: 564, h: 48, color: 4, border: 1, borderColor: 9, radius: 8, padding: 8 },
      { name: 'rest', x: M, y: 94, w: 564, h: 152, color: 3, padding: 8 },
      STATUS,
    ],
  },
  go: {
    key: 'go',
    images: [],
    texts: [
      { name: 'title', x: M, y: M, w: 564, h: 32, color: 2 },
      { name: 'list', x: M, y: 40, w: 564, h: 204, color: 4, border: 1, borderColor: 7, radius: 8, padding: 8 },
      STATUS,
    ],
  },
  radar: {
    key: 'radar',
    images: [{ name: 'radar', x: M, y: M, w: 136, h: 136 }],
    texts: [
      { name: 'title', x: 152, y: 8, w: 418, h: 32, color: 2 },
      { name: 'top', x: 152, y: 42, w: 418, h: 100, color: 4 },
      { name: 'list', x: M, y: 150, w: 564, h: 98, color: 3, border: 1, borderColor: 7, radius: 8, padding: 6 },
      STATUS,
    ],
  },
  poi: {
    key: 'poi',
    images: [{ name: 'dir', x: 434, y: M, w: 136, h: 136 }],
    texts: [
      { name: 'info', x: M, y: M, w: 422, h: 148, color: 4 },
      { name: 'dist', x: 434, y: 146, w: 136, h: 32, color: 4 },
      { name: 'addr', x: M, y: 158, w: 422, h: 86, color: 2, border: 1, borderColor: 6, radius: 8, padding: 8 },
      STATUS,
    ],
  },
  map: {
    key: 'map',
    images: [
      { name: 'mapTop', x: 0, y: 0, w: 288, h: 144 },
      { name: 'mapBottom', x: 0, y: 144, w: 288, h: 144 },
    ],
    texts: [
      { name: 'title', x: 296, y: 8, w: 274, h: 32, color: 2 },
      { name: 'place', x: 296, y: 42, w: 274, h: 60, color: 4 },
      { name: 'info', x: 296, y: 104, w: 274, h: 114, color: 4, border: 1, borderColor: 7, radius: 8, padding: 8 },
      { name: 'status', x: 296, y: 224, w: 274, h: 62, color: 1 },
    ],
  },
  overview: {
    key: 'overview',
    images: [
      { name: 'mapTop', x: 0, y: 0, w: 288, h: 144 },
      { name: 'mapBottom', x: 0, y: 144, w: 288, h: 144 },
    ],
    texts: [
      { name: 'title', x: 296, y: 8, w: 274, h: 32, color: 2 },
      { name: 'dest', x: 296, y: 42, w: 274, h: 60, color: 4 },
      { name: 'stats', x: 296, y: 104, w: 274, h: 114, color: 4, border: 1, borderColor: 7, radius: 8, padding: 8 },
      { name: 'status', x: 296, y: 224, w: 274, h: 62, color: 1 },
    ],
  },
  arrival: {
    key: 'arrival',
    images: [{ name: 'reticle', x: M, y: M, w: 136, h: 136 }],
    texts: [
      { name: 'title', x: 152, y: 8, w: 418, h: 62, color: 4 },
      card('c0', 0), card('c1', 1), card('c2', 2),
      STATUS,
    ],
  },
}

// ── 内容生成 ──────────────────────────────────────────────────────

function navFrame(m: HudModel): TemplateFrame {
  const nav = m.nav!
  const route = m.route!
  const focus = m.view === 'focus'
  const act = nav.maneuver === 'arrive' ? '到达目的地' : MANEUVER_LABEL[nav.maneuver]
  const road = nav.maneuver === 'arrive'
    ? route.destName
    : nav.nextStep?.road || (nav.nextStep?.instruction ?? '').replace(/^.*?(进入|沿)/, '$1').slice(0, 16)
  const then = nav.thenManeuver && nav.thenManeuver !== 'straight' && nav.nextStep
    ? `然后  ${MANEUVER_GLYPH[nav.thenManeuver]} ${MANEUVER_LABEL[nav.thenManeuver]} · ${fmtDistStr(nav.thenDistance ?? 0)}`
    : ' '
  const eta = fmtClock(new Date(m.now.getTime() + nav.etaSec * 1000))
  const arrowKey = `${nav.maneuver}|${focus}|${route.mode}`
  return {
    texts: {
      main: `${fmtDistStr(nav.distToManeuver)}  ${act}\n${road ? '进入 ' + road : '沿当前道路'}`,
      then: focus ? ' ' : then,
      prog: focus ? ' ' : `${bar(nav.progress, 18)}  ${Math.round(nav.progress * 100)}%`,
      c0: focus ? ' ' : `剩余\n${fmtDistStr(nav.remaining)}`,
      c1: focus ? ' ' : `用时\n${fmtDurationZh(nav.etaSec)}`,
      c2: focus ? ' ' : `到达\n${eta}`,
      status: statusLine(m, `${fmtSpeed(m.fix?.speed ?? NaN)} km/h`),
    },
    images: {
      arrow: img('arrow', 136, 136, arrowKey, (ctx) => {
        brackets(ctx, 2, 2, 132, 132, 16, 9)
        maneuverIcon(ctx, nav.maneuver, 68, focus ? 70 : 62, focus ? 70 : 92)
        if (!focus) {
          // 出行方式标签（只在方式变化时随箭头图重发）
          ctx.fillStyle = L(9)
          ctx.font = '600 15px "PingFang SC", "Noto Sans CJK SC", sans-serif'
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(MODE_LABEL[route.mode], 68, 120)
        }
      }),
    },
  }
}

function cruiseFrame(m: HudModel): TemplateFrame {
  const heading = displayHeading(m)
  const w = m.weather ? `   ${m.weather.temperature}°C ${m.weather.text}` : ''
  const place = m.place
    ? `${m.place.street || m.place.address}\n${[m.place.city, m.place.district].filter(Boolean).join(' · ')}`
    : m.fix ? '定位中…' : m.hasKey ? '等待定位信号' : '请在手机端填写高德 Key'
  let home = ' '
  const start = m.trip.start
  if (m.fix && start && haversine(m.fix.p, start) > 30) {
    home = `${dirGlyph(angleDiff(heading, bearing(m.fix.p, start)))} 起点 ${fmtDistStr(haversine(m.fix.p, start))}`
  }
  const alt = Number.isFinite(m.fix?.altitude ?? NaN) ? `${Math.round(m.fix!.altitude)} m` : '--'
  void w
  return {
    texts: {
      title: '巡航  ·  单击后长按打开菜单',
      place,
      heading: `航向  ${headingText(m)}`,
      c0: m.fix && Number.isFinite(m.fix.speed) && m.fix.speed < 0.3 ? '速度\n静止' : `速度\n${fmtSpeed(m.fix?.speed ?? NaN)} km/h`,
      c1: m.weather ? `天气\n${m.weather.temperature}°C ${m.weather.text}` : `海拔\n${alt}`,
      c2: home !== ' '
        ? `起点\n${home.replace(' 起点 ', ' ')}`
        : alt !== '--' ? `海拔\n${alt}` : `GPS 精度\n${m.fix ? `±${Math.round(m.fix.accuracy)} m` : '无信号'}`,
      status: statusLine(m),
    },
    images: { minimap: minimap(m) },
  }
}

/**
 * 游戏风格小地图（136×136，车头朝上）：街道线框 + 罗盘刻度 + 位置箭头 + 比例尺。
 * 位置按约 5px 量化、航向按 15° 量化，并按链路速度限流（至少 3 倍单张耗时）。
 */
function minimap(m: HudModel): HTMLCanvasElement {
  const me = m.fix?.p
  const heading = displayHeading(m)
  const hq = Math.round(normDeg(heading) / 15) * 15
  const sp = m.fix && Number.isFinite(m.fix.speed) ? m.fix.speed : 0
  const mpp = Math.min(6, Math.max(1.2, 1.2 + sp * 0.12)) // 越快比例尺越大
  const bm = m.basemap
  const grid = 5 * mpp
  const pos = me ? `${Math.round((me[0] * 85000) / grid)},${Math.round((me[1] * 111000) / grid)}` : 'none'
  const raw = `${pos}|${hq}|${m.headingSource === 'none'}|${Math.round(mpp * 2)}|${bm ? bm.center.join() + bm.zoom : 'nobm'}|${m.route?.createdAt ?? 0}`
  const key = gatedKey('minimap', raw, imageInterval(m, 3, 1500, 8000))
  return img('minimap', 136, 136, key, (ctx) => {
    const cx = 68, cy = 68, R = 64
    ctx.save()
    ctx.beginPath()
    ctx.arc(cx, cy, R - 1, 0, Math.PI * 2)
    ctx.clip()
    if (bm && me) drawBasemap(ctx, bm, me, cx, cy, mpp, -hq, 1.6)
    else {
      // 没有底图（未填 Key 或加载中）：距离环
      for (let i = 1; i <= 2; i++) {
        ctx.strokeStyle = L(3)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2)
        ctx.stroke()
      }
    }
    if (me) drawRouteOn(ctx, m, me, cx, cy, mpp, -hq, 3)
    ctx.restore()
    // 外圈与罗盘刻度
    ctx.strokeStyle = L(9)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cx, cy, R, 0, Math.PI * 2)
    ctx.stroke()
    for (let a = 0; a < 360; a += 30) {
      const t = ((a - hq) * Math.PI) / 180
      const major = a % 90 === 0
      ctx.strokeStyle = L(major ? 13 : 7)
      ctx.lineWidth = major ? 3 : 2
      ctx.beginPath()
      ctx.moveTo(cx + Math.sin(t) * (R - (major ? 9 : 5)), cy - Math.cos(t) * (R - (major ? 9 : 5)))
      ctx.lineTo(cx + Math.sin(t) * R, cy - Math.cos(t) * R)
      ctx.stroke()
    }
    const nt = (-hq * Math.PI) / 180
    const nx = cx + Math.sin(nt) * (R - 17)
    const ny = cy - Math.cos(nt) * (R - 17)
    ctx.fillStyle = '#000'
    ctx.beginPath()
    ctx.arc(nx, ny, 8, 0, Math.PI * 2)
    ctx.fill()
    ctx.fillStyle = L(15)
    ctx.font = '900 13px Orbitron, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', nx, ny + 1)
    posMarker(ctx, m, cx, cy, 9, 0)
    // 比例尺（半径对应的距离）
    const radiusM = Math.round((R * mpp) / 10) * 10
    ctx.fillStyle = '#000'
    ctx.fillRect(cx - 22, cy + R - 20, 44, 13)
    ctx.fillStyle = L(9)
    ctx.font = '700 11px Rajdhani, sans-serif'
    ctx.fillText(scaleText(radiusM), cx, cy + R - 13)
  })
}

// ── 街道地图页：288×288 正北朝上大地图（上下两张图）+ 右侧文字，可缩放 ────────

const smap = createCanvas(288, 288)
const smapTop = createCanvas(288, 144)
const smapBottom = createCanvas(288, 144)
let smapKey = ''
let smapZoomShown = 0

function streetMapFrame(m: HudModel): TemplateFrame {
  const me = m.fix?.p
  const heading = displayHeading(m)
  const zoom = m.mapZoom
  const lat = me ? me[1] : 39.9
  const mpp = metersPerPixel(lat, zoom)
  const bm = m.mapBasemap && m.mapBasemap.zoom === zoom ? m.mapBasemap : null
  const grid = 8 * mpp
  const pos = me ? `${Math.round((me[0] * 85000) / grid)},${Math.round((me[1] * 111000) / grid)}` : 'none'
  const raw = `${pos}|${Math.round(normDeg(heading) / 30)}|${m.headingSource === 'none'}|${zoom}|${bm ? bm.center.join() : 'nobm'}|${m.route?.createdAt ?? 0}|${Math.round((m.nav?.progress ?? 0) * 50)}`
  // 缩放变化立即重画；其余按链路速度限流（至少 5 倍单张耗时，每次要发两张图）
  const key = gatedKey('streetmap', raw, imageInterval(m, 5, 3000, 15000), zoom !== smapZoomShown)
  if (key !== smapKey) {
    smapKey = key
    smapZoomShown = zoom
    const ctx = smap.getContext('2d', { willReadFrequently: true })!
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, 288, 288)
    if (bm && me) drawBasemap(ctx, bm, me, 144, 144, mpp, 0, 2)
    else {
      ctx.fillStyle = L(3)
      for (let x = 24; x < 288; x += 40) for (let y = 24; y < 288; y += 40) ctx.fillRect(x - 1, y - 1, 2, 2)
    }
    if (me) {
      drawRouteOn(ctx, m, me, 144, 144, mpp, 0, 4)
      const accR = Math.min(60, (m.fix?.accuracy ?? 0) / mpp)
      if (accR > 6) {
        ctx.strokeStyle = L(6)
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.arc(144, 144, accR, 0, Math.PI * 2)
        ctx.stroke()
      }
      posMarker(ctx, m, 144, 144, 11, heading)
    }
    brackets(ctx, 2, 2, 284, 284, 16, 8)
    // 指北针
    ctx.fillStyle = L(15)
    ctx.font = '900 14px Orbitron, sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText('N', 262, 22)
    ctx.beginPath()
    ctx.moveTo(262, 30); ctx.lineTo(257, 42); ctx.lineTo(267, 42); ctx.closePath()
    ctx.fill()
    // 比例尺
    const nice = [20, 50, 100, 200, 500, 1000, 2000]
    let meters = nice[0]
    for (const n of nice) if (n / mpp <= 90) meters = n
    ctx.strokeStyle = L(10)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.moveTo(14, 264); ctx.lineTo(14, 270); ctx.lineTo(14 + meters / mpp, 270); ctx.lineTo(14 + meters / mpp, 264)
    ctx.stroke()
    ctx.fillStyle = L(10)
    ctx.font = '700 11px Rajdhani, sans-serif'
    ctx.textAlign = 'left'
    ctx.fillText(scaleText(meters), 20 + meters / mpp, 268)
    smapTop.getContext('2d')!.drawImage(smap, 0, 0, 288, 144, 0, 0, 288, 144)
    smapBottom.getContext('2d')!.drawImage(smap, 0, 144, 288, 144, 0, 0, 288, 144)
  }
  const level = MAP_ZOOMS.indexOf(zoom)
  const levelBar = MAP_ZOOMS.map((_, i) => (i <= level ? '━' : '─')).join('')
  const place = m.place ? `${m.place.street || m.place.address}\n${m.place.district || m.place.city}` : m.fix ? '定位中…' : '等待定位'
  const nav = m.nav
  return {
    texts: {
      title: `街道地图  ${levelBar}`,
      place,
      info: [
        `航向  ${headingText(m)}`,
        `速度  ${fmtSpeed(m.fix?.speed ?? NaN)} km/h`,
        nav ? `剩余  ${fmtDistStr(nav.remaining)}` : (bm ? `范围  约 ${scaleText(Math.round((144 * mpp) / 50) * 50)}` : m.hasKey ? '街道加载中…' : '需要高德 Key 显示街道'),
      ].join('\n'),
      status: m.toast ? `※ ${m.toast}` : `单击放大 · 长按缩小\n${pageDots(m)}`,
    },
    images: { mapTop: smapTop, mapBottom: smapBottom },
  }
}

function telemetryFrame(m: HudModel): TemplateFrame {
  const t = m.trip
  const heading = displayHeading(m)
  const alt = Number.isFinite(m.fix?.altitude ?? NaN) ? `${Math.round(m.fix!.altitude)} m` : '--'
  const cells: [string, string][] = [
    ['速度', `${fmtSpeed(m.fix?.speed ?? NaN)} km/h`],
    ['行程', fmtDistStr(t.distance)],
    ['用时', t.elapsedSec < 60 ? '不到 1 分钟' : fmtDurationZh(t.elapsedSec)],
    ['均速', `${fmtSpeed(t.avgSpeed)} km/h`],
    ['最高', `${fmtSpeed(t.maxSpeed)} km/h`],
    ['航向', m.headingSource === 'none' ? '—' : `${compass8(heading, true)} ${Math.round(normDeg(heading) / 5) * 5}°`],
  ]
  const texts: Record<string, string> = {}
  cells.forEach(([k, v], i) => (texts[`c${i}`] = `${k}\n${v}`))
  const foot = [`海拔 ${alt}`, `爬升 ${Math.round(t.climb)} m`, m.fix ? `GPS ±${Math.round(m.fix.accuracy / 5) * 5} m` : 'GPS --', m.weather ? `${m.weather.temperature}°C ${m.weather.text}` : '']
    .filter(Boolean).join('  ·  ')
  texts.status = `${foot}\n${batteryText(m) || ' '}\n${statusLine(m, '', false)}`
  return { texts, images: {} }
}

function roadbookFrame(m: HudModel): TemplateFrame {
  const route = m.route
  const nav = m.nav
  if (!route || !nav) return { texts: { title: '路书', cur: '尚未开始导航', rest: ' ', status: statusLine(m) }, images: {} }
  const first = Math.min(route.steps.length - 1, nav.stepIndex + m.roadbookOffset)
  const row = (i: number) => {
    const st = route.steps[i]
    const next = route.steps[i + 1]
    const label = st.maneuver === 'arrive' ? '到达目的地' : MANEUVER_LABEL[st.maneuver]
    const road = st.maneuver === 'arrive' ? route.destName : next?.road || ''
    return `${MANEUVER_GLYPH[st.maneuver]}  ${fmtDistStr(Math.max(0, st.s1 - nav.s)).padEnd(7)} ${label}${road ? ' · ' + road : ''}`
  }
  const rest: string[] = []
  for (let i = first + 1; i < Math.min(route.steps.length, first + 5); i++) rest.push(row(i))
  return {
    texts: {
      title: `路书  ·  第 ${first + 1}/${route.steps.length} 段      单击翻页`,
      cur: (first === nav.stepIndex ? '当前  ' : '') + row(first),
      rest: rest.join('\n') || ' ',
      status: statusLine(m),
    },
    images: {},
  }
}

function goFrame(m: HudModel): TemplateFrame {
  const me = m.fix?.p
  const heading = displayHeading(m)
  if (m.planning) return { texts: { title: '前往', list: `正在规划前往 ${m.planning}…`, status: statusLine(m) }, images: {} }
  const rows = m.quick.slice(0, 6).map((q) => {
    const tag = QUICK_TAG_LABEL[q.tag].padEnd(2, '　')
    if (!me) return `${tag}  ${q.place.name}`
    const d = fmtDistStr(Math.round(haversine(me, q.place.location) / 50) * 50 || haversine(me, q.place.location))
    return `${tag}  ${q.place.name}   ${d} ${dirGlyph(angleDiff(heading, bearing(me, q.place.location)))}`
  })
  return {
    texts: {
      title: `前往  ·  ${MODE_LABEL[m.travelMode]}      单击选择`,
      list: rows.join('\n') || '还没有快捷点\n在手机端设置家 / 公司，或把地点「加到眼镜」',
      status: statusLine(m),
    },
    images: {},
  }
}

function radarFrame(m: HudModel): TemplateFrame {
  const me = m.fix?.p
  const heading = displayHeading(m)
  const hq = Math.round(normDeg(heading) / 15) * 15
  const cat = RADAR_CATEGORIES[m.radar.category]
  const pois = m.radar.pois.slice(0, 5)
  const info = (i: number) => {
    const p = pois[i]
    const meta = [p.rating ? `★${p.rating.toFixed(1)}` : '', p.cost ? `¥${Math.round(p.cost)}` : '', p.floor ?? ''].filter(Boolean).join(' ')
    const d = me ? `${fmtDistStr(Math.round(haversine(me, p.location) / 10) * 10)} ${dirGlyph(angleDiff(heading, bearing(me, p.location)))}` : ''
    return { name: p.name, meta, d }
  }
  let top = m.radar.loading ? '扫描中…' : m.radar.error ? m.radar.error : m.radar.fetchedAt ? '附近未找到' : '单击开始扫描'
  if (pois.length) {
    const a = info(0)
    top = `1  ${a.name}\n${[a.meta, a.d].filter(Boolean).join('   ')}`
  }
  const rest = pois.slice(1, 4).map((_, k) => {
    const a = info(k + 1)
    return `${k + 2}  ${a.name}   ${a.d}${a.meta ? '   ' + a.meta : ''}`
  })
  // 雷达图：按 15° 航向与 10m 距离量化，只在明显变化时重发
  const blips = me ? pois.map((p) => [Math.round(angleDiff(hq, bearing(me, p.location)) / 10) * 10, Math.round(haversine(me, p.location) / 20) * 20]) : []
  let range = 250
  for (const [, d] of blips) while (d > range && range < 2000) range *= 2
  return {
    texts: {
      title: `周边  ·  ${cat.name}      单击选择 / 换类别`,
      top,
      list: rest.join('\n') || ' ',
      status: statusLine(m),
    },
    images: {
      radar: img('radar', 136, 136, JSON.stringify([hq, range, blips]), (ctx) => {
        const cx = 68, cy = 68, R = 62
        for (let i = 1; i <= 3; i++) {
          ctx.strokeStyle = L(i === 3 ? 7 : 4)
          ctx.lineWidth = i === 3 ? 2 : 1
          ctx.beginPath()
          ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2)
          ctx.stroke()
        }
        ctx.strokeStyle = L(4)
        ctx.beginPath()
        ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy)
        ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R)
        ctx.stroke()
        const nt = (-hq * Math.PI) / 180
        ctx.fillStyle = L(15)
        ctx.font = '900 13px Orbitron, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('N', cx + Math.sin(nt) * (R - 10), cy - Math.cos(nt) * (R - 10))
        blips.forEach(([b, d], i) => {
          const r = (Math.min(1, d / range) * R)
          const t = (b * Math.PI) / 180
          const x = cx + Math.sin(t) * r
          const y = cy - Math.cos(t) * r
          ctx.fillStyle = L(i === 0 ? 15 : 11)
          ctx.fillRect(x - (i === 0 ? 4 : 3), y - (i === 0 ? 4 : 3), i === 0 ? 8 : 6, i === 0 ? 8 : 6)
        })
        pointer(ctx, cx, cy, 8, 0, 15)
      }),
    },
  }
}

function poiFrame(m: HudModel): TemplateFrame {
  const p = m.poi!
  const me = m.fix?.p
  const heading = displayHeading(m)
  const target = p.entrance ?? p.location
  const stars = p.rating ? `${'★'.repeat(Math.round(p.rating))}${'☆'.repeat(5 - Math.round(p.rating))} ${p.rating.toFixed(1)}` : ''
  const line2 = [p.cost ? `人均 ¥${Math.round(p.cost)}` : '', p.floor ? `楼层 ${p.floor}` : ''].filter(Boolean).join('  ·  ')
  const meta = [stars, line2, p.openToday ? `营业 ${p.openToday}` : ''].filter(Boolean).join('\n') || ' '
  const rel = me ? Math.round(angleDiff(heading, bearing(me, target)) / 10) * 10 : 0
  return {
    texts: {
      // 店名与评分等放在同一个文本框里连续排列（店名短时不会留出空白）
      info: `${p.name}\n${meta}`,
      dist: me ? `${fmtDistStr(haversine(me, target))} ${compass8(bearing(me, target), true)}` : ' ',
      addr: [p.area, p.address].filter(Boolean).join(' · ') || ' ',
      status: m.toast ? `※ ${m.toast}` : '单击 导航前往  ·  双击 返回',
    },
    images: {
      dir: img('dir', 136, 136, String(me ? rel : 'none'), (ctx) => {
        ctx.strokeStyle = L(6)
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(68, 68, 60, 0, Math.PI * 2)
        ctx.stroke()
        if (me) pointer(ctx, 68, 68, 34, rel, 15)
      }),
    },
  }
}

function arrivalFrame(m: HudModel): TemplateFrame {
  const a = m.arrival
  return {
    texts: {
      title: `已到达\n${a?.name ?? '目的地'}`,
      c0: a ? `用时\n${fmtDurationZh(a.elapsed)}` : ' ',
      c1: a ? `距离\n${fmtDistStr(a.distance)}` : ' ',
      c2: a ? `均速\n${fmtSpeed(a.avg)} km/h` : ' ',
      status: '单击返回巡航',
    },
    images: {
      reticle: img('reticle', 136, 136, 'static', (ctx) => {
        for (const [r, lv] of [[62, 5], [46, 9]] as const) {
          ctx.strokeStyle = L(lv)
          ctx.lineWidth = 2
          ctx.beginPath()
          ctx.arc(68, 68, r, 0, Math.PI * 2)
          ctx.stroke()
        }
        maneuverIcon(ctx, 'arrive', 68, 68, 64)
        reticle(ctx, 68, 68, 6, 15)
      }),
    },
  }
}

// ── 全局地图：288×288 正方形地图（上下两张图拼成）+ 右侧文字 ─────────

const mapCanvas = createCanvas(288, 288)
const mapTop = createCanvas(288, 144)
const mapBottom = createCanvas(288, 144)
let mapKey = ''

function drawOverviewMap(m: HudModel): void {
  const ctx = mapCanvas.getContext('2d', { willReadFrequently: true })!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, 288, 288)
  const route = m.route
  const me = m.fix?.p
  const pts: LngLat[] = route?.points ?? []
  const pad = 22
  let mpp: number
  let center: LngLat
  if (m.overviewZoom === 'near' || pts.length < 2) {
    center = me ?? pts[0] ?? [116.397, 39.909]
    mpp = 2 // 附近：约 580m 见方
  } else {
    const proj0 = new LocalProjector(pts[0])
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const p of me ? [...pts, me] : pts) {
      const [x, y] = proj0.toXY(p)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x); minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    mpp = Math.max((maxX - minX) / (288 - pad * 2), (maxY - minY) / (288 - pad * 2), 1)
    center = proj0.toLngLat((minX + maxX) / 2, (minY + maxY) / 2)
  }
  const proj = new LocalProjector(center)
  const toS = (p: LngLat): [number, number] => {
    const [x, y] = proj.toXY(p)
    return [144 + x / mpp, 144 - y / mpp]
  }
  brackets(ctx, 2, 2, 284, 284, 16, 7)
  ctx.fillStyle = L(3)
  for (let x = 24; x < 288; x += 40) for (let y = 24; y < 288; y += 40) ctx.fillRect(x - 1, y - 1, 2, 2)
  if (route) {
    const s0 = m.nav?.s ?? 0
    let split = route.cum.findIndex((c) => c > s0)
    if (split < 0) split = pts.length - 1
    const stroke = (i0: number, i1: number, lw: number, lv: number) => {
      ctx.beginPath()
      for (let i = i0; i <= i1; i++) {
        const [x, y] = toS(pts[i])
        if (i === i0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.strokeStyle = L(lv)
      ctx.lineWidth = lw
      ctx.stroke()
    }
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    if (split > 0) stroke(0, split, 2, 5)
    stroke(Math.max(0, split - 1), pts.length - 1, 8, 4)
    stroke(Math.max(0, split - 1), pts.length - 1, 3, 15)
    const [sx, sy] = toS(route.origin)
    diamond(ctx, sx, sy, 5, 12, false)
    const [dx, dy] = toS(route.destination)
    reticle(ctx, dx, dy, 7, 15)
  }
  if (me) {
    const [ux, uy] = toS(me)
    chevron(ctx, ux, uy, 9, displayHeading(m))
  }
  // 比例尺
  const nice = [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]
  let meters = nice[0]
  for (const n of nice) if (n / mpp <= 80) meters = n
  ctx.strokeStyle = L(9)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(14, 266); ctx.lineTo(14, 272); ctx.lineTo(14 + meters / mpp, 272); ctx.lineTo(14 + meters / mpp, 266)
  ctx.stroke()
  ctx.fillStyle = L(9)
  ctx.font = '700 11px Rajdhani, sans-serif'
  ctx.textAlign = 'left'
  ctx.fillText(fmtDistStr(meters).toUpperCase(), 20 + meters / mpp, 274)
  mapTop.getContext('2d')!.drawImage(mapCanvas, 0, 0, 288, 144, 0, 0, 288, 144)
  mapBottom.getContext('2d')!.drawImage(mapCanvas, 0, 144, 288, 144, 0, 0, 288, 144)
}

function overviewFrame(m: HudModel): TemplateFrame {
  const route = m.route
  const nav = m.nav
  const me = m.fix?.p
  // 位置按约 1/36 图宽量化、航向按 30°：只有明显移动才重画地图（每次重画要发两张图）
  const span = route ? Math.max(200, route.distance / 3) : 1500
  const grid = m.overviewZoom === 'near' ? 16 : span / 36
  const pos = me ? `${Math.round(me[0] * 111000 / grid)},${Math.round(me[1] * 111000 / grid)}` : '-'
  const key = `${route?.createdAt ?? 0}|${m.overviewZoom}|${pos}|${Math.round(displayHeading(m) / 30)}|${Math.round((nav?.progress ?? 0) * 40)}`
  if (key !== mapKey) {
    mapKey = key
    drawOverviewMap(m)
  }
  const eta = nav ? fmtClock(new Date(m.now.getTime() + nav.etaSec * 1000)) : '--'
  return {
    texts: {
      title: `全局地图  ·  ${m.overviewZoom === 'near' ? '附近' : '全程'}`,
      dest: route ? `→ ${route.destName}` : '尚未开始导航',
      stats: nav && route
        ? `剩余  ${fmtDistStr(nav.remaining)}\n用时  ${fmtDurationZh(nav.etaSec)}\n到达  ${eta}`
        : ' ',
      status: m.toast ? `※ ${m.toast}` : `单击切换 全程 / 附近\n${pageDots(m)}`,
    },
    images: { mapTop, mapBottom },
  }
}

/** 返回当前视图的模板与内容；没有模板的视图（全局地图）返回 null，走四图块 */
export function templateFor(m: HudModel): { spec: TemplateSpec; frame: TemplateFrame } | null {
  const v = m.view
  if ((v === 'nav' || v === 'focus') && m.nav && m.route) return { spec: TEMPLATES.nav!, frame: navFrame(m) }
  if (v === 'cruise') return { spec: TEMPLATES.cruise!, frame: cruiseFrame(m) }
  if (v === 'telemetry') return { spec: TEMPLATES.telemetry!, frame: telemetryFrame(m) }
  if (v === 'roadbook') return { spec: TEMPLATES.roadbook!, frame: roadbookFrame(m) }
  if (v === 'go') return { spec: TEMPLATES.go!, frame: goFrame(m) }
  if (v === 'radar') return { spec: TEMPLATES.radar!, frame: radarFrame(m) }
  if (v === 'poi' && m.poi) return { spec: TEMPLATES.poi!, frame: poiFrame(m) }
  if (v === 'arrival') return { spec: TEMPLATES.arrival!, frame: arrivalFrame(m) }
  if (v === 'map') return { spec: TEMPLATES.map!, frame: streetMapFrame(m) }
  if (v === 'overview' && m.route) return { spec: TEMPLATES.overview!, frame: overviewFrame(m) }
  return null
}
