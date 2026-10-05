// 路线跟踪：把定位点吸附到路线上，计算进度、下一个转向、剩余里程/时间、偏航与到达。

import { angleDiff, haversine, LocalProjector, projectToSegment, type LngLat } from '../geo'
import { remainingPlannedDuration, type Maneuver, type Route, type Step, type TravelMode } from './route'

export interface Fix {
  /** GCJ-02 */
  p: LngLat
  accuracy: number
  /** m/s，NaN 表示未知 */
  speed: number
  /** 度，NaN 表示未知 */
  heading: number
  altitude: number
  t: number
}

export interface NavState {
  matched: LngLat
  /** 已行驶里程（沿路线） */
  s: number
  /** 偏离路线的距离 */
  offset: number
  /** 当前所在分段 */
  stepIndex: number
  step: Step
  /** 当前分段结束处的转向 */
  maneuver: Maneuver
  distToManeuver: number
  /** 转向后进入的分段 */
  nextStep?: Step
  /** 再下一个转向（"然后…"） */
  thenManeuver?: Maneuver
  thenDistance?: number
  remaining: number
  etaSec: number
  progress: number
  offRoute: boolean
  arrived: boolean
  /** 路线在匹配点处的方向 */
  routeHeading: number
}

const OFF_ROUTE_THRESHOLD: Record<TravelMode, number> = {
  walking: 35,
  bicycling: 40,
  electrobike: 40,
  driving: 60,
}

const ARRIVE_THRESHOLD: Record<TravelMode, number> = {
  walking: 20,
  bicycling: 25,
  electrobike: 25,
  driving: 40,
}

export class RouteTracker {
  private proj: LocalProjector
  private xy: [number, number][]
  private segBearing: number[]
  private seg = 0
  private s = 0
  private offCount = 0
  private offSince = 0
  private startT = 0
  private startS = 0
  arrived = false

  constructor(readonly route: Route) {
    this.proj = new LocalProjector(route.points[0])
    this.xy = route.points.map((p) => this.proj.toXY(p))
    this.segBearing = []
    for (let i = 0; i < this.xy.length - 1; i++) {
      const [ax, ay] = this.xy[i]
      const [bx, by] = this.xy[i + 1]
      this.segBearing.push(((Math.atan2(bx - ax, by - ay) * 180) / Math.PI + 360) % 360)
    }
  }

  private match(fix: Fix, from: number, to: number): { seg: number; t: number; d: number; cost: number } {
    const [px, py] = this.proj.toXY(fix.p)
    let best = { seg: this.seg, t: 0, d: Infinity, cost: Infinity }
    const useHeading = Number.isFinite(fix.heading) && fix.speed > 1.2
    for (let i = Math.max(0, from); i < Math.min(this.xy.length - 1, to); i++) {
      const [ax, ay] = this.xy[i]
      const [bx, by] = this.xy[i + 1]
      const r = projectToSegment(px, py, ax, ay, bx, by)
      const d = Math.sqrt(r.d2)
      let cost = d
      const sHere = this.route.cum[i] + r.t * (this.route.cum[i + 1] - this.route.cum[i])
      if (sHere < this.s - 30) cost += 25 // 不轻易倒退
      if (useHeading && Math.abs(angleDiff(this.segBearing[i], fix.heading)) > 100) cost += 20
      if (cost < best.cost) best = { seg: i, t: r.t, d, cost }
    }
    return best
  }

  update(fix: Fix): NavState {
    const route = this.route
    // 先在当前位置附近的窗口内匹配，找不到再全局搜索（绕路后重新汇入）
    let m = this.match(fix, this.seg - 30, this.seg + 400)
    if (m.d > OFF_ROUTE_THRESHOLD[route.mode]) {
      const g = this.match(fix, 0, this.xy.length)
      if (g.d < m.d) m = g
    }
    this.seg = m.seg
    const segLen = route.cum[m.seg + 1] - route.cum[m.seg]
    const s = route.cum[m.seg] + m.t * segLen
    this.s = Math.max(s, Math.min(this.s, s + 5)) // 抑制原地抖动造成的回退
    if (!this.startT) {
      this.startT = fix.t
      this.startS = this.s
    }

    const a = route.points[m.seg]
    const b = route.points[m.seg + 1]
    const matched: LngLat = [a[0] + (b[0] - a[0]) * m.t, a[1] + (b[1] - a[1]) * m.t]

    // 偏航判定：连续 3 次且持续 4 秒以上超过阈值（考虑定位精度）
    const threshold = Math.max(OFF_ROUTE_THRESHOLD[route.mode], (fix.accuracy || 0) * 1.2)
    if (m.d > threshold) {
      this.offCount++
      if (!this.offSince) this.offSince = fix.t
    } else {
      this.offCount = 0
      this.offSince = 0
    }
    const offRoute = this.offCount >= 3 && fix.t - this.offSince >= 4000

    const steps = route.steps
    let stepIndex = steps.findIndex((st) => this.s < st.s1)
    if (stepIndex < 0) stepIndex = steps.length - 1
    const step = steps[stepIndex]
    const nextStep = steps[stepIndex + 1]
    const thenStep = nextStep
    const remaining = Math.max(0, route.distance - this.s)

    // ETA：计划耗时 × 实际节奏系数（走过 300m 后启用）
    let eta = remainingPlannedDuration(route, this.s)
    const covered = this.s - this.startS
    if (covered > 300 && fix.t > this.startT) {
      const planned = remainingPlannedDuration(route, this.startS) - remainingPlannedDuration(route, this.s)
      const actual = (fix.t - this.startT) / 1000
      if (planned > 0) eta *= Math.min(2, Math.max(0.5, actual / planned))
    }

    const toDest = haversine(fix.p, route.destination)
    if (!this.arrived && (remaining < ARRIVE_THRESHOLD[route.mode] || toDest < ARRIVE_THRESHOLD[route.mode] * 0.8) && !offRoute) {
      this.arrived = true
    }

    return {
      matched,
      s: this.s,
      offset: m.d,
      stepIndex,
      step,
      maneuver: step.maneuver,
      distToManeuver: Math.max(0, step.s1 - this.s),
      nextStep,
      thenManeuver: thenStep?.maneuver,
      thenDistance: thenStep ? thenStep.s1 - thenStep.s0 : undefined,
      remaining,
      etaSec: eta,
      progress: route.distance > 0 ? Math.min(1, this.s / route.distance) : 0,
      offRoute,
      arrived: this.arrived,
      routeHeading: this.segBearing[m.seg] ?? 0,
    }
  }
}
