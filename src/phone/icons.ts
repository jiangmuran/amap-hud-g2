// SF Symbols 风格的内联 SVG 图标（线宽、圆角端点与 SF 保持一致）

const svg = (body: string, size = 22, fill = false) =>
  `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="${fill ? 'none' : 'currentColor'}" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`

export const icon = {
  search: (s = 17) => svg('<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.6-4.6"/>', s),
  gear: (s = 22) => svg('<path d="M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4Z"/><path d="M19.4 13.5a7.6 7.6 0 0 0 0-3l2-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.6-1.5L14 2.5h-4l-.4 2.5A7.6 7.6 0 0 0 7 6.5l-2.4-1-2 3.4 2 1.6a7.6 7.6 0 0 0 0 3l-2 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.6 1.5l.4 2.5h4l.4-2.5a7.6 7.6 0 0 0 2.6-1.5l2.4 1 2-3.4Z"/>', s),
  chevronRight: (s = 14) => svg('<path d="m9 5 7 7-7 7"/>', s),
  chevronLeft: (s = 20) => svg('<path d="m15 5-7 7 7 7"/>', s),
  xmark: (s = 14) => svg('<path d="M6 6l12 12M18 6 6 18"/>', s),
  location: (s = 15) => svg('<path d="M20.5 3.5 3.8 10.6c-.8.3-.7 1.4.1 1.6l6.6 1.3 1.3 6.6c.2.8 1.3.9 1.6.1Z"/>', s, true),
  house: (s = 20) => svg('<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 9.8V20h4.5v-5.5h4V20h4.5V9.8"/>', s),
  briefcase: (s = 20) => svg('<rect x="3" y="7" width="18" height="13" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3 12.5h18"/>', s),
  clock: (s = 18) => svg('<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>', s),
  pin: (s = 18) => svg('<path d="M12 21s-6.5-5.6-6.5-11a6.5 6.5 0 0 1 13 0C18.5 15.4 12 21 12 21Z"/><circle cx="12" cy="10" r="2.3"/>', s),
  walk: (s = 18) => svg('<circle cx="13" cy="4.5" r="1.8"/><path d="m9.5 21 2.2-6.2 2.6 2.2V21M8 12.5l1.6-4.3 3.4-.8 2.3 3.6 2.7 1M11.7 14.8 13 9.2"/>', s),
  bike: (s = 18) => svg('<circle cx="5.5" cy="16.5" r="3.5"/><circle cx="18.5" cy="16.5" r="3.5"/><path d="M5.5 16.5 9 9h6.5l3 7.5M12 16.5 9 9M14 5.5h2.5L18 9"/>', s),
  scooter: (s = 18) => svg('<circle cx="5.5" cy="17.5" r="2.5"/><circle cx="18.5" cy="17.5" r="2.5"/><path d="M8 17.5h7.5l2-9h2M15 5h2.5l-1 3.5M5.5 15V12h6"/>', s),
  car: (s = 18) => svg('<path d="M4 16.5V12l2-5.2A2 2 0 0 1 7.9 5.5h8.2a2 2 0 0 1 1.9 1.3L20 12v4.5"/><path d="M3 12h18v4.5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z"/><circle cx="7" cy="14.8" r="1" fill="currentColor"/><circle cx="17" cy="14.8" r="1" fill="currentColor"/>', s),
  glasses: (s = 20) => svg('<circle cx="6.5" cy="13.5" r="3.5"/><circle cx="17.5" cy="13.5" r="3.5"/><path d="M10 13.5c1.2-1 2.8-1 4 0M3 13.5 4.5 7M21 13.5 19.5 7"/>', s),
  play: (s = 16) => svg('<path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.3-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z"/>', s, true),
  stop: (s = 16) => svg('<rect x="6" y="6" width="12" height="12" rx="2.5"/>', s, true),
  arrowTurn: (s = 18) => svg('<path d="M6 20v-7a4 4 0 0 1 4-4h8M14 5l4 4-4 4"/>', s),
  sparkles: (s = 18) => svg('<path d="M12 3.5 13.6 8 18 9.5l-4.4 1.6L12 15.5l-1.6-4.4L6 9.5 10.4 8Z"/><path d="M18.5 15.5 19.2 17.3 21 18l-1.8.7-.7 1.8-.7-1.8L16 18l1.8-.7Z"/>', s),
  phone: (s = 18) => svg('<rect x="6.5" y="2.5" width="11" height="19" rx="2.6"/><path d="M10.5 18.5h3"/>', s),
  key: (s = 18) => svg('<circle cx="8" cy="15" r="4"/><path d="m11 12 8.5-8.5M16.5 6.5l2.5 2.5M14.5 8.5l2 2"/>', s),
}
