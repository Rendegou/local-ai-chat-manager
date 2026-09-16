import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

/**
 * Vite 配置（Tauri 2 前端）。
 *
 * - 端口固定 1420：Tauri 的 devUrl 依赖它；
 * - `TAURI_DEV_HOST`：允许在手机 / 其他设备上调试；
 * - 关闭 sourcemap 让打包更小，但保留 minify。
 */
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // Tauri 期望一个固定端口，端口被占用时直接失败而不是自动换端口
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: {
      // src-tauri 由 Rust 侧监听，前端不需要重复关注
      ignored: ['**/src-tauri/**', '**/crates/**', '**/target/**'],
    },
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    // 桌面端 WebView（WebView2 / WKWebView）都支持现代语法
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
  },
})
