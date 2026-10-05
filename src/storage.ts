// 持久化：优先用 SDK 的 bridge 存储（.ehpk 的 WebView 里浏览器 localStorage 重启会丢），
// 浏览器开发模式回退到 localStorage。

import type { LngLat } from './geo'
import type { TravelMode } from './nav/route'

export interface KV {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<void>
}

export function browserKV(prefix = 'amaphud:'): KV {
  return {
    async get(key) {
      try {
        return localStorage.getItem(prefix + key) ?? ''
      } catch {
        return ''
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(prefix + key, value)
      } catch {
        /* 隐私模式等 */
      }
    },
  }
}

export interface Place {
  name: string
  address?: string
  location: LngLat
  id?: string
}

export type RefreshProfile = 'eco' | 'standard' | 'fast'

export interface Settings {
  amapKey: string
  /** 可选：自建代理地址，替代 https://restapi.amap.com（便于隐藏 key、加签名） */
  apiBase: string
  travelMode: TravelMode
  headingUp: boolean
  basemap: boolean
  focusMode: boolean
  refresh: RefreshProfile
  /** 手机屏幕常亮：关闭 / 导航时 / 始终 */
  keepAwake: 'off' | 'nav' | 'always'
  /** 首次打开时选择的手机系统 */
  platform: '' | 'ios' | 'android'
  /** 宿主定位是否为 WGS-84（iOS / 安卓系统定位都是），是则本地转换为 GCJ-02 */
  locationIsWgs: boolean
  home?: Place
  work?: Place
  /** 显示在眼镜「前往」页的快捷点 */
  pins: Place[]
  history: Place[]
}

export const DEFAULT_SETTINGS: Settings = {
  amapKey: (import.meta.env?.VITE_AMAP_KEY as string | undefined) ?? '',
  apiBase: '',
  travelMode: 'walking',
  headingUp: true,
  basemap: true,
  focusMode: false,
  refresh: 'standard',
  keepAwake: 'nav',
  platform: '',
  locationIsWgs: true,
  pins: [],
  history: [],
}

const SETTINGS_KEY = 'settings.v1'

export async function loadSettings(kv: KV): Promise<Settings> {
  try {
    const raw = await kv.get(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    const merged = { ...DEFAULT_SETTINGS, ...parsed }
    if (!merged.amapKey) merged.amapKey = DEFAULT_SETTINGS.amapKey
    return merged
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export async function saveSettings(kv: KV, s: Settings): Promise<void> {
  await kv.set(SETTINGS_KEY, JSON.stringify(s))
}

export const MAX_PINS = 8

export function isPinned(s: Settings, p: Place): boolean {
  return s.pins.some((x) => samePlace(x, p))
}

export function samePlace(a: Place, b: Place): boolean {
  if (a.id && b.id) return a.id === b.id
  return a.name === b.name && Math.abs(a.location[0] - b.location[0]) < 1e-4 && Math.abs(a.location[1] - b.location[1]) < 1e-4
}

export function pushHistory(s: Settings, p: Place): void {
  s.history = [p, ...s.history.filter((h) => h.name !== p.name)].slice(0, 12)
}
