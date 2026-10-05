// 宿主桥接抽象：真机/官方模拟器里用 SDK 的 EvenAppBridge；
// 普通浏览器里用 MockBridge（模拟调用耗时，输入由手机端 UI 的按钮/键盘注入）。

import {
  DeviceConnectType,
  waitForEvenAppBridge,
  type AppLocation,
  type AppLocationOptions,
  type CreateStartUpPageContainer,
  type DeviceInfo,
  type DeviceStatus,
  type EvenHubEvent,
  type ImageRawDataUpdate,
  type RebuildPageContainer,
  type TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'

export interface HubBridge {
  readonly real: boolean
  createStartUpPageContainer(c: CreateStartUpPageContainer): Promise<unknown>
  rebuildPageContainer(c: RebuildPageContainer): Promise<boolean>
  updateImageRawData(d: ImageRawDataUpdate): Promise<unknown>
  textContainerUpgrade(c: TextContainerUpgrade): Promise<boolean>
  shutDownPageContainer(mode?: number): Promise<boolean>
  onEvenHubEvent(cb: (e: EvenHubEvent) => void): () => void
  onDeviceStatusChanged(cb: (s: DeviceStatus) => void): () => void
  getDeviceInfo(): Promise<DeviceInfo | null>
  startAppLocationUpdates(o?: AppLocationOptions): Promise<boolean>
  stopAppLocationUpdates(): Promise<boolean>
  getAppLocation(o?: AppLocationOptions): Promise<AppLocation | null>
  onAppLocationChanged(cb: (l: AppLocation) => void): () => void
  setLocalStorage(k: string, v: string): Promise<boolean>
  getLocalStorage(k: string): Promise<string>
}

export interface GlassesStatus {
  connected: boolean
  battery?: number
  wearing?: boolean
  charging?: boolean
}

/** R1 戒指状态（SDK 只提供电量/连接/充电，不提供健康数据） */
export interface RingStatus {
  connected: boolean
  battery?: number
  charging?: boolean
}

function wrapReal(b: any): HubBridge {
  return {
    real: true,
    createStartUpPageContainer: (c) => b.createStartUpPageContainer(c),
    rebuildPageContainer: (c) => b.rebuildPageContainer(c),
    updateImageRawData: (d) => b.updateImageRawData(d),
    textContainerUpgrade: (c) => b.textContainerUpgrade(c),
    shutDownPageContainer: (m) => b.shutDownPageContainer(m),
    onEvenHubEvent: (cb) => b.onEvenHubEvent(cb),
    onDeviceStatusChanged: (cb) => b.onDeviceStatusChanged(cb),
    getDeviceInfo: () => b.getDeviceInfo(),
    startAppLocationUpdates: (o) => b.startAppLocationUpdates(o),
    stopAppLocationUpdates: () => b.stopAppLocationUpdates(),
    getAppLocation: (o) => b.getAppLocation(o),
    onAppLocationChanged: (cb) => b.onAppLocationChanged(cb),
    setLocalStorage: (k, v) => b.setLocalStorage(k, v),
    getLocalStorage: (k) => b.getLocalStorage(k),
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 浏览器开发用的假桥接：模拟真机实测的调用耗时（图片 ~110ms、文本 ~80ms、重建 ~165ms） */
export class MockBridge implements HubBridge {
  readonly real = false
  private eventCbs = new Set<(e: EvenHubEvent) => void>()
  private statusCbs = new Set<(s: DeviceStatus) => void>()

  async createStartUpPageContainer(): Promise<unknown> {
    await sleep(120)
    return 0
  }
  async rebuildPageContainer(): Promise<boolean> {
    await sleep(165)
    return true
  }
  async updateImageRawData(): Promise<unknown> {
    await sleep(105 + Math.random() * 40)
    return 'success'
  }
  async textContainerUpgrade(): Promise<boolean> {
    await sleep(80)
    return true
  }
  async shutDownPageContainer(): Promise<boolean> {
    console.info('[mock] shutDownPageContainer → 宿主会弹出退出确认')
    return true
  }
  onEvenHubEvent(cb: (e: EvenHubEvent) => void): () => void {
    this.eventCbs.add(cb)
    return () => this.eventCbs.delete(cb)
  }
  onDeviceStatusChanged(cb: (s: DeviceStatus) => void): () => void {
    this.statusCbs.add(cb)
    setTimeout(() => cb({ sn: 'G2-MOCK', connectType: DeviceConnectType.Connected, batteryLevel: 86, isWearing: true } as DeviceStatus), 300)
    setTimeout(() => cb({ sn: 'R1-MOCK', connectType: DeviceConnectType.Connected, batteryLevel: 72 } as DeviceStatus), 500)
    return () => this.statusCbs.delete(cb)
  }
  async startAppLocationUpdates(): Promise<boolean> {
    return false
  }
  async getDeviceInfo(): Promise<DeviceInfo | null> {
    return { model: 'g2', sn: 'G2-MOCK' } as unknown as DeviceInfo
  }
  async stopAppLocationUpdates(): Promise<boolean> {
    return true
  }
  async getAppLocation(): Promise<AppLocation | null> {
    return null
  }
  onAppLocationChanged(): () => void {
    return () => undefined
  }
  async setLocalStorage(k: string, v: string): Promise<boolean> {
    try {
      localStorage.setItem('amaphud:' + k, v)
    } catch { /* ignore */ }
    return true
  }
  async getLocalStorage(k: string): Promise<string> {
    try {
      return localStorage.getItem('amaphud:' + k) ?? ''
    } catch {
      return ''
    }
  }
  /** 注入一个眼镜输入事件 */
  emit(e: EvenHubEvent): void {
    for (const cb of this.eventCbs) cb(e)
  }
}

/**
 * 检测宿主。Even App / 官方模拟器会注入 flutter_inappwebview；
 * 普通浏览器里 waitForEvenAppBridge 可能永远不返回，因此加超时并回退到 Mock。
 * URL 带 ?mock=1 强制使用 Mock。
 */
export async function connectBridge(timeoutMs = 4000): Promise<HubBridge> {
  const forceMock = new URLSearchParams(location.search).has('mock')
  const w = window as any
  if (forceMock) return new MockBridge()
  const hasHost = () => !!w.flutter_inappwebview
  if (!hasHost()) {
    // 有的宿主注入稍晚，短暂等待
    for (let i = 0; i < 10 && !hasHost(); i++) await sleep(100)
    if (!hasHost()) return new MockBridge()
  }
  const real = await Promise.race([waitForEvenAppBridge(), sleep(timeoutMs).then(() => null)])
  return real ? wrapReal(real) : new MockBridge()
}
