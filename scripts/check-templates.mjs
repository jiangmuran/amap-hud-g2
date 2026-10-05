// 模板页排版检查：估算每个原生文本控件需要的行数，找出会溢出（出现滚动条/被截断）的地方。
// 原生字体实测：中文约 19px、ASCII 约 10px、行高约 27px（来自官方模拟器截图）。
// 用法：先 npm run dev，然后 CHROME=/path/to/chrome node scripts/check-templates.mjs
import { chromium } from 'playwright-core'

const b = await chromium.launch({ executablePath: process.env.CHROME || undefined })
const p = await (await b.newContext()).newPage()
await p.goto((process.env.URL || 'http://127.0.0.1:5173') + '/?mock=1&seed=1&demo=walking')
await p.waitForFunction(() => window.__hud)
await p.waitForTimeout(2500)
const { out: problems, checked } = await p.evaluate(async () => {
  const { templateFor, TEMPLATES } = await import('/src/hud/templates.ts')
  const { app } = window.__hud
  const LINE = 27
  const charW = (ch) => (/[\u0000-ÿ]/.test(ch) ? 10 : 19)
  const linesFor = (text, width) => {
    let n = 0
    for (const raw of String(text).split('\n')) {
      let w = 0
      let l = 1
      for (const ch of raw) {
        w += charW(ch)
        if (w > width) { l++; w = charW(ch) }
      }
      n += l
    }
    return n
  }
  const out = []
  let checked = 0
  const check = (label) => {
    const m = app.model()
    const t = templateFor(m)
    if (!t) return
    for (const spec of t.spec.texts) {
      const v = t.frame.texts[spec.name]
      if (v === undefined) continue
      checked++
      const pad = (spec.padding ?? 2) + (spec.border ? 2 : 0)
      const need = linesFor(v, spec.w - pad * 2 - 4) * LINE + pad * 2
      if (need > spec.h) out.push(`${label} · ${spec.name}: 需要 ${need}px > ${spec.h}px  「${String(v).replace(/\n/g, '⏎').slice(0, 60)}」`)
    }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  for (const v of ['nav', 'overview', 'roadbook', 'telemetry', 'radar', 'go']) { app.setView(v); check(v) }
  app.poiDetail = app.radar.pois[1]; check('poi'); app.poiDetail = undefined
  // 极端内容：超长路名 / 店名 / 地址
  const r = app.route
  r.steps.forEach((st) => (st.road = '东直门外大街辅路至三元桥匝道'))
  app.setView('nav'); check('nav·长路名')
  app.setView('roadbook'); check('roadbook·长路名')
  app.poiDetail = { ...app.radar.pois[0], name: '北京三里屯通盈中心洲际酒店行政酒廊与西餐厅', address: '北京市朝阳区三里屯路1号通盈中心洲际酒店3层南侧电梯厅旁', area: '三里屯', openToday: '11:30-14:30 17:30-22:00' }
  check('poi·长店名'); app.poiDetail = undefined
  app.settings.pins = Array.from({ length: 8 }, (_, i) => ({ name: `测试地点名称很长的收藏地点${i}`, location: [116.45 + i / 1000, 39.93] }))
  app.setView('go'); check('go·8个长名')
  app.stopNavigation(); app.setView('cruise'); check('cruise')
  app.place = { street: '朝阳区三里屯路与工人体育场北路交叉口', address: '', city: '北京市', district: '朝阳区', adcode: '' }
  check('cruise·长地址')
  app.arrival = { name: '北京三里屯通盈中心洲际酒店行政酒廊', distance: 3200, elapsed: 2500, avg: 1.3 }
  app.viewIndex = 0; check('arrival')
  // 自检：故意塞 4 行进只能放 3 行的周边列表，必须被抓到
  const spec = TEMPLATES.radar.texts.find((x) => x.name === "list")
  const need = linesFor("a\nb\nc\nd", spec.w) * LINE + 2 * ((spec.padding ?? 2) + 2)
  if (need <= spec.h) out.push("自检失败：检查器没有抓到已知溢出")
  return { out, checked }
})
console.log(problems.length ? problems.join('\n') : `no overflow（检查了 ${checked} 个文本框）`)
process.exitCode = problems.length ? 1 : 0
await b.close()
