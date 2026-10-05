// 路线模型：把高德 v5 路径规划结果整理成导航用的结构
// （整条折线 + 累计里程 + 带起止里程的分段 + 归一化的转向类型）。

import { angleDiff, bearing, haversine, parsePolyline, type LngLat } from '../geo'

export type TravelMode = 'walking' | 'bicycling' | 'electrobike' | 'driving'

export const MODE_LABEL: Record<TravelMode, string> = {
  walking: '步行',
  bicycling: '骑行',
  electrobike: '电动车',
  driving: '驾车',
}

export type Maneuver =
  | 'depart'
  | 'straight'
  | 'slight-left'
  | 'left'
  | 'sharp-left'
  | 'slight-right'
  | 'right'
  | 'sharp-right'
  | 'keep-left'
  | 'keep-right'
  | 'uturn-left'
  | 'uturn-right'
  | 'roundabout'
  | 'arrive'

export const MANEUVER_LABEL: Record<Maneuver, string> = {
  depart: '出发',
  straight: '直行',
  'slight-left': '向左前方',
  left: '左转',
  'sharp-left': '向左后方',
  'slight-right': '向右前方',
  right: '右转',
  'sharp-right': '向右后方',
  'keep-left': '靠左',
  'keep-right': '靠右',
  'uturn-left': '掉头',
  'uturn-right': '掉头',
  roundabout: '环岛',
  arrive: '到达',
}

export interface Step {
  index: number
  instruction: string
  road: string
  distance: number
  duration: number
  /** 本段结束处要做的动作（高德 navi.action / assistant_action） */
  action: string
  assistant: string
  maneuver: Maneuver
  /** 在整条路线上的起止里程（米） */
  s0: number
  s1: number
}

export interface TrafficSpan {
  s0: number
  s1: number
  /** 未知/畅通/缓行/拥堵/严重拥堵 */
  status: string
}

export interface Route {
  mode: TravelMode
  destName: string
  origin: LngLat
  destination: LngLat
  points: LngLat[]
  /** points[i] 处的累计里程 */
  cum: number[]
  steps: Step[]
  distance: number
  duration: number
  tolls?: number
  lights?: number
  traffic: TrafficSpan[]
  createdAt: number
}

export function maneuverFromAction(action: string, assistant: string): Maneuver | null {
  const a = action || ''
  if (/到达目的地|到达终点/.test(assistant) || /到达目的地/.test(a)) return 'arrive'
  if (/环岛/.test(a)) return 'roundabout'
  if (/调头|掉头/.test(a)) return /右/.test(a) ? 'uturn-right' : 'uturn-left'
  if (/左后/.test(a)) return 'sharp-left'
  if (/右后/.test(a)) return 'sharp-right'
  if (/左前/.test(a)) return 'slight-left'
  if (/右前/.test(a)) return 'slight-right'
  if (/左转/.test(a)) return 'left'
  if (/右转/.test(a)) return 'right'
  if (/靠左/.test(a)) return 'keep-left'
  if (/靠右/.test(a)) return 'keep-right'
  if (/直行/.test(a)) return 'straight'
  return null
}

/** 无动作字段时，用几何夹角兜底判断转向 */
export function maneuverFromAngle(turn: number): Maneuver {
  const t = Math.abs(turn)
  const right = turn > 0
  if (t < 25) return 'straight'
  if (t < 60) return right ? 'slight-right' : 'slight-left'
  if (t < 120) return right ? 'right' : 'left'
  if (t < 165) return right ? 'sharp-right' : 'sharp-left'
  return right ? 'uturn-right' : 'uturn-left'
}

function num(v: unknown, fallback = 0): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** 在折线 pts 上从 idx 处，取前后各 ~len 米的点，计算转角 */
function turnAngleAt(pts: LngLat[], idx: number, len = 20): number | null {
  if (idx <= 0 || idx >= pts.length - 1) return null
  let i = idx - 1
  let acc = 0
  while (i > 0 && acc < len) {
    acc += haversine(pts[i], pts[i + 1])
    i--
  }
  let j = idx + 1
  acc = 0
  while (j < pts.length - 1 && acc < len) {
    acc += haversine(pts[j - 1], pts[j])
    j++
  }
  if (haversine(pts[i], pts[idx]) < 1 || haversine(pts[idx], pts[j]) < 1) return null
  return angleDiff(bearing(pts[i], pts[idx]), bearing(pts[idx], pts[j]))
}

/** 解析高德 v5 路径规划响应（四种出行方式结构基本一致，做防御性解析） */
export function parseRoute(json: any, mode: TravelMode, destName: string, pathIndex = 0): Route {
  const container = json?.route ?? json?.data ?? json
  const paths: any[] = container?.paths ?? []
  const path = paths[pathIndex] ?? paths[0]
  if (!path) throw new Error('路线结果为空')

  const rawSteps: any[] = Array.isArray(path.steps) ? path.steps : []
  const points: LngLat[] = []
  const stepEndIdx: number[] = []
  const stepStartIdx: number[] = []

  for (const st of rawSteps) {
    const pl = typeof st.polyline === 'object' && st.polyline ? st.polyline.polyline : st.polyline
    const pts = parsePolyline(str(pl))
    stepStartIdx.push(Math.max(0, points.length - 1))
    for (const p of pts) {
      const last = points[points.length - 1]
      if (last && Math.abs(last[0] - p[0]) < 1e-7 && Math.abs(last[1] - p[1]) < 1e-7) continue
      points.push(p)
    }
    stepEndIdx.push(points.length - 1)
  }

  const origin: LngLat = points[0] ?? [0, 0]
  const destination: LngLat = points[points.length - 1] ?? origin
  if (points.length < 2) throw new Error('路线几何为空')

  const cum: number[] = [0]
  for (let i = 1; i < points.length; i++) cum.push(cum[i - 1] + haversine(points[i - 1], points[i]))
  const geomTotal = cum[cum.length - 1]

  const pathDistance = num(path.distance, geomTotal)
  const pathDuration = num(path.cost?.duration ?? path.duration, 0)

  const steps: Step[] = rawSteps.map((st, i) => {
    const s0 = cum[stepStartIdx[i]] ?? 0
    const s1 = cum[stepEndIdx[i]] ?? s0
    const action = str(st.navi?.action) || str(st.action)
    const assistant = str(st.navi?.assistant_action) || str(st.assistant_action)
    const dist = num(st.step_distance ?? st.distance, s1 - s0)
    let dur = num(st.cost?.duration ?? st.duration, NaN)
    if (!Number.isFinite(dur)) dur = pathDistance > 0 ? (pathDuration * dist) / pathDistance : 0
    let maneuver = maneuverFromAction(action, assistant)
    if (!maneuver) {
      const ang = i < rawSteps.length - 1 ? turnAngleAt(points, stepEndIdx[i]) : null
      maneuver = ang === null ? 'straight' : maneuverFromAngle(ang)
    }
    if (i === rawSteps.length - 1) maneuver = 'arrive'
    return {
      index: i,
      instruction: str(st.instruction),
      road: str(st.road_name) || str(st.road),
      distance: dist,
      duration: dur,
      action,
      assistant,
      maneuver,
      s0,
      s1,
    }
  })

  // 驾车路况：tmcs 每段有 tmc_status / tmc_distance，依次铺在 step 上
  const traffic: TrafficSpan[] = []
  if (mode === 'driving') {
    rawSteps.forEach((st, i) => {
      const tmcs: any[] = Array.isArray(st.tmcs) ? st.tmcs : []
      let s = steps[i].s0
      const scale = steps[i].distance > 0 ? (steps[i].s1 - steps[i].s0) / steps[i].distance : 1
      for (const t of tmcs) {
        const d = num(t.tmc_distance) * scale
        traffic.push({ s0: s, s1: s + d, status: str(t.tmc_status) })
        s += d
      }
    })
  }

  return {
    mode,
    destName,
    origin,
    destination,
    points,
    cum,
    steps,
    distance: geomTotal,
    duration: pathDuration || steps.reduce((a, s) => a + s.duration, 0),
    tolls: path.cost?.tolls !== undefined ? num(path.cost.tolls) : undefined,
    lights: path.cost?.traffic_lights !== undefined ? num(path.cost.traffic_lights) : undefined,
    traffic,
    createdAt: Date.now(),
  }
}

/** 已走过的里程 s 之后，剩余计划耗时（秒） */
export function remainingPlannedDuration(route: Route, s: number): number {
  let total = 0
  for (const st of route.steps) {
    if (st.s1 <= s) continue
    const len = Math.max(1, st.s1 - st.s0)
    const frac = st.s0 >= s ? 1 : (st.s1 - s) / len
    total += st.duration * frac
  }
  return total
}

/** 在路线上里程 s 处的坐标与方向 */
export function pointAt(route: Route, s: number): { p: LngLat; heading: number; index: number } {
  const { points, cum } = route
  if (s <= 0) return { p: points[0], heading: bearing(points[0], points[1]), index: 0 }
  let lo = 0
  let hi = cum.length - 1
  if (s >= cum[hi]) return { p: points[hi], heading: bearing(points[hi - 1], points[hi]), index: hi - 1 }
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (cum[mid] <= s) lo = mid
    else hi = mid
  }
  const seg = cum[hi] - cum[lo]
  const t = seg > 0 ? (s - cum[lo]) / seg : 0
  const a = points[lo]
  const b = points[hi]
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], heading: bearing(a, b), index: lo }
}
