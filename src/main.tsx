/**
 * 前端入口：挂载 React 应用并做一次兜底错误提示。
 */
import React from 'react'
import ReactDOM from 'react-dom/client'

import App from './app/App'
import './index.css'

const container = document.getElementById('root')
if (!container) {
  throw new Error('缺少 #root 挂载点')
}

ReactDOM.createRoot(container).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
