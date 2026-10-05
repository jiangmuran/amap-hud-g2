import '@fontsource/orbitron/latin-600.css'
import '@fontsource/orbitron/latin-700.css'
import '@fontsource/orbitron/latin-800.css'
import '@fontsource/orbitron/latin-900.css'
import '@fontsource/rajdhani/latin-600.css'
import '@fontsource/rajdhani/latin-700.css'
import './phone/style.css'

import { HudApp } from './app'
import { connectBridge, MockBridge } from './glasses/bridge'
import { PhoneUI } from './phone/ui'
import { browserKV, type KV } from './storage'
import type { TravelMode } from './nav/route'
import { DEMO_ORIGIN } from './nav/demo'
import type { Poi } from './amap/api'
import type { LngLat } from './geo'

/** 画布字体必须先加载完，否则第一帧会用回退字体渲染 */
async function loadFonts(): Promise<void> {
  const specs = ['600 20px Orbitron', '700 20px Orbitron', '800 20px Orbitron', '900 20px Orbitron', '600 20px Rajdhani', '700 20px Rajdhani']
  try {
    await Promise.race([Promise.all(specs.map((f) => document.fonts.load(f, '0123456789NAVKM'))), new Promise((r) => setTimeout(r, 2500))])
  } catch {
    /* 回退字体也能用 */
  }
}

async function boot(): Promise<void> {
  const [bridge] = await Promise.all([connectBridge(), loadFonts()])
  const kv: KV = bridge.real
    ? { get: (k) => bridge.getLocalStorage(k).then((v) => v ?? ''), set: (k, v) => bridge.setLocalStorage(k, v).then(() => undefined) }
    : browserKV()
  const app = new HudApp(bridge, kv)
  await app.init()
  const ui = new PhoneUI(app, document.getElementById('app')!, bridge instanceof MockBridge ? bridge : null)
  ui.mount()
  ;(window as any).__hud = { app, ui, bridge }

  // 开发：?seed=1 填入示例快捷点与周边结果（含评分/楼层），无需 Key 即可调试选择流程
  if (new URLSearchParams(location.search).has('seed')) seedDevData(app)

  // 开发/演示：?demo=walking|bicycling|electrobike|driving 自动开始模拟导航
  const demo = new URLSearchParams(location.search).get('demo')
  if (demo) {
    const mode = (['walking', 'bicycling', 'electrobike', 'driving'].includes(demo) ? demo : 'walking') as TravelMode
    const { route, dest } = app.demoRoute(mode)
    app.startNavigation(route, dest, { simulate: true })
  }
  console.log('REALMAPCN_READY', bridge.real ? 'host' : 'mock')
}

boot().catch((e) => {
  console.error(e)
  document.getElementById('app')!.innerHTML = `<pre style="padding:20px;white-space:pre-wrap">启动失败：${String(e?.stack ?? e)}</pre>`
})

function seedDevData(app: HudApp): void {
  const at = (de: number, dn: number): LngLat => [DEMO_ORIGIN[0] + de / 85000, DEMO_ORIGIN[1] + dn / 111000]
  app.settings.home = { name: '望京花园', location: at(3000, 6000) }
  app.settings.work = { name: '国贸三期', location: at(1500, -2600) }
  app.settings.pins = [
    { name: '三里屯太古里', location: at(120, -300) },
    { name: '工人体育场', location: at(-900, 200) },
  ]
  const pois: Poi[] = [
    { name: '海底捞火锅(三里屯店)', location: at(150, 180), rating: 4.7, cost: 132, floor: 'F3', openToday: '10:00-次日07:00', address: '三里屯路19号', area: '三里屯' },
    { name: '鼎泰丰(太古里店)', location: at(-260, 90), rating: 4.5, cost: 168, floor: 'B1', openToday: '11:00-21:30', address: '太古里南区', area: '三里屯' },
    { name: '局气(工体店)', location: at(-480, -320), rating: 4.4, cost: 96, openToday: '10:30-22:00', address: '工体北路', area: '工体' },
    { name: '很久以前羊肉串', location: at(420, -510), rating: 4.3, cost: 88, floor: 'F2', address: '新东路' },
    { name: 'Wagas沃歌斯', location: at(80, -650), rating: 4.2, cost: 75, floor: 'F1', openToday: '07:30-22:00', address: '三里屯SOHO' },
  ]
  app.radar = { category: 2, pois, loading: false, fetchedAt: Date.now() }
  if (!app.loc.last) app.loc.push({ p: DEMO_ORIGIN, accuracy: 8, speed: 0, heading: 30, gcj: true })
  app.place = { street: '三里屯路', address: '北京市朝阳区三里屯路', city: '北京市', district: '朝阳区', adcode: '110105' }
  app.weather = { text: '晴', temperature: 23 }
  // 没有 Key 时，从眼镜发起的规划改用离线演示路线
  if (!app.api.hasKey()) {
    app.api.hasKey = () => true
    app.planRoutes = async (dest, mode) => {
      const { route } = app.demoRoute(mode)
      return [{ ...route, destName: dest.name }]
    }
  }
}
