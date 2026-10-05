// 行程统计与面包屑轨迹（返航、轨迹显示用）。

import { haversine, type LngLat } from '../geo'
import type { Fix } from './tracker'

export interface TripSnapshot {
  startedAt: number
  elapsedSec: number
  movingSec: number
  distance: number
  maxSpeed: number
  avgSpeed: number
  climb: number
  start?: LngLat
  trail: LngLat[]
}

export class TripRecorder {
  startedAt = Date.now()
  private distance = 0
  private movingSec = 0
  private maxSpeed = 0
  private climb = 0
  private lastAlt = NaN
  private last?: Fix
  private trail: LngLat[] = []
  start?: LngLat

  reset(): void {
    this.startedAt = Date.now()
    this.distance = 0
    this.movingSec = 0
    this.maxSpeed = 0
    this.climb = 0
    this.lastAlt = NaN
    this.last = undefined
    this.trail = []
    this.start = undefined
  }

  add(fix: Fix): void {
    if (!this.start) this.start = fix.p
    if (fix.accuracy > 60) return // 定位太差不计入
    if (this.last) {
      const d = haversine(this.last.p, fix.p)
      const dt = (fix.t - this.last.t) / 1000
      // 过滤静止漂移：位移需大于精度的一部分
      if (d > Math.max(2, fix.accuracy * 0.3) && dt > 0 && d / dt < 70) {
        this.distance += d
        this.movingSec += dt
        this.last = fix
        const tail = this.trail[this.trail.length - 1]
        if (!tail || haversine(tail, fix.p) > 8) {
          this.trail.push(fix.p)
          if (this.trail.length > 3000) this.trail = this.trail.filter((_, i) => i % 2 === 0)
        }
      } else if (dt > 30) {
        this.last = fix
      }
    } else {
      this.last = fix
      this.trail.push(fix.p)
    }
    if (Number.isFinite(fix.speed)) this.maxSpeed = Math.max(this.maxSpeed, fix.speed)
    if (Number.isFinite(fix.altitude)) {
      if (Number.isFinite(this.lastAlt) && fix.altitude > this.lastAlt + 1) this.climb += fix.altitude - this.lastAlt
      if (!Number.isFinite(this.lastAlt) || Math.abs(fix.altitude - this.lastAlt) > 1) this.lastAlt = fix.altitude
    }
  }

  snapshot(): TripSnapshot {
    return {
      startedAt: this.startedAt,
      elapsedSec: (Date.now() - this.startedAt) / 1000,
      movingSec: this.movingSec,
      distance: this.distance,
      maxSpeed: this.maxSpeed,
      avgSpeed: this.movingSec > 0 ? this.distance / this.movingSec : 0,
      climb: this.climb,
      start: this.start,
      trail: this.trail,
    }
  }
}
