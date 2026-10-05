// 文本模式 HUD（图片通道不可用时的兜底），只用固件字体里确认存在的字符。

import type { TextFrame } from '../glasses/display'
import { compass8, normDeg } from '../geo'
import { MANEUVER_LABEL, type Maneuver } from '../nav/route'
import { fmtClock, fmtDistStr, fmtDurationZh, fmtSpeed } from './format'
import { displayHeading, RADAR_CATEGORIES, type HudModel } from './model'

const ARROW: Record<Maneuver, string> = {
  depart: '↑',
  straight: '↑',
  'slight-left': '↖',
  left: '←',
  'sharp-left': '↙',
  'slight-right': '↗',
  right: '→',
  'sharp-right': '↘',
  'keep-left': '↖',
  'keep-right': '↗',
  'uturn-left': '↓',
  'uturn-right': '↓',
  roundabout: '○',
  arrive: '◎',
}

function bar(p: number, n = 20): string {
  const k = Math.round(p * n)
  return '━'.repeat(k) + '─'.repeat(n - k)
}

export function buildTextFrame(m: HudModel): TextFrame {
  const bat = m.glasses.battery !== undefined ? `  ■${m.glasses.battery}%` : ''
  const head = `${fmtClock(m.now)}   ${fmtSpeed(m.fix?.speed ?? NaN)} km/h   ${compass8(displayHeading(m), true)} ${Math.round(normDeg(displayHeading(m)))}°${bat}`
  if (m.toast) return { head, main: `\n  ※ ${m.toast}`, foot: ' ' }

  if (m.view === 'arrival' && m.arrival) {
    return { head, main: `◎ 已到达\n${m.arrival.name}\n\n用时 ${fmtDurationZh(m.arrival.elapsed)} · ${fmtDistStr(m.arrival.distance)}`, foot: '单击返回巡航' }
  }

  if (m.nav && m.route && m.view !== 'radar') {
    const n = m.nav
    const road = n.nextStep?.road || n.nextStep?.instruction || ''
    const lines = [
      `${ARROW[n.maneuver]}  ${fmtDistStr(n.distToManeuver)}  ${n.maneuver === 'arrive' ? '到达目的地' : MANEUVER_LABEL[n.maneuver]}`,
      road ? `进入 ${road}` : '',
      n.thenManeuver && n.thenManeuver !== 'straight' ? `然后 ${ARROW[n.thenManeuver]} ${MANEUVER_LABEL[n.thenManeuver]}` : '',
      '',
      bar(n.progress),
    ].filter((s, i) => s || i === 3)
    const eta = new Date(m.now.getTime() + n.etaSec * 1000)
    return {
      head,
      main: lines.join('\n'),
      foot: `剩余 ${fmtDistStr(n.remaining)} · ${fmtDurationZh(n.etaSec)} · 到达 ${fmtClock(eta)}`,
    }
  }

  if (m.view === 'radar') {
    const cat = RADAR_CATEGORIES[m.radar.category]
    const rows = m.radar.pois.slice(0, 5).map((p, i) => `${i + 1}. ${p.name}  ${p.distance !== undefined ? fmtDistStr(p.distance) : ''}`)
    return { head, main: `周边 · ${cat.name}\n${rows.join('\n') || (m.radar.loading ? '扫描中…' : '单击扫描')}`, foot: '单击换类别 · 滑动切换页面' }
  }

  const place = m.place ? `${m.place.street || m.place.address}\n${m.place.city} ${m.place.district}` : '等待定位…'
  return { head, main: `巡航模式\n\n${place}`, foot: '在手机上选择目的地开始导航' }
}
