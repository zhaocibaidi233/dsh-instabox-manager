/**
 * Client half of `@local/instabox-manager`.
 *
 * Two slots: a compact action at the sidebar foot, and a frame-wide overlay
 * panel that lists the configured InstaBox sandboxes and drives their
 * lifecycle. Every privileged step goes through the Host routes
 * `/instabox-manager/state` and `/instabox-manager/action` (see index.js);
 * the browser never sees an API key and never calls instabox.sh directly.
 */
window.__ModuleLoader__.load({
  id: '@local/instabox-manager',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'instabox'
    const STATE_ROUTE = '/instabox-manager/state'
    const ACTION_ROUTE = '/instabox-manager/action'
    const LEASE_ROUTE = '/instabox-manager/lease'
    const REFRESH_MS = 15_000

    const FALLBACK = {
      label: 'InstaBox',
      open: '打开 InstaBox 沙盒面板',
      panelTitle: 'InstaBox 沙盒',
      panelHint: '配置来自 ~/.dsh/instabox-manager.json',
      refresh: '刷新',
      refreshing: '刷新中…',
      close: '关闭',
      empty: '没有配置任何沙盒',
      loadFailed: '读取状态失败',
      actionFailed: '操作失败',
      running: '运行中',
      suspended: '已暂停',
      stopped: '已停止',
      cooldown: '冷却至',
      start: '启动',
      suspend: '暂停',
      resume: '恢复',
      stop: '停止',
      working: '处理中…',
      leaseOn: '保活',
      leaseOff: '停止保活',
      leaseHeld: '持租约',
      leaseExpires: '到期',
      leaseEvery: '每',
      leaseRenewUnit: 's 续',
      leaseFailed: '保活操作失败',
      leaseOnlyRunning: '仅运行中/已暂停可保活',
      cycleOn: '轮转',
      cycleOff: '停止轮转',
      cycleNext: '下次轮转',
      cycleMaxRun: 'maxRun 剩',
      cycleSoon: '即将轮转',
      cycleFailed: '轮转失败',
      cycleNone: '轮转未排期',
      cycleDisabled: '轮转关闭',
    }

    const CSS = [
      '.ibx-btn{box-sizing:border-box;display:inline-flex;align-items:center;gap:6px;min-height:28px;padding:3px 8px;pointer-events:auto;',
      'border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;',
      'font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap;overflow:hidden}',
      '.ibx-btn:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-2))}',
      '.ibx-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px;color:var(--dsw-alias-label-primary)}',
      '.ibx-btn svg{flex:none}',
      '.ibx-wide{flex:1 1 100%;width:calc(100% + 8px);margin:4px -4px;height:34px;padding:0 10px;border-radius:12px;',
      'font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary)}',
      '.ibx-rail{width:36px;height:36px;padding:0;justify-content:center;border-radius:12px}',
      '.ibx-label{min-width:0;overflow:hidden;text-overflow:ellipsis}',
      '.ibx-backdrop{position:fixed;inset:0;z-index:1000;display:flex;align-items:center;justify-content:center;pointer-events:auto;',
      'padding:24px;background:var(--dsw-alias-bg-mask-1)}',
      '.ibx-panel{box-sizing:border-box;width:min(620px,100%);max-height:min(76vh,720px);display:flex;flex-direction:column;',
      'border:1px solid var(--dsw-alias-border-l2);border-radius:16px;background:var(--dsw-alias-bg-layer-1);',
      'box-shadow:0 18px 48px rgba(0,0,0,.24);overflow:hidden;color:var(--dsw-alias-label-primary);font:inherit}',
      '.ibx-head{display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}',
      '.ibx-title{font-size:14px;font-weight:600;line-height:20px}',
      '.ibx-hint{font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.ibx-head-actions{margin-left:auto;display:flex;align-items:center;gap:6px}',
      '.ibx-ghost{min-height:26px;padding:2px 9px;border:1px solid var(--dsw-alias-border-l2);border-radius:8px;',
      'background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.ibx-ghost:hover{color:var(--dsw-alias-label-primary);border-color:var(--dsw-alias-border-l3,var(--dsw-alias-border-l2))}',
      '.ibx-body{padding:12px 16px;overflow:auto;display:flex;flex-direction:column;gap:10px}',
      '.ibx-card{border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:12px;display:flex;flex-direction:column;gap:8px;',
      'background:var(--dsw-alias-bg-layer-2,transparent)}',
      '.ibx-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.ibx-name{font-size:13px;font-weight:600}',
      '.ibx-meta{font-size:11px;color:var(--dsw-alias-label-secondary);line-height:16px}',
      '.ibx-badge{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;',
      'border:1px solid var(--dsw-alias-border-l2)}',
      '.ibx-dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.ibx-on{color:var(--dsw-alias-state-success-primary)}',
      '.ibx-off{color:var(--dsw-alias-label-secondary)}',
      '.ibx-warn{color:var(--dsw-alias-state-warn-primary)}',
      '.ibx-actions{display:flex;gap:6px;flex-wrap:wrap}',
      '.ibx-act{min-height:28px;padding:2px 10px;border-radius:8px;border:1px solid var(--dsw-alias-border-l2);',
      'background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;cursor:pointer}',
      '.ibx-act:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-brand-primary)}',
      '.ibx-act:disabled{opacity:.45;cursor:not-allowed}',
      '.ibx-act.is-on{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.ibx-lease{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;',
      'border:1px dashed var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}',
      '.ibx-lease.bad{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}',
      '.ibx-cycle{display:inline-flex;align-items:center;gap:5px;padding:1px 8px;border-radius:999px;font-size:11px;line-height:18px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}',
      '.ibx-cycle.due{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}',
      '.ibx-note{margin:0 16px 14px;padding:8px 10px;border-radius:10px;font-size:12px;line-height:18px;',
      'border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-state-error-primary);background:transparent}',
      '.ibx-code{font-family:var(--dsw-alias-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;',
      'color:var(--dsw-alias-label-secondary);word-break:break-all}',
      '.ibx-empty{padding:26px 8px;text-align:center;font-size:13px;color:var(--dsw-alias-label-secondary)}',
    ].join('')

    const store = {
      open: false,
      listeners: new Set(),
      get() {
        return store.open
      },
      set(next) {
        if (store.open === next) return
        store.open = next
        for (const listener of [...store.listeners]) listener()
      },
      subscribe(listener) {
        store.listeners.add(listener)
        return () => store.listeners.delete(listener)
      },
    }

    function useOpen() {
      const [open, setOpen] = React.useState(() => store.get())
      React.useEffect(() => store.subscribe(() => setOpen(store.get())), [])
      return open
    }

    function translator(props) {
      const translate = typeof props?.t === 'function' ? props.t : null
      return (key) => {
        if (translate) {
          const value = translate(key)
          if (typeof value === 'string' && value !== key && value !== '') return value
        }
        return FALLBACK[key] ?? key
      }
    }

    function Glyph(size) {
      return h(
        'svg',
        {
          viewBox: '0 0 24 24',
          width: size,
          height: size,
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          style: { display: 'block', color: 'var(--dsw-alias-brand-primary)' },
        },
        h('rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }),
        h('path', { d: 'M7 10.5l2 2-2 2' }),
        h('path', { d: 'M12.5 14.5h4.5' }),
      )
    }

    function LaunchAction(props) {
      const t = translator(props)
      const wide = props?.wide === true
      const open = useOpen()
      return h(
        'div',
        { className: 'ibx-root', style: { display: 'flex' } },
        h('style', null, CSS),
        h(
          'button',
          {
            type: 'button',
            className: 'ibx-btn ' + (wide ? 'ibx-wide' : 'ibx-rail'),
            'aria-label': t('open'),
            'aria-expanded': open ? 'true' : 'false',
            title: wide ? t('open') : t('label'),
            onClick: () => store.set(true),
          },
          Glyph(wide ? 14 : 18),
          wide ? h('span', { className: 'ibx-label' }, t('label')) : null,
        ),
      )
    }

    function stateTone(state) {
      if (state === 'running') return { className: 'ibx-badge ibx-on', key: 'running' }
      if (state === 'suspended' || state === 'suspending') return { className: 'ibx-badge ibx-warn', key: 'suspended' }
      if (state === 'stopped') return { className: 'ibx-badge ibx-off', key: 'stopped' }
      return { className: 'ibx-badge ibx-warn', key: null }
    }

    function leaseExpiryText(lease, t) {
      if (!lease?.expiresAt) return t('leaseHeld')
      const at = Date.parse(lease.expiresAt)
      if (!Number.isFinite(at)) return t('leaseHeld')
      const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
      const renew = lease.renewEverySeconds ? ` · ${t('leaseEvery')} ${lease.renewEverySeconds}${t('leaseRenewUnit')}` : ''
      return `${t('leaseHeld')} · ${t('leaseExpires')} ${time}${renew}`
    }

    function cycleNextText(lease, t) {
      if (!lease?.active) return null
      if (lease.cycleEnabled === false) return t('cycleDisabled')
      const at = Date.parse(lease.nextCycleAt ?? '')
      if (!Number.isFinite(at)) return t('cycleNone')
      const minutes = Math.max(0, Math.round((at - Date.now()) / 60_000))
      const time = new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      return minutes <= 1 ? t('cycleSoon') : `${t('cycleNext')} ${time}`
    }

    function MachineCard(props) {
      const { machine, busy, onAct, onLease, onCycle, t } = props
      const tone = stateTone(machine.state)
      const stateLabel = tone.key ? t(tone.key) : machine.state
      const running = machine.state === 'running'
      const suspended = machine.state === 'suspended'
      const stopped = machine.state === 'stopped' || machine.state === 'error'
      const mine = typeof busy === 'string' && busy.startsWith(`${machine.id}:`)
      const lease = machine.lease ?? { active: false }
      const leaseBusy = mine && busy === `${machine.id}:lease`
      const cycleBusy = mine && busy === `${machine.id}:cycle`
      const button = (action, label, enabled) =>
        h(
          'button',
          {
            type: 'button',
            className: 'ibx-act',
            disabled: (mine && busy === `${machine.id}:${action}`) || !enabled,
            onClick: () => onAct(machine, action),
          },
          mine && busy === `${machine.id}:${action}` ? t('working') : t(label),
        )
      return h(
        'div',
        { className: 'ibx-card' },
        h(
          'div',
          { className: 'ibx-row' },
          h('span', { className: 'ibx-name' }, machine.name),
          h('span', { className: tone.className }, h('span', { className: 'ibx-dot' }), stateLabel),
          machine.cooldownUntil
            ? h('span', { className: 'ibx-meta' }, `${t('cooldown')} ${machine.cooldownUntil}`)
            : null,
          running && machine.runMinutesLeft !== undefined
            ? h(
                'span',
                { className: 'ibx-cycle' + (machine.runMinutesLeft <= 25 ? ' due' : '') },
                `${t('cycleMaxRun')} ${machine.runMinutesLeft}min${machine.maxRunMinutes ? `/${machine.maxRunMinutes}` : ''}`,
              )
            : null,
          lease.active
            ? h(
                'span',
                {
                  className: 'ibx-lease' + (lease.lastError ? ' bad' : ''),
                  title: lease.lastError ?? '',
                },
                leaseExpiryText(lease, t),
              )
            : null,
          lease.active && cycleNextText(lease, t)
            ? h('span', { className: 'ibx-cycle' }, cycleNextText(lease, t))
            : null,
        ),
        h(
          'div',
          { className: 'ibx-meta' },
          [
            machine.account,
            machine.template,
            machine.vcpus !== undefined && machine.memMiB !== undefined
              ? `${machine.vcpus}c / ${machine.memMiB} MiB`
              : undefined,
            machine.id,
          ]
            .filter(Boolean)
            .join(' · '),
        ),
        lease.active && lease.lastError
          ? h('div', { className: 'ibx-meta' }, `${t('leaseHeld')}：${lease.lastError}`)
          : null,
        lease.active && lease.lastCycleError
          ? h('div', { className: 'ibx-meta' }, `${t('cycleFailed')}：${lease.lastCycleError}`)
          : null,
        lease.active && lease.cycleCount > 0
          ? h('div', { className: 'ibx-meta' }, `${t('cycleOn')} ×${lease.cycleCount}${lease.lastCycleAt ? ` · ${new Date(lease.lastCycleAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}`)
          : null,
        machine.ssh ? h('div', { className: 'ibx-code' }, machine.ssh) : null,
        h(
          'div',
          { className: 'ibx-actions' },
          button('start', 'start', stopped),
          button('suspend', 'suspend', running),
          button('resume', 'resume', suspended),
          button('stop', 'stop', running || suspended),
          h(
            'button',
            {
              type: 'button',
              className: 'ibx-act' + (lease.active ? ' is-on' : ''),
              disabled: leaseBusy || (!lease.active && !(running || suspended)),
              title: lease.active ? t('leaseOff') : t('leaseOn'),
              onClick: () => onLease(machine),
            },
            leaseBusy ? t('working') : lease.active ? t('leaseOff') : t('leaseOn'),
          ),
          lease.active
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ibx-act' + (lease.cycleEnabled !== false ? ' is-on' : ''),
                  disabled: cycleBusy || !running,
                  title: lease.cycleEnabled !== false ? t('cycleOff') : t('cycleOn'),
                  onClick: () => onCycle(machine, lease.cycleEnabled !== false ? 'cycle-disable' : 'cycle-enable'),
                },
                cycleBusy ? t('working') : lease.cycleEnabled !== false ? t('cycleOff') : t('cycleOn'),
              )
            : null,
          lease.active && running
            ? h(
                'button',
                {
                  type: 'button',
                  className: 'ibx-act',
                  disabled: cycleBusy,
                  title: '立即轮转一次',
                  onClick: () => onCycle(machine, 'cycle'),
                },
                '立即轮转',
              )
            : null,
        ),
      )
    }

    function Panel(props) {
      const t = translator(props)
      const tRef = React.useRef(t)
      tRef.current = t
      const open = useOpen()
      const [snapshot, setSnapshot] = React.useState(null)
      const [failure, setFailure] = React.useState(null)
      const [busy, setBusy] = React.useState(null)
      const [loading, setLoading] = React.useState(false)

      const load = React.useCallback(async () => {
        setLoading(true)
        try {
          const response = await fetch(STATE_ROUTE, { cache: 'no-store', credentials: 'same-origin' })
          const data = await response.json()
          if (response.ok && data && Array.isArray(data.machines)) {
            setSnapshot(data)
            setFailure(Array.isArray(data.errors) && data.errors.length > 0
              ? data.errors.map((entry) => `${entry.alias}: ${entry.message}`).join('\n')
              : null)
          } else {
            setFailure(data?.reason ?? tRef.current('loadFailed'))
          }
        } catch (error) {
          setFailure(String(error))
        } finally {
          setLoading(false)
        }
      }, [])

      React.useEffect(() => {
        if (!open) return undefined
        let cancelled = false
        void load()
        const timer = setInterval(() => {
          if (!cancelled) void load()
        }, REFRESH_MS)
        const onKey = (event) => {
          if (event.key === 'Escape') store.set(false)
        }
        document.addEventListener('keydown', onKey)
        return () => {
          cancelled = true
          clearInterval(timer)
          document.removeEventListener('keydown', onKey)
        }
      }, [open, load])

      const act = async (machine, action) => {
        setBusy(`${machine.id}:${action}`)
        try {
          const response = await fetch(ACTION_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machine: machine.id, action }),
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data?.ok) {
            setFailure(data?.text ?? data?.reason ?? tRef.current('actionFailed'))
          } else {
            setFailure(null)
          }
        } catch (error) {
          setFailure(String(error))
        } finally {
          setBusy(null)
          void load()
        }
      }

      const cycleAct = async (machine, action) => {
        setBusy(`${machine.id}:cycle`)
        try {
          const response = await fetch(LEASE_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machine: machine.id, action }),
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data?.ok) {
            setFailure(data?.text ?? data?.reason ?? tRef.current('cycleFailed'))
          } else {
            setFailure(null)
          }
        } catch (error) {
          setFailure(String(error))
        } finally {
          setBusy(null)
          void load()
        }
      }

      const leaseAct = async (machine) => {
        const active = machine.lease?.active === true
        setBusy(`${machine.id}:lease`)
        try {
          const response = await fetch(LEASE_ROUTE, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ machine: machine.id, action: active ? 'stop' : 'start' }),
          })
          const data = await response.json().catch(() => null)
          if (!response.ok || !data?.ok) {
            setFailure(data?.text ?? data?.reason ?? tRef.current('leaseFailed'))
          } else {
            setFailure(null)
          }
        } catch (error) {
          setFailure(String(error))
        } finally {
          setBusy(null)
          void load()
        }
      }

      if (!open) return null
      const machines = Array.isArray(snapshot?.machines) ? snapshot.machines : []
      return h(
        React.Fragment,
        null,
        h('style', { key: 'ibx-style' }, CSS),
        h(
          'div',
          {
            key: 'ibx-backdrop',
            className: 'ibx-backdrop',
            onClick: (event) => {
              if (event.target === event.currentTarget) store.set(false)
            },
          },
          h(
            'div',
            { className: 'ibx-panel', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('panelTitle') },
            h(
              'div',
              { className: 'ibx-head' },
              Glyph(20),
              h(
                'div',
                null,
                h('div', { className: 'ibx-title' }, t('panelTitle')),
                h('div', { className: 'ibx-hint' }, t('panelHint')),
              ),
              h(
                'div',
                { className: 'ibx-head-actions' },
                h(
                  'button',
                  { type: 'button', className: 'ibx-ghost', onClick: () => void load(), disabled: loading },
                  loading ? t('refreshing') : t('refresh'),
                ),
                h('button', { type: 'button', className: 'ibx-ghost', onClick: () => store.set(false) }, t('close')),
              ),
            ),
            h(
              'div',
              { className: 'ibx-body' },
              machines.length === 0
                ? h('div', { className: 'ibx-empty' }, snapshot === null ? t('refreshing') : t('empty'))
                : machines.map((machine) =>
                    h(MachineCard, {
                      key: machine.id,
                      machine,
                      busy,
                      t,
                      onAct: act,
                      onLease: leaseAct,
                      onCycle: cycleAct,
                    }),
                  ),
            ),
            failure ? h('div', { className: 'ibx-note', role: 'status' }, failure) : null,
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const slots = ctx.slots
        if (!slots) return
        ctx.inject(['locale'], (scoped) => {
          const locale = scoped.locale
          if (!locale || typeof locale.register !== 'function') return
          scoped.effect(
            () =>
              locale.register(NS, {
                zh: {
                  label: 'InstaBox',
                  open: '打开 InstaBox 沙盒面板',
                  panelTitle: 'InstaBox 沙盒',
                  panelHint: '配置来自 ~/.dsh/instabox-manager.json',
                  refresh: '刷新',
                  refreshing: '刷新中…',
                  close: '关闭',
                  empty: '没有配置任何沙盒',
                  loadFailed: '读取状态失败',
                  actionFailed: '操作失败',
                  running: '运行中',
                  suspended: '已暂停',
                  stopped: '已停止',
                  cooldown: '冷却至',
                  start: '启动',
                  suspend: '暂停',
                  resume: '恢复',
                  stop: '停止',
                  working: '处理中…',
                  leaseOn: '保活',
                  leaseOff: '停止保活',
                  leaseHeld: '持租约',
                  leaseExpires: '到期',
                  leaseEvery: '每',
                  leaseRenewUnit: 's 续',
                  leaseFailed: '保活操作失败',
                  leaseOnlyRunning: '仅运行中/已暂停可保活',
                  cycleOn: '轮转',
                  cycleOff: '停止轮转',
                  cycleNext: '下次轮转',
                  cycleMaxRun: 'maxRun 剩',
                  cycleSoon: '即将轮转',
                  cycleFailed: '轮转失败',
                  cycleNone: '轮转未排期',
                  cycleDisabled: '轮转关闭',
                },
                en: {
                  label: 'InstaBox',
                  open: 'Open the InstaBox sandbox panel',
                  panelTitle: 'InstaBox sandboxes',
                  panelHint: 'Configured in ~/.dsh/instabox-manager.json',
                  refresh: 'Refresh',
                  refreshing: 'Refreshing…',
                  close: 'Close',
                  empty: 'No sandboxes configured',
                  loadFailed: 'Could not read sandbox state',
                  actionFailed: 'Action failed',
                  running: 'Running',
                  suspended: 'Suspended',
                  stopped: 'Stopped',
                  cooldown: 'Cooldown until',
                  start: 'Start',
                  suspend: 'Suspend',
                  resume: 'Resume',
                  stop: 'Stop',
                  working: 'Working…',
                  leaseOn: 'Keep alive',
                  leaseOff: 'Stop keepalive',
                  leaseHeld: 'Lease held',
                  leaseExpires: 'expires',
                  leaseEvery: 'every',
                  leaseRenewUnit: 's',
                  leaseFailed: 'Keepalive action failed',
                  leaseOnlyRunning: 'Keepalive needs a running or suspended sandbox',
                  cycleOn: 'Rotate',
                  cycleOff: 'Stop rotation',
                  cycleNext: 'Next rotation',
                  cycleMaxRun: 'maxRun left',
                  cycleSoon: 'Rotating soon',
                  cycleFailed: 'Rotation failed',
                  cycleNone: 'No rotation scheduled',
                  cycleDisabled: 'Rotation off',
                },
              }),
            'instabox-manager: locale',
          )
          slots.inject('sidebar.footer.action', () =>
            slots.register(
              { name: 'sidebar.footer.action', id: 'instabox-manager', order: 6, locale: NS },
              LaunchAction,
            ),
          )
          slots.inject('shell.overlay', () =>
            slots.register(
              { name: 'shell.overlay', id: 'instabox-manager-panel', order: 60, locale: NS },
              Panel,
            ),
          )
        })
      },
    }
  },
})