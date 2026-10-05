// 高德 Web 服务 API 客户端。
// restapi.amap.com 返回 Access-Control-Allow-Origin: *，WebView 里可直接调用。
// 内置：串行限流（个人开发者 QPS 很低）、按月配额计数、错误码翻译。

import { fmtLngLat, parseLngLat, type LngLat } from '../geo'
import type { KV, Place } from '../storage'
import type { TravelMode } from '../nav/route'

/** 2025-05-20 起的计费服务包 */
export type QuotaBucket = 'lbs' | 'search' | 'weather'

/** 个人认证开发者月配额 */
export const PERSONAL_MONTHLY_QUOTA: Record<QuotaBucket, number> = {
  lbs: 150_000,
  search: 5_000,
  weather: 5_000,
}

export class AmapError extends Error {
  constructor(message: string, readonly infocode?: string) {
    super(message)
  }
}

const INFOCODE_HINTS: Record<string, string> = {
  '10001': 'Key 无效，请检查设置里的高德 Key',
  '10002': '该 Key 没有此服务权限',
  '10003': '今日/本月调用量已超限',
  '10004': '请求过于频繁',
  '10005': 'IP 白名单不匹配',
  '10009': 'Key 平台类型不匹配，需要「Web服务」类型的 Key',
  '10010': 'IP 访问超限',
  '10012': '权限不足',
  '10019': '服务总 QPS 超限',
  '10020': '该接口 QPS 超限',
  '10021': '账号 QPS 超限',
  '10044': '账号日调用量超限',
  '20800': '规划点不在中国陆地范围内',
  '20801': '起终点附近找不到道路',
  '20802': '无法规划路线',
  '20803': '起终点距离过长',
}

export class QuotaTracker {
  private counts: Record<string, number> = {}
  private month = ''
  constructor(private kv: KV) {}

  private monthKey(): string {
    const d = new Date()
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`
  }

  async load(): Promise<void> {
    this.month = this.monthKey()
    try {
      const raw = await this.kv.get(`quota.${this.month}`)
      this.counts = raw ? JSON.parse(raw) : {}
    } catch {
      this.counts = {}
    }
  }

  hit(bucket: QuotaBucket): void {
    const m = this.monthKey()
    if (m !== this.month) {
      this.month = m
      this.counts = {}
    }
    this.counts[bucket] = (this.counts[bucket] ?? 0) + 1
    void this.kv.set(`quota.${this.month}`, JSON.stringify(this.counts))
  }

  used(bucket: QuotaBucket): number {
    return this.counts[bucket] ?? 0
  }

  snapshot(): { bucket: QuotaBucket; used: number; limit: number }[] {
    return (Object.keys(PERSONAL_MONTHLY_QUOTA) as QuotaBucket[]).map((b) => ({
      bucket: b,
      used: this.used(b),
      limit: PERSONAL_MONTHLY_QUOTA[b],
    }))
  }
}

export interface Poi extends Place {
  type?: string
  distance?: number
  tel?: string
  /** 评分（高德仅对餐饮/酒店/景点/影院返回） */
  rating?: number
  /** 人均消费（元） */
  cost?: number
  /** 今日营业时间 */
  openToday?: string
  /** 楼层显示值，如 F3 / B1 */
  floor?: string
  /** 所属商圈 */
  area?: string
  /** 导航入口坐标（比 POI 中心点更适合作为目的地） */
  entrance?: LngLat
}

export interface Weather {
  text: string
  temperature: number
  humidity?: number
  wind?: string
  city?: string
}

export interface ReGeo {
  address: string
  street: string
  district: string
  city: string
  adcode: string
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

export class AmapClient {
  private queue: Promise<unknown> = Promise.resolve()
  private lastCall = 0
  /** 两次请求最小间隔（ms），个人开发者默认 QPS 约 3 */
  minIntervalMs = 350

  constructor(
    private getKey: () => string,
    private getBase: () => string,
    readonly quota: QuotaTracker,
  ) {}

  hasKey(): boolean {
    return !!this.getKey()
  }

  private base(): string {
    return (this.getBase() || 'https://restapi.amap.com').replace(/\/+$/, '')
  }

  private schedule<T>(fn: () => Promise<T>): Promise<T> {
    const run = async () => {
      const wait = this.lastCall + this.minIntervalMs - Date.now()
      if (wait > 0) await new Promise((r) => setTimeout(r, wait))
      this.lastCall = Date.now()
      return fn()
    }
    const p = this.queue.then(run, run)
    this.queue = p.catch(() => undefined)
    return p
  }

  private async get(path: string, params: Record<string, string | number | undefined>, bucket: QuotaBucket): Promise<any> {
    const key = this.getKey()
    if (!key) throw new AmapError('未设置高德 Key（手机端 → 设置）')
    const qs = new URLSearchParams()
    qs.set('key', key)
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') qs.set(k, String(v))
    return this.schedule(async () => {
      this.quota.hit(bucket)
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 10_000)
      let res: Response
      try {
        res = await fetch(`${this.base()}${path}?${qs}`, { signal: ctrl.signal })
      } catch (e) {
        throw new AmapError(ctrl.signal.aborted ? '网络超时' : `网络错误：${(e as Error).message}`)
      } finally {
        clearTimeout(timer)
      }
      if (!res.ok) throw new AmapError(`HTTP ${res.status}`)
      const json = await res.json()
      // v3 用 status:"1"，v5 同样带 status/infocode
      if (String(json.status) !== '1') {
        const code = str(json.infocode)
        throw new AmapError(INFOCODE_HINTS[code] ?? `高德错误 ${code} ${str(json.info)}`, code)
      }
      return json
    })
  }

  // ── 搜索（基础搜索服务包，个人每月仅 5000 次，谨慎调用）────────────

  async inputTips(keywords: string, opts: { city?: string; location?: LngLat } = {}): Promise<Poi[]> {
    const json = await this.get('/v3/assistant/inputtips', {
      keywords,
      city: opts.city,
      location: opts.location ? fmtLngLat(opts.location) : undefined,
      datatype: 'all',
    }, 'search')
    const tips: any[] = Array.isArray(json.tips) ? json.tips : []
    return tips.flatMap((t): Poi[] => {
      const location = parseLngLat(str(t.location))
      if (!location || !str(t.name)) return []
      return [{ name: str(t.name), address: [str(t.district), str(t.address)].filter(Boolean).join(' '), location, id: str(t.id) }]
    })
  }

  async searchText(keywords: string, opts: { region?: string; pageSize?: number } = {}): Promise<Poi[]> {
    const json = await this.get('/v5/place/text', {
      keywords,
      region: opts.region,
      page_size: opts.pageSize ?? 10,
      show_fields: 'business,indoor,navi',
    }, 'search')
    return parsePois(json.pois)
  }

  async searchAround(location: LngLat, opts: { keywords?: string; types?: string; radius?: number; pageSize?: number } = {}): Promise<Poi[]> {
    const json = await this.get('/v5/place/around', {
      location: fmtLngLat(location),
      keywords: opts.keywords,
      types: opts.types,
      radius: opts.radius ?? 1000,
      sortrule: 'distance',
      page_size: opts.pageSize ?? 10,
      show_fields: 'business,indoor,navi',
    }, 'search')
    return parsePois(json.pois)
  }

  // ── 基础 LBS 服务包（个人每月 15 万次）─────────────────────────────

  async route(mode: TravelMode, origin: LngLat, destination: LngLat, opts: { strategy?: number } = {}): Promise<any> {
    const path = {
      walking: '/v5/direction/walking',
      bicycling: '/v5/direction/bicycling',
      electrobike: '/v5/direction/electrobike',
      driving: '/v5/direction/driving',
    }[mode]
    const showFields = mode === 'driving' ? 'cost,navi,polyline,tmcs' : 'cost,navi,polyline'
    return this.get(path, {
      origin: fmtLngLat(origin),
      destination: fmtLngLat(destination),
      show_fields: showFields,
      strategy: mode === 'driving' ? (opts.strategy ?? 32) : undefined,
      alternative_route: mode === 'walking' ? 1 : undefined,
    }, 'lbs')
  }

  async regeo(location: LngLat): Promise<ReGeo> {
    const json = await this.get('/v3/geocode/regeo', { location: fmtLngLat(location), extensions: 'base' }, 'lbs')
    const rg = json.regeocode ?? {}
    const ac = rg.addressComponent ?? {}
    const city = str(ac.city) || str(ac.province)
    const street = str(ac.streetNumber?.street) || str(ac.township)
    return {
      address: str(rg.formatted_address),
      street,
      district: str(ac.district),
      city,
      adcode: str(ac.adcode),
    }
  }

  /** 静态地图：作为局部地图底图（会做灰度/反相处理） */
  async staticMap(center: LngLat, zoom: number, size: number): Promise<ImageBitmap> {
    const key = this.getKey()
    if (!key) throw new AmapError('未设置高德 Key')
    const qs = new URLSearchParams({
      key,
      location: fmtLngLat(center),
      zoom: String(zoom),
      size: `${size}*${size}`,
      scale: '1',
      traffic: '0',
    })
    return this.schedule(async () => {
      this.quota.hit('lbs')
      const res = await fetch(`${this.base()}/v3/staticmap?${qs}`)
      const type = res.headers.get('content-type') ?? ''
      if (!res.ok || type.includes('json')) {
        let msg = `HTTP ${res.status}`
        try {
          const j = await res.json()
          msg = INFOCODE_HINTS[str(j.infocode)] ?? str(j.info) ?? msg
        } catch { /* ignore */ }
        throw new AmapError(`静态地图失败：${msg}`)
      }
      return createImageBitmap(await res.blob())
    })
  }

  // ── 天气（个人每月 5000 次）────────────────────────────────────────

  async weather(adcode: string): Promise<Weather | null> {
    const json = await this.get('/v3/weather/weatherInfo', { city: adcode, extensions: 'base' }, 'weather')
    const live = Array.isArray(json.lives) ? json.lives[0] : null
    if (!live) return null
    return {
      text: str(live.weather),
      temperature: Number(live.temperature),
      humidity: Number(live.humidity) || undefined,
      wind: `${str(live.winddirection)}风${str(live.windpower)}级`,
      city: str(live.city),
    }
  }
}

export function parsePois(raw: unknown): Poi[] {
  const arr: any[] = Array.isArray(raw) ? raw : []
  return arr.flatMap((p): Poi[] => {
    const location = parseLngLat(str(p.location))
    if (!location || !str(p.name)) return []
    const biz = p.business ?? {}
    const indoor = p.indoor ?? {}
    const rating = Number(str(biz.rating))
    const cost = Number(str(biz.cost))
    return [{
      name: str(p.name),
      address: [str(p.adname), str(p.address)].filter(Boolean).join(' '),
      location,
      id: str(p.id),
      type: str(p.type),
      distance: p.distance !== undefined && p.distance !== '' ? Number(p.distance) : undefined,
      tel: str(biz.tel) || undefined,
      rating: rating > 0 ? rating : undefined,
      cost: cost > 0 ? cost : undefined,
      openToday: str(biz.opentime_today) || undefined,
      area: str(biz.business_area) || undefined,
      floor: str(indoor.truefloor) || floorFromIndex(str(indoor.floor)),
      entrance: parseLngLat(str(p.navi?.entr_location)) ?? undefined,
    }]
  })
}

/** indoor.floor 是楼层序号（负数为地下），没有 truefloor 时转换成 F3 / B1 */
function floorFromIndex(f: string): string | undefined {
  const n = Number(f)
  if (!f || !Number.isFinite(n) || n === 0) return undefined
  return n > 0 ? `F${n}` : `B${-n}`
}
