// dsh-sv-bridge —— 浏览器半边。
//
// 就是输入框下面的一枚状态徽标:SV2 那边的桥在不在线、宿主什么版本、有几条 SV2 的消息还没投递。
// 数据来自宿主半边的只读路由 GET /dsh-sv-bridge/status(仅回环)。
//
// 纪律(来自官方 cordis-plugin-development 技能):
//   · 不 import 任何 Harness Client 包;只用 require('react') 与浏览器原生 fetch。
//   · 只用主题 token(--dsw-alias-*),不写死颜色。
//   · 样式随组件一起渲染,卸载即消失;不在组件外碰 DOM、不 append 到 document.body。
//   · 工厂函数保持无副作用;注册写在 apply 里并返回清理函数。

window.__ModuleLoader__.load({
  id: 'dsh-sv-bridge',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const STATUS_URL = '/dsh-sv-bridge/status'
    const POLL_MS = 5000

    const CSS = `
.svdb-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 10px 2px 8px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  user-select: none;
  cursor: default;
}
.svdb-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--dsw-alias-state-idle-primary);
  flex: 0 0 auto;
}
.svdb-dot[data-state='online'] { background: var(--dsw-alias-state-success-primary); }
.svdb-dot[data-state='stale'] { background: var(--dsw-alias-state-warn-primary); }
.svdb-dot[data-state='offline'] { background: var(--dsw-alias-state-error-primary); }
.svdb-warn { color: var(--dsw-alias-state-warn-primary); }
`

    function StatusChip() {
      const [state, setState] = useState(null)
      const [failed, setFailed] = useState(false)

      useEffect(() => {
        let alive = true
        const load = () => {
          fetch(STATUS_URL, { headers: { accept: 'application/json' } })
            .then((res) => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
            .then((data) => {
              if (!alive) return
              setState(data)
              setFailed(false)
            })
            .catch(() => {
              if (!alive) return
              setFailed(true)
            })
        }
        load()
        const timer = setInterval(load, POLL_MS)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const online = Boolean(state && state.online)
      const mismatch = Boolean(state && state.dirMatches === false)
      const stale = Boolean(state && state.scriptStale)
      const queued = Number(state && state.queuedFromSv) || 0
      const hbAge = Number(state && state.heartbeatAgeSeconds)

      let dotState = 'offline'
      if (online) dotState = mismatch || stale ? 'stale' : 'online'
      else if (state && !failed) dotState = 'stale'

      const parts = []
      if (failed) parts.push('SV: 插件未响应')
      else if (online) {
        parts.push(`SV ${state.hostVersion || '?'}`)
        if (state.bridgeVersion) parts.push(`桥 ${state.bridgeVersion}`)
      } else if (state) {
        parts.push(Number.isFinite(hbAge) ? `SV 已离线 ${hbAge}s` : 'SV 未连接')
      } else parts.push('SV …')
      if (stale) parts.push('⚠ 需重跑桥')
      if (queued > 0) parts.push(`${queued} 条待投递`)
      if (mismatch) parts.push('目录不一致')

      const title = failed
        ? '读不到 /dsh-sv-bridge/status。'
        : stale
          ? '⚠ 部署的脚本文件比桥的启动时间新 —— 宿主里跑的是旧实例。\n' +
            '在 SV2 里 [脚本] > [中止所有脚本],再重新运行 [脚本] > [DSH] > [DSH Bridge]。'
          : online
            ? `桥在线 · ${state.hostName || 'Synthesizer V Studio'} ${state.hostVersion || ''} · 桥版本 ${state.bridgeVersion || '?'}` +
              (queued > 0 ? `\n${queued} 条来自 SV2 的消息还没投递(用 sv_bind 绑定会话)` : '')
            : '桥不在线:在 SV2 里运行 [脚本] > [DSH] > [DSH Bridge]。\n常驻脚本不会热更,改过桥要重跑。'

      return h(
        'div',
        { className: 'svdb-chip', title },
        h('style', null, CSS),
        h('span', { className: 'svdb-dot', 'data-state': dotState }),
        h('span', null, parts.join(' · ')),
        mismatch ? h('span', { className: 'svdb-warn' }, '⚠') : null,
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.composer.dock', () =>
          ctx.slots.register(
            {
              name: 'conversation.composer.dock',
              id: 'dsh-sv-bridge-status',
              order: 20,
              label: 'SV2 桥状态',
            },
            StatusChip,
          ),
        )
      },
    }
  },
})
