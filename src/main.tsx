/**
 * 前端入口：挂载 React 应用并做一次兜底错误提示。
 *
 * `?gallery` 参数进入组件画廊（dev-only 设计验收工具，不进生产界面）。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './app/App'
import { Gallery } from './gallery/Gallery'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('缺少 #root 挂载点')
}

const isGallery = new URLSearchParams(window.location.search).has('gallery')

ReactDOM.createRoot(container).render(
  <React.StrictMode>{isGallery ? <Gallery /> : <App />}</React.StrictMode>,
)
