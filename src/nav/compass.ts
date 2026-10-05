// 手机指南针（DeviceOrientation）。
// - iPhone：deviceorientation 事件的 webkitCompassHeading（系统已做倾斜补偿，相对磁北）；
//   iOS 13+ 必须在用户点击时调用 DeviceOrientationEvent.requestPermission()。
// - 安卓：deviceorientationabsolute 事件的 alpha/beta/gamma（绝对方向），这里做倾斜补偿，
//   手机竖着拿或平放都能得到「手机顶部指向」的方位角。
// 得到的是手机的朝向：手机拿在手上时约等于人的朝向；放在口袋里时不可靠，
// 所以移动较快时应用优先使用 GPS 行进方向（见 app.ts 的朝向融合）。

import { angleDiff, normDeg } from '../geo'

export type CompassState = 'unsupported' | 'needs-permission' | 'denied' | 'waiting' | 'active'

const RAD = Math.PI / 180

/**
 * 由绝对方向欧拉角得到人面对的方位角（0=北，顺时针）。
 * - 手机接近平放（|beta| < 45°）：取手机顶部朝向 = 360 − alpha；
 * - 手机竖着拿：用 W3C DeviceOrientation 规范附录的倾斜补偿公式，得到背面摄像头朝向
 *   （平放时该公式退化为 0/0，所以分两种情况）。
 */
export function headingFromEuler(alpha: number, beta: number, gamma: number): number {
  if (Math.abs(beta) < 45) return normDeg(360 - alpha)
  const a = alpha * RAD
  const b = beta * RAD
  const g = gamma * RAD
  const cA = Math.cos(a), sA = Math.sin(a)
  const sB = Math.sin(b)
  const cG = Math.cos(g), sG = Math.sin(g)
  const rA = -cA * sG - sA * sB * cG
  const rB = -sA * sG + cA * sB * cG
  let h = Math.atan(rA / rB)
  if (rB < 0) h += Math.PI
  else if (rA < 0) h += 2 * Math.PI
  return normDeg(h / RAD)
}

export class PhoneCompass {
  heading = NaN
  /** iOS 提供的精度（度），越小越好 */
  accuracy = NaN
  t = 0
  state: CompassState = 'waiting'
  private listeners = new Set<() => void>()
  private started = false
  private lastNotify = 0

  constructor() {
    if (typeof window === 'undefined' || !('DeviceOrientationEvent' in window)) this.state = 'unsupported'
    else if (typeof (window as any).DeviceOrientationEvent?.requestPermission === 'function') this.state = 'needs-permission'
  }

  onChange(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  /** 最近 3 秒内有读数才算可用 */
  get fresh(): boolean {
    return this.state === 'active' && Number.isFinite(this.heading) && Date.now() - this.t < 3000
  }

  /** iOS：必须在用户点击事件里调用 */
  async requestPermission(): Promise<boolean> {
    const DOE = (window as any).DeviceOrientationEvent
    if (typeof DOE?.requestPermission !== 'function') {
      this.start()
      return true
    }
    try {
      const r = await DOE.requestPermission()
      if (r === 'granted') {
        this.state = 'waiting'
        this.start()
        return true
      }
      this.state = 'denied'
    } catch {
      this.state = 'denied'
    }
    this.emit(true)
    return false
  }

  /** 不需要授权的平台（安卓）直接开始监听 */
  start(): void {
    if (this.started || this.state === 'unsupported' || this.state === 'needs-permission' || this.state === 'denied') return
    this.started = true
    window.addEventListener('deviceorientationabsolute', (e) => this.onAbsolute(e as DeviceOrientationEvent), true)
    window.addEventListener('deviceorientation', (e) => this.onOrientation(e as DeviceOrientationEvent), true)
  }

  private onAbsolute(e: DeviceOrientationEvent): void {
    if (e.alpha == null || e.beta == null || e.gamma == null) return
    this.update(headingFromEuler(e.alpha, e.beta, e.gamma), NaN)
  }

  private onOrientation(e: DeviceOrientationEvent): void {
    const ios = (e as any).webkitCompassHeading
    if (typeof ios === 'number' && ios >= 0) {
      this.update(ios, (e as any).webkitCompassAccuracy ?? NaN)
      return
    }
    // 部分安卓 WebView 只有 deviceorientation 且标记 absolute
    if (e.absolute && e.alpha != null && e.beta != null && e.gamma != null) this.update(headingFromEuler(e.alpha, e.beta, e.gamma), NaN)
  }

  private update(h: number, acc: number): void {
    // 屏幕旋转补偿（横屏时设备顶部不是屏幕上方）
    const screenAngle = (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number
    const raw = normDeg(h + screenAngle)
    // 圆周平滑，抑制磁场抖动
    this.heading = Number.isFinite(this.heading) ? normDeg(this.heading + angleDiff(this.heading, raw) * 0.25) : raw
    this.accuracy = acc
    this.t = Date.now()
    this.state = 'active'
    this.emit(false)
  }

  private emit(force: boolean): void {
    // 指南针事件很频繁（60Hz），通知节流到 4Hz
    const now = Date.now()
    if (!force && now - this.lastNotify < 250) return
    this.lastNotify = now
    for (const cb of this.listeners) cb()
  }
}
