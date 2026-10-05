import type { Poi, ReGeo, Weather } from '../amap/api'
import type { GlassesStatus } from '../glasses/bridge'
import type { Place } from '../storage'
import type { Route } from '../nav/route'
import type { Fix, NavState } from '../nav/tracker'
import type { TripSnapshot } from '../nav/trip'
import type { Basemap } from './basemap'

export type ViewId = 'nav' | 'overview' | 'roadbook' | 'telemetry' | 'radar' | 'go' | 'poi' | 'cruise' | 'arrival' | 'focus'

export type QuickTag = 'home' | 'work' | 'pin' | 'recent'

export interface QuickItem {
  tag: QuickTag
  place: Place
}

export const QUICK_TAG_LABEL: Record<QuickTag, string> = { home: '家', work: '公司', pin: '★', recent: '最近' }

export const VIEW_LABEL: Record<ViewId, string> = {
  nav: 'NAV',
  overview: 'MAP',
  roadbook: 'ROUTE',
  telemetry: 'DATA',
  radar: 'RADAR',
  go: 'GO',
  poi: 'POI',
  cruise: 'CRUISE',
  arrival: 'ARRIVED',
  focus: 'FOCUS',
}

export interface RadarCategory {
  name: string
  short: string
  types?: string
  keywords?: string
}

export const RADAR_CATEGORIES: RadarCategory[] = [
  { name: '地铁站', short: 'METRO', types: '150500' },
  { name: '超市', short: 'MARKET', types: '060400' },
  { name: '美食', short: 'FOOD', types: '050000' },
  { name: '咖啡', short: 'CAFE', types: '050500' },
  { name: '便利店', short: 'SHOP', types: '060200' },
  { name: '卫生间', short: 'WC', types: '200300' },
  { name: '公交站', short: 'BUS', types: '150700' },
  { name: '加油站', short: 'FUEL', types: '010100' },
  { name: '充电站', short: 'EV', types: '011100' },
  { name: '停车场', short: 'PARK', types: '150900' },
]

export interface RadarState {
  category: number
  pois: Poi[]
  loading: boolean
  error?: string
  fetchedAt?: number
}

export interface HudModel {
  now: Date
  t: number
  view: ViewId
  viewIndex: number
  viewCount: number
  fix?: Fix
  nav?: NavState
  route?: Route
  trip: TripSnapshot
  glasses: GlassesStatus
  weather?: Weather
  place?: ReGeo
  toast?: string
  headingUp: boolean
  basemap?: Basemap | null
  radar: RadarState
  overviewZoom: 'fit' | 'near'
  roadbookOffset: number
  rerouting: boolean
  simulated: boolean
  hasKey: boolean
  locationSource: string
  /** 眼镜「前往」页的快捷点 */
  quick: QuickItem[]
  /** POI 详情卡 */
  poi?: Poi
  /** 正在从眼镜发起规划 */
  planning?: string
  /** 到达页数据 */
  arrival?: { name: string; distance: number; elapsed: number; avg: number }
}

/** 当前用于地图朝向的航向：优先真实航向，其次路线方向 */
export function displayHeading(m: HudModel): number {
  const h = m.fix?.heading
  if (h !== undefined && Number.isFinite(h)) return h
  if (m.nav) return m.nav.routeHeading
  return 0
}
