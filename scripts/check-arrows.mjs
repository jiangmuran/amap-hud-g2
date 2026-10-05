// 渲染回归检查：方向箭头在各尺寸、各角度下，视觉上「最突出的点」必须朝向目标方向。
// （只检查几何尖端不够：翼尖若比尖端更远，人眼会读成别的方向。）
// 用法：先 npm run dev，然后 CHROME=/path/to/chrome npm run check:arrows
import { chromium } from 'playwright-core'

const b = await chromium.launch({ executablePath: process.env.CHROME || undefined })
const p = await (await b.newContext()).newPage()
await p.goto(process.env.URL || 'http://127.0.0.1:5173/?mock=1')
const res = await p.evaluate(async () => {
  const g = await import('/src/hud/gfx.ts')
  const out = []
  for (const [name, fn] of [['pointer', g.pointer], ['chevron', g.chevron]]) {
    // 视图里使用的箭头不小于 9px（雷达中心的 8px 标记固定朝上，不参与方向判断）
    for (const size of [9, 10, 12, 16, 26, 28]) {
      for (let ang = 0; ang < 360; ang += 15) {
        const c = document.createElement('canvas')
        c.width = c.height = 90
        const ctx = c.getContext('2d')
        ctx.fillStyle = '#000'
        ctx.fillRect(0, 0, 90, 90)
        fn(ctx, 45, 45, size, ang, 15)
        const d = ctx.getImageData(0, 0, 90, 90).data
        // 以绘制中心为原点，找亮像素延伸最远的方向（同时检查最远点明显领先第二远的峰）
        const reach = new Array(72).fill(0)
        for (let y = 0; y < 90; y++) for (let x = 0; x < 90; x++) {
          if (d[(y * 90 + x) * 4 + 1] < 100) continue
          const r = Math.hypot(x - 45, y - 45)
          const k = Math.round(((Math.atan2(x - 45, -(y - 45)) * 180) / Math.PI + 360) % 360 / 5) % 72
          reach[k] = Math.max(reach[k], r)
        }
        let best = 0
        for (let k = 1; k < 72; k++) if (reach[k] > reach[best]) best = k
        const got = best * 5
        let err = Math.abs(got - ang)
        err = Math.min(err, 360 - err)
        // 与目标方向相差 60° 以外的最大延伸（翼尖）必须明显短于尖端
        let wing = 0
        for (let k = 0; k < 72; k++) {
          let e = Math.abs(k * 5 - ang)
          e = Math.min(e, 360 - e)
          if (e > 60) wing = Math.max(wing, reach[k])
        }
        const ratio = wing / reach[best]
        if (err > 20 || ratio > 0.85) out.push({ name, size, ang, got, err, ratio: +ratio.toFixed(2) })
      }
    }
  }
  return out
})
console.log(res.length ? res : 'all arrows point correctly')
process.exitCode = res.length ? 1 : 0
await b.close()
