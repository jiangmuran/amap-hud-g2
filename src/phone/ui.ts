// 手机端 UI（运行在 Even App 的 WebView 里，也可在桌面浏览器中预览）。
// 采用 iOS 设计语言：大标题、Inset Grouped 列表、分段控件、开关、底部面板。

import type { Poi } from '../amap/api'
import type { HudApp } from '../app'
import type { MockBridge } from '../glasses/bridge'
import { maneuverIcon } from '../hud/gfx'
import { fmtClock, fmtDistStr, fmtDurationZh, fmtSpeed } from '../hud/format'
import { MANEUVER_LABEL, MODE_LABEL, type Route, type TravelMode } from '../nav/route'
import type { Place, RefreshProfile } from '../storage'
import { icon } from './icons'

const esc = (s: string | number | undefined | null) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

const MODES: TravelMode[] = ['walking', 'bicycling', 'electrobike', 'driving']
const MODE_ICON: Record<TravelMode, (s?: number) => string> = {
  walking: icon.walk,
  bicycling: icon.bike,
  electrobike: icon.scooter,
  driving: icon.car,
}

const MENU_ACTIONS = [
  { id: 1, name: '结束导航' },
  { id: 2, name: '重新规划' },
  { id: 3, name: '专注模式 开/关' },
  { id: 4, name: '地图朝向 切换' },
  { id: 5, name: '街道底图 开/关' },
  { id: 6, name: '周边扫描' },
  { id: 7, name: '返回起点' },
]

type SheetKind = 'place' | 'settings' | 'menu' | 'platform' | null

export class PhoneUI {
  private query = ''
  private results: Poi[] | null = null
  private searching = false
  private searchError = ''
  private selected?: Place
  private mode: TravelMode
  private routes: Route[] = []
  private routeIdx = 0
  private planning = false
  private planError = ''
  private sheet: SheetKind = null
  private raf = 0
  private mirrorCtx!: CanvasRenderingContext2D
  private toastTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private app: HudApp, private root: HTMLElement, private mock: MockBridge | null) {
    this.mode = app.settings.travelMode
  }

  mount(): void {
    this.root.innerHTML = `
      <header class="navbar" id="navbar">
        <div class="row">
          <span style="width:44px"></span>
          <span class="compact-title">导航</span>
          <button class="icon-btn" data-act="settings" aria-label="设置">${icon.gear()}</button>
        </div>
      </header>
      <main>
        <h1 class="large-title">导航</h1>
        <div class="subtitle" id="subtitle"></div>
        <div id="banner"></div>
        <section class="section">
          <div class="mirror-card">
            <div class="mirror-wrap"><canvas id="mirror" width="576" height="288" aria-label="眼镜画面镜像"></canvas></div>
            <div class="mirror-meta" id="mirror-meta"></div>
            <div class="pad" id="pad">
              <button data-in="prev">上一页<small>↑ 滑动</small></button>
              <button data-in="next">下一页<small>↓ 滑动</small></button>
              <button data-in="click">单击<small>操作</small></button>
              <button data-in="longpress">长按<small>唤醒</small></button>
              <button data-act="menu">菜单<small>单击+长按</small></button>
            </div>
          </div>
          <p class="section-footer">上方是眼镜实时画面。也可以用这里的按钮代替镜腿或戒指操作。</p>
        </section>
        <div id="nav-card"></div>
        <div class="searchbar">
          <label class="searchfield">
            ${icon.search()}
            <input id="q" type="search" enterkeyhint="search" placeholder="搜索地点" autocomplete="off" />
            <button class="clear" id="q-clear" hidden aria-label="清除"><span>${icon.xmark(9)}</span></button>
          </label>
          <button class="cancel-btn" id="q-cancel" hidden>取消</button>
        </div>
        <div id="content"></div>
      </main>
      <div class="backdrop" id="backdrop" hidden></div>
      <div class="sheet" id="sheet" role="dialog" aria-modal="true" hidden></div>
      <div class="toast-ui" id="toast"></div>
    `
    this.mirrorCtx = (this.root.querySelector('#mirror') as HTMLCanvasElement).getContext('2d')!
    this.bind()
    this.app.on(() => this.schedule())
    this.app.display.onShadowChange = () => {
      this.drawMirror()
      this.schedule()
    }
    this.drawMirror()
    this.render()
    const platform = this.app.settings.platform
    if (platform) applyPlatform(platform)
    else this.openSheet('platform')
  }

  // ── 事件绑定 ───────────────────────────────────────────────────

  private bind(): void {
    const $ = <T extends HTMLElement>(s: string) => this.root.querySelector(s) as T
    const navbar = $('#navbar')
    window.addEventListener('scroll', () => navbar.classList.toggle('scrolled', window.scrollY > 40), { passive: true })

    const q = $<HTMLInputElement>('#q')
    const clear = $('#q-clear')
    const cancel = $('#q-cancel')
    q.addEventListener('input', () => {
      this.query = q.value
      clear.hidden = !q.value
    })
    q.addEventListener('focus', () => (cancel.hidden = false))
    q.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        q.blur()
        void this.doSearch()
      }
    })
    clear.addEventListener('click', (e) => {
      e.preventDefault()
      q.value = ''
      this.query = ''
      clear.hidden = true
      this.results = null
      this.render()
      q.focus()
    })
    cancel.addEventListener('click', () => {
      q.value = ''
      this.query = ''
      clear.hidden = true
      cancel.hidden = true
      this.results = null
      this.searchError = ''
      q.blur()
      this.render()
    })

    this.root.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-act],[data-in],[data-poi],[data-place],[data-mode],[data-route]')
      if (!t) return
      if (t.dataset.in) {
        this.app.handleInput({ kind: t.dataset.in as 'prev' })
        return
      }
      if (t.dataset.poi !== undefined) {
        const p = this.results?.[Number(t.dataset.poi)]
        if (p) this.openPlace(p)
        return
      }
      if (t.dataset.place !== undefined) {
        const key = t.dataset.place
        const s = this.app.settings
        const p = key === 'home' ? s.home : key === 'work' ? s.work : s.history[Number(key)]
        if (p) this.openPlace(p)
        else this.showToast(key === 'home' ? '搜索地点后可「设为家」' : '搜索地点后可「设为公司」')
        return
      }
      if (t.dataset.mode) {
        this.mode = t.dataset.mode as TravelMode
        void this.app.updateSettings({ travelMode: this.mode })
        if (this.selected) void this.plan()
        this.renderSheet()
        return
      }
      if (t.dataset.route !== undefined) {
        this.routeIdx = Number(t.dataset.route)
        this.renderSheet()
        return
      }
      this.onAction(t.dataset.act!, t)
    })

    $('#backdrop').addEventListener('click', () => {
      if (this.sheet !== 'platform') this.closeSheet()
    })

    // 桌面浏览器快捷键
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement).tagName === 'INPUT') return
      const map: Record<string, 'prev' | 'next' | 'click' | 'double' | 'longpress'> = {
        ArrowUp: 'prev', ArrowLeft: 'prev', ArrowDown: 'next', ArrowRight: 'next',
        Enter: 'click', ' ': 'click', l: 'longpress', d: 'double',
      }
      const k = map[e.key]
      if (k) {
        e.preventDefault()
        this.app.handleInput({ kind: k })
      }
    })
  }

  private onAction(act: string, el: HTMLElement): void {
    const s = this.app.settings
    switch (act) {
      case 'settings': return this.openSheet('settings')
      case 'menu': return this.openSheet('menu')
      case 'close': return this.closeSheet()
      case 'menu-item':
        this.app.handleInput({ kind: 'menu', id: Number(el.dataset.id) })
        return this.closeSheet()
      case 'start': return this.start()
      case 'platform':
        void this.choosePlatform(el.dataset.v as 'ios' | 'android')
        return
      case 'stop':
        this.app.stopNavigation()
        return this.showToast('导航已结束')
      case 'set-home':
      case 'set-work':
        if (this.selected) {
          const p: Place = { name: this.selected.name, address: this.selected.address, location: this.selected.location }
          void this.app.updateSettings(act === 'set-home' ? { home: p } : { work: p })
          this.showToast(act === 'set-home' ? '已设为家' : '已设为公司')
          this.renderSheet()
        }
        return
      case 'test-key': return void this.testKey()
      case 'toggle': {
        const key = el.dataset.key as 'basemap' | 'headingUp' | 'focusMode'
        const input = el.querySelector('input') as HTMLInputElement | null
        if (input && el !== input) return
        void this.app.updateSettings({ [key]: !s[key] })
        return
      }
      case 'refresh':
        this.commitSettingsInputs()
        void this.app.updateSettings({ refresh: el.dataset.v as RefreshProfile })
        return this.renderSheet()
      case 'clear-history':
        void this.app.updateSettings({ history: [] })
        return
      case 'view':
        this.app.setView(el.dataset.v as never)
        return
    }
  }

  // ── 搜索与规划 ─────────────────────────────────────────────────

  private async doSearch(): Promise<void> {
    const q = this.query.trim()
    if (!q) return
    if (!this.app.api.hasKey()) {
      this.searchError = '需要先在设置中填写高德 Web 服务 Key'
      this.results = []
      return this.render()
    }
    this.searching = true
    this.searchError = ''
    this.render()
    try {
      this.results = await this.app.search(q)
    } catch (e) {
      this.results = []
      this.searchError = (e as Error).message
    } finally {
      this.searching = false
      this.render()
    }
  }

  private openPlace(p: Place): void {
    this.selected = p
    this.routes = []
    this.routeIdx = 0
    this.planError = ''
    this.openSheet('place')
    void this.plan()
  }

  private async plan(): Promise<void> {
    if (!this.selected) return
    this.planning = true
    this.planError = ''
    this.renderSheet()
    try {
      this.routes = await this.app.planRoutes(this.selected, this.mode)
      this.routeIdx = 0
    } catch (e) {
      this.routes = []
      this.planError = (e as Error).message
    } finally {
      this.planning = false
      this.renderSheet()
    }
  }

  private start(): void {
    const r = this.routes[this.routeIdx]
    if (!r || !this.selected) return
    this.app.startNavigation(r, this.selected)
    this.closeSheet()
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }

  private async testKey(): Promise<void> {
    const input = this.root.querySelector<HTMLInputElement>('#key-input')
    const base = this.root.querySelector<HTMLInputElement>('#base-input')
    if (input) await this.app.updateSettings({ amapKey: input.value.trim(), apiBase: base?.value.trim() ?? '' })
    try {
      const r = await this.app.api.regeo(this.app.loc.last?.p ?? [116.397428, 39.90923])
      this.showToast(`Key 可用 · ${r.city || r.address}`)
    } catch (e) {
      this.showToast(`Key 不可用：${(e as Error).message}`)
    }
    this.renderSheet()
  }

  // ── 渲染 ───────────────────────────────────────────────────────

  private schedule(): void {
    if (this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.render()
      if (this.sheet === 'settings') this.renderDiagnostics()
    })
  }

  private drawMirror(): void {
    const ctx = this.mirrorCtx
    ctx.globalCompositeOperation = 'source-over'
    ctx.drawImage(this.app.display.shadow, 0, 0)
    // 灰度 → G2 绿
    ctx.globalCompositeOperation = 'multiply'
    ctx.fillStyle = '#3cfa44'
    ctx.fillRect(0, 0, 576, 288)
    ctx.globalCompositeOperation = 'source-over'
  }

  render(): void {
    this.renderStatus()
    this.renderNavCard()
    this.renderContent()
  }

  private renderStatus(): void {
    const app = this.app
    const g = app.glasses
    const src = { host: 'GPS', browser: '浏览器定位', sim: '模拟定位', none: '无定位' }[app.model().locationSource] ?? '无定位'
    const glass = this.mock
      ? '<span class="dot warn"></span>浏览器预览'
      : `<span class="dot ${g.connected ? 'on' : ''}"></span>${g.connected ? `眼镜已连接${g.battery !== undefined ? ` · ${g.battery}%` : ''}` : '眼镜未连接'}`
    const fix = app.loc.last
    this.root.querySelector('#subtitle')!.innerHTML = `${glass}<span>·</span><span>${src}${fix ? ` ±${Math.round(fix.accuracy)}m` : ''}</span>`

    const banner = this.root.querySelector('#banner')!
    let bannerHtml = ''
    if (!app.api.hasKey()) {
      bannerHtml = `<div class="banner">${icon.key(20)}<div class="grow"><b>尚未设置高德 Key</b><br><span style="color:var(--label-2)">搜索与路线规划需要「Web服务」类型的 Key，点右侧去填写。</span></div><button class="link" data-act="settings">设置</button></div>`
    } else if (app.display.mode === 'text') {
      bannerHtml = `<div class="banner">${icon.glasses(20)}<div class="grow"><b>眼镜已切换到文本模式</b><br><span style="color:var(--label-2)">宿主图像通道异常（已知问题），重启应用可恢复图形界面。</span></div></div>`
    }
    if (bannerHtml !== this.bannerHtml) banner.innerHTML = this.bannerHtml = bannerHtml

    const st = app.display.stats
    this.root.querySelector('#mirror-meta')!.innerHTML =
      `<span>${esc(viewName(app.model().view))}</span><span class="mono">${st.tilesLastFrame}/4 图块 · ${Math.round(st.lastFrameMs)}ms</span>`
  }

  private renderNavCard(): void {
    const el = this.root.querySelector('#nav-card')!
    const app = this.app
    const nav = app.nav
    const route = app.route
    const structure = app.arrival ? 'arrival' : route ? `nav:${route.createdAt}` : 'none'
    if (structure === this.navKey && route && !app.arrival) return this.updateNavCard()
    this.navKey = structure
    this.lastManeuver = ''
    if (app.arrival) {
      const a = app.arrival
      el.innerHTML = `<section class="section"><div class="nav-card">
        <div class="nav-head"><div class="maneuver-badge" style="background:var(--green)">${icon.pin(28)}</div>
        <div class="grow" style="min-width:0"><div class="nav-dist" style="font-size:28px">已到达</div><div class="nav-road">${esc(a.name)}</div></div></div>
        <div class="stats" style="margin-top:16px">
          <div class="stat"><div class="v">${fmtDurationZh(a.elapsed)}</div><div class="k">用时</div></div>
          <div class="stat"><div class="v">${fmtDistStr(a.distance)}</div><div class="k">距离</div></div>
          <div class="stat"><div class="v">${fmtSpeed(a.avg)}</div><div class="k">均速 km/h</div></div>
        </div>
        <button class="btn gray" data-act="stop">完成</button></div></section>`
      return
    }
    if (!route) {
      el.innerHTML = ''
      return
    }
    void nav
    el.innerHTML = `<section class="section">
      <div class="section-header prominent" style="display:flex;justify-content:space-between;align-items:baseline">
        <span>前往 ${esc(route.destName)}</span><span style="font-size:15px;color:var(--label-2);font-weight:400">${MODE_LABEL[route.mode]}</span>
      </div>
      <div class="nav-card">
        <div class="nav-head">
          <div class="maneuver-badge"><canvas width="80" height="80" id="mv"></canvas></div>
          <div class="grow" style="min-width:0">
            <div class="nav-dist"><span data-f="dv"></span><small data-f="du"></small> <small data-f="mv"></small></div>
            <div class="nav-road" data-f="road"></div>
          </div>
        </div>
        <div class="progress"><div data-f="prog" style="width:0%"></div></div>
        <div class="stats">
          <div class="stat"><div class="v" data-f="rem">--</div><div class="k">剩余</div></div>
          <div class="stat"><div class="v" data-f="dur">--</div><div class="k">预计用时</div></div>
          <div class="stat"><div class="v" data-f="eta">--</div><div class="k">到达时间</div></div>
        </div>
        <div class="btn-row">
          <button class="btn destructive" data-act="stop">${icon.stop(14)}结束导航</button>
        </div>
      </div>
    </section>`
    this.updateNavCard()
  }

  /** 导航卡片结构不变时只更新文本，避免每秒重建 DOM 吞掉点击 */
  private updateNavCard(): void {
    const el = this.root.querySelector('#nav-card')!
    const { nav, route } = this.app
    if (!route) return
    const set = (f: string, v: string) => {
      const n = el.querySelector<HTMLElement>(`[data-f="${f}"]`)
      if (n && n.textContent !== v) n.textContent = v
    }
    const dist = nav ? fmtDistStr(nav.distToManeuver) : '--'
    const m = dist.match(/^([\d.]+)(\D+)$/)
    set('dv', m ? m[1] : dist)
    set('du', m ? m[2] : '')
    set('mv', nav ? (nav.maneuver === 'arrive' ? '到达' : MANEUVER_LABEL[nav.maneuver]) : '')
    set('road', nav ? (nav.maneuver === 'arrive' ? route.destName : nav.nextStep?.road || nav.nextStep?.instruction || '') : '等待定位…')
    set('rem', nav ? fmtDistStr(nav.remaining) : '--')
    set('dur', nav ? fmtDurationZh(nav.etaSec) : '--')
    set('eta', nav ? fmtClock(new Date(Date.now() + nav.etaSec * 1000)) : '--')
    const prog = el.querySelector<HTMLElement>('[data-f="prog"]')
    if (prog) prog.style.width = `${((nav?.progress ?? 0) * 100).toFixed(1)}%`
    const cv = el.querySelector<HTMLCanvasElement>('#mv')
    if (cv && nav && nav.maneuver !== this.lastManeuver) {
      this.lastManeuver = nav.maneuver
      const c = cv.getContext('2d')!
      c.clearRect(0, 0, 80, 80)
      maneuverIcon(c, nav.maneuver, 40, 40, 66, 15)
    }
  }

  private contentKey = ''
  private bannerHtml = '-'
  private navKey = ''
  private lastManeuver = ''

  private renderContent(): void {
    const el = this.root.querySelector('#content')!
    const active = document.activeElement
    if (active && el.contains(active)) return
    const s0 = this.app.settings
    const key = JSON.stringify([
      this.searching, this.searchError, this.results?.map((p) => p.id || p.name) ?? null,
      s0.home?.name, s0.work?.name, s0.history.map((h) => h.name), this.app.views(), this.app.view,
    ])
    if (key === this.contentKey) return
    this.contentKey = key
    if (this.searching) {
      el.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`
      return
    }
    if (this.results) {
      if (!this.results.length) {
        el.innerHTML = `<div class="empty-state">${esc(this.searchError || '没有找到相关地点')}</div>`
        return
      }
      el.innerHTML = `<section class="section"><div class="group with-icon">
        ${this.results.map((p, i) => `
          <button class="cell" data-poi="${i}">
            <div class="badge-icon red">${icon.pin(17)}</div>
            <div class="grow"><div class="title">${esc(p.name)}</div><div class="sub">${esc(p.address || p.type || '')}</div></div>
            ${p.distance !== undefined ? `<span class="detail">${fmtDistStr(p.distance)}</span>` : ''}
            <span class="accessory">${icon.chevronRight()}</span>
          </button>`).join('')}
      </div><p class="section-footer">搜索消耗「基础搜索」配额（个人每月 5000 次）</p></section>`
      return
    }
    const s = this.app.settings
    const history = s.history.slice(0, 6)
    el.innerHTML = `
      <section class="section">
        <div class="section-header prominent">快捷前往</div>
        <div class="quick">
          <button data-place="home"><span class="q-ic ${s.home ? '' : 'empty'}" style="${s.home ? 'background:var(--tint)' : ''}">${icon.house(24)}</span><span class="t">${s.home ? '家' : '添加家'}</span></button>
          <button data-place="work"><span class="q-ic ${s.work ? '' : 'empty'}" style="${s.work ? 'background:var(--orange)' : ''}">${icon.briefcase(24)}</span><span class="t">${s.work ? '公司' : '添加公司'}</span></button>
        </div>
      </section>
      ${history.length ? `<section class="section">
        <div class="section-header" style="display:flex;justify-content:space-between"><span>最近</span><button class="link" style="text-transform:none" data-act="clear-history">清除</button></div>
        <div class="group with-icon">
          ${history.map((p, i) => `<button class="cell" data-place="${i}">
            <div class="badge-icon gray">${icon.clock(17)}</div>
            <div class="grow"><div class="title">${esc(p.name)}</div>${p.address ? `<div class="sub">${esc(p.address)}</div>` : ''}</div>
            <span class="accessory">${icon.chevronRight()}</span></button>`).join('')}
        </div></section>` : ''}
      <section class="section">
        <div class="section-header">眼镜视图</div>
        <div class="group with-icon">
          ${this.app.views().map((v) => `<button class="cell" data-act="view" data-v="${v}">
            <div class="badge-icon ${v === this.app.view ? 'blue' : 'gray'}">${icon.glasses(17)}</div>
            <div class="grow"><div class="title">${viewName(v)}</div><div class="sub">${viewDesc(v)}</div></div>
            ${v === this.app.view ? '<span class="detail" style="color:var(--tint)">当前</span>' : ''}</button>`).join('')}
        </div>
        <p class="section-footer">在眼镜上前后滑动切换视图，单击执行视图内操作，单击后长按打开菜单，双击退出。</p>
      </section>`
  }

  // ── 底部面板 ───────────────────────────────────────────────────

  private openSheet(kind: SheetKind): void {
    this.sheet = kind
    const sheet = this.root.querySelector<HTMLElement>('#sheet')!
    const backdrop = this.root.querySelector<HTMLElement>('#backdrop')!
    sheet.hidden = false
    backdrop.hidden = false
    this.renderSheet()
    requestAnimationFrame(() => {
      sheet.classList.add('show')
      backdrop.classList.add('show')
    })
  }

  private closeSheet(): void {
    const sheet = this.root.querySelector<HTMLElement>('#sheet')!
    const backdrop = this.root.querySelector<HTMLElement>('#backdrop')!
    if (this.sheet === 'settings') this.commitSettingsInputs()
    this.sheet = null
    sheet.classList.remove('show')
    backdrop.classList.remove('show')
    setTimeout(() => {
      if (!this.sheet) {
        sheet.hidden = true
        backdrop.hidden = true
      }
    }, 380)
  }

  private commitSettingsInputs(): void {
    const key = this.root.querySelector<HTMLInputElement>('#key-input')
    const base = this.root.querySelector<HTMLInputElement>('#base-input')
    if (key && (key.value.trim() !== this.app.settings.amapKey || (base?.value.trim() ?? '') !== this.app.settings.apiBase)) {
      void this.app.updateSettings({ amapKey: key.value.trim(), apiBase: base?.value.trim() ?? '' })
    }
  }

  private renderSheet(): void {
    const sheet = this.root.querySelector<HTMLElement>('#sheet')!
    if (this.sheet === 'place') sheet.innerHTML = this.placeSheet()
    else if (this.sheet === 'settings') {
      sheet.innerHTML = this.settingsSheet()
      this.renderDiagnostics()
    } else if (this.sheet === 'menu') sheet.innerHTML = this.menuSheet()
    else if (this.sheet === 'platform') sheet.innerHTML = this.platformSheet()
  }

  private modeSegment(): string {
    return `<div class="segmented" role="tablist">${MODES.map((m, i) => {
      const on = m === this.mode
      const afterOn = i > 0 && MODES[i - 1] === this.mode
      return `<button role="tab" aria-selected="${on}" class="${on ? 'on' : ''} ${afterOn ? 'after-on' : ''}" data-mode="${m}">${MODE_ICON[m](14)}${MODE_LABEL[m]}</button>`
    }).join('')}</div>`
  }

  private placeSheet(): string {
    const p = this.selected
    if (!p) return ''
    const me = this.app.loc.last?.p
    let routesHtml: string
    if (this.planning) routesHtml = `<div class="empty-state"><div class="spinner"></div></div>`
    else if (this.planError)
      routesHtml = `<div class="empty-state">${esc(this.planError)}</div>`
    else
      routesHtml = `<div class="group">${this.routes.map((r, i) => `
        <button class="cell route-opt ${i === this.routeIdx ? 'on' : ''}" data-route="${i}">
          <div class="grow">
            <div class="big">${fmtDurationZh(r.duration)}</div>
            <div class="sub">${fmtDistStr(r.distance)}${r.lights ? ` · ${r.lights} 个红绿灯` : ''}${r.tolls ? ` · 过路费 ¥${r.tolls}` : ''} · ${r.steps.length} 个路段</div>
          </div>
          <span class="check"></span>
        </button>`).join('')}</div>`
    const fav = `<div class="btn-row" style="margin-top:10px">
        <button class="btn gray" data-act="set-home">${icon.house(18)}设为家</button>
        <button class="btn gray" data-act="set-work">${icon.briefcase(18)}设为公司</button></div>`
    return `
      <div class="grabber"></div>
      <div class="sheet-head"><span class="side"></span><h2></h2><span class="side r"><button class="circle-btn" data-act="close" aria-label="关闭">${icon.xmark(12)}</button></span></div>
      <div class="sheet-body">
        <div class="place-head">
          <h3>${esc(p.name)}</h3>
          <p>${esc(p.address || '')}${me ? ` · 距你 ${fmtDistStr(haversineSafe(me, p.location))}` : ''}</p>
        </div>
        <div class="section">${this.modeSegment()}</div>
        <div class="section"><div class="section-header">路线</div>${routesHtml}</div>
        <div class="section">
          <div class="btn-row">
            <button class="btn filled" data-act="start" ${this.routes.length ? '' : 'disabled'}>${icon.play(14)}开始导航</button>
          </div>
          ${fav}
        </div>
      </div>`
  }

  private platformSheet(): string {
    return `
      <div class="grabber"></div>
      <div class="sheet-body" style="padding-top:12px">
        <div class="place-head" style="text-align:center">
          <div style="display:grid;place-items:center;margin:4px auto 14px;width:64px;height:64px;border-radius:16px;background:var(--tint);color:#fff">${icon.glasses(34)}</div>
          <h3>欢迎使用 AMAP HUD</h3>
          <p>请选择你的手机系统，用于定位坐标处理与权限指引</p>
        </div>
        <div class="section"><div class="group with-icon">
          <button class="cell" data-act="platform" data-v="ios"><div class="badge-icon gray">${icon.phone(18)}</div><div class="grow"><div class="title">iPhone</div><div class="sub">iOS</div></div><span class="accessory">${icon.chevronRight()}</span></button>
          <button class="cell" data-act="platform" data-v="android"><div class="badge-icon green">${icon.phone(18)}</div><div class="grow"><div class="title">安卓</div><div class="sub">Android</div></div><span class="accessory">${icon.chevronRight()}</span></button>
        </div>
        <p class="section-footer">之后可以在「设置 → 手机系统」中修改。</p></div>
      </div>`
  }

  private async choosePlatform(v: 'ios' | 'android'): Promise<void> {
    // 两个系统的系统定位都是 WGS-84，统一本地转换为 GCJ-02
    await this.app.updateSettings({ platform: v, locationIsWgs: true })
    applyPlatform(v)
    if (this.sheet === 'platform') {
      this.closeSheet()
      this.showToast(v === 'ios' ? '已设为 iPhone' : '已设为安卓')
    } else this.renderSheet()
  }

  private menuSheet(): string {
    return `
      <div class="grabber"></div>
      <div class="sheet-head"><span class="side"></span><h2>眼镜菜单</h2><span class="side r"><button class="link" data-act="close">完成</button></span></div>
      <div class="sheet-body">
        <div class="section"><div class="group">
          ${MENU_ACTIONS.map((m) => `<button class="cell" data-act="menu-item" data-id="${m.id}"><div class="grow">${m.name}</div></button>`).join('')}
        </div>
        <p class="section-footer">与眼镜上「单击后长按」弹出的菜单相同。</p></div>
      </div>`
  }

  private toggleCell(key: 'basemap' | 'headingUp' | 'focusMode', title: string, badge: string, color: string, sub = ''): string {
    const on = this.app.settings[key]
    return `<label class="cell">
      <div class="badge-icon ${color}">${badge}</div>
      <div class="grow"><div class="title">${title}</div>${sub ? `<div class="sub">${sub}</div>` : ''}</div>
      <span class="switch" data-act="toggle" data-key="${key}"><input type="checkbox" ${on ? 'checked' : ''} aria-label="${title}" data-act="toggle" data-key="${key}"><span></span></span>
    </label>`
  }

  private settingsSheet(): string {
    const s = this.app.settings
    const refresh: [RefreshProfile, string][] = [['eco', '省电'], ['standard', '标准'], ['fast', '流畅']]
    return `
      <div class="grabber"></div>
      <div class="sheet-head"><span class="side"></span><h2>设置</h2><span class="side r"><button class="link" style="font-weight:600" data-act="close">完成</button></span></div>
      <div class="sheet-body">
        <div class="section">
          <div class="section-header">高德开放平台</div>
          <div class="group">
            <label class="cell"><span>Key</span><input class="text-field" id="key-input" value="${esc(s.amapKey)}" placeholder="Web服务 Key" autocomplete="off" autocapitalize="off" spellcheck="false" style="font-family:var(--mono);font-size:15px"></label>
            <label class="cell"><span>接口地址</span><input class="text-field" id="base-input" value="${esc(s.apiBase)}" placeholder="restapi.amap.com" autocomplete="off" autocapitalize="off" spellcheck="false"></label>
            <button class="cell" data-act="test-key"><span class="link">保存并测试</span></button>
          </div>
          <p class="section-footer">在 lbs.amap.com 控制台创建「Web服务」类型的 Key。接口地址留空即直连高德；如需隐藏 Key 或使用数字签名，可填自建代理。</p>
        </div>

        <div class="section">
          <div class="section-header">眼镜显示</div>
          <div class="group with-icon">
            ${this.toggleCell('basemap', '街道底图', icon.pin(17), 'green', '局部地图叠加道路线框')}
            ${this.toggleCell('headingUp', '车头朝上', icon.location(15), 'blue', '关闭后为正北朝上')}
            ${this.toggleCell('focusMode', '专注模式', icon.glasses(17), 'indigo', '远离转向时熄屏，接近时自动亮起')}
            <div class="cell"><div class="badge-icon orange">${icon.clock(17)}</div><div class="grow">刷新频率</div>
              <div class="segmented" style="width:168px">${refresh.map(([v, l]) => `<button class="${s.refresh === v ? 'on' : ''}" data-act="refresh" data-v="${v}">${l}</button>`).join('')}</div>
            </div>
          </div>
          <p class="section-footer">每次刷新只发送有变化的画面区域。「省电」约 2 秒一次，「流畅」会更快消耗眼镜电量。</p>
        </div>

        <div class="section">
          <div class="section-header">手机系统</div>
          <div class="group">
            <div class="cell"><div class="grow">系统</div>
              <div class="segmented" style="width:180px">${(['ios', 'android'] as const).map((v) => `<button class="${s.platform === v ? 'on' : ''}" data-act="platform" data-v="${v}">${v === 'ios' ? 'iPhone' : '安卓'}</button>`).join('')}</div>
            </div>
          </div>
          <p class="section-footer">${esc(platformHint(s.platform))}</p>
        </div>

        <div class="section">
          <div class="section-header">本月用量 · 个人认证额度</div>
          <div class="group" id="quota"></div>
          <p class="section-footer">本机统计，仅供参考。个人认证免费额度自认证起 1 年有效，且仅限非商业用途。</p>
        </div>

        <div class="section">
          <div class="section-header">诊断</div>
          <div class="group" id="diag"></div>
        </div>
      </div>`
  }

  private renderDiagnostics(): void {
    const quota = this.root.querySelector('#quota')
    const label: Record<string, string> = { lbs: '基础 LBS（路线/地址/底图）', search: '基础搜索（搜索/周边）', weather: '天气' }
    if (quota) {
      quota.innerHTML = this.app.quota.snapshot().map((q) => {
        const pct = Math.min(100, (q.used / q.limit) * 100)
        const cls = pct > 90 ? 'crit' : pct > 70 ? 'warn' : ''
        return `<div class="cell" style="display:block"><div style="display:flex;justify-content:space-between"><span>${label[q.bucket]}</span><span class="detail" style="font-size:15px">${q.used.toLocaleString()} / ${q.limit.toLocaleString()}</span></div><div class="quota-bar"><div class="${cls}" style="width:${pct.toFixed(2)}%"></div></div></div>`
      }).join('')
    }
    const diag = this.root.querySelector('#diag')
    if (diag) {
      const st = this.app.display.stats
      const rows: [string, string][] = [
        ['运行环境', this.mock ? '浏览器预览（Mock）' : 'Even App'],
        ['显示模式', this.app.display.mode === 'image' ? '图形' : '文本（兜底）'],
        ['图块发送', `${st.sends} 次 · 失败 ${st.failures}`],
        ['平均耗时', `${Math.round(st.avgSendMs)} ms / 图块`],
        ['街道底图', this.app.basemap.lastError ?? (this.app.basemap.current ? `z${this.app.basemap.current.zoom} 已加载` : '未加载')],
      ]
      diag.innerHTML = rows.map(([k, v]) => `<div class="cell"><span class="grow">${k}</span><span class="detail" style="font-size:15px">${esc(v)}</span></div>`).join('')
    }
  }

  showToast(msg: string): void {
    const t = this.root.querySelector<HTMLElement>('#toast')!
    t.textContent = msg
    t.classList.add('show')
    if (this.toastTimer) clearTimeout(this.toastTimer)
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 2200)
  }
}

function haversineSafe(a: [number, number], b: [number, number]): number {
  const R = 6378137
  const dLat = ((b[1] - a[1]) * Math.PI) / 180
  const dLng = ((b[0] - a[0]) * Math.PI) / 180
  const s = Math.sin(dLat / 2) ** 2 + Math.cos((a[1] * Math.PI) / 180) * Math.cos((b[1] * Math.PI) / 180) * Math.sin(dLng / 2) ** 2
  return 2 * R * Math.asin(Math.sqrt(s))
}

function viewName(v: string): string {
  return ({ nav: '导航', overview: '全局地图', roadbook: '路书', telemetry: '仪表', radar: '周边雷达', cruise: '巡航', arrival: '到达', focus: '专注' } as Record<string, string>)[v] ?? v
}

function viewDesc(v: string): string {
  return ({
    nav: '转向指引 + 局部雷达地图',
    overview: '全程路线，单击切换附近',
    roadbook: '后续路段列表，单击翻页',
    telemetry: '速度表、行程、海拔、航向',
    radar: '附近地铁/卫生间/便利店…',
    cruise: '罗盘航向带、地址、天气、返航',
    arrival: '到达与行程总结',
  } as Record<string, string>)[v] ?? ''
}

function applyPlatform(p: 'ios' | 'android'): void {
  document.documentElement.dataset.platform = p
}

function platformHint(p: '' | 'ios' | 'android' | undefined): string {
  if (p === 'android')
    return '请在 系统设置 → 应用 → Even → 权限 → 位置 中选择「仅在使用中允许」并开启「使用确切位置」；建议关闭 Even 的电池优化，避免导航中被系统挂起。'
  return '请在 iPhone 设置 → Even → 位置 中选择「使用 App 期间」并开启「精确位置」。'
}
