// 手机屏幕常亮（Screen Wake Lock API）。
// Even Hub 没有「后台运行 / 保持亮屏」权限可申请；安卓在内存紧张时会挂起后台 WebView，
// 导航时让手机屏幕保持常亮，WebView 就一直处于前台，定位与眼镜刷新不会中断。
// 页面切到后台时系统会自动释放锁，回到前台需要重新申请。

export class ScreenWake {
  private lock: { release(): Promise<void>; addEventListener(t: string, cb: () => void): void } | null = null
  private want = false

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible' && this.want) void this.acquire()
      })
    }
  }

  get supported(): boolean {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator
  }

  get active(): boolean {
    return this.lock !== null
  }

  async set(on: boolean): Promise<void> {
    if (on === this.want && (on ? this.lock : !this.lock)) return
    this.want = on
    if (on) await this.acquire()
    else await this.release()
  }

  private async acquire(): Promise<void> {
    if (this.lock || !this.supported) return
    try {
      const l = await (navigator as any).wakeLock.request('screen')
      this.lock = l
      l.addEventListener('release', () => {
        if (this.lock === l) this.lock = null
      })
    } catch (e) {
      console.warn('wakeLock', (e as Error).message)
    }
  }

  private async release(): Promise<void> {
    const l = this.lock
    this.lock = null
    try {
      await l?.release()
    } catch { /* ignore */ }
  }
}
