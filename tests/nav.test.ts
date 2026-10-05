import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bearing, haversine, wgs84ToGcj02, gcj02ToWgs84, angleDiff, parsePolyline } from '../src/geo.ts'
import { maneuverFromAction, parseRoute, pointAt, remainingPlannedDuration } from '../src/nav/route.ts'
import { RouteTracker, type Fix } from '../src/nav/tracker.ts'
import { demoRouteJson, DEMO_ORIGIN } from '../src/nav/demo.ts'

const fix = (p: [number, number], t: number, extra: Partial<Fix> = {}): Fix => ({
  p, accuracy: 5, speed: 1.5, heading: NaN, altitude: NaN, t, ...extra,
})

test('haversine / bearing 基本正确', () => {
  const a: [number, number] = [116.397428, 39.90923]
  const b: [number, number] = [116.397428, 39.91923]
  assert.ok(Math.abs(haversine(a, b) - 1112) < 5)
  assert.ok(Math.abs(bearing(a, b)) < 0.01)
  assert.equal(angleDiff(350, 10), 20)
  assert.equal(angleDiff(10, 350), -20)
})

test('WGS84→GCJ02 偏移量级正确且可逆', () => {
  const w: [number, number] = [116.397428, 39.90923]
  const g = wgs84ToGcj02(w)
  const off = haversine(w, g)
  assert.ok(off > 300 && off < 700, `offset ${off}`)
  const back = gcj02ToWgs84(g)
  assert.ok(haversine(back, w) < 2)
  // 境外不偏移
  assert.deepEqual(wgs84ToGcj02([-122.4, 37.7]), [-122.4, 37.7])
})

test('polyline 解析', () => {
  assert.deepEqual(parsePolyline('116.1,39.1;116.2,39.2'), [[116.1, 39.1], [116.2, 39.2]])
  assert.deepEqual(parsePolyline(''), [])
})

test('动作字符串映射', () => {
  assert.equal(maneuverFromAction('左转', ''), 'left')
  assert.equal(maneuverFromAction('向右前方行驶', ''), 'slight-right')
  assert.equal(maneuverFromAction('左转调头', ''), 'uturn-left')
  assert.equal(maneuverFromAction('', '到达目的地'), 'arrive')
  assert.equal(maneuverFromAction('进入环岛', ''), 'roundabout')
  assert.equal(maneuverFromAction('', ''), null)
})

test('解析演示路线（高德 v5 结构）', () => {
  const r = parseRoute(demoRouteJson(DEMO_ORIGIN, 'walking'), 'walking', 'X')
  assert.equal(r.steps.length, 6)
  assert.equal(r.steps[0].maneuver, 'right')
  assert.equal(r.steps[1].maneuver, 'slight-left')
  assert.equal(r.steps[5].maneuver, 'arrive')
  assert.ok(Math.abs(r.distance - 1660) < 40, `distance ${r.distance}`)
  // 分段首尾相接
  for (let i = 1; i < r.steps.length; i++) assert.ok(Math.abs(r.steps[i].s0 - r.steps[i - 1].s1) < 1)
  assert.ok(Math.abs(r.steps[5].s1 - r.distance) < 1)
  assert.ok(remainingPlannedDuration(r, 0) > remainingPlannedDuration(r, 800))
})

test('无动作字段时用几何角度兜底', () => {
  const json = demoRouteJson(DEMO_ORIGIN, 'walking')
  for (const st of json.route.paths[0].steps) st.navi = {}
  const r = parseRoute(json, 'walking', 'X')
  assert.equal(r.steps[0].maneuver, 'right')   // 北 → 东
  assert.equal(r.steps[2].maneuver, 'sharp-left') // 东北(41°) → 西(270°)，转角 -131°
})

test('跟踪：进度、下一个转向、到达', () => {
  const r = parseRoute(demoRouteJson(DEMO_ORIGIN, 'walking'), 'walking', 'X')
  const tr = new RouteTracker(r)
  let t = 0
  let st = tr.update(fix(pointAt(r, 100).p, (t += 1000)))
  assert.equal(st.stepIndex, 0)
  assert.ok(Math.abs(st.distToManeuver - (r.steps[0].s1 - 100)) < 3)
  assert.equal(st.maneuver, 'right')
  st = tr.update(fix(pointAt(r, 500).p, (t += 1000)))
  assert.equal(st.stepIndex, 1)
  assert.equal(st.offRoute, false)
  for (let s = 600; s <= r.distance; s += 50) st = tr.update(fix(pointAt(r, s).p, (t += 1000)))
  st = tr.update(fix(r.destination, (t += 1000)))
  assert.equal(st.arrived, true)
})

test('跟踪：持续偏离才判定偏航', () => {
  const r = parseRoute(demoRouteJson(DEMO_ORIGIN, 'walking'), 'walking', 'X')
  const tr = new RouteTracker(r)
  const base = pointAt(r, 120).p
  const off: [number, number] = [base[0] - 0.0008, base[1]] // 向西 ~68m
  let t = 0
  tr.update(fix(base, (t += 1000)))
  let st = tr.update(fix(off, (t += 1000)))
  assert.equal(st.offRoute, false, '单次漂移不算偏航')
  for (let i = 0; i < 5; i++) st = tr.update(fix(off, (t += 1500)))
  assert.equal(st.offRoute, true)
  st = tr.update(fix(base, (t += 1000)))
  assert.equal(st.offRoute, false, '回到路线后恢复')
})
