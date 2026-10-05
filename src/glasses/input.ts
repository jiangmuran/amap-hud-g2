// 眼镜输入归一化。处理已知坑：
// - CLICK_EVENT=0 在 protobuf 里被省略，到 JS 是 undefined，只能在信封存在时兜底成单击
// - 模拟器走 sysEvent，真机走 textEvent/listEvent，三种都要收
// - 一次物理动作可能产生重复的系统事件（相隔 50-100ms），需要去重
// - 滑动可能连发，需要节流

import { OsEventTypeList, type EvenHubEvent } from '@evenrealities/even_hub_sdk'

export type InputAction =
  | { kind: 'prev' }
  | { kind: 'next' }
  | { kind: 'click'; index?: number }
  | { kind: 'double' }
  | { kind: 'longpress' }
  | { kind: 'menu'; id: number }
  | { kind: 'foreground' }
  | { kind: 'background' }
  | { kind: 'exit' }

function typeOf(envelope?: { eventType?: OsEventTypeList }): OsEventTypeList | null {
  if (!envelope) return null
  return envelope.eventType ?? OsEventTypeList.CLICK_EVENT
}

export class InputNormalizer {
  private lastAt = new Map<string, number>()

  constructor(private scrollCooldownMs = 280, private dedupeMs = 600) {}

  private gate(key: string, ms: number): boolean {
    const now = Date.now()
    const last = this.lastAt.get(key) ?? 0
    if (now - last < ms) return false
    this.lastAt.set(key, now)
    return true
  }

  normalize(e: EvenHubEvent): InputAction | null {
    if (e.menuItemClickEvent && e.menuItemClickEvent.itemID) {
      return { kind: 'menu', id: e.menuItemClickEvent.itemID }
    }
    if (e.audioEvent) return null

    // IMU 数据走 sysEvent，不能被当成单击
    if (e.sysEvent?.eventType === OsEventTypeList.IMU_DATA_REPORT) return null
    if (e.sysEvent?.imuData && e.sysEvent.eventType === undefined) return null

    const types = [typeOf(e.sysEvent), typeOf(e.textEvent), typeOf(e.listEvent)].filter(
      (t): t is OsEventTypeList => t !== null,
    )
    if (!types.length) return null
    const has = (t: OsEventTypeList) => types.includes(t)

    // 双击优先于单击判断
    if (has(OsEventTypeList.DOUBLE_CLICK_EVENT)) return this.gate('double', 350) ? { kind: 'double' } : null
    if (has(OsEventTypeList.SCROLL_TOP_EVENT)) return this.gate('scroll', this.scrollCooldownMs) ? { kind: 'prev' } : null
    if (has(OsEventTypeList.SCROLL_BOTTOM_EVENT)) return this.gate('scroll', this.scrollCooldownMs) ? { kind: 'next' } : null
    if (has(OsEventTypeList.LONG_PRESS_EVENT)) return this.gate('long', 500) ? { kind: 'longpress' } : null
    if (has(OsEventTypeList.LONG_PRESS_RELEASE_EVENT)) return null
    if (has(OsEventTypeList.FOREGROUND_ENTER_EVENT)) return this.gate('fg', this.dedupeMs) ? { kind: 'foreground' } : null
    if (has(OsEventTypeList.FOREGROUND_EXIT_EVENT)) return this.gate('bg', this.dedupeMs) ? { kind: 'background' } : null
    if (has(OsEventTypeList.SYSTEM_EXIT_EVENT) || has(OsEventTypeList.ABNORMAL_EXIT_EVENT)) return { kind: 'exit' }
    if (has(OsEventTypeList.CLICK_EVENT)) {
      if (!this.gate('click', 200)) return null
      // 原生列表的点击带选中项；第 0 项的 index 常被省略
      if (e.listEvent) return { kind: 'click', index: e.listEvent.currentSelectItemIndex ?? 0 }
      return { kind: 'click' }
    }
    return null
  }
}
