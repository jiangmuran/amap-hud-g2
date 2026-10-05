// 定位源：Even App 宿主定位 / 浏览器定位 / 模拟行驶。统一输出 GCJ-02 的 Fix，
// 并补齐缺失的速度、航向（由位移推算）和平滑处理。

import { AppLocationAccuracy, type AppLocation } from '@evenrealities/even_hub_sdk'
import { angleDiff, bearing, haversine, normDeg, wgs84ToGcj02, type LngLat } from '../geo'
import type { HubBridge } from '../glasses/bridge'
import { pointAt, type Route } from './route'
import type { Fix } from './tracker'

export type LocationSource = 'host' | 'browser' | 'sim' | 'none'

export interface RawFix {
  p: LngLat
  accuracy?: number
  speed?: number
  heading?: number
  altitude?: number
  t?: number
  /** true 表示坐标已是 GCJ-02 */
  gcj?: boolean
}

export class LocationService {
  source: LocationSource = 'none'
  /** 模拟行驶中：忽略真实定位 */
  simulating = false
  last?: Fix
  private prev?: Fix
  private listeners = new Set<(f: Fix) => void>()
  private stopFns: (() => void)[] = []
  private smoothHeading = NaN
  private smoothSpeed = NaN

  constructor(private bridge: HubBridge | null, private isWgs: () => boolean) {}

  onFix(cb: (f: Fix) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 外部（模拟器）注入定位 */
  push(raw: RawFix): void {
    const p = raw.gcj || !this.isWgs() ? raw.p : wgs84ToGcj02(raw.p)
    const t = raw.t ?? Date.now()
    let speed = raw.speed !== undefined && raw.speed >= 0 ? raw.speed : NaN
    let heading = raw.heading !== undefined && raw.heading >= 0 ? raw.heading : NaN

    const prev = this.prev
    if (prev) {
      const d = haversine(prev.p, p)
      const dt = (t - prev.t) / 1000
      if (!Number.isFinite(speed) && dt > 0.2) speed = d / dt
      // 宿主航向无效或低速时由位移推算（位移太小则沿用上一次）
      if ((!Number.isFinite(heading) || (Number.isFinite(speed) && speed < 0.8)) && d > 3) heading = bearing(prev.p, p)
    }
    if (Number.isFinite(speed)) {
      this.smoothSpeed = Number.isFinite(this.smoothSpeed) ? this.smoothSpeed * 0.5 + speed * 0.5 : speed
    }
    if (Number.isFinite(heading)) {
      if (!Number.isFinite(this.smoothHeading)) this.smoothHeading = heading
      else this.smoothHeading = normDeg(this.smoothHeading + angleDiff(this.smoothHeading, heading) * 0.6)
    }

    const fix: Fix = {
      p,
      accuracy: raw.accuracy ?? 10,
      speed: this.smoothSpeed,
      heading: this.smoothHeading,
      altitude: raw.altitude ?? NaN,
      t,
    }
    if (!prev || haversine(prev.p, p) > 2 || t - prev.t > 5000) this.prev = fix
    this.last = fix
    for (const cb of this.listeners) cb(fix)
  }

  async start(): Promise<LocationSource> {
    this.stop()
    if (this.bridge?.real) {
      try {
        const ok = await this.bridge.startAppLocationUpdates({
          accuracy: AppLocationAccuracy.High,
          intervalMs: 1000,
          distanceFilter: 0,
        })
        if (ok) {
          const off = this.bridge.onAppLocationChanged((l: AppLocation) => this.pushHost(l))
          this.stopFns.push(off, () => void this.bridge?.stopAppLocationUpdates())
          this.source = 'host'
          // 先拿一次（不阻塞首屏）
          void this.bridge.getAppLocation({ accuracy: AppLocationAccuracy.High, timeoutMs: 5000 }).then((l) => l && this.pushHost(l))
          return this.source
        }
      } catch (e) {
        console.warn('host location failed', e)
      }
    }
    if (typeof navigator !== 'undefined' && navigator.geolocation) {
      const id = navigator.geolocation.watchPosition(
        (pos) =>
          !this.simulating &&
          this.push({
            p: [pos.coords.longitude, pos.coords.latitude],
            accuracy: pos.coords.accuracy,
            speed: pos.coords.speed ?? undefined,
            heading: pos.coords.heading ?? undefined,
            altitude: pos.coords.altitude ?? undefined,
            t: pos.timestamp,
          }),
        (err) => console.warn('geolocation', err.message),
        { enableHighAccuracy: true, maximumAge: 1000, timeout: 15000 },
      )
      this.stopFns.push(() => navigator.geolocation.clearWatch(id))
      this.source = 'browser'
      return this.source
    }
    this.source = 'none'
    return this.source
  }

  private pushHost(l: AppLocation): void {
    if (!Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return
    if (this.simulating) return
    this.push({
      p: [l.longitude, l.latitude],
      accuracy: l.accuracy,
      speed: l.speed,
      heading: l.heading,
      altitude: l.altitude,
      t: l.timestamp && l.timestamp > 1e12 ? l.timestamp : Date.now(),
    })
  }

  stop(): void {
    for (const f of this.stopFns) f()
    this.stopFns = []
  }

  resetSmoothing(): void {
    this.prev = undefined
    this.smoothHeading = NaN
    this.smoothSpeed = NaN
  }
}

/** 沿路线回放的模拟行驶，用于没有真实移动时调试与演示 */
export class RouteSimulator {
  private timer: ReturnType<typeof setInterval> | null = null
  private s = 0
  private detourUntil = 0
  speed: number

  constructor(private route: Route, private loc: LocationService, speedMps: number) {
    this.speed = speedMps
  }

  start(): void {
    this.stop()
    this.loc.simulating = true
    this.loc.resetSmoothing()
    this.tick()
    this.timer = setInterval(() => this.tick(), 1000)
  }

  /** 模拟偏航：接下来一段时间横向偏移 80m，用于测试重新规划 */
  detour(): void {
    this.detourUntil = Date.now() + 9000
  }

  private tick(): void {
    this.s = Math.min(this.route.distance, this.s + this.speed)
    const { p, heading } = pointAt(this.route, this.s)
    let q = p
    if (Date.now() < this.detourUntil) {
      const off = 80 / 111320
      const rad = ((heading + 90) * Math.PI) / 180
      q = [p[0] + (off * Math.sin(rad)) / Math.cos((p[1] * Math.PI) / 180), p[1] + off * Math.cos(rad)]
    }
    const jitter = () => (Math.random() - 0.5) * 0.00003
    this.loc.push({
      p: [q[0] + jitter(), q[1] + jitter()],
      accuracy: 6,
      speed: this.speed * (0.9 + Math.random() * 0.2),
      heading,
      altitude: 45 + Math.sin(this.s / 300) * 6,
      gcj: true,
    })
    if (this.s >= this.route.distance) this.stop()
  }

  get running(): boolean {
    return this.timer !== null
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** 结束模拟，恢复真实定位 */
  dispose(): void {
    this.stop()
    this.loc.simulating = false
    this.loc.resetSmoothing()
  }
}
