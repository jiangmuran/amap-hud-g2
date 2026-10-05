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

  // 开发/演示：?demo=walking|bicycling|electrobike|driving 自动开始模拟导航
  const demo = new URLSearchParams(location.search).get('demo')
  if (demo) {
    const mode = (['walking', 'bicycling', 'electrobike', 'driving'].includes(demo) ? demo : 'walking') as TravelMode
    const { route, dest } = app.demoRoute(mode)
    app.startNavigation(route, dest, { simulate: true })
  }
  console.log('AMAP_HUD_READY', bridge.real ? 'host' : 'mock')
}

boot().catch((e) => {
  console.error(e)
  document.getElementById('app')!.innerHTML = `<pre style="padding:20px;white-space:pre-wrap">启动失败：${String(e?.stack ?? e)}</pre>`
})
