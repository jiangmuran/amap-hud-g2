// 模板页：页面结构（原生文本控件 + 少量小图片）只建一次，之后只发送变化的内容。
// 原生文本由眼镜固件渲染：字号固定（约 18px，行高约 24–27px），只有 0–4 五档亮度，
// 字符集有限（箭头 ↑↗→↘↓↙←↖、★☆、━─、●○、· ¥ ° 可用，emoji 不可用）。
// 图片只用在变化很少的地方（转向箭头、罗盘、雷达、方向指针），并对角度做量化，避免频繁重发。

import type { TemplateSpec } from '../glasses/display'
import { createCanvas } from '../glasses/display'
import { angleDiff, bearing, compass8, haversine, LocalProjector, normDeg, type LngLat } from '../geo'
import { MANEUVER_LABEL, MODE_LABEL, type Maneuver } from '../nav/route'
import { brackets, chevron, diamond, L, maneuverIcon, pointer, reticle, type Ctx } from './gfx'
import { fmtClock, fmtDistStr, fmtDurationZh, fmtSpeed } from './format'
import { displayHeading, QUICK_TAG_LABEL, RADAR_CATEGORIES, VIEW_LABEL, type HudModel, type ViewId } from './model'

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

function pageDots(m: HudModel): string {
  let s = ''
  for (let i = 0; i < m.viewCount; i++) s += i === m.viewIndex ? '●' : '○'
  return `${s}  ${VIEW_LABEL[m.view === 'focus' ? 'nav' : m.view]}`
}

function statusLine(m: HudModel, extra = ''): string {
  if (m.toast) return `※ ${m.toast}`
  const bat = m.glasses.battery !== undefined ? `  ·  眼镜 ${m.glasses.battery}%` : ''
  return `${fmtClock(m.now)}${bat}${extra}     ${pageDots(m)}`
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

// ── 页面结构 ──────────────────────────────────────────────────────
// 每页最多 4 张图片、7 个文本（另有 1 个全屏透明文本负责接收输入）。

export const TEMPLATES: Partial<Record<ViewId, TemplateSpec>> = {
  nav: {
    key: 'nav',
    images: [{ name: 'arrow', x: 4, y: 4, w: 136, h: 136 }],
    texts: [
      { name: 'main', x: 152, y: 8, w: 420, h: 62, color: 4 },
      { name: 'then', x: 152, y: 76, w: 420, h: 34, color: 2 },
      { name: 'prog', x: 152, y: 110, w: 420, h: 32, color: 3 },
      { name: 'stats', x: 4, y: 150, w: 568, h: 92, color: 4, border: 1, padding: 8 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
    ],
  },
  cruise: {
    key: 'cruise',
    images: [{ name: 'compass', x: 4, y: 4, w: 136, h: 136 }],
    texts: [
      { name: 'title', x: 152, y: 8, w: 420, h: 32, color: 2 },
      { name: 'place', x: 152, y: 42, w: 420, h: 62, color: 4 },
      { name: 'heading', x: 152, y: 108, w: 420, h: 32, color: 3 },
      { name: 'stats', x: 4, y: 150, w: 568, h: 92, color: 4, border: 1, padding: 8 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
    ],
  },
  telemetry: {
    key: 'telemetry',
    images: [],
    texts: [
      { name: 'c0', x: 4, y: 4, w: 186, h: 76, color: 4, border: 1, padding: 8 },
      { name: 'c1', x: 195, y: 4, w: 186, h: 76, color: 4, border: 1, padding: 8 },
      { name: 'c2', x: 386, y: 4, w: 186, h: 76, color: 4, border: 1, padding: 8 },
      { name: 'c3', x: 4, y: 86, w: 186, h: 76, color: 4, border: 1, padding: 8 },
      { name: 'c4', x: 195, y: 86, w: 186, h: 76, color: 4, border: 1, padding: 8 },
      { name: 'c5', x: 386, y: 86, w: 186, h: 76, color: 4, border: 1, padding: 8 },
      { name: 'status', x: 4, y: 176, w: 568, h: 110, color: 2, padding: 4 },
    ],
  },
  roadbook: {
    key: 'roadbook',
    images: [],
    texts: [
      { name: 'title', x: 4, y: 4, w: 568, h: 32, color: 2 },
      { name: 'cur', x: 4, y: 40, w: 568, h: 48, color: 4, border: 1, padding: 8 },
      { name: 'rest', x: 4, y: 96, w: 568, h: 150, color: 3, padding: 8 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
    ],
  },
  go: {
    key: 'go',
    images: [],
    texts: [
      { name: 'title', x: 4, y: 4, w: 568, h: 32, color: 2 },
      { name: 'list', x: 4, y: 40, w: 568, h: 208, color: 4, border: 1, padding: 8 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
    ],
  },
  radar: {
    key: 'radar',
    images: [{ name: 'radar', x: 4, y: 4, w: 140, h: 140 }],
    texts: [
      { name: 'title', x: 152, y: 8, w: 420, h: 32, color: 2 },
      { name: 'top', x: 152, y: 42, w: 420, h: 100, color: 4 },
      { name: 'list', x: 4, y: 150, w: 568, h: 98, color: 3, border: 1, padding: 6 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
    ],
  },
  poi: {
    key: 'poi',
    images: [{ name: 'dir', x: 436, y: 8, w: 136, h: 136 }],
    texts: [
      { name: 'info', x: 4, y: 4, w: 424, h: 150, color: 4 },
      { name: 'dist', x: 436, y: 148, w: 136, h: 32, color: 4 },
      { name: 'addr', x: 4, y: 158, w: 424, h: 90, color: 2, border: 1, padding: 8 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
    ],
  },
  overview: {
    key: 'overview',
    images: [
      { name: 'mapTop', x: 0, y: 0, w: 288, h: 144 },
      { name: 'mapBottom', x: 0, y: 144, w: 288, h: 144 },
    ],
    texts: [
      { name: 'title', x: 296, y: 8, w: 276, h: 32, color: 2 },
      { name: 'dest', x: 296, y: 42, w: 276, h: 60, color: 4 },
      { name: 'stats', x: 296, y: 104, w: 276, h: 114, color: 4, border: 1, padding: 8 },
      { name: 'status', x: 296, y: 224, w: 276, h: 62, color: 1 },
    ],
  },
  arrival: {
    key: 'arrival',
    images: [{ name: 'reticle', x: 4, y: 4, w: 136, h: 136 }],
    texts: [
      { name: 'title', x: 152, y: 8, w: 420, h: 62, color: 4 },
      { name: 'stats', x: 4, y: 150, w: 568, h: 92, color: 4, border: 1, padding: 8 },
      { name: 'status', x: 4, y: 254, w: 568, h: 32, color: 1 },
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
  const arrowKey = `${nav.maneuver}|${focus}`
  return {
    texts: {
      main: `${fmtDistStr(nav.distToManeuver)}  ${act}\n${road ? '进入 ' + road : '沿当前道路'}`,
      then: focus ? ' ' : then,
      prog: focus ? ' ' : `${bar(nav.progress, 18)}  ${Math.round(nav.progress * 100)}%`,
      stats: focus
        ? ' '
        : `剩余  ${fmtDistStr(nav.remaining)}     ${fmtDurationZh(nav.etaSec)}     到达  ${eta}\n${MODE_LABEL[route.mode]}  ·  ${fmtSpeed(m.fix?.speed ?? NaN)} km/h  ·  ${route.destName}`,
      status: statusLine(m, m.simulated ? '  ·  模拟' : ''),
    },
    images: {
      arrow: img('arrow', 136, 136, arrowKey, (ctx) => {
        brackets(ctx, 2, 2, 132, 132, 16, 9)
        maneuverIcon(ctx, nav.maneuver, 68, 70, focus ? 70 : 104)
      }),
    },
  }
}

function cruiseFrame(m: HudModel): TemplateFrame {
  const heading = displayHeading(m)
  const hq = Math.round(normDeg(heading) / 15) * 15 // 罗盘按 15° 量化，转身时才重发
  const w = m.weather ? `   ${m.weather.temperature}°C ${m.weather.text}` : ''
  const place = m.place
    ? `${m.place.street || m.place.address}\n${[m.place.city, m.place.district].filter(Boolean).join(' · ')}`
    : m.fix ? '定位中…' : m.hasKey ? '等待定位信号' : '请在手机端填写高德 Key'
  let home = ' '
  const start = m.trip.start
  if (m.fix && start && haversine(m.fix.p, start) > 30) {
    home = `${dirGlyph(angleDiff(heading, bearing(m.fix.p, start)))} 起点 ${fmtDistStr(haversine(m.fix.p, start))}`
  }
  const alt = Number.isFinite(m.fix?.altitude ?? NaN) ? `  ·  海拔 ${Math.round(m.fix!.altitude)} m` : ''
  return {
    texts: {
      title: `巡航  ·  ${fmtClock(m.now)}${w}`,
      place,
      heading: `航向  ${compass8(heading, true)} ${String(Math.round(normDeg(heading) / 5) * 5).padStart(3, '0')}°`,
      stats: `速度  ${fmtSpeed(m.fix?.speed ?? NaN)} km/h${alt}\n${home === ' ' ? '单击后长按打开菜单 · 在手机上选择目的地' : home}`,
      status: statusLine(m),
    },
    images: {
      compass: img('compass', 136, 136, String(hq), (ctx) => {
        const cx = 68, cy = 68, r = 60
        ctx.strokeStyle = L(6)
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.arc(cx, cy, r, 0, Math.PI * 2)
        ctx.stroke()
        for (let a = 0; a < 360; a += 30) {
          const t = ((a - hq) * Math.PI) / 180
          const major = a % 90 === 0
          ctx.strokeStyle = L(major ? 13 : 6)
          ctx.lineWidth = major ? 3 : 2
          ctx.beginPath()
          ctx.moveTo(cx + Math.sin(t) * (r - (major ? 14 : 8)), cy - Math.cos(t) * (r - (major ? 14 : 8)))
          ctx.lineTo(cx + Math.sin(t) * r, cy - Math.cos(t) * r)
          ctx.stroke()
        }
        const nt = (-hq * Math.PI) / 180
        ctx.fillStyle = L(15)
        ctx.font = '900 16px Orbitron, sans-serif'
        ctx.textAlign = 'center'
        ctx.textBaseline = 'middle'
        ctx.fillText('N', cx + Math.sin(nt) * (r - 26), cy - Math.cos(nt) * (r - 26))
        pointer(ctx, cx, cy + 4, 22, 0, 15)
      }),
    },
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
    ['航向', `${compass8(heading, true)} ${Math.round(normDeg(heading) / 5) * 5}°`],
  ]
  const texts: Record<string, string> = {}
  cells.forEach(([k, v], i) => (texts[`c${i}`] = `${k}\n${v}`))
  const foot = [`海拔 ${alt}`, `爬升 ${Math.round(t.climb)} m`, m.fix ? `GPS ±${Math.round(m.fix.accuracy / 5) * 5} m` : 'GPS --', m.weather ? `${m.weather.temperature}°C ${m.weather.text}` : '']
    .filter(Boolean).join('  ·  ')
  texts.status = `${foot}\n\n${statusLine(m)}`
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
      title: '前往  ·  快捷目的地      单击选择',
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
      radar: img('radar', 140, 140, JSON.stringify([hq, range, blips]), (ctx) => {
        const cx = 70, cy = 70, R = 64
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
      stats: a ? `用时  ${fmtDurationZh(a.elapsed)}     距离  ${fmtDistStr(a.distance)}\n均速  ${fmtSpeed(a.avg)} km/h` : ' ',
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
  if (v === 'overview' && m.route) return { spec: TEMPLATES.overview!, frame: overviewFrame(m) }
  return null
}
