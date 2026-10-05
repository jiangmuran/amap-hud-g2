// 眼镜显示驱动。
//
// 图像模式：一个全屏的透明文本容器负责接收输入（图片容器不能捕获事件），
// 上面铺 2×2 共 4 个 288×144 的图片容器，拼成完整的 576×288 画布。
// 每帧把画布量化成 16 级灰度，按图块计算哈希，只发送有变化的图块。
// 发送严格串行；发送期间到来的新帧会被合并，始终发送最新内容。
//
// 文本模式（兜底）：已知宿主缺陷——退出确认框弹出又取消后，图片通道会
// 永久返回 sendFailed（1-3ms 立即失败），只能重启应用。检测到后自动切换到
// 纯文本 HUD，保证导航仍然可用。

import {
  CreateStartUpPageContainer,
  ImageContainerProperty,
  ListContainerProperty,
  ListItemContainerProperty,
  ImageRawDataUpdate,
  ImageRawDataUpdateResult,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  StartUpPageCreateResult,
  TextContainerProperty,
  TextContainerUpgrade,
} from '@evenrealities/even_hub_sdk'
import type { HubBridge } from './bridge'

export const SCREEN_W = 576
export const SCREEN_H = 288
const TILE_W = 288
const TILE_H = 144

const TILES = [
  { id: 2, name: 'tile-tl', x: 0, y: 0 },
  { id: 3, name: 'tile-tr', x: TILE_W, y: 0 },
  { id: 4, name: 'tile-bl', x: 0, y: TILE_H },
  { id: 5, name: 'tile-br', x: TILE_W, y: TILE_H },
]

const TEXT_SLOTS = [
  { id: 11, name: 'txt-head', x: 0, y: 0, w: SCREEN_W, h: 44 },
  { id: 12, name: 'txt-main', x: 0, y: 44, w: SCREEN_W, h: 196 },
  { id: 13, name: 'txt-foot', x: 0, y: 240, w: SCREEN_W, h: 48 },
]

export interface MenuItem {
  id: number
  name: string
}

export interface TextFrame {
  head: string
  main: string
  foot: string
}

export type DisplayMode = 'image' | 'text'

/** 原生列表选择页（固件渲染，滑动移动高亮，单击选中） */
export interface ListPage {
  title: string
  items: string[]
}

const LIST_TITLE = { id: 21, name: 'list-title' }
const LIST_BODY = { id: 22, name: 'list-body' }

export interface DisplayStats {
  /** 各图块累计发送次数（左上、右上、左下、右下） */
  perTile: number[]
  /** 最近一次「操作 → 画面发完」的耗时 */
  inputLatencyMs: number
  sends: number
  failures: number
  lastFrameMs: number
  avgSendMs: number
  tilesLastFrame: number
}

export function createCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  return c
}

function ctx2d(c: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = c.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('canvas 2d unavailable')
  return ctx
}

export class GlassesDisplay {
  mode: DisplayMode = 'image'
  ready = false
  /** 宿主模态层（退出确认）显示期间暂停发送：此时发送必然失败，不能算作通道损坏 */
  private paused = false
  readonly stats: DisplayStats = { perTile: [0, 0, 0, 0], inputLatencyMs: 0, sends: 0, failures: 0, lastFrameMs: 0, avgSendMs: 0, tilesLastFrame: 0 }
  /** 已成功发送到眼镜的画面（手机端镜像预览用） */
  readonly shadow = createCanvas(SCREEN_W, SCREEN_H)
  onShadowChange?: () => void
  onModeChange?: (m: DisplayMode) => void

  private frame = createCanvas(SCREEN_W, SCREEN_H)
  private tileCanvases: HTMLCanvasElement[] = []
  private sent: (number | null)[] = TILES.map(() => null)
  private dirty = false
  private pumping = false
  private startCalled = false
  private fastFails = 0
  private lastRebuildAt = 0
  private textSent: TextFrame = { head: '', main: '', foot: '' }
  private textPending: TextFrame | null = null
  /** 非空时显示原生列表页，HUD 帧暂存不发送 */
  private list: ListPage | null = null
  /** 用户操作发生的时间，帧发完时用来计算响应耗时 */
  private inputAt = 0

  markInput(): void {
    this.inputAt = performance.now()
    this.boostStart = performance.now()
    this.boostUntil = performance.now() + 1500
  }

  get listOpen(): boolean {
    return this.list !== null
  }

  constructor(private bridge: HubBridge, private menu: MenuItem[]) {
    const s = ctx2d(this.shadow)
    s.fillStyle = '#000'
    s.fillRect(0, 0, SCREEN_W, SCREEN_H)
  }

  private menuObject(): MenuContainerProperty | undefined {
    if (!this.menu.length) return undefined
    return new MenuContainerProperty({
      menuItems: this.menu.slice(0, 10).map((m) => new MenuItemProperty({ itemID: m.id, itemName: m.name })),
    })
  }

  private imagePage() {
    const eventLayer = new TextContainerProperty({
      xPosition: 0,
      yPosition: 0,
      width: SCREEN_W,
      height: SCREEN_H,
      borderWidth: 0,
      borderColor: 0,
      paddingLength: 0,
      containerID: 1,
      containerName: 'input',
      content: ' ',
      isEventCapture: 1,
      zOrderIndex: 0,
    })
    const images = TILES.map(
      (t, i) =>
        new ImageContainerProperty({
          xPosition: t.x,
          yPosition: t.y,
          width: TILE_W,
          height: TILE_H,
          containerID: t.id,
          containerName: t.name,
          zOrderIndex: i + 1,
        }),
    )
    return { containerTotalNum: 1 + images.length, textObject: [eventLayer], imageObject: images, menuObject: this.menuObject() }
  }

  private textPage() {
    const texts = TEXT_SLOTS.map(
      (t, i) =>
        new TextContainerProperty({
          xPosition: t.x,
          yPosition: t.y,
          width: t.w,
          height: t.h,
          borderWidth: i === 1 ? 1 : 0,
          borderColor: 6,
          borderRadius: 6,
          paddingLength: 6,
          containerID: t.id,
          containerName: t.name,
          content: i === 1 ? '导航 HUD · 文本模式' : ' ',
          isEventCapture: i === 1 ? 1 : 0,
          textColor: i === 1 ? 4 : 3,
          zOrderIndex: i,
        }),
    )
    return { containerTotalNum: texts.length, textObject: texts, menuObject: this.menuObject() }
  }

  private listPage(l: ListPage) {
    const items = l.items.slice(0, 20).map((s) => (utf8Len(s) > 60 ? truncUtf8(s, 60) : s) || ' ')
    const title = new TextContainerProperty({
      xPosition: 0, yPosition: 0, width: SCREEN_W, height: 40,
      borderWidth: 0, borderColor: 0, paddingLength: 6,
      containerID: LIST_TITLE.id, containerName: LIST_TITLE.name,
      content: l.title, isEventCapture: 0, textColor: 3, zOrderIndex: 0,
    })
    const body = new ListContainerProperty({
      xPosition: 0, yPosition: 42, width: SCREEN_W, height: SCREEN_H - 42,
      borderWidth: 1, borderColor: 13, borderRadius: 6, paddingLength: 4,
      containerID: LIST_BODY.id, containerName: LIST_BODY.name,
      isEventCapture: 1, zOrderIndex: 1,
      itemContainer: new ListItemContainerProperty({
        itemCount: items.length, itemWidth: 0, isItemSelectBorderEn: 1, itemName: items,
      }),
    })
    return { containerTotalNum: 2, textObject: [title], listObject: [body], menuObject: this.menuObject() }
  }

  /** 打开原生列表选择页 */
  async showList(l: ListPage): Promise<boolean> {
    if (!l.items.length) return false
    this.list = l
    const ok = await this.rebuild()
    this.drawListShadow()
    return ok
  }

  /** 关闭列表页，回到 HUD */
  async hideList(): Promise<void> {
    if (!this.list) return
    this.list = null
    await this.rebuild()
  }

  private drawListShadow(): void {
    const l = this.list
    if (!l) return
    const ctx = ctx2d(this.shadow)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
    ctx.textBaseline = 'middle'
    ctx.font = '18px -apple-system, "PingFang SC", "Noto Sans CJK SC", sans-serif'
    ctx.fillStyle = '#aaa'
    ctx.fillText(l.title, 8, 20)
    ctx.strokeStyle = '#ddd'
    ctx.strokeRect(0.5, 42.5, SCREEN_W - 1, SCREEN_H - 43)
    const n = Math.min(20, l.items.length)
    const h = Math.min(40, (SCREEN_H - 50) / n)
    l.items.slice(0, n).forEach((it, i) => {
      ctx.fillStyle = '#fff'
      ctx.fillText(it, 12, 46 + h * i + h / 2, SCREEN_W - 24)
    })
    this.onShadowChange?.()
  }

  /** 创建启动页。createStartUpPageContainer 每个会话只能调用一次：无论成败都要打上已调用标记 */
  async start(): Promise<boolean> {
    let ok = false
    if (!this.startCalled) {
      this.startCalled = true
      try {
        const res = StartUpPageCreateResult.normalize(
          await this.bridge.createStartUpPageContainer(new CreateStartUpPageContainer(this.imagePage())),
        )
        ok = res === StartUpPageCreateResult.success
        if (!ok) console.error('createStartUpPageContainer →', res)
      } catch (e) {
        console.error('createStartUpPageContainer threw', e)
      }
    }
    if (!ok) ok = await this.rebuild()
    this.ready = true
    this.invalidate()
    return ok
  }

  async rebuild(): Promise<boolean> {
    this.lastRebuildAt = Date.now()
    try {
      const page = this.list ? this.listPage(this.list) : this.mode === 'image' ? this.imagePage() : this.textPage()
      const ok = await this.bridge.rebuildPageContainer(new RebuildPageContainer(page))
      this.invalidate()
      return !!ok
    } catch (e) {
      console.error('rebuildPageContainer threw', e)
      return false
    }
  }

  pause(): void {
    this.paused = true
  }

  /**
   * 恢复发送。
   * rebuild：先重建页面（退出对话框会清空页面）。
   * probe：宿主可能仍有覆盖层（系统菜单等）——试发失败就继续暂停并稍后重试，不计入通道损坏判定。
   */
  async resume(opts: { rebuild?: boolean; probe?: boolean } = {}): Promise<void> {
    if (this.probeTimer) clearTimeout(this.probeTimer)
    this.probeTimer = null
    const wasPaused = this.paused
    this.paused = false
    this.fastFails = 0
    this.probing = !!opts.probe
    if (opts.probe && !wasPaused) this.probeTries = 0
    if (opts.rebuild) await this.rebuild()
    else this.invalidate()
  }

  private probing = false
  private probeTries = 0
  private probeTimer: ReturnType<typeof setTimeout> | null = null

  /** 宿主可能清空了页面（前后台切换、菜单、对话框后），标记全部重发 */
  invalidate(): void {
    this.sent = TILES.map(() => null)
    this.textSent = { head: '', main: '', foot: '' }
    this.dirty = true
    void this.pump()
  }

  /** 提交一帧（576×288 任意颜色画布，内部转灰度） */
  submit(src: HTMLCanvasElement): void {
    const ctx = ctx2d(this.frame)
    ctx.drawImage(src, 0, 0)
    this.dirty = true
    void this.pump()
  }

  submitText(t: TextFrame): void {
    this.textPending = t
    void this.pumpText()
  }

  async enterTextMode(reason: string): Promise<void> {
    if (this.mode === 'text') return
    console.warn('切换到文本模式：', reason)
    this.mode = 'text'
    this.onModeChange?.('text')
    await this.rebuild()
  }

  private quantizeTile(i: number): { hash: number; data: ImageData } {
    const t = TILES[i]
    const data = ctx2d(this.frame).getImageData(t.x, t.y, TILE_W, TILE_H)
    const px = data.data
    let hash = 0x811c9dc5
    for (let k = 0; k < px.length; k += 4) {
      const lum = (px[k] * 299 + px[k + 1] * 587 + px[k + 2] * 114) / 1000
      const q = (lum * 15 + 127.5) / 255 | 0
      const v = q * 17
      px[k] = px[k + 1] = px[k + 2] = v
      px[k + 3] = 255
      hash ^= q
      hash = Math.imul(hash, 0x01000193)
    }
    return { hash: hash >>> 0, data }
  }

  private async encode(data: ImageData): Promise<Uint8Array> {
    // 每次用独立画布：流水线下可能有两个编码同时进行
    const c = this.tileCanvases.pop() ?? createCanvas(TILE_W, TILE_H)
    ctx2d(c).putImageData(data, 0, 0)
    try {
      const blob: Blob = await new Promise((res, rej) =>
        c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png'),
      )
      return new Uint8Array(await blob.arrayBuffer())
    } finally {
      this.tileCanvases.push(c)
    }
  }

  // ── 图块调度 ─────────────────────────────────────────────────────
  // 每个图块有最小刷新间隔（由应用按视图和车速设置）；操作后短时间内不受限。
  // 每次从「有变化且已到间隔」的图块里挑最久没刷新的发送，保证四块都能轮到，
  // 不会因为新帧不断到来而只刷第一块。

  private lastSentAt: number[] = TILES.map(() => 0)
  private minInterval: number[] = TILES.map(() => 0)
  private boostUntil = 0
  private boostStart = 0
  private wakeTimer: ReturnType<typeof setTimeout> | null = null

  /** 设置各图块（左上、右上、左下、右下）的最小刷新间隔（ms） */
  setTileIntervals(ms: number[]): void {
    for (let i = 0; i < TILES.length; i++) this.minInterval[i] = Math.max(0, ms[i] ?? 0)
  }

  /** 短时间内忽略刷新间隔（用户操作、提示信息） */
  boost(ms = 1500): void {
    if (performance.now() >= this.boostUntil) this.boostStart = performance.now()
    this.boostUntil = Math.max(this.boostUntil, performance.now() + ms)
    this.dirty = true
    void this.pump()
  }

  /** 操作后每个图块都已刷新过（或本来就没变）即视为画面跟上了操作 */
  private checkInputDone(): void {
    if (!this.inputAt) return
    for (let i = 0; i < TILES.length; i++) {
      if (this.lastSentAt[i] >= this.inputAt) continue
      if (this.quantizeTile(i).hash === this.sent[i]) continue
      return
    }
    this.stats.inputLatencyMs = performance.now() - this.inputAt
    this.inputAt = 0
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.paused || this.list || !this.ready || this.mode !== 'image') return
    this.pumping = true
    try {
      let frameStart = performance.now()
      let count = 0
      while (this.mode === 'image' && !this.paused && !this.list) {
        this.dirty = false
        const now = performance.now()
        const boosted = now < this.boostUntil
        let pick = -1
        let pickQ: { hash: number; data: ImageData } | null = null
        let waitMs = Infinity
        let anyChanged = false
        for (let i = 0; i < TILES.length; i++) {
          const q = this.quantizeTile(i)
          if (q.hash === this.sent[i]) continue
          anyChanged = true
          const due = this.lastSentAt[i] + this.minInterval[i] - now
          if (!boosted && due > 0) {
            waitMs = Math.min(waitMs, due)
            continue
          }
          // 操作后：本轮还没刷过的块按 左上→右上→左下→右下 顺序；平时：最久没刷的优先
          const rank = (j: number) => (boosted ? (this.lastSentAt[j] >= this.boostStart ? 1e9 + j : j) : this.lastSentAt[j])
          if (pick < 0 || rank(i) < rank(pick)) {
            pick = i
            pickQ = q
          }
        }
        if (pick < 0) {
          this.checkInputDone()
          if (!anyChanged) {
            if (count) {
              this.stats.lastFrameMs = performance.now() - frameStart
              this.stats.tilesLastFrame = count
            }

          } else if (Number.isFinite(waitMs)) {
            // 有变化但还没到间隔：到点再来
            if (this.wakeTimer) clearTimeout(this.wakeTimer)
            this.wakeTimer = setTimeout(() => {
              this.wakeTimer = null
              void this.pump()
            }, waitMs + 5)
          }
          break
        }
        const bytes = await this.encode(pickQ!.data)
        const ok = await this.sendTile(pick, pickQ!, bytes)
        if (!ok) break
        this.lastSentAt[pick] = performance.now()
        this.stats.perTile[pick]++
        this.checkInputDone()
        if (count === 0) frameStart = now
        count++
      }
    } finally {
      this.pumping = false
    }
    // 发送期间来了新帧且没有在等间隔，继续
    if (this.dirty && !this.wakeTimer) void this.pump()
  }

  private async sendTile(i: number, q: { hash: number; data: ImageData }, bytes: Uint8Array): Promise<boolean> {
    const t = TILES[i]
    const t0 = performance.now()
    let res: ImageRawDataUpdateResult
    try {
      res = ImageRawDataUpdateResult.normalize(
        await this.bridge.updateImageRawData(
          new ImageRawDataUpdate({ containerID: t.id, containerName: t.name, imageData: bytes }),
        ),
      )
    } catch (e) {
      console.error('updateImageRawData threw', e)
      res = ImageRawDataUpdateResult.sendFailed
    }
    const dt = performance.now() - t0
    this.stats.sends++
    this.stats.avgSendMs = this.stats.avgSendMs ? this.stats.avgSendMs * 0.9 + dt * 0.1 : dt

    if (res === ImageRawDataUpdateResult.success) {
      this.sent[i] = q.hash
      this.fastFails = 0
      this.probing = false
      this.probeTries = 0
      ctx2d(this.shadow).putImageData(q.data, t.x, t.y)
      this.onShadowChange?.()
      return true
    }

    this.stats.failures++
    console.warn(`tile ${t.name} → ${res} (${dt.toFixed(0)}ms)`)
    if (this.paused) {
      this.dirty = true
      return false
    }
    if (this.probing) {
      // 覆盖层可能还在：暂停后重试，最多约 60 秒，之后按正常路径判定
      this.paused = true
      this.dirty = true
      if (++this.probeTries < 30) {
        this.probeTimer = setTimeout(() => void this.resume({ probe: true }), 2000)
      } else {
        this.probeTimer = setTimeout(() => void this.resume({ rebuild: true }), 2000)
      }
      return false
    }
    if (res === ImageRawDataUpdateResult.sendFailed && dt < 25) {
      if (++this.fastFails >= 3) {
        await this.enterTextMode('图片通道持续立即失败（宿主已知缺陷）')
        return false
      }
    }
    // 页面可能已被宿主清掉：节流地重建一次
    if (Date.now() - this.lastRebuildAt > 5000) await this.rebuild()
    else this.dirty = true
    await new Promise((r) => setTimeout(r, 300))
    return false
  }

  private async pumpText(): Promise<void> {
    if (this.pumping || this.paused || this.list || !this.ready || this.mode !== 'text' || !this.textPending) return
    this.pumping = true
    try {
      while (this.textPending) {
        const t = this.textPending
        this.textPending = null
        const keys: (keyof TextFrame)[] = ['head', 'main', 'foot']
        for (let i = 0; i < keys.length; i++) {
          const k = keys[i]
          const content = (t[k] || ' ').slice(0, 900)
          if (content === this.textSent[k]) continue
          const slot = TEXT_SLOTS[i]
          const ok = await this.bridge.textContainerUpgrade(
            new TextContainerUpgrade({ containerID: slot.id, containerName: slot.name, content }),
          )
          if (ok) this.textSent[k] = content
        }
        this.drawTextShadow()
      }
    } finally {
      this.pumping = false
    }
  }

  private drawTextShadow(): void {
    const ctx = ctx2d(this.shadow)
    ctx.fillStyle = '#000'
    ctx.fillRect(0, 0, SCREEN_W, SCREEN_H)
    ctx.fillStyle = '#ccc'
    ctx.font = '18px -apple-system, "PingFang SC", sans-serif'
    ctx.textBaseline = 'top'
    const keys: (keyof TextFrame)[] = ['head', 'main', 'foot']
    keys.forEach((k, i) => {
      const s = TEXT_SLOTS[i]
      ctx.fillStyle = i === 1 ? '#fff' : '#aaa'
      this.textSent[k].split('\n').forEach((line, j) => ctx.fillText(line, s.x + 8, s.y + 8 + j * 24, s.w - 16))
    })
    ctx.strokeStyle = '#666'
    ctx.strokeRect(TEXT_SLOTS[1].x + 0.5, TEXT_SLOTS[1].y + 0.5, TEXT_SLOTS[1].w - 1, TEXT_SLOTS[1].h - 1)
    this.onShadowChange?.()
  }
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length
}

/** 按 UTF-8 字节截断（列表项上限 64 字节，留余量） */
function truncUtf8(s: string, max: number): string {
  let out = ''
  for (const ch of s) {
    if (utf8Len(out + ch + '…') > max) break
    out += ch
  }
  return out + '…'
}
