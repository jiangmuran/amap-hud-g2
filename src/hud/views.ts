// 眼镜端各视图。画布 576×288，左上角原点；最终会被拆成 4 个 288×144 图块发送，
// 布局上尽量让「频繁变化的内容」集中在少数图块，减少每帧发送量。

import { bearing, compass8, haversine, LocalProjector, angleDiff, normDeg, type LngLat } from '../geo'
import { MANEUVER_LABEL, MODE_LABEL, type Route } from '../nav/route'
import { SCREEN_H, SCREEN_W } from '../glasses/display'
import {
  battery, brackets, chamferRect, chevron, clear, diamond, ellipsize, font, hatch, L, line, maneuverIcon,
  numUnit, reticle, segBar, signal, text, type Ctx,
} from './gfx'
import { fmtClock, fmtDist, fmtDistStr, fmtDuration, fmtElapsed, fmtSpeed, kmh } from './format'
import { displayHeading, RADAR_CATEGORIES, VIEW_LABEL, type HudModel } from './model'

interface Rect { x: number; y: number; w: number; h: number }

export function renderHud(ctx: Ctx, m: HudModel): void {
  clear(ctx, SCREEN_W, SCREEN_H)
  switch (m.view) {
    case 'nav': drawNav(ctx, m); break
    case 'overview': drawOverview(ctx, m); break
    case 'roadbook': drawRoadbook(ctx, m); break
    case 'telemetry': drawTelemetry(ctx, m); break
    case 'radar': drawRadar(ctx, m); break
    case 'arrival': drawArrival(ctx, m); break
    case 'focus': drawFocus(ctx, m); break
    default: drawCruise(ctx, m)
  }
  if (m.toast) drawToast(ctx, m.toast)
}

// ── 公共部件 ─────────────────────────────────────────────────────

function pageDots(ctx: Ctx, x: number, y: number, m: HudModel): void {
  for (let i = 0; i < m.viewCount; i++) diamond(ctx, x + i * 11, y, i === m.viewIndex ? 4 : 2.5, i === m.viewIndex ? 13 : 5, i === m.viewIndex)
  text(ctx, VIEW_LABEL[m.view], x + m.viewCount * 11 + 4, y + 4, { font: font.label(12, 700), level: 7 })
}

function statusCluster(ctx: Ctx, xRight: number, y: number, m: HudModel): void {
  battery(ctx, xRight - 26, y, m.glasses.battery)
  signal(ctx, xRight - 52, y - 2, m.fix?.accuracy)
  if (m.simulated) {
    chamferRect(ctx, xRight - 90, y - 2, 32, 14, 3, 9, 1)
    text(ctx, 'SIM', xRight - 74, y + 9, { font: font.label(11, 700), level: 12, align: 'center' })
  }
}

function drawToast(ctx: Ctx, msg: string): void {
  ctx.font = font.cjk(18)
  const w = Math.min(520, ctx.measureText(msg).width + 56)
  const x = (SCREEN_W - w) / 2
  chamferRect(ctx, x, 8, w, 36, 8, 15, 2, 0)
  hatch(ctx, x + 6, 14, 14, 24, 8)
  text(ctx, msg, x + w / 2 + 8, 32, { font: font.cjk(18), level: 15, align: 'center', maxWidth: w - 40 })
}

function scaleBar(ctx: Ctx, x: number, y: number, mpp: number, maxPx = 80): void {
  const nice = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000]
  let meters = nice[0]
  for (const n of nice) if (n / mpp <= maxPx) meters = n
  const px = meters / mpp
  ctx.strokeStyle = L(9)
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(x, y - 5); ctx.lineTo(x, y); ctx.lineTo(x + px, y); ctx.lineTo(x + px, y - 5)
  ctx.stroke()
  text(ctx, fmtDistStr(meters).toUpperCase(), x + px + 5, y + 1, { font: font.label(12, 700), level: 9 })
}

function nextRoadName(m: HudModel): string {
  const nav = m.nav
  if (!nav) return ''
  if (nav.maneuver === 'arrive') return m.route?.destName ?? '目的地'
  const ns = nav.nextStep
  if (ns?.road) return ns.road
  const ins = ns?.instruction ?? nav.step.instruction
  const match = ins.match(/进入(.+?)(?:[，,]|$)/)
  return match ? match[1] : ins
}

// ── 局部地图（雷达风格）────────────────────────────────────────────

interface MapOpts {
  rect: Rect
  cx: number
  cy: number
  mpp: number
  rotation: number
  rings?: boolean
  compass?: boolean
}

function drawLocalMap(ctx: Ctx, m: HudModel, o: MapOpts): void {
  const me = m.fix?.p ?? m.nav?.matched ?? m.route?.origin
  if (!me) {
    text(ctx, 'NO GPS', o.rect.x + o.rect.w / 2, o.rect.y + o.rect.h / 2, { font: font.num(18), level: 8, align: 'center' })
    return
  }
  const proj = new LocalProjector(me)
  const rot = (-o.rotation * Math.PI) / 180
  const cos = Math.cos(rot)
  const sin = Math.sin(rot)
  const toScreen = (p: LngLat): [number, number] => {
    const [x, y] = proj.toXY(p)
    const rx = x * cos - y * sin
    const ry = x * sin + y * cos
    return [o.cx + rx / o.mpp, o.cy - ry / o.mpp]
  }
  const rangeM = Math.hypot(o.rect.w, o.rect.h) * o.mpp

  ctx.save()
  ctx.beginPath()
  ctx.rect(o.rect.x, o.rect.y, o.rect.w, o.rect.h)
  ctx.clip()

  // 街道底图
  const bm = m.basemap
  if (bm && haversine(bm.center, me) < bm.size * bm.mpp) {
    const [bx, by] = proj.toXY(bm.center)
    ctx.save()
    ctx.translate(o.cx, o.cy)
    ctx.rotate(rot)
    const k = bm.mpp / o.mpp
    ctx.scale(k, k)
    ctx.imageSmoothingEnabled = true
    ctx.drawImage(bm.canvas, bx / bm.mpp - bm.size / 2, -by / bm.mpp - bm.size / 2)
    ctx.restore()
  }

  // 距离环
  if (o.rings) {
    const nice = [25, 50, 100, 200, 250, 500, 1000, 2000]
    const target = (Math.min(o.rect.w, o.rect.h) * 0.3) * o.mpp
    let step = nice[0]
    for (const n of nice) if (n <= target) step = n
    ctx.setLineDash([2, 5])
    for (let i = 1; i <= 3; i++) {
      const r = (step * i) / o.mpp
      ctx.strokeStyle = L(i === 3 ? 5 : 4)
      ctx.lineWidth = 1.5
      ctx.beginPath()
      ctx.arc(o.cx, o.cy, r, 0, Math.PI * 2)
      ctx.stroke()
      text(ctx, fmtDistStr(step * i), o.cx + r * 0.71 + 3, o.cy - r * 0.71 - 3, { font: font.label(11, 700), level: 6 })
    }
    ctx.setLineDash([])
  }

  // 罗盘刻度环
  if (o.compass) {
    const r = Math.min(o.rect.w, o.rect.h) * 0.47
    for (let a = 0; a < 360; a += 10) {
      const ang = ((a - o.rotation) * Math.PI) / 180
      const major = a % 30 === 0
      const r0 = r - (major ? 9 : 4)
      line(ctx, o.cx + Math.sin(ang) * r0, o.cy - Math.cos(ang) * r0, o.cx + Math.sin(ang) * r, o.cy - Math.cos(ang) * r, major ? 9 : 5, major ? 2 : 1)
    }
    const na = (-o.rotation * Math.PI) / 180
    const nx = o.cx + Math.sin(na) * (r - 20)
    const ny = o.cy - Math.cos(na) * (r - 20)
    text(ctx, 'N', nx, ny, { font: font.num(14, 900), level: 15, align: 'center', baseline: 'middle' })
  }

  // 面包屑轨迹
  const trail = m.trip.trail
  if (trail.length > 1) {
    ctx.fillStyle = L(6)
    for (const p of trail) {
      if (haversine(p, me) > rangeM) continue
      const [x, y] = toScreen(p)
      ctx.fillRect(x - 1, y - 1, 2, 2)
    }
  }

  // 路线
  const route = m.route
  if (route) {
    const s = m.nav?.s ?? 0
    const pts = route.points
    const cum = route.cum
    const visible = (i: number) => haversine(pts[i], me) < rangeM + 200
    const pathFrom = (i0: number, i1: number) => {
      ctx.beginPath()
      let started = false
      for (let i = i0; i <= i1; i++) {
        if (!visible(i) && !(i > i0 && visible(i - 1)) && !(i < i1 && visible(i + 1))) {
          started = false
          continue
        }
        const [x, y] = toScreen(pts[i])
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      }
    }
    let split = cum.findIndex((c) => c > s)
    if (split < 0) split = pts.length - 1
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    // 已走过：暗细线
    if (split > 0) {
      pathFrom(0, split)
      ctx.strokeStyle = L(4)
      ctx.lineWidth = 2
      ctx.stroke()
    }
    // 未走：外发光 + 亮芯
    pathFrom(Math.max(0, split - 1), pts.length - 1)
    ctx.strokeStyle = L(5)
    ctx.lineWidth = 11
    ctx.stroke()
    ctx.strokeStyle = L(15)
    ctx.lineWidth = 4
    ctx.stroke()
    // 拥堵：亮芯上打黑色虚线
    for (const t of route.traffic) {
      if (!/拥堵/.test(t.status) || t.s1 < s) continue
      const i0 = Math.max(0, cum.findIndex((c) => c >= t.s0))
      let i1 = cum.findIndex((c) => c >= t.s1)
      if (i1 < 0) i1 = pts.length - 1
      pathFrom(i0, i1)
      ctx.setLineDash([4, 4])
      ctx.strokeStyle = '#000'
      ctx.lineWidth = 3
      ctx.stroke()
      ctx.setLineDash([])
    }
    ctx.lineCap = 'butt'

    // 下一个转向点
    if (m.nav && m.nav.maneuver !== 'arrive') {
      const p = pointAtS(route, m.nav.step.s1)
      const [x, y] = toScreen(p)
      diamond(ctx, x, y, 7, 15)
      diamond(ctx, x, y, 3, 0)
    }
    const [dx, dy] = toScreen(route.destination)
    reticle(ctx, dx, dy, 8, 15)
  }

  // POI 雷达点也画到局部地图上
  ctx.restore()
}

function pointAtS(route: Route, s: number): LngLat {
  const { cum, points } = route
  let i = cum.findIndex((c) => c >= s)
  if (i <= 0) return points[Math.max(0, i)]
  const t = (s - cum[i - 1]) / Math.max(1e-6, cum[i] - cum[i - 1])
  return [points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t, points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t]
}

function mapMpp(m: HudModel): number {
  const sp = m.fix?.speed
  const mode = m.route?.mode
  const base = mode === 'driving' ? 2.2 : mode === 'walking' || !mode ? 0.9 : 1.4
  if (!sp || !Number.isFinite(sp)) return base
  return Math.min(7, Math.max(base, base + sp * 0.18))
}

// ── NAV 主导航 ────────────────────────────────────────────────────

function drawNav(ctx: Ctx, m: HudModel): void {
  const nav = m.nav
  const route = m.route
  if (!nav || !route) return drawCruise(ctx, m)

  // 顶栏
  text(ctx, fmtClock(m.now), 10, 17, { font: font.num(15), level: 12 })
  text(ctx, MODE_LABEL[route.mode], 70, 16, { font: font.cjk(12), level: 7 })
  statusCluster(ctx, 280, 6, m)
  line(ctx, 8, 24, 280, 24, 4)
  for (let x = 8; x <= 280; x += 34) line(ctx, x, 22, x, 26, 6)

  // 转向
  brackets(ctx, 8, 32, 104, 104, 14, 9)
  maneuverIcon(ctx, nav.maneuver, 60, 84, 88)
  const d = fmtDist(nav.distToManeuver)
  numUnit(ctx, d.v, d.u, 122, 86, 44)
  text(ctx, nav.maneuver === 'arrive' ? '到达目的地' : MANEUVER_LABEL[nav.maneuver], 124, 122, { font: font.cjk(22, 700), level: 15, maxWidth: 160 })

  // 进入道路
  text(ctx, '▶', 10, 160, { font: font.cjk(14), level: 9 })
  text(ctx, nextRoadName(m) || '沿当前道路', 30, 161, { font: font.cjk(20, 700), level: 15, maxWidth: 250 })

  // 然后
  if (nav.thenManeuver && nav.nextStep && nav.thenManeuver !== 'straight') {
    maneuverIcon(ctx, nav.thenManeuver, 20, 184, 22, 9)
    text(ctx, `然后 ${MANEUVER_LABEL[nav.thenManeuver]} · ${fmtDistStr(nav.thenDistance ?? 0)}`, 36, 190, { font: font.cjk(14), level: 9, maxWidth: 240 })
  }

  // 进度
  segBar(ctx, 8, 202, 272, 5, nav.progress, 28, 13, 3)

  // 三栏数据
  const cols = [8, 100, 192]
  const labels = ['剩余', '到达', '速度']
  labels.forEach((lb, i) => text(ctx, lb, cols[i], 228, { font: font.cjk(12), level: 7 }))
  const rem = fmtDist(nav.remaining)
  numUnit(ctx, rem.v, rem.u, cols[0], 254, 20)
  const eta = new Date(m.now.getTime() + nav.etaSec * 1000)
  numUnit(ctx, fmtClock(eta), '', cols[1], 254, 20)
  numUnit(ctx, fmtSpeed(m.fix?.speed ?? NaN), 'KM/H', cols[2], 254, 20, { unitSize: 10 })
  const dur = fmtDuration(nav.etaSec)
  text(ctx, `${dur.v} ${dur.u}`, cols[1], 272, { font: font.label(12, 700), level: 7 })
  pageDots(ctx, cols[2], 276, m)

  // 分隔线
  line(ctx, 288, 0, 288, 288, 5)
  for (let y = 12; y < 288; y += 24) line(ctx, 286, y, 290, y, 7)

  // 右侧局部地图
  const heading = displayHeading(m)
  const rect = { x: 290, y: 0, w: 286, h: 288 }
  const cx = 433
  const cy = m.headingUp ? 196 : 150
  drawLocalMap(ctx, m, { rect, cx, cy, mpp: mapMpp(m), rotation: m.headingUp ? heading : 0, rings: true, compass: true })
  chevron(ctx, cx, cy, 12, m.headingUp ? 0 : heading)

  // 航向读数
  const hdg = `${String(Math.round(normDeg(heading))).padStart(3, '0')}° ${compass8(heading)}`
  chamferRect(ctx, cx - 46, 6, 92, 22, 5, 10, 1.5, 0)
  text(ctx, hdg, cx, 22, { font: font.num(13), level: 15, align: 'center' })
  text(ctx, m.headingUp ? 'H-UP' : 'N-UP', 570, 20, { font: font.label(12, 700), level: 7, align: 'right' })
  scaleBar(ctx, 298, 278, mapMpp(m), 60)
}

// ── 全局地图 ──────────────────────────────────────────────────────

function drawOverview(ctx: Ctx, m: HudModel): void {
  const route = m.route
  const me = m.fix?.p
  const rect = { x: 8, y: 34, w: 560, h: 236 }
  brackets(ctx, 4, 30, 568, 248, 16, 7)

  let mpp: number
  let center: LngLat
  const pts: LngLat[] = route ? route.points : m.trip.trail
  if (m.overviewZoom === 'near' || pts.length < 2) {
    center = me ?? pts[0] ?? [116.397, 39.909]
    mpp = 5
  } else {
    const origin = pts[0]
    const proj = new LocalProjector(origin)
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    const all = me ? [...pts, me] : pts
    for (const p of all) {
      const [x, y] = proj.toXY(p)
      minX = Math.min(minX, x); maxX = Math.max(maxX, x)
      minY = Math.min(minY, y); maxY = Math.max(maxY, y)
    }
    const w = Math.max(50, maxX - minX)
    const h = Math.max(50, maxY - minY)
    mpp = Math.max(w / (rect.w - 40), h / (rect.h - 40))
    center = proj.toLngLat((minX + maxX) / 2, (minY + maxY) / 2)
  }
  const proj = new LocalProjector(center)
  const cx = rect.x + rect.w / 2
  const cy = rect.y + rect.h / 2
  const toScreen = (p: LngLat): [number, number] => {
    const [x, y] = proj.toXY(p)
    return [cx + x / mpp, cy - y / mpp]
  }

  ctx.save()
  ctx.beginPath()
  ctx.rect(rect.x, rect.y, rect.w, rect.h)
  ctx.clip()

  // 经纬网格感的背景点阵
  ctx.fillStyle = L(3)
  for (let x = rect.x + 20; x < rect.x + rect.w; x += 40) for (let y = rect.y + 18; y < rect.y + rect.h; y += 40) ctx.fillRect(x - 1, y - 1, 2, 2)

  if (route) {
    const s = m.nav?.s ?? 0
    let split = route.cum.findIndex((c) => c > s)
    if (split < 0) split = route.points.length - 1
    const stroke = (i0: number, i1: number, lw: number, lv: number) => {
      ctx.beginPath()
      for (let i = i0; i <= i1; i++) {
        const [x, y] = toScreen(route.points[i])
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
    stroke(Math.max(0, split - 1), route.points.length - 1, 9, 4)
    stroke(Math.max(0, split - 1), route.points.length - 1, 3, 15)
    ctx.lineCap = 'butt'
    for (const st of route.steps.slice(0, -1)) {
      if (st.maneuver === 'straight') continue
      const [x, y] = toScreen(pointAtS(route, st.s1))
      ctx.fillStyle = st.s1 > s ? L(12) : L(5)
      ctx.fillRect(x - 2, y - 2, 4, 4)
    }
    const [sx, sy] = toScreen(route.origin)
    diamond(ctx, sx, sy, 6, 12, false)
    const [dx, dy] = toScreen(route.destination)
    reticle(ctx, dx, dy, 9, 15)
  } else if (pts.length > 1) {
    ctx.beginPath()
    pts.forEach((p, i) => {
      const [x, y] = toScreen(p)
      if (i) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
    })
    ctx.strokeStyle = L(12)
    ctx.lineWidth = 2
    ctx.stroke()
    const [sx, sy] = toScreen(pts[0])
    diamond(ctx, sx, sy, 6, 12, false)
  }
  if (me) {
    const [ux, uy] = toScreen(me)
    ctx.strokeStyle = L(8)
    ctx.lineWidth = 1
    ctx.beginPath()
    ctx.arc(ux, uy, 16, 0, Math.PI * 2)
    ctx.stroke()
    chevron(ctx, ux, uy, 10, displayHeading(m))
  }
  ctx.restore()

  // 顶部信息
  const title = route ? `OVERVIEW · ${m.overviewZoom === 'near' ? '附近' : '全程'}` : 'TRACK · 轨迹'
  text(ctx, title, 10, 20, { font: font.label(16, 700), level: 13 })
  if (route && m.nav) {
    const rem = fmtDist(m.nav.remaining)
    const dur = fmtDuration(m.nav.etaSec)
    const s = `${rem.v}${rem.u}  ·  ${dur.v}${dur.u}  ·  ${fmtClock(new Date(m.now.getTime() + m.nav.etaSec * 1000))}`
    text(ctx, s, 566, 20, { font: font.num(14), level: 15, align: 'right' })
    text(ctx, route.destName, 300, 20, { font: font.cjk(14), level: 9, align: 'right', maxWidth: 140 })
  } else {
    const d = fmtDist(m.trip.distance)
    text(ctx, `${d.v}${d.u} · ${fmtElapsed(m.trip.elapsedSec)}`, 566, 20, { font: font.num(14), level: 15, align: 'right' })
  }
  scaleBar(ctx, 16, 264, mpp, 90)
  text(ctx, '单击切换 全程/附近', 562, 268, { font: font.cjk(12), level: 6, align: 'right' })
  pageDots(ctx, 230, 282, m)
}

// ── 路书 ──────────────────────────────────────────────────────────

function drawRoadbook(ctx: Ctx, m: HudModel): void {
  const route = m.route
  const nav = m.nav
  text(ctx, 'ROADBOOK', 10, 20, { font: font.label(17, 700), level: 13 })
  text(ctx, '路书', 104, 19, { font: font.cjk(14), level: 8 })
  if (!route || !nav) return
  const first = Math.min(route.steps.length - 1, nav.stepIndex + m.roadbookOffset)
  text(ctx, `STEP ${first + 1}/${route.steps.length}`, 566, 20, { font: font.num(13), level: 10, align: 'right' })
  line(ctx, 8, 28, 568, 28, 4)
  const rows = route.steps.slice(first, first + 4)
  rows.forEach((st, i) => {
    const y = 34 + i * 60
    const current = st.index === nav.stepIndex
    if (current) brackets(ctx, 4, y, 568, 56, 10, 12)
    const lv = current ? 15 : 8
    maneuverIcon(ctx, st.maneuver, 36, y + 28, 40, lv)
    const dist = Math.max(0, st.s1 - nav.s)
    const d = fmtDist(dist)
    numUnit(ctx, d.v, d.u, 66, y + 36, 22, { level: lv, unitLevel: current ? 10 : 6 })
    const label = st.maneuver === 'arrive' ? '到达目的地' : MANEUVER_LABEL[st.maneuver]
    text(ctx, label, 186, y + 24, { font: font.cjk(16, 700), level: lv })
    const next = route.steps[st.index + 1]
    const road = st.maneuver === 'arrive' ? route.destName : next?.road || st.instruction
    text(ctx, road, 186, y + 46, { font: font.cjk(15), level: current ? 12 : 6, maxWidth: 376 })
  })
  pageDots(ctx, 230, 282, m)
  text(ctx, '单击翻页', 562, 282, { font: font.cjk(11), level: 6, align: 'right' })
}

// ── 遥测仪表 ──────────────────────────────────────────────────────

function drawTelemetry(ctx: Ctx, m: HudModel): void {
  const speed = kmh(m.fix?.speed ?? NaN)
  const mode = m.route?.mode
  const max = mode === 'driving' ? 140 : mode === 'electrobike' ? 40 : mode === 'bicycling' ? 40 : 12
  const cx = 146
  const cy = 156
  const r = 112
  const a0 = (135 * Math.PI) / 180
  const sweep = (270 * Math.PI) / 180
  ctx.lineCap = 'butt'
  ctx.strokeStyle = L(3)
  ctx.lineWidth = 12
  ctx.beginPath()
  ctx.arc(cx, cy, r, a0, a0 + sweep)
  ctx.stroke()
  const v = Number.isFinite(speed) ? Math.min(1, speed / max) : 0
  // 分段填充
  const segs = 36
  for (let i = 0; i < segs * v; i++) {
    const s0 = a0 + (sweep * i) / segs
    ctx.strokeStyle = L(i > segs * 0.85 ? 15 : 12)
    ctx.beginPath()
    ctx.arc(cx, cy, r, s0 + 0.01, s0 + sweep / segs - 0.02)
    ctx.stroke()
  }
  for (let i = 0; i <= 6; i++) {
    const a = a0 + (sweep * i) / 6
    line(ctx, cx + Math.cos(a) * (r - 14), cy + Math.sin(a) * (r - 14), cx + Math.cos(a) * (r - 24), cy + Math.sin(a) * (r - 24), 9, 2)
    text(ctx, String(Math.round((max * i) / 6)), cx + Math.cos(a) * (r - 36), cy + Math.sin(a) * (r - 36) + 4, { font: font.label(12, 700), level: 7, align: 'center' })
  }
  text(ctx, fmtSpeed(m.fix?.speed ?? NaN), cx, cy + 14, { font: font.num(50, 800), level: 15, align: 'center' })
  text(ctx, 'KM/H', cx, cy + 38, { font: font.label(14, 700), level: 9, align: 'center' })
  text(ctx, `MAX ${fmtSpeed(m.trip.maxSpeed)}`, cx, cy + 92, { font: font.num(12), level: 8, align: 'center' })

  const t = m.trip
  const heading = displayHeading(m)
  const cells: [string, string, string][] = [
    ['行程 DIST', fmtDist(t.distance).v, fmtDist(t.distance).u],
    ['用时 TIME', fmtElapsed(t.elapsedSec), ''],
    ['均速 AVG', fmtSpeed(t.avgSpeed), 'KM/H'],
    ['海拔 ALT', Number.isFinite(m.fix?.altitude ?? NaN) ? String(Math.round(m.fix!.altitude)) : '--', 'M'],
    ['航向 HDG', `${String(Math.round(normDeg(heading))).padStart(3, '0')}°`, compass8(heading)],
    ['爬升 CLIMB', String(Math.round(t.climb)), 'M'],
  ]
  cells.forEach(([lb, val, unit], i) => {
    const x = 300 + (i % 2) * 138
    const y = 10 + Math.floor(i / 2) * 82
    chamferRect(ctx, x, y, 130, 72, 8, 5, 1)
    text(ctx, lb, x + 10, y + 20, { font: font.cjk(12), level: 8 })
    numUnit(ctx, val, unit, x + 10, y + 54, 22, { unitSize: 11 })
  })
  const foot = [
    m.fix ? `GPS ±${Math.round(m.fix.accuracy)}m` : 'GPS --',
    m.glasses.battery !== undefined ? `眼镜 ${m.glasses.battery}%` : '',
    m.weather ? `${m.weather.temperature}°C ${m.weather.text}` : '',
  ].filter(Boolean).join('   ')
  text(ctx, foot, 300, 270, { font: font.cjk(12), level: 8, maxWidth: 270 })
  pageDots(ctx, 10, 282, m)
}

// ── 周边雷达 ──────────────────────────────────────────────────────

function drawRadar(ctx: Ctx, m: HudModel): void {
  const cx = 142
  const cy = 148
  const R = 122
  const heading = displayHeading(m)
  const me = m.fix?.p
  const pois = m.radar.pois
  let range = 250
  for (const p of pois.slice(0, 8)) {
    const d = me ? haversine(me, p.location) : p.distance ?? 0
    while (d > range && range < 2000) range *= 2
  }
  // 环与十字
  for (let i = 1; i <= 3; i++) {
    ctx.strokeStyle = L(i === 3 ? 7 : 4)
    ctx.lineWidth = i === 3 ? 2 : 1
    ctx.beginPath()
    ctx.arc(cx, cy, (R * i) / 3, 0, Math.PI * 2)
    ctx.stroke()
  }
  line(ctx, cx - R, cy, cx + R, cy, 4)
  line(ctx, cx, cy - R, cx, cy + R, 4)
  text(ctx, fmtDistStr(range), cx + 4, cy - R + 14, { font: font.label(11, 700), level: 7 })
  // 扫描线
  const sweep = ((m.t / 1000) * 90) % 360
  for (let k = 0; k < 8; k++) {
    const a = ((sweep - k * 5) * Math.PI) / 180
    line(ctx, cx, cy, cx + Math.sin(a) * R, cy - Math.cos(a) * R, 12 - k * 1.4, k === 0 ? 2 : 1.5)
  }
  // 北
  const na = (-heading * Math.PI) / 180
  text(ctx, 'N', cx + Math.sin(na) * (R + 0) , cy - Math.cos(na) * (R + 0) + 5, { font: font.num(13, 900), level: 15, align: 'center' })
  chevron(ctx, cx, cy, 8, 0)

  const list = pois.slice(0, 5)
  list.forEach((p, i) => {
    if (!me) return
    const d = haversine(me, p.location)
    const b = angleDiff(heading, bearing(me, p.location))
    const rr = Math.min(1, d / range) * R
    const a = (b * Math.PI) / 180
    const x = cx + Math.sin(a) * rr
    const y = cy - Math.cos(a) * rr
    ctx.fillStyle = L(15)
    ctx.fillRect(x - 4, y - 4, 8, 8)
    text(ctx, String(i + 1), x + 7, y - 5, { font: font.num(11), level: 13 })
  })

  // 右侧列表
  const cat = RADAR_CATEGORIES[m.radar.category]
  text(ctx, `RADAR · ${cat.short}`, 290, 22, { font: font.label(17, 700), level: 13 })
  text(ctx, cat.name, 566, 22, { font: font.cjk(15), level: 11, align: 'right' })
  line(ctx, 290, 30, 568, 30, 4)
  if (m.radar.loading) {
    text(ctx, '扫描中…', 290, 70, { font: font.cjk(18), level: 12 })
  } else if (m.radar.error) {
    text(ctx, m.radar.error, 290, 70, { font: font.cjk(15), level: 12, maxWidth: 276 })
  } else if (!list.length) {
    text(ctx, m.radar.fetchedAt ? '附近未找到' : '单击开始扫描', 290, 70, { font: font.cjk(18), level: 10 })
  }
  list.forEach((p, i) => {
    const y = 40 + i * 46
    const d = me ? haversine(me, p.location) : p.distance ?? NaN
    chamferRect(ctx, 290, y + 6, 22, 22, 4, 10, 1.5)
    text(ctx, String(i + 1), 301, y + 23, { font: font.num(13), level: 15, align: 'center' })
    text(ctx, p.name, 320, y + 23, { font: font.cjk(16, 700), level: 15, maxWidth: 170 })
    if (me) {
      const b = angleDiff(heading, bearing(me, p.location))
      chevron(ctx, 556, y + 17, 7, b, 12)
    }
    text(ctx, fmtDistStr(d), 544, y + 23, { font: font.num(13), level: 12, align: 'right' })
    if (p.address) text(ctx, p.address, 320, y + 41, { font: font.cjk(11), level: 6, maxWidth: 240 })
  })
  pageDots(ctx, 290, 282, m)
  text(ctx, '单击换类别', 566, 282, { font: font.cjk(11), level: 6, align: 'right' })
}

// ── 巡航（无路线）─────────────────────────────────────────────────

function headingTape(ctx: Ctx, heading: number, y: number): void {
  const cx = SCREEN_W / 2
  const ppd = 4
  ctx.save()
  ctx.beginPath()
  ctx.rect(16, y, SCREEN_W - 32, 40)
  ctx.clip()
  const start = Math.floor((heading - 75) / 5) * 5
  for (let a = start; a <= heading + 75; a += 5) {
    const x = cx + angleDiff(heading, a) * ppd
    const n = normDeg(a)
    const major = n % 15 === 0
    line(ctx, x, y + 26, x, y + (major ? 14 : 20), major ? 10 : 5, major ? 2 : 1)
    if (n % 45 === 0) text(ctx, compass8(n), x, y + 11, { font: font.num(12, 900), level: n === 0 ? 15 : 12, align: 'center' })
    else if (major) text(ctx, String(n), x, y + 11, { font: font.label(11, 700), level: 7, align: 'center' })
  }
  ctx.restore()
  line(ctx, 16, y + 27, SCREEN_W - 16, y + 27, 6)
  ctx.fillStyle = L(15)
  ctx.beginPath()
  ctx.moveTo(cx, y + 28)
  ctx.lineTo(cx - 7, y + 38)
  ctx.lineTo(cx + 7, y + 38)
  ctx.closePath()
  ctx.fill()
}

function drawCruise(ctx: Ctx, m: HudModel): void {
  const heading = displayHeading(m)
  headingTape(ctx, heading, 2)
  chamferRect(ctx, SCREEN_W / 2 - 34, 44, 68, 22, 5, 10, 1.5, 0)
  text(ctx, `${String(Math.round(normDeg(heading))).padStart(3, '0')}°`, SCREEN_W / 2, 60, { font: font.num(14), level: 15, align: 'center' })

  text(ctx, 'SPEED', 24, 86, { font: font.label(13, 700), level: 7 })
  numUnit(ctx, fmtSpeed(m.fix?.speed ?? NaN), 'KM/H', 24, 136, 46, { unitSize: 14 })

  text(ctx, fmtClock(m.now), 552, 126, { font: font.num(40, 800), level: 15, align: 'right' })
  const w = m.weather
  if (w) text(ctx, `${w.temperature}°C  ${w.text}`, 552, 152, { font: font.cjk(16), level: 10, align: 'right' })

  brackets(ctx, 14, 166, 548, 66, 12, 7)
  if (m.place) {
    text(ctx, m.place.street || m.place.address, 28, 198, { font: font.cjk(24, 700), level: 15, maxWidth: 520 })
    text(ctx, [m.place.city, m.place.district].filter(Boolean).join(' · '), 28, 222, { font: font.cjk(14), level: 8, maxWidth: 520 })
  } else {
    text(ctx, m.fix ? '定位中…' : m.hasKey ? '等待定位信号' : '请在手机端填写高德 Key', 28, 206, { font: font.cjk(20), level: 11 })
  }

  // 返航指示
  const start = m.trip.start
  if (m.fix && start && haversine(m.fix.p, start) > 30) {
    const b = angleDiff(heading, bearing(m.fix.p, start))
    chevron(ctx, 34, 258, 10, b, 13)
    text(ctx, `起点 ${fmtDistStr(haversine(m.fix.p, start))}`, 54, 264, { font: font.cjk(15), level: 12 })
  }
  text(ctx, '单击后长按：菜单  ·  手机端选择目的地', 562, 264, { font: font.cjk(12), level: 6, align: 'right' })
  pageDots(ctx, 230, 282, m)
}

// ── 到达 ──────────────────────────────────────────────────────────

function drawArrival(ctx: Ctx, m: HudModel): void {
  const cx = 130
  const cy = 144
  const pulse = (m.t / 1000) % 2
  for (let i = 0; i < 3; i++) {
    const r = 30 + ((pulse * 30 + i * 30) % 90)
    ctx.strokeStyle = L(15 - r / 9)
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.arc(cx, cy, r, 0, Math.PI * 2)
    ctx.stroke()
  }
  maneuverIcon(ctx, 'arrive', cx, cy, 70)
  const a = m.arrival
  text(ctx, 'ARRIVED', 250, 70, { font: font.num(30, 900), level: 15 })
  text(ctx, a?.name ?? '目的地', 250, 104, { font: font.cjk(22, 700), level: 13, maxWidth: 310 })
  if (a) {
    const rows: [string, string][] = [
      ['用时', fmtElapsed(a.elapsed)],
      ['距离', fmtDistStr(a.distance)],
      ['均速', `${fmtSpeed(a.avg)} km/h`],
    ]
    rows.forEach(([k, v], i) => {
      text(ctx, k, 250, 146 + i * 34, { font: font.cjk(14), level: 8 })
      text(ctx, v, 300, 147 + i * 34, { font: font.num(18), level: 15 })
    })
  }
  text(ctx, '单击返回巡航', 562, 278, { font: font.cjk(12), level: 6, align: 'right' })
}

// ── 专注模式：远离转向时几乎全黑，只留一个小角标 ────────────────────

function drawFocus(ctx: Ctx, m: HudModel): void {
  const nav = m.nav
  if (!nav) return
  maneuverIcon(ctx, nav.maneuver, 24, 22, 32, 11)
  // 按 50m 取整，减少刷新
  const dist = nav.distToManeuver >= 1000 ? nav.distToManeuver : Math.round(nav.distToManeuver / 50) * 50
  const d = fmtDist(dist)
  numUnit(ctx, d.v, d.u, 48, 30, 18, { level: 11, unitLevel: 7 })
  ctx.font = font.cjk(14)
  text(ctx, ellipsize(ctx, nextRoadName(m), 180), 48, 50, { font: font.cjk(14), level: 7 })
}
