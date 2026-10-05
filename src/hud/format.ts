export function fmtDist(m: number): { v: string; u: string } {
  if (!Number.isFinite(m)) return { v: '--', u: '' }
  if (m < 10) return { v: String(Math.max(0, Math.round(m))), u: 'M' }
  if (m < 1000) return { v: String(Math.round(m / 10) * 10), u: 'M' }
  if (m < 10000) return { v: (m / 1000).toFixed(1), u: 'KM' }
  return { v: String(Math.round(m / 1000)), u: 'KM' }
}

export function fmtDistStr(m: number): string {
  const d = fmtDist(m)
  return d.v + (d.u === 'KM' ? 'km' : d.u === 'M' ? 'm' : '')
}

export function fmtDuration(sec: number): { v: string; u: string } {
  if (!Number.isFinite(sec)) return { v: '--', u: '' }
  const m = Math.max(0, Math.round(sec / 60))
  if (m < 60) return { v: String(m), u: 'MIN' }
  return { v: `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`, u: 'H' }
}

export function fmtDurationZh(sec: number): string {
  const m = Math.max(0, Math.round(sec / 60))
  if (m < 60) return `${m}分钟`
  return `${Math.floor(m / 60)}小时${m % 60 ? `${m % 60}分` : ''}`
}

export function fmtClock(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function fmtElapsed(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
}

export function kmh(mps: number): number {
  return Number.isFinite(mps) ? mps * 3.6 : NaN
}

export function fmtSpeed(mps: number): string {
  const v = kmh(mps)
  if (!Number.isFinite(v)) return '--'
  return v < 10 ? v.toFixed(1) : String(Math.round(v))
}
