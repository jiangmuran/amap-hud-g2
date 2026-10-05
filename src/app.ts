// 应用核心：串联定位、路线跟踪、偏航重算、眼镜输入、视图切换、渲染与生命周期。
// 手机端 UI 只通过本类的公开方法与 'change' 事件交互。

import { DeviceConnectType } from '@evenrealities/even_hub_sdk'
import { AmapClient, QuotaTracker, type Poi, type ReGeo, type Weather } from './amap/api'
import { haversine, type LngLat } from './geo'
import type { GlassesStatus, HubBridge } from './glasses/bridge'
import { createCanvas, GlassesDisplay, SCREEN_H, SCREEN_W, type MenuItem } from './glasses/display'
import { InputNormalizer, type InputAction } from './glasses/input'
import { BasemapManager } from './hud/basemap'
import { RADAR_CATEGORIES, type HudModel, type RadarState, type ViewId } from './hud/model'
import { buildTextFrame } from './hud/textHud'
import { renderHud } from './hud/views'
import { demoRouteJson, DEMO_ORIGIN } from './nav/demo'
import { LocationService, RouteSimulator } from './nav/location'
import { parseRoute, type Route, type TravelMode } from './nav/route'
import { RouteTracker, type NavState } from './nav/tracker'
import { TripRecorder } from './nav/trip'
import { loadSettings, pushHistory, saveSettings, type KV, type Place, type Settings } from './storage'

const MENU = {
  stop: 1,
  reroute: 2,
  focus: 3,
  heading: 4,
  basemap: 5,
  radar: 6,
  home: 7,
} as const

const MENU_ITEMS: MenuItem[] = [
  { id: MENU.stop, name: '结束导航' },
  { id: MENU.reroute, name: '重新规划' },
  { id: MENU.focus, name: '专注模式 开/关' },
  { id: MENU.heading, name: '地图朝向 切换' },
  { id: MENU.basemap, name: '街道底图 开/关' },
  { id: MENU.radar, name: '周边扫描' },
  { id: MENU.home, name: '返回起点' },
]

const REFRESH_MS = { eco: 2000, standard: 1000, fast: 450 }

/** 专注模式下距离转向多近时自动唤醒完整 HUD */
const FOCUS_WAKE: Record<TravelMode, number> = { walking: 80, bicycling: 160, electrobike: 160, driving: 500 }

export interface NavSession {
  dest: Place
  startedAt: number
  startDistance: number
  simulate: boolean
}

export class HudApp {
  settings!: Settings
  readonly quota: QuotaTracker
  readonly api: AmapClient
  readonly loc: LocationService
  readonly trip = new TripRecorder()
  readonly display: GlassesDisplay
  readonly basemap: BasemapManager
  readonly frame = createCanvas(SCREEN_W, SCREEN_H)

  route?: Route
  tracker?: RouteTracker
  nav?: NavState
  session?: NavSession
  sim?: RouteSimulator
  glasses: GlassesStatus = { connected: false }
  weather?: Weather
  place?: ReGeo
  radar: RadarState = { category: 0, pois: [], loading: false }
  arrival?: HudModel['arrival']

  viewIndex = 0
  overviewZoom: 'fit' | 'near' = 'fit'
  roadbookOffset = 0
  rerouting = false
  private lastRerouteAt = 0
  private rerouteCount = 0
  private toastMsg?: { text: string; until: number }
  private peekUntil = 0
  private exitDialogPending = false
  private exitDialogTimer: ReturnType<typeof setTimeout> | null = null
  private lastRegeo?: { p: LngLat; t: number }
  private lastWeatherAt = 0
  private radarCache = new Map<number, { p: LngLat; t: number; pois: Poi[] }>()
  private renderTimer: ReturnType<typeof setTimeout> | null = null
  private renderQueued = false
  private listeners = new Set<() => void>()
  private input = new InputNormalizer()
  private arrivalTimer: ReturnType<typeof setTimeout> | null = null

  constructor(readonly bridge: HubBridge, private kv: KV) {
    this.quota = new QuotaTracker(kv)
    this.api = new AmapClient(() => this.settings?.amapKey ?? '', () => this.settings?.apiBase ?? '', this.quota)
    this.loc = new LocationService(bridge, () => this.settings?.locationIsWgs ?? true)
    this.display = new GlassesDisplay(bridge, MENU_ITEMS)
    this.basemap = new BasemapManager(this.api)
  }

  // ── 生命周期 ──────────────────────────────────────────────────────

  async init(): Promise<void> {
    this.settings = await loadSettings(this.kv)
    await this.quota.load()
    this.basemap.enabled = this.settings.basemap

    this.bridge.onEvenHubEvent((e) => {
      const a = this.input.normalize(e)
      if (a) this.handleInput(a)
    })
    this.bridge.onDeviceStatusChanged((s) => {
      this.glasses = {
        connected: s.connectType === DeviceConnectType.Connected,
        battery: s.batteryLevel,
        wearing: s.isWearing,
      }
      if (s.batteryLevel !== undefined && s.batteryLevel <= 10) this.toast(`眼镜电量低 ${s.batteryLevel}%`)
      this.changed()
    })
    this.loc.onFix((f) => this.onFix(f))
    this.display.onModeChange = (mode) => {
      if (mode === 'text') this.toast('图像通道异常，已切换文本模式')
      this.changed()
    }

    // 先出首屏再等定位，避免黑屏
    await this.display.start()
    this.scheduleRender(0)
    void this.loc.start().then(() => this.changed())
  }

  on(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private changed(): void {
    for (const cb of this.listeners) cb()
    this.requestRender()
  }

  async updateSettings(patch: Partial<Settings>): Promise<void> {
    Object.assign(this.settings, patch)
    if (patch.basemap !== undefined) {
      this.basemap.enabled = patch.basemap
      if (!patch.basemap) this.basemap.clear()
    }
    if (patch.amapKey !== undefined) this.basemap.clear()
    await saveSettings(this.kv, this.settings)
    this.changed()
  }

  // ── 视图 ─────────────────────────────────────────────────────────

  views(): ViewId[] {
    if (this.arrival) return ['arrival', 'telemetry', 'overview', 'radar']
    if (this.route) return ['nav', 'overview', 'roadbook', 'telemetry', 'radar']
    return ['cruise', 'overview', 'telemetry', 'radar']
  }

  get view(): ViewId {
    const v = this.views()
    return v[Math.min(this.viewIndex, v.length - 1)]
  }

  setView(id: ViewId): void {
    const i = this.views().indexOf(id)
    if (i >= 0) this.viewIndex = i
    this.changed()
  }

  toast(text: string, ms = 3000): void {
    this.toastMsg = { text, until: Date.now() + ms }
    this.requestRender()
    setTimeout(() => this.requestRender(), ms + 50)
  }

  // ── 输入 ─────────────────────────────────────────────────────────

  handleInput(a: InputAction): void {
    const views = this.views()
    // 对话框挂起时又收到普通输入，说明对话框已关闭（部分宿主不发前后台事件）
    if (this.exitDialogPending && ['next', 'prev', 'click', 'longpress'].includes(a.kind)) this.endExitDialog()
    switch (a.kind) {
      case 'next':
        this.viewIndex = (this.viewIndex + 1) % views.length
        this.roadbookOffset = 0
        this.peekUntil = Date.now() + 8000
        break
      case 'prev':
        this.viewIndex = (this.viewIndex - 1 + views.length) % views.length
        this.roadbookOffset = 0
        this.peekUntil = Date.now() + 8000
        break
      case 'click':
        this.onClick()
        break
      case 'double':
        // 审核要求：根页面双击必须弹出系统退出确认
        if (this.exitDialogPending) return
        this.exitDialogPending = true
        this.display.pause()
        if (this.exitDialogTimer) clearTimeout(this.exitDialogTimer)
        this.exitDialogTimer = setTimeout(() => this.endExitDialog(), 20_000)
        void this.bridge.shutDownPageContainer(1)
        return
      case 'longpress':
        this.peekUntil = Date.now() + 10_000
        break
      case 'menu':
        void this.onMenu(a.id)
        setTimeout(() => void this.display.resume({ probe: true }), 400)
        break
      case 'foreground':
        // 退出确认/系统菜单弹出时也会收到 FOREGROUND_ENTER（极性反转），
        // 也可能是真的回到前台。先暂停，再探测式恢复整屏重发。
        if (!this.exitDialogPending) {
          this.display.pause()
          setTimeout(() => void this.display.resume({ probe: true }), 500)
        }
        return
      case 'background':
        if (this.exitDialogPending) {
          // 用户在退出确认里选了「否」
          this.endExitDialog()
        } else {
          // 菜单关闭 / 真正进入后台：探测式恢复
          setTimeout(() => void this.display.resume({ probe: true }), 500)
        }
        return
      case 'exit':
        this.shutdown()
        return
    }
    this.changed()
  }

  private endExitDialog(): void {
    if (!this.exitDialogPending) return
    this.exitDialogPending = false
    if (this.exitDialogTimer) clearTimeout(this.exitDialogTimer)
    this.exitDialogTimer = null
    setTimeout(() => void this.display.resume({ rebuild: true }), 300)
  }

  private onClick(): void {
    switch (this.view) {
      case 'overview':
        this.overviewZoom = this.overviewZoom === 'fit' ? 'near' : 'fit'
        break
      case 'roadbook': {
        const total = this.route?.steps.length ?? 0
        const cur = this.nav?.stepIndex ?? 0
        this.roadbookOffset = cur + this.roadbookOffset + 4 >= total ? 0 : this.roadbookOffset + 4
        break
      }
      case 'radar':
        void this.scanRadar(this.radar.fetchedAt !== undefined && !this.radar.loading)
        break
      case 'arrival':
        this.finishArrival()
        break
      case 'nav':
        this.settings.headingUp = !this.settings.headingUp
        void saveSettings(this.kv, this.settings)
        this.toast(this.settings.headingUp ? '地图：车头朝上' : '地图：正北朝上', 1500)
        break
      case 'cruise':
        if (this.loc.last) void this.refreshPlace(this.loc.last.p, true)
        break
      default:
        break
    }
    this.peekUntil = Date.now() + 8000
  }

  private async onMenu(id: number): Promise<void> {
    switch (id) {
      case MENU.stop:
        if (this.route) {
          this.stopNavigation()
          this.toast('导航已结束')
        }
        break
      case MENU.reroute:
        if (this.route) {
          this.lastRerouteAt = 0
          await this.reroute(true)
        }
        break
      case MENU.focus:
        await this.updateSettings({ focusMode: !this.settings.focusMode })
        this.toast(this.settings.focusMode ? '专注模式：开（接近转向时自动亮起）' : '专注模式：关')
        break
      case MENU.heading:
        await this.updateSettings({ headingUp: !this.settings.headingUp })
        this.toast(this.settings.headingUp ? '地图：车头朝上' : '地图：正北朝上')
        break
      case MENU.basemap:
        await this.updateSettings({ basemap: !this.settings.basemap })
        this.toast(this.settings.basemap ? '街道底图：开' : '街道底图：关')
        break
      case MENU.radar:
        this.setView('radar')
        await this.scanRadar(false)
        break
      case MENU.home:
        await this.navigateHome()
        break
    }
    this.changed()
  }

  // ── 定位 ─────────────────────────────────────────────────────────

  private onFix(fix: import('./nav/tracker').Fix): void {
    this.trip.add(fix)
    this.basemap.maybeRefresh(fix.p, fix.speed)
    if (this.tracker && !this.arrival) {
      this.nav = this.tracker.update(fix)
      if (this.nav.arrived) this.arrive()
      else if (this.nav.offRoute) void this.reroute(false)
    }
    void this.refreshPlace(fix.p, false)
    this.changed()
  }

  private async refreshPlace(p: LngLat, force: boolean): Promise<void> {
    if (!this.api.hasKey()) return
    const now = Date.now()
    const last = this.lastRegeo
    // 导航中地址不显示，降低频率
    const interval = this.route ? 300_000 : 60_000
    if (!force && last && (now - last.t < interval || haversine(last.p, p) < 120)) return
    if (force && last && now - last.t < 5000) return
    this.lastRegeo = { p, t: now }
    try {
      this.place = await this.api.regeo(p)
      if (force) this.toast('位置已刷新', 1200)
      if (this.place.adcode && now - this.lastWeatherAt > 30 * 60_000) {
        this.lastWeatherAt = now
        this.weather = (await this.api.weather(this.place.adcode)) ?? this.weather
      }
      this.changed()
    } catch (e) {
      console.warn('regeo', e)
    }
  }

  // ── 搜索与规划 ───────────────────────────────────────────────────

  origin(): LngLat {
    if (this.loc.last) return this.loc.last.p
    if (!this.bridge.real) return DEMO_ORIGIN
    throw new Error('尚未获取定位')
  }

  async search(keyword: string): Promise<Poi[]> {
    const pois = await this.api.searchText(keyword, { region: this.place?.city, pageSize: 15 })
    const me = this.loc.last?.p
    if (me) {
      for (const p of pois) p.distance = haversine(me, p.location)
      pois.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0))
    }
    return pois
  }

  async planRoutes(dest: Place, mode: TravelMode, from?: LngLat): Promise<Route[]> {
    const json = await this.api.route(mode, from ?? this.origin(), dest.location)
    const paths: unknown[] = json?.route?.paths ?? []
    const routes: Route[] = []
    for (let i = 0; i < Math.min(3, paths.length); i++) {
      try {
        routes.push(parseRoute(json, mode, dest.name, i))
      } catch (e) {
        console.warn('parseRoute', e)
      }
    }
    if (!routes.length) throw new Error('未能规划出路线')
    return routes
  }

  demoRoute(mode: TravelMode): { route: Route; dest: Place } {
    const origin = this.loc.last?.p ?? DEMO_ORIGIN
    const route = parseRoute(demoRouteJson(origin, mode), mode, '演示目的地')
    return { route, dest: { name: '演示目的地', location: route.destination } }
  }

  startNavigation(route: Route, dest: Place, opts: { simulate?: boolean; simSpeed?: number } = {}): void {
    this.sim?.dispose()
    this.sim = undefined
    this.arrival = undefined
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer)
    this.applyRoute(route)
    this.session = {
      dest,
      startedAt: Date.now(),
      startDistance: this.trip.snapshot().distance,
      simulate: !!opts.simulate,
    }
    this.rerouteCount = 0
    if (dest.name !== '演示目的地') {
      pushHistory(this.settings, dest)
      void saveSettings(this.kv, this.settings)
    }
    if (opts.simulate) {
      const speed = opts.simSpeed ?? (route.mode === 'driving' ? 12 : route.mode === 'walking' ? 1.6 : 5)
      this.sim = new RouteSimulator(route, this.loc, speed)
      this.sim.start()
    }
    this.viewIndex = 0
    this.toast(`开始导航 · ${dest.name}`, 2500)
    this.changed()
  }

  private applyRoute(route: Route): void {
    this.route = route
    this.tracker = new RouteTracker(route)
    this.nav = this.loc.last ? this.tracker.update(this.loc.last) : undefined
    this.roadbookOffset = 0
  }

  stopNavigation(): void {
    this.sim?.dispose()
    this.sim = undefined
    this.route = undefined
    this.tracker = undefined
    this.nav = undefined
    this.session = undefined
    this.arrival = undefined
    this.viewIndex = 0
    this.changed()
  }

  setSimSpeed(mps: number): void {
    if (this.sim) this.sim.speed = mps
    this.changed()
  }

  simulateDetour(): void {
    this.sim?.detour()
  }

  private async reroute(manual: boolean): Promise<void> {
    if (this.rerouting || !this.route || !this.session) return
    const now = Date.now()
    if (!manual && (now - this.lastRerouteAt < 15_000 || this.rerouteCount >= 30)) return
    const from = this.loc.last?.p
    if (!from) return
    this.rerouting = true
    this.toast('偏离路线 · 正在重新规划', 6000)
    try {
      if (this.session.dest.name === '演示目的地') {
        // 演示路线无法在线重算：直接拉回原路线
        this.toast('演示路线：已回到路线', 2000)
      } else {
        const [r] = await this.planRoutes(this.session.dest, this.route.mode, from)
        this.applyRoute(r)
        if (this.sim) {
          const speed = this.sim.speed
          this.sim.dispose()
          this.sim = new RouteSimulator(r, this.loc, speed)
          this.sim.start()
        }
        this.toast('已重新规划路线', 2000)
      }
    } catch (e) {
      this.toast(`重新规划失败：${(e as Error).message}`, 4000)
    } finally {
      this.rerouting = false
      this.lastRerouteAt = Date.now()
      this.rerouteCount++
      this.changed()
    }
  }

  private async navigateHome(): Promise<void> {
    const start = this.trip.start
    if (!start) return this.toast('还没有记录起点')
    try {
      const mode = this.route?.mode ?? this.settings.travelMode
      const dest: Place = { name: '起点', location: start }
      const [r] = await this.planRoutes(dest, mode)
      this.startNavigation(r, dest, { simulate: !!this.sim })
    } catch (e) {
      this.toast(`返航规划失败：${(e as Error).message}`, 4000)
    }
  }

  private arrive(): void {
    const s = this.session
    const t = this.trip.snapshot()
    const elapsed = s ? (Date.now() - s.startedAt) / 1000 : t.elapsedSec
    const distance = this.route?.distance ?? (s ? t.distance - s.startDistance : t.distance)
    this.arrival = {
      name: this.route?.destName ?? '目的地',
      distance,
      elapsed,
      avg: elapsed > 0 ? distance / elapsed : 0,
    }
    this.sim?.dispose()
    this.sim = undefined
    this.viewIndex = 0
    this.arrivalTimer = setTimeout(() => this.finishArrival(), 90_000)
    this.changed()
  }

  finishArrival(): void {
    if (this.arrivalTimer) clearTimeout(this.arrivalTimer)
    this.stopNavigation()
  }

  // ── 周边雷达 ─────────────────────────────────────────────────────

  async scanRadar(nextCategory: boolean): Promise<void> {
    if (nextCategory) this.radar.category = (this.radar.category + 1) % RADAR_CATEGORIES.length
    const me = this.loc.last?.p
    if (!me) {
      this.radar = { ...this.radar, pois: [], error: '等待定位…', loading: false }
      return this.changed()
    }
    const cached = this.radarCache.get(this.radar.category)
    if (cached && Date.now() - cached.t < 5 * 60_000 && haversine(cached.p, me) < 200) {
      this.radar = { ...this.radar, pois: cached.pois, error: undefined, loading: false, fetchedAt: cached.t }
      return this.changed()
    }
    const cat = RADAR_CATEGORIES[this.radar.category]
    this.radar = { ...this.radar, loading: true, error: undefined }
    this.changed()
    try {
      const pois = await this.api.searchAround(me, { types: cat.types, keywords: cat.keywords, radius: 1500, pageSize: 10 })
      this.radarCache.set(this.radar.category, { p: me, t: Date.now(), pois })
      this.radar = { ...this.radar, pois, loading: false, fetchedAt: Date.now() }
    } catch (e) {
      this.radar = { ...this.radar, pois: [], loading: false, error: (e as Error).message, fetchedAt: Date.now() }
    }
    this.changed()
  }

  // ── 渲染 ─────────────────────────────────────────────────────────

  model(): HudModel {
    const now = Date.now()
    let view = this.view
    const toast = this.toastMsg && this.toastMsg.until > now ? this.toastMsg.text : undefined
    if (
      view === 'nav' && this.settings.focusMode && this.nav && this.route && !toast &&
      now > this.peekUntil && this.nav.distToManeuver > FOCUS_WAKE[this.route.mode]
    ) {
      view = 'focus'
    }
    return {
      now: new Date(now),
      t: now,
      view,
      viewIndex: this.viewIndex,
      viewCount: this.views().length,
      fix: this.loc.last,
      nav: this.nav,
      route: this.route,
      trip: this.trip.snapshot(),
      glasses: this.glasses,
      weather: this.weather,
      place: this.place,
      toast,
      headingUp: this.settings.headingUp,
      basemap: this.settings.basemap ? this.basemap.current : null,
      radar: this.radar,
      overviewZoom: this.overviewZoom,
      roadbookOffset: this.roadbookOffset,
      rerouting: this.rerouting,
      simulated: !!this.sim,
      hasKey: this.api.hasKey(),
      locationSource: this.loc.simulating ? 'sim' : this.loc.source,
      arrival: this.arrival,
    }
  }

  /** 状态变化时尽快重绘（合并 30ms 内的多次请求） */
  requestRender(): void {
    if (this.renderQueued) return
    this.renderQueued = true
    setTimeout(() => {
      this.renderQueued = false
      this.render()
    }, 30)
  }

  private scheduleRender(ms: number): void {
    if (this.renderTimer) clearTimeout(this.renderTimer)
    this.renderTimer = setTimeout(() => {
      this.render()
      this.scheduleRender(REFRESH_MS[this.settings.refresh])
    }, ms)
  }

  render(): void {
    const m = this.model()
    const ctx = this.frame.getContext('2d')!
    renderHud(ctx, m)
    if (this.display.mode === 'image') this.display.submit(this.frame)
    else this.display.submitText(buildTextFrame(m))
  }

  shutdown(): void {
    this.sim?.dispose()
    this.loc.stop()
    if (this.renderTimer) clearTimeout(this.renderTimer)
  }
}
