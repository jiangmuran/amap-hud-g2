import { defineConfig } from 'vite'

// 手机扫码加载时，HMR 需要连回电脑的局域网 IP 而不是 localhost：
//   HMR_HOST=192.168.8.4 npm run dev
const hmrHost = process.env.HMR_HOST

export default defineConfig({
  // 相对路径：打包进 .ehpk 后从本地文件加载
  base: './',
  server: { host: true, port: 5173, hmr: hmrHost ? { host: hmrHost } : undefined },
  build: { target: 'es2022', assetsInlineLimit: 0 },
})
