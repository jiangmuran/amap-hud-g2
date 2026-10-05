// 离线演示路线：按高德 v5 响应格式合成一条带多个转向的路线，
// 没有 Key / 没有定位时也能完整体验 HUD 与模拟导航。

import type { LngLat } from '../geo'
import type { TravelMode } from './route'

const M_LAT = 1 / 111320

function offset(p: LngLat, east: number, north: number): LngLat {
  return [p[0] + (east * M_LAT) / Math.cos((p[1] * Math.PI) / 180), p[1] + north * M_LAT]
}

function densify(a: LngLat, b: LngLat, stepM = 25): LngLat[] {
  const dx = (b[0] - a[0]) / Math.cos((a[1] * Math.PI) / 180)
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy) / M_LAT
  const n = Math.max(1, Math.round(len / stepM))
  const out: LngLat[] = []
  for (let i = 0; i <= n; i++) out.push([a[0] + ((b[0] - a[0]) * i) / n, a[1] + ((b[1] - a[1]) * i) / n])
  return out
}

/** 起点默认三里屯附近（GCJ-02） */
export const DEMO_ORIGIN: LngLat = [116.45503, 39.93279]

export function demoRouteJson(origin: LngLat = DEMO_ORIGIN, mode: TravelMode = 'walking'): any {
  // [东, 北] 米，以及到达该拐点时的动作与道路
  const legs: { e: number; n: number; road: string; action: string; assistant?: string }[] = [
    { e: 0, n: 260, road: '三里屯路', action: '右转' },
    { e: 380, n: 0, road: '工体北路', action: '向左前方行驶' },
    { e: 140, n: 160, road: '新东路', action: '左转' },
    { e: -220, n: 0, road: '东直门外大街', action: '靠右' },
    { e: -60, n: 240, road: '东直门外斜街', action: '右转' },
    { e: 320, n: 0, road: '左家庄中街', action: '', assistant: '到达目的地' },
  ]
  let cur = origin
  const steps: any[] = []
  const speed = mode === 'driving' ? 9 : mode === 'walking' ? 1.3 : 4
  let total = 0
  legs.forEach((leg, i) => {
    const next = offset(cur, leg.e, leg.n)
    const pts = densify(cur, next)
    const dist = Math.round(Math.hypot(leg.e, leg.n))
    total += dist
    steps.push({
      instruction: `沿${leg.road}行驶${dist}米${leg.action ? `，${leg.action}` : ''}`,
      orientation: '',
      road_name: leg.road,
      step_distance: String(dist),
      cost: { duration: String(Math.round(dist / speed)) },
      polyline: pts.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join(';'),
      navi: { action: leg.action, assistant_action: leg.assistant ?? '' },
    })
    cur = next
    void i
  })
  return {
    status: '1',
    info: 'OK',
    infocode: '10000',
    route: {
      origin: `${origin[0]},${origin[1]}`,
      destination: `${cur[0]},${cur[1]}`,
      paths: [{ distance: String(total), cost: { duration: String(Math.round(total / speed)) }, steps }],
    },
  }
}
