// 把 .ehpk 和上架资料上传到 Even Hub 开发者门户（不会提交审核）。
//
// 前置：先用官方 CLI 登录，凭证保存在 ~/.config/evenhub/credentials.yaml：
//   npx evenhub login
// 用法：
//   node scripts/hub-upload.mjs status            查看账号与应用状态
//   node scripts/hub-upload.mjs upload            上传 ehpk（新建应用或新建版本）并填写上架资料
//   node scripts/hub-upload.mjs listing           只更新上架资料
//
// 接口来自门户前端（hub.evenrealities.com）：/api/v1/apps/*、/api/v1/versions/*、/api/v1/misc/*

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const BASE = process.env.EVENHUB_BASE_URL || 'https://hub.evenrealities.com'
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const CRED = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'evenhub', 'credentials.yaml')
const app = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'))
const listing = JSON.parse(fs.readFileSync(path.join(ROOT, 'store/listing.json'), 'utf8'))
const PKG = app.package_id
const EHPK = path.join(ROOT, process.env.EHPK || 'realmapcn.ehpk')

// ── 凭证（只读写官方 CLI 的文件，不额外保存） ─────────────────────
function readCred() {
  if (!fs.existsSync(CRED)) throw new Error(`未找到 ${CRED}，请先运行 npx evenhub login`)
  const out = {}
  for (const line of fs.readFileSync(CRED, 'utf8').split('\n')) {
    const m = line.match(/^(\w+):\s*['"]?([^'"]*)['"]?\s*$/)
    if (m) out[m[1]] = m[2]
  }
  return out
}
function writeCred(c) {
  const body = Object.entries(c).map(([k, v]) => `${k}: ${typeof v === 'number' ? v : `'${v}'`}`).join('\n') + '\n'
  fs.writeFileSync(CRED, body, { mode: 0o600 })
}
const jwtExp = (t) => { try { return JSON.parse(Buffer.from(t.split('.')[1], 'base64url').toString()).exp } catch { return 0 } }

let cred = readCred()
async function accessToken() {
  if (cred.access_token && jwtExp(cred.access_token) > Date.now() / 1000 + 60) return cred.access_token
  const r = await fetch(`${BASE}/api/v1/auth/refresh`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: cred.refresh_token }),
  })
  const j = await r.json()
  if (j.code !== 0) throw new Error(`刷新令牌失败（${j.code} ${j.message}），请重新运行 npx evenhub login`)
  cred = { ...cred, ...j.data }
  writeCred(cred)
  return cred.access_token
}

// ── 请求封装 ───────────────────────────────────────────────────────
async function call(method, p, { params, json, form } = {}) {
  const url = new URL(BASE + p)
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v)
  const headers = { 'x-even-authorization': await accessToken() }
  let body
  if (json) { headers['Content-Type'] = 'application/json'; body = JSON.stringify(json) }
  if (form) body = form
  const r = await fetch(url, { method, headers, body })
  const text = await r.text()
  let j
  try { j = JSON.parse(text) } catch { throw new Error(`${method} ${p} → HTTP ${r.status} ${text.slice(0, 200)}`) }
  if (j.code !== 0) throw new Error(`${method} ${p} → ${j.code} ${j.message}`)
  return j.data
}
const get = (p, params) => call('GET', p, { params })
const postForm = (p, form, params) => call('POST', p, { form, params })
const fileBlob = (f, type) => new Blob([fs.readFileSync(path.join(ROOT, f))], { type })

// ── 动作 ───────────────────────────────────────────────────────────
async function findApp() {
  const data = await get('/api/v1/apps/list', { page: 1, page_size: 100 })
  const list = data?.list ?? data ?? []
  return list.find((a) => a.package_id === PKG) ?? null
}

async function uploadEhpk(existing) {
  if (!fs.existsSync(EHPK)) throw new Error(`没有 ${EHPK}，先运行 npm run pack`)
  const form = new FormData()
  form.append('ehpk', new Blob([fs.readFileSync(EHPK)]), path.basename(EHPK))
  if (!existing) {
    const draft = await postForm('/api/v1/apps/draft', form)
    console.log('ehpk 草稿：', JSON.stringify(draft).slice(0, 300))
    const f = new FormData()
    f.append('draft_id', draft.draft_id ?? draft.id)
    f.append('tagline', listing.tagline)
    f.append('name', listing.name)
    f.append('icon', fileBlob(listing.icon, 'image/png'), 'icon.png')
    f.append('icon_data', JSON.stringify(listing.icon_data))
    const created = await postForm('/api/v1/apps/create', f)
    console.log('已创建应用：', JSON.stringify(created).slice(0, 300))
  } else {
    const draft = await postForm('/api/v1/versions/draft', form, { package_id: PKG })
    console.log('版本草稿：', JSON.stringify(draft).slice(0, 300))
    const f = new FormData()
    f.append('draft_id', draft.draft_id ?? draft.id)
    f.append('changelog', listing.changelog)
    const v = await postForm('/api/v1/versions/create', f, { package_id: PKG })
    console.log('已创建版本：', JSON.stringify(v).slice(0, 300))
  }
}

async function pickCover() {
  const cfg = await get('/api/v1/misc/covers_config')
  const groups = cfg?.list ?? cfg ?? []
  const images = []
  for (const g of groups) for (const c of g.categories ?? []) for (const im of c.images ?? []) images.push({ group: g.name ?? g.title, cat: c.name ?? c.category ?? c, ...im })
  const want = process.env.COVER
  const pick = (want && images.find((i) => i.original?.includes(want))) || images.find((i) => /travel|city|map|night|road/i.test(JSON.stringify(i))) || images[0]
  console.log(`封面：${images.length} 张可选，使用 ${pick?.original}`)
  return pick
}

async function updateListing() {
  const cover = await pickCover()
  const f = new FormData()
  f.append('name', listing.name)
  f.append('tagline', listing.tagline)
  f.append('description', listing.description)
  f.append('creator_name', listing.creator_name)
  for (const c of listing.category) f.append('category', c)
  for (const t of listing.tags) f.append('tags', t)
  f.append('icon', fileBlob(listing.icon, 'image/png'), 'icon.png')
  f.append('icon_data', JSON.stringify(listing.icon_data))
  for (const s of listing.screenshots) f.append('foreground', fileBlob(s, 'image/png'), path.basename(s))
  if (cover?.original) f.append('background', cover.original)
  if (cover?.styled) f.append('background_styled', cover.styled)
  if (listing.privacy_url) f.append('privacy', listing.privacy_url)
  const r = await postForm('/api/v1/apps/update', f, { package_id: PKG })
  console.log('上架资料已更新：', JSON.stringify(r).slice(0, 300))
}

async function status() {
  const self = await call('GET', '/api/v1/auth/self_check').catch((e) => ({ error: e.message }))
  console.log('账号：', JSON.stringify(self).slice(0, 300))
  const a = await findApp()
  if (!a) return console.log(`门户里还没有 ${PKG}`)
  const detail = await get('/api/v1/apps/get', { package_id: PKG })
  const { description, ...rest } = detail ?? {}
  console.log('应用：', JSON.stringify(rest, null, 1).slice(0, 2500))
  const summary = await get('/api/v1/apps/store-listing-summary', { package_id: PKG }).catch((e) => e.message)
  console.log('上架资料完成度：', JSON.stringify(summary).slice(0, 800))
}

const cmd = process.argv[2] || 'status'
try {
  if (cmd === 'status') await status()
  else if (cmd === 'upload') { await uploadEhpk(await findApp()); await updateListing(); await status() }
  else if (cmd === 'listing') { await updateListing(); await status() }
  else console.log('用法：status | upload | listing')
} catch (e) {
  console.error('✗', e.message)
  process.exitCode = 1
}
