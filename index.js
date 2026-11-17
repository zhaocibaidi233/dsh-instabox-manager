/**
 * InstaBox sandbox manager for this Harness profile.
 *
 * Reads the configured accounts from $DSH_INSTABOX_CONFIG (default
 * ~/.dsh/instabox-manager.json) and exposes four model-facing tools:
 * list, status, exec and power. No network dependency beyond `fetch`.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'instabox-manager'
export const inject = ['tools']

const CONFIG_PATH = process.env.DSH_INSTABOX_CONFIG ?? join(homedir(), '.dsh', 'instabox-manager.json')
const DEFAULT_API_BASE = 'https://api.instabox.sh'
const OPERATION_POLL_MS = 1500
const OPERATION_WAIT_MS = 120_000

const LEASE_ID = 'keepalive'
const LEASE_TTL_DEFAULT = 300
const LEASE_TTL_MIN = 30
const LEASE_TTL_MAX = 3600
const LEASE_RENEW_RATIO = 0.6
const LEASE_TICK_MS = 5_000
const LEASE_STATE_PATH = process.env.DSH_INSTABOX_LEASE_STATE ?? join(homedir(), '.dsh', 'instabox-manager-lease.json')

// Maintenance rotation: a free-plan run starts at 120 minutes and cannot be
// extended by a lease, so the run is reset by an intentional suspend→resume
// before the max-run pause (and its cooldown) would fire.
function envInt(name, fallback, min, max) {
  const raw = Number(process.env[name])
  if (!Number.isFinite(raw)) return fallback
  return Math.min(max, Math.max(min, Math.round(raw)))
}

const CYCLE_MARGIN_MIN = envInt('DSH_INSTABOX_CYCLE_MARGIN_MIN', 20, 1, 110)
const CYCLE_HOLD_SEC = envInt('DSH_INSTABOX_CYCLE_HOLD_SEC', 0, 0, 600)
const CYCLE_RETRY_MS = 5 * 60_000
const CYCLE_DEBUG = process.env.DSH_INSTABOX_CYCLE_DEBUG === '1'
const cycleDbg = (...parts) => { if (CYCLE_DEBUG) console.error('[instabox-cycle]', ...parts) }

/** One text-only tool result, rendered as the visible content block. */
const textResult = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      text: { type: 'string', description: 'The complete human-readable result.' },
    },
    required: ['text'],
  },
  render(_args, value) {
    return [{ type: 'text', text: value.text }]
  },
}

function maskKey(key) {
  const tail = key.slice(-6)
  return `ibk_****${tail}`
}

function readConfig() {
  let raw
  try {
    raw = readFileSync(CONFIG_PATH, 'utf8')
  } catch (error) {
    throw new Error(`InstaBox 配置缺失或不可读：${CONFIG_PATH}（${error.code ?? error.message}）。写入 {"apiBase":"https://api.instabox.sh","accounts":[{"alias":"名字","apiKey":"ibk_...","machineId":"m_..."}]} 后重试。`)
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`InstaBox 配置不是合法 JSON：${CONFIG_PATH}`)
  }
  const accounts = (Array.isArray(parsed?.accounts) ? parsed.accounts : [])
    .filter(entry => entry && typeof entry.apiKey === 'string' && entry.apiKey.startsWith('ibk_'))
    .map(entry => ({
      alias: String(entry.alias ?? entry.machineId ?? entry.name ?? 'account'),
      name: entry.name === undefined ? undefined : String(entry.name),
      apiKey: entry.apiKey,
      machineId: entry.machineId === undefined ? undefined : String(entry.machineId),
      sshCommand: entry.sshCommand === undefined ? undefined : String(entry.sshCommand),
    }))
  if (accounts.length === 0) {
    throw new Error(`InstaBox 配置里没有可用账号（每条需要 apiKey="ibk_..."）：${CONFIG_PATH}`)
  }
  return {
    apiBase: String(parsed?.apiBase ?? DEFAULT_API_BASE).replace(/\/+$/, ''),
    accounts,
  }
}

async function request(config, account, path, options = {}) {
  const url = `${config.apiBase}${path}`
  const headers = { 'X-API-Key': account.apiKey, ...(options.headers ?? {}) }
  const init = { method: options.method ?? 'GET', headers }
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json'
    init.body = JSON.stringify(options.body)
  }
  if (options.signal) init.signal = options.signal
  const response = await fetch(url, init)
  const raw = await response.text()
  let payload
  if (raw.length > 0) {
    try {
      payload = JSON.parse(raw)
    } catch {
      payload = undefined
    }
  }
  if (!response.ok) {
    const error = payload?.error ?? {}
    const retry = error.retryAfterSeconds ?? response.headers.get('retry-after')
    const detail = [error.code, error.message].filter(Boolean).join(': ')
      || raw.slice(0, 300)
      || response.statusText
    throw new Error(`InstaBox API ${response.status} ${detail}${retry === undefined || retry === null ? '' : `（${retry} 秒后可重试）`}`)
  }
  return payload
}

function accountFor(config, machine) {
  const wanted = String(machine ?? '').trim()
  const aliases = config.accounts.map(entry => entry.alias).join('、')
  if (wanted.length === 0) {
    if (config.accounts.length === 1) return config.accounts[0]
    throw new Error(`需要指定沙盒：${aliases}`)
  }
  const needle = wanted.toLowerCase()
  const hit = config.accounts.find(entry => entry.alias.toLowerCase() === needle
    || entry.machineId?.toLowerCase() === needle
    || entry.name?.toLowerCase() === needle)
  if (hit !== undefined) return hit
  throw new Error(`未配置沙盒 "${wanted}"；可用：${aliases}`)
}

async function machineIdOf(config, account, signal) {
  if (account.machineId) return account.machineId
  const data = await request(config, account, '/v1/machines', { signal })
  const first = Array.isArray(data?.machines) ? data.machines[0] : undefined
  if (first === undefined) throw new Error(`账号 ${account.alias} 下没有沙盒`)
  account.machineId = first.id
  return first.id
}

function activeCooldown(machine) {
  const until = machine?.cooldownUntil
  if (typeof until !== 'string' || until.length === 0) return undefined
  const at = Date.parse(until)
  return Number.isFinite(at) && at > Date.now() ? until : undefined
}

function describeMachine(machine) {
  const spec = machine.spec ?? {}
  const template = machine.template ?? {}
  const bits = [
    String(machine.state ?? 'unknown').padEnd(9),
    machine.name ?? '(no name)',
    machine.id,
    `${template.id ?? '?'}@${template.version ?? '?'}`,
    `${spec.vcpus ?? '?'}c/${spec.memMiB ?? '?'}MiB`,
  ]
  const cooldown = activeCooldown(machine)
  if (cooldown !== undefined) bits.push(`冷却至 ${cooldown}`)
  if (machine.autoSuspendAfterSeconds === null) bits.push('自动睡眠关闭')
  return bits.join('  ')
}

function formatDisk(disk) {
  const filesystems = Array.isArray(disk?.filesystems) ? disk.filesystems : []
  if (filesystems.length === 0) return undefined
  return filesystems
    .map((entry) => {
      const pct = typeof entry.usedPct === 'number' ? `${Math.round(entry.usedPct)}%` : '?'
      const free = typeof entry.availableBytes === 'number'
        ? `${(entry.availableBytes / 1024 ** 3).toFixed(1)} GiB 可用`
        : ''
      const level = entry.level === undefined ? '' : ` ${entry.level}`
      return `${entry.mount ?? '?'} ${pct}${level}${free.length > 0 ? ` · ${free}` : ''}`
    })
    .join(' · ')
}

function sleep(milliseconds, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason ?? new Error('aborted'))
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
  })
}

async function waitOperation(config, account, operationId, signal) {
  const deadline = Date.now() + OPERATION_WAIT_MS
  let operation
  while (Date.now() < deadline) {
    operation = await request(config, account, `/v1/operations/${operationId}`, { signal })
    if (operation?.state === 'succeeded' || operation?.state === 'failed') return operation
    await sleep(OPERATION_POLL_MS, signal)
  }
  return operation
}

const POWER_PATH = {
  start: 'start',
  stop: 'stop',
  suspend: 'suspend',
  resume: 'resume',
  wake: 'wake',
}

const API_ROOT = '/instabox-manager'

/** Turn one lifecycle request into its finished operation. Shared by the tool and the sidebar route. */
async function runPower(config, machine, action, signal) {
  const account = accountFor(config, machine)
  const segment = POWER_PATH[action]
  if (segment === undefined) throw new Error(`未知 action "${action}"；可用：${Object.keys(POWER_PATH).join(', ')}`)
  const machineId = await machineIdOf(config, account, signal)
  const accepted = await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/${segment}`, {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': `dsh-instabox-${randomUUID()}` },
    signal,
  })
  const operationId = accepted?.id ?? accepted?.operationId
  if (typeof operationId !== 'string') {
    return { ok: true, state: undefined, text: `已提交 ${action}：${machineId}（服务未返回 operation id）` }
  }
  const operation = await waitOperation(config, account, operationId, signal)
  if (operation === undefined) {
    return { ok: true, state: undefined, text: `已提交 ${action}：${machineId} · operation ${operationId} 状态未知` }
  }
  const phase = operation.phase ? ` · ${operation.phase}` : ''
  const machineState = operation.machine?.state
  const stateText = machineState ? ` → ${machineState}` : ''
  if (operation.state === 'failed') {
    const error = operation.error
      ? `\n错误：${[operation.error.code, operation.error.message].filter(Boolean).join(' ')}`
      : ''
    return { ok: false, state: machineState, text: `${action} 失败${phase} · 沙盒 ${machineId}${stateText}${error}` }
  }
  if (operation.state !== 'succeeded') {
    return {
      ok: true,
      state: machineState,
      text: `${action} 已提交（operation ${operation.state}${phase}）· 沙盒 ${machineId}${stateText}；后台继续执行，稍后用 instabox_status 查看`,
    }
  }
  return { ok: true, state: machineState, text: `${action} 成功${phase} · 沙盒 ${machineId}${stateText}` }
}

// ---- activity lease keepalive ------------------------------------------------
// A held activity lease stops the 30-minute idle auto-suspend. The ledger below
// remembers which machines are leased so the Host renews them across restarts.

function clampTtl(value) {
  if (!Number.isFinite(value)) return LEASE_TTL_DEFAULT
  return Math.min(LEASE_TTL_MAX, Math.max(LEASE_TTL_MIN, Math.round(value)))
}

function renewIntervalFor(ttlSeconds) {
  return Math.max(15, Math.round(clampTtl(ttlSeconds) * LEASE_RENEW_RATIO))
}

function emptyLedger() {
  return { version: 1, entries: {} }
}

function loadLedger() {
  try {
    const raw = readFileSync(LEASE_STATE_PATH, 'utf8')
    const parsed = JSON.parse(raw)
    const entries = parsed?.entries
    if (entries === null || typeof entries !== 'object') return emptyLedger()
    const clean = {}
    for (const [machineId, entry] of Object.entries(entries)) {
      if (entry === null || typeof entry !== 'object') continue
      clean[machineId] = {
        machineId,
        alias: typeof entry.alias === 'string' ? entry.alias : undefined,
        leaseId: LEASE_ID,
        ttlSeconds: clampTtl(entry.ttlSeconds),
        renewEverySeconds: renewIntervalFor(entry.ttlSeconds),
        enabledAt: typeof entry.enabledAt === 'string' ? entry.enabledAt : undefined,
        expiresAt: typeof entry.expiresAt === 'string' ? entry.expiresAt : undefined,
        lastRenewAt: typeof entry.lastRenewAt === 'string' ? entry.lastRenewAt : undefined,
        lastError: typeof entry.lastError === 'string' ? entry.lastError : undefined,
        failures: Number.isInteger(entry.failures) ? entry.failures : 0,
        nextRenewAt: Number.isFinite(entry.nextRenewAt) ? entry.nextRenewAt : 0,
        cycleEnabled: entry.cycleEnabled !== false,
        maxRunMinutes: Number.isFinite(entry.maxRunMinutes) ? entry.maxRunMinutes : undefined,
        runMinutesLeft: Number.isFinite(entry.runMinutesLeft) ? entry.runMinutesLeft : undefined,
        runStartedAt: typeof entry.runStartedAt === 'string' ? entry.runStartedAt : undefined,
        nextCycleAt: Number.isFinite(entry.nextCycleAt) ? entry.nextCycleAt : undefined,
        lastCycleAt: typeof entry.lastCycleAt === 'string' ? entry.lastCycleAt : undefined,
        lastCycleError: typeof entry.lastCycleError === 'string' ? entry.lastCycleError : undefined,
        cycleCount: Number.isInteger(entry.cycleCount) ? entry.cycleCount : 0,
      }
    }
    return { version: 1, entries: clean }
  } catch {
    return emptyLedger()
  }
}

let ledger = loadLedger()
let leaseTimer
let leaseRenewing = false
let lastTickAt
let cycleInFlight

function saveLedger() {
  try {
    writeFileSync(LEASE_STATE_PATH, `${JSON.stringify(ledger, null, 2)}\n`, { mode: 0o600 })
    chmodSync(LEASE_STATE_PATH, 0o600)
  } catch (error) {
    // A read-only HOME must not break renewal; the ledger just stays in memory.
    ledger.lastPersistError = error?.message ?? String(error)
  }
}

async function putLease(config, account, machineId, ttlSeconds, signal) {
  return request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/activity-leases/${LEASE_ID}`, {
    method: 'PUT',
    body: { ttlSeconds },
    signal,
  })
}

async function dropLease(config, account, machineId, signal) {
  try {
    await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/activity-leases/${LEASE_ID}`, {
      method: 'DELETE',
      signal,
    })
    return 204
  } catch (error) {
    if (/\b404\b/.test(error?.message ?? '')) return 204
    throw error
  }
}

// ---- maintenance rotation ---------------------------------------------------
// Free-plan runs cannot be extended by a lease: a run lasts 120 minutes and then
// a max-run pause starts a cooldown that blocks every wake path. Suspending and
// resuming before the limit ends the run "with no cooldown owed", which resets
// both runStartedAt and the cooldown escalation count.

function runMinutesLeft(machine) {
  const limit = machine?.maxRunMinutes
  if (!Number.isFinite(limit) || limit <= 0) return undefined
  const started = Date.parse(machine?.runStartedAt ?? '')
  if (!Number.isFinite(started)) return undefined
  return (started + limit * 60_000 - Date.now()) / 60_000
}

function applyTiming(entry, machine) {
  entry.machineState = typeof machine?.state === 'string' ? machine.state : undefined
  entry.maxRunMinutes = Number.isFinite(machine?.maxRunMinutes) ? machine.maxRunMinutes : undefined
  entry.runStartedAt = typeof machine?.runStartedAt === 'string' ? machine.runStartedAt : undefined
  const left = runMinutesLeft(machine)
  if (left === undefined) {
    entry.runMinutesLeft = undefined
    entry.nextCycleAt = entry.cycleEnabled ? undefined : entry.nextCycleAt
    return
  }
  entry.runMinutesLeft = Math.round(left * 10) / 10
  entry.nextCycleAt = Math.max(Date.now() + 1_000, Date.now() + (left - CYCLE_MARGIN_MIN) * 60_000)
}

async function readMachine(config, account, machineId, signal) {
  return request(config, account, `/v1/machines/${encodeURIComponent(machineId)}`, { signal })
}

const CYCLE_STEP = {
  suspend: 'suspend',
  resume: 'resume',
}

async function postLifecycle(config, account, machineId, action, signal) {
  return request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/${CYCLE_STEP[action]}`, {
    method: 'POST',
    body: {},
    headers: { 'Idempotency-Key': `dsh-instabox-${randomUUID()}` },
    signal,
  })
}

async function waitForState(config, account, machineId, wanted, tries, gapMs, signal) {
  let last
  for (let index = 0; index < tries; index += 1) {
    await sleep(gapMs, signal)
    last = await readMachine(config, account, machineId, signal)
    if (last?.state === wanted) return last
  }
  return last
}

/** One suspend→resume rotation. Ends the run cleanly, then re-holds the lease. */
async function cycleOnce(config, account, entry, signal) {
  if (entry.cycling === true) return { ok: false, reason: '轮转已在进行中' }
  entry.cycling = true
  entry.lastCycleError = undefined
  const machineId = entry.machineId
  cycleDbg('cycle start', machineId)
  const before = entry.runStartedAt
  const steps = []
  try {
    const machine = await readMachine(config, account, machineId, signal)
    applyTiming(entry, machine)
    if (machine.state !== 'running') {
      // No schedule while the machine is down; the next lease renewal re-arms it
      // once the machine runs again. Without this the tick would re-read the
      // machine every 5 seconds just to skip it.
      entry.lastCycleError = `跳过轮转：state=${machine.state}`
      entry.nextCycleAt = undefined
      return { ok: false, reason: entry.lastCycleError }
    }
    await postLifecycle(config, account, machineId, 'suspend', signal)
    steps.push('suspend 202')
    const paused = await waitForState(config, account, machineId, 'suspended', 10, 2_000, signal)
    if (paused?.state !== 'suspended') throw new Error(`suspend 后没进入 suspended（state=${paused?.state ?? '?'}）`)
    steps.push('state=suspended')
    if (CYCLE_HOLD_SEC > 0) {
      await sleep(CYCLE_HOLD_SEC * 1000, signal)
      steps.push(`hold ${CYCLE_HOLD_SEC}s`)
    }
    await postLifecycle(config, account, machineId, 'resume', signal)
    steps.push('resume 202')
    const running = await waitForState(config, account, machineId, 'running', 24, 2_500, signal)
    if (running?.state !== 'running') throw new Error(`resume 后没回到 running（state=${running?.state ?? '?'}）`)
    steps.push('state=running')
    const lease = await putLease(config, account, machineId, entry.ttlSeconds, signal)
    entry.expiresAt = typeof lease?.expiresAt === 'string' ? lease.expiresAt : entry.expiresAt
    entry.lastRenewAt = new Date().toISOString()
    entry.nextRenewAt = Date.now() + renewIntervalFor(entry.ttlSeconds) * 1000
    steps.push(`lease 续 ` + (entry.expiresAt ?? ''))
    const after = await readMachine(config, account, machineId, signal)
    applyTiming(entry, after)
    entry.cycleCount = (entry.cycleCount ?? 0) + 1
    entry.lastCycleAt = new Date().toISOString()
    entry.cycleSummary = {
      before: before ?? null,
      after: entry.runStartedAt ?? null,
      cooldownUntil: activeCooldown(after) ?? null,
      maxRunMinutes: entry.maxRunMinutes ?? null,
      at: entry.lastCycleAt,
    }
    if (activeCooldown(after) !== undefined) {
      entry.lastCycleError = `轮转后仍进入冷却至 ${after.cooldownUntil}`
    }
    return { ok: true, text: `${steps.join(' → ')}` }
  } catch (error) {
    entry.lastCycleError = error?.message ?? String(error)
    entry.nextCycleAt = Date.now() + CYCLE_RETRY_MS
    return { ok: false, reason: entry.lastCycleError }
  } finally {
    entry.cycling = false
    saveLedger()
  }
}

/** Rotate the entry when its schedule is due; cheap no-op otherwise. */
async function cycleIfDue(config) {
  const now = Date.now()
  for (const entry of Object.values(ledger.entries)) {
    cycleDbg('tick', entry.machineId, 'enabled=' + (entry.cycleEnabled !== false), 'cycling=' + (entry.cycling === true), 'nextCycle=' + (Number.isFinite(entry.nextCycleAt) ? new Date(entry.nextCycleAt).toISOString() : '—'), 'due=' + (Number.isFinite(entry.nextCycleAt) && entry.nextCycleAt <= now))
    if (entry.cycleEnabled === false || entry.cycling === true) continue
    if (!(Number.isFinite(entry.nextCycleAt) && entry.nextCycleAt <= now)) continue
    try {
      const account = accountFor(config, entry.alias ?? entry.machineId)
      await cycleOnce(config, account, entry)
    } catch (error) {
      entry.lastCycleError = error?.message ?? String(error)
      entry.nextCycleAt = Date.now() + CYCLE_RETRY_MS
      saveLedger()
    }
  }
}

/** Renew every entry whose schedule is due (or all of them when forced). */
async function renewDue(force = false) {
  if (leaseRenewing) return
  const now = Date.now()
  const due = Object.values(ledger.entries).filter(entry => force || !(entry.nextRenewAt > now))
  if (due.length === 0) return
  leaseRenewing = true
  try {
    let config
    try {
      config = readConfig()
    } catch (error) {
      for (const entry of due) {
        entry.lastError = error.message
        entry.nextRenewAt = Date.now() + 30_000
      }
      return
    }
    for (const entry of due) {
      try {
        const account = accountFor(config, entry.alias ?? entry.machineId)
        const data = await putLease(config, account, entry.machineId, entry.ttlSeconds)
        entry.expiresAt = typeof data?.expiresAt === 'string' ? data.expiresAt : undefined
        entry.lastRenewAt = new Date().toISOString()
        entry.nextRenewAt = Date.now() + renewIntervalFor(entry.ttlSeconds) * 1000
        entry.lastError = undefined
        entry.failures = 0
        if (entry.cycleEnabled !== false) {
          // maxRunMinutes grows with real use, so refresh the run deadline here.
          const machine = await readMachine(config, account, entry.machineId)
          applyTiming(entry, machine)
        }
      } catch (error) {
        entry.lastError = error?.message ?? String(error)
        entry.failures = (entry.failures ?? 0) + 1
        entry.nextRenewAt = Date.now() + Math.min(300, 30 * entry.failures) * 1000
      }
    }
  } finally {
    leaseRenewing = false
    saveLedger()
  }
}

/** One 5s tick: renew due leases, then rotate any machine whose run is near its limit. */
async function runTick() {
  lastTickAt = new Date().toISOString()
  try {
    await renewDue()
  } catch (error) {
    ledger.lastTickError = error?.message ?? String(error)
  }
  try {
    await cycleIfDue(readConfig())
  } catch (error) {
    ledger.lastCycleTickError = error?.message ?? String(error)
  }
}

function ensureLeaseTimer() {
  if (Object.keys(ledger.entries).length === 0) {
    if (leaseTimer !== undefined) clearInterval(leaseTimer)
    leaseTimer = undefined
    return
  }
  if (leaseTimer !== undefined) return
  leaseTimer = setInterval(() => { void runTick() }, LEASE_TICK_MS)
  leaseTimer.unref?.()
}

function leaseView(machineId) {
  const entry = ledger.entries[machineId]
  if (entry === undefined) return { active: false, leaseId: LEASE_ID }
  return {
    active: true,
    leaseId: entry.leaseId,
    ttlSeconds: entry.ttlSeconds,
    renewEverySeconds: entry.renewEverySeconds,
    enabledAt: entry.enabledAt,
    expiresAt: entry.expiresAt,
    lastRenewAt: entry.lastRenewAt,
    lastError: entry.lastError,
    failures: entry.failures ?? 0,
    cycleEnabled: entry.cycleEnabled !== false,
    cycleMarginMinutes: CYCLE_MARGIN_MIN,
    maxRunMinutes: entry.maxRunMinutes,
    runMinutesLeft: entry.runMinutesLeft,
    runStartedAt: entry.runStartedAt,
    nextCycleAt: Number.isFinite(entry.nextCycleAt) ? new Date(entry.nextCycleAt).toISOString() : undefined,
    lastCycleAt: entry.lastCycleAt,
    lastCycleError: entry.lastCycleError,
    cycleCount: entry.cycleCount ?? 0,
    cycleSummary: entry.cycleSummary,
  }
}

function describeLease(machineId, label) {
  const entry = ledger.entries[machineId]
  if (entry === undefined) return '持租约    关闭'
  const bits = [
    `开启（lease ${entry.leaseId} · ttl ${entry.ttlSeconds}s · 每 ${entry.renewEverySeconds}s 续）`,
    entry.expiresAt ? `到期 ${entry.expiresAt}` : undefined,
    entry.lastRenewAt ? `上次续 ${entry.lastRenewAt}` : undefined,
    entry.runMinutesLeft === undefined
      ? undefined
      : `maxRun 剩 ${Math.round(entry.runMinutesLeft)}min/${entry.maxRunMinutes ?? '?'}min`,
    entry.cycleEnabled === false
      ? '轮转关闭'
      : Number.isFinite(entry.nextCycleAt)
        ? `下次轮转 ${new Date(entry.nextCycleAt).toISOString()}`
        : undefined,
    entry.cycleCount > 0 ? `已轮转 ${entry.cycleCount} 次（上次 ${entry.lastCycleAt}）` : undefined,
    entry.lastCycleError ? `错误：${entry.lastCycleError}` : undefined,
  ].filter(Boolean)
  return `持租约    ${bits.join(' · ')}${label ? ` · ${label}` : ''}`
}

function leaseStatusText() {
  const entries = Object.values(ledger.entries)
  if (entries.length === 0) return '持租约：没有开启的沙盒。'
  const lines = entries.map((entry) => {
    const bits = [
      `${entry.alias ?? '?'} · ${entry.machineId}`,
      `lease ${entry.leaseId}`,
      `ttl ${entry.ttlSeconds}s / 每 ${entry.renewEverySeconds}s 续`,
      entry.expiresAt ? `到期 ${entry.expiresAt}` : '尚未续约',
      entry.runMinutesLeft === undefined ? undefined : `maxRun 剩 ${Math.round(entry.runMinutesLeft)}min`,
      entry.cycleEnabled === false
        ? '轮转关闭'
        : Number.isFinite(entry.nextCycleAt) ? `下次轮转 ${new Date(entry.nextCycleAt).toISOString()}` : undefined,
      entry.cycleCount > 0 ? `已轮转 ${entry.cycleCount} 次` : undefined,
      entry.lastError ? `错误：${entry.lastError}` : '正常',
    ].filter(Boolean)
    return `  ${bits.join(' · ')}`
  })
  return [`持租约：${entries.length} 台`, ...lines, `台账 ${LEASE_STATE_PATH}`].join('\n')
}

/** Start / stop / renew / status for one machine's activity lease. Shared by tool and route. */
async function runLease(config, machine, action, ttlSeconds, signal) {
  const verb = String(action ?? '').trim()
  if (verb === 'status') {
    const account = machine === undefined || String(machine).trim().length === 0
      ? undefined
      : accountFor(config, machine)
    if (account === undefined) return { ok: true, text: leaseStatusText() }
    const machineId = await machineIdOf(config, account, signal)
    const entry = ledger.entries[machineId]
    return {
      ok: entry === undefined || entry.lastError === undefined,
      active: entry !== undefined,
      text: `${account.alias} · ${machineId}\n  ${describeLease(machineId)}`,
    }
  }
  const LEASE_ACTIONS = ['start', 'stop', 'renew', 'cycle', 'cycle-enable', 'cycle-disable']
  if (!LEASE_ACTIONS.includes(verb)) {
    throw new Error(`未知 action "${verb}"；可用：${LEASE_ACTIONS.join(', ')}, status`)
  }
  const account = accountFor(config, machine)
  const machineId = await machineIdOf(config, account, signal)

  if (verb === 'cycle' || verb === 'cycle-enable' || verb === 'cycle-disable') {
    const entry = ledger.entries[machineId]
    if (entry === undefined) throw new Error(`沙盒 ${account.alias} 还没持租约，先 action=start 再轮转`)
    if (verb === 'cycle-enable') {
      entry.cycleEnabled = true
      const machine = await readMachine(config, account, machineId, signal)
      applyTiming(entry, machine)
      entry.lastCycleError = undefined
      saveLedger()
      return {
        ok: true,
        text: `轮转已开启：${account.alias} · ${machineId} · maxRun 剩 ${entry.runMinutesLeft === undefined ? '?' : Math.round(entry.runMinutesLeft)}min · 下次轮转 ${Number.isFinite(entry.nextCycleAt) ? new Date(entry.nextCycleAt).toISOString() : '待定'}`,
      }
    }
    if (verb === 'cycle-disable') {
      entry.cycleEnabled = false
      entry.nextCycleAt = undefined
      saveLedger()
      return { ok: true, text: `轮转已关闭：${account.alias} · ${machineId}（租约继续续，但不再主动 suspend→resume）` }
    }
    const result = await cycleOnce(config, account, entry, signal)
    const summary = entry.cycleSummary
    if (summary === undefined) {
      return { ok: result.ok, text: `轮转${result.ok ? '完成' : '中断'}：${account.alias} · ${machineId} · ${result.ok ? result.text : result.reason}` }
    }
    const cooldown = summary.cooldownUntil === null || summary.cooldownUntil === undefined
      ? '无（未触发 max-run 冷却）'
      : `冷却生效至 ${summary.cooldownUntil}`
    return {
      ok: result.ok,
      text: `轮转${result.ok ? '完成' : '中断'}：${account.alias} · ${machineId}\n  步骤      ${result.ok ? result.text : result.reason}\n  runStartedAt  ${summary.before ?? '—'} → ${summary.after ?? '—'}\n  maxRun    ${summary.maxRunMinutes ?? '?'}min · 冷却：${cooldown}\n  下次轮转  ${Number.isFinite(entry.nextCycleAt) ? new Date(entry.nextCycleAt).toISOString() : '待定'}`,
    }
  }

  const ttl = clampTtl(Number(ttlSeconds ?? ledger.entries[machineId]?.ttlSeconds ?? LEASE_TTL_DEFAULT))

  if (verb === 'stop') {
    const previous = ledger.entries[machineId]
    await dropLease(config, account, machineId, signal)
    delete ledger.entries[machineId]
    saveLedger()
    ensureLeaseTimer()
    const ttlNote = previous === undefined ? '' : `（原 ttl ${previous.ttlSeconds}s）`
    return { ok: true, active: false, text: `已释放租约：${account.alias} · ${machineId} · lease ${LEASE_ID} · DELETE 204${ttlNote}` }
  }

  const data = await putLease(config, account, machineId, ttl, signal)
  const existing = ledger.entries[machineId]
  const entry = {
    machineId,
    alias: account.alias,
    leaseId: LEASE_ID,
    ttlSeconds: ttl,
    renewEverySeconds: renewIntervalFor(ttl),
    enabledAt: existing?.enabledAt ?? new Date().toISOString(),
    expiresAt: typeof data?.expiresAt === 'string' ? data.expiresAt : existing?.expiresAt,
    lastRenewAt: new Date().toISOString(),
    lastError: undefined,
    failures: 0,
    nextRenewAt: Date.now() + renewIntervalFor(ttl) * 1000,
    cycleEnabled: existing?.cycleEnabled !== false,
    cycleCount: existing?.cycleCount ?? 0,
    lastCycleAt: existing?.lastCycleAt,
    lastCycleError: undefined,
    cycleSummary: existing?.cycleSummary,
  }
  ledger.entries[machineId] = entry
  try {
    const machine = await readMachine(config, account, machineId, signal)
    applyTiming(entry, machine)
  } catch (error) {
    entry.lastCycleError = `读取运行计时失败：${error?.message ?? String(error)}`
  }
  saveLedger()
  ensureLeaseTimer()
  const timing = entry.runMinutesLeft === undefined
    ? 'maxRun ?'
    : `maxRun 剩 ${Math.round(entry.runMinutesLeft)}min/${entry.maxRunMinutes ?? '?'}min`
  const cycleLine = entry.cycleEnabled === false
    ? '轮转关闭'
    : `下次轮转 ${Number.isFinite(entry.nextCycleAt) ? new Date(entry.nextCycleAt).toISOString() : '待定'}（剩 ${CYCLE_MARGIN_MIN}min 触发）`
  return {
    ok: true,
    active: true,
    text: `${verb === 'renew' ? '已手动续租' : '持租约已开'}：${account.alias} · ${machineId} · lease ${LEASE_ID} · ttl ${ttl}s · PUT 200 · 到期 ${entry.expiresAt ?? '（服务未返回）'} · 每 ${entry.renewEverySeconds}s 续\n  ${timing} · ${cycleLine}`,
  }
}

/** Compact machine snapshots for the sidebar panel. */
async function collectState(config, signal) {
  const machines = []
  const errors = []
  for (const account of config.accounts) {
    try {
      const data = await request(config, account, '/v1/machines', { signal })
      for (const machine of Array.isArray(data?.machines) ? data.machines : []) {
        machines.push({
          account: account.alias,
          id: machine.id,
          name: machine.name ?? machine.id,
          state: machine.state ?? 'unknown',
          template: machine.template ? `${machine.template.id}@${machine.template.version}` : undefined,
          vcpus: machine.spec?.vcpus,
          memMiB: machine.spec?.memMiB,
          cooldownUntil: activeCooldown(machine),
          maxRunMinutes: Number.isFinite(machine.maxRunMinutes) ? machine.maxRunMinutes : undefined,
          runStartedAt: typeof machine.runStartedAt === 'string' ? machine.runStartedAt : undefined,
          runMinutesLeft: (() => {
            const left = runMinutesLeft(machine)
            return left === undefined ? undefined : Math.round(left)
          })(),
          ssh: account.sshCommand,
          lease: leaseView(machine.id),
        })
      }
    } catch (error) {
      errors.push({ alias: account.alias, message: error.message })
    }
  }
  return {
    ok: errors.length === 0,
    machines,
    errors,
    heartbeat: {
      lastTickAt,
      tickMs: LEASE_TICK_MS,
      cycleMarginMinutes: CYCLE_MARGIN_MIN,
      cycleHoldSeconds: CYCLE_HOLD_SEC,
      leaseStatePath: LEASE_STATE_PATH,
    },
  }
}

function replyJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        reject(new Error('request body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve(undefined)
        return
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        reject(new Error('invalid JSON body'))
      }
    })
    req.on('error', reject)
  })
}

/** Fail-closed same-origin check through the host connection service. */
function createTrustCheck(ctx) {
  let warned = false
  return (req) => {
    try {
      const connection = ctx.get?.('connection')
      const reject = connection?.requestRejection
      if (typeof reject !== 'function') {
        if (!warned) {
          warned = true
          ctx.logger?.warn?.('instabox-manager: connection.requestRejection is unavailable; routes answer 403')
        }
        return 403
      }
      const rejection = reject.call(connection, { headers: req.headers })
      return rejection === 401 || rejection === 403 ? rejection : undefined
    } catch (error) {
      if (!warned) {
        warned = true
        ctx.logger?.warn?.('instabox-manager: request rejection threw; routes answer 403')
        ctx.logger?.warn?.(error)
      }
      return 403
    }
  }
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'instabox_list',
    description: 'List every configured InstaBox cloud sandbox with its live state, template, size and any cooldown. Use it first to learn the sandbox aliases (ss-bot, android, …) that the other instabox_* tools accept. Optional account field restricts the report to one configured account alias.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: { type: 'string', description: 'Optional configured account alias; omit for all accounts.' },
      },
    },
    output: textResult,
    async execute(args, exec) {
      const config = readConfig()
      const only = typeof args?.account === 'string' && args.account.trim().length > 0 ? args.account.trim().toLowerCase() : undefined
      const accounts = only === undefined ? config.accounts : config.accounts.filter(entry => entry.alias.toLowerCase() === only)
      if (accounts.length === 0) throw new Error(`未配置账号 "${args.account}"；可用：${config.accounts.map(entry => entry.alias).join('、')}`)
      const blocks = []
      const failures = []
      for (const account of accounts) {
        try {
          const data = await request(config, account, '/v1/machines', { signal: exec.signal })
          const machines = Array.isArray(data?.machines) ? data.machines : []
          const header = `${account.alias}  (${maskKey(account.apiKey)})  ${machines.length} 台`
          blocks.push([header, ...machines.map(machine => `  ${describeMachine(machine)}`)].join('\n'))
          if (account.machineId === undefined && machines[0] !== undefined) account.machineId = machines[0].id
        } catch (error) {
          failures.push(`${account.alias}: ${error.message}`)
        }
      }
      const sections = [...blocks]
      if (failures.length > 0) sections.push(`失败\n${failures.map(line => `  ${line}`).join('\n')}`)
      return { text: sections.join('\n\n') || '没有可显示的沙盒。' }
    },
  })

  ctx.tools.register({
    name: 'instabox_status',
    description: 'Show one InstaBox sandbox in detail: live state, size, template, run/cooldown timers, disk usage and the SSH connection command. Use it when you need to connect with ssh/mosh or check how full its disk is.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        machine: { type: 'string', description: 'Sandbox alias, machine ID or configured name.' },
      },
      required: ['machine'],
    },
    output: textResult,
    async execute(args, exec) {
      const config = readConfig()
      const account = accountFor(config, args?.machine)
      const machineId = await machineIdOf(config, account, exec.signal)
      const machine = await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}`, { signal: exec.signal })
      const lines = [
        `${machine.name ?? machine.id}  (${account.alias})`,
        `  状态      ${machine.state ?? 'unknown'}${machine.desiredState ? ` / 期望 ${machine.desiredState}` : ''}`,
        `  ID        ${machine.id}`,
        `  模板      ${machine.template?.id ?? '?'}@${machine.template?.version ?? '?'}`,
        `  规格      ${machine.spec?.vcpus ?? '?'} vCPU · ${machine.spec?.memMiB ?? '?'} MiB 内存 · /data ${machine.spec?.persistentDiskGiB ?? machine.storage?.sizeGiB ?? '?'} GiB`,
        `  运行      ${machine.runStartedAt ? `开始于 ${machine.runStartedAt}` : '—'}${activeCooldown(machine) ? ` · 冷却至 ${activeCooldown(machine)}` : ''}`,
        `  maxRun    ${(() => {
          const left = runMinutesLeft(machine)
          const limit = machine.maxRunMinutes
          if (limit !== undefined && limit <= 0) return '不限'
          if (left === undefined) {
            return `${limit ?? '?'}min 上限 · 当前没有在跑的 run（挂起/停止中，启动后从 120min 重新起算）`
          }
          return `剩 ${Math.round(left)}min / 上限 ${limit}min · 轮转阈值剩 ${CYCLE_MARGIN_MIN}min`
        })()}`,
        `  自动睡眠  ${machine.autoSuspendAfterSeconds === null ? '关闭' : `${Math.round((machine.autoSuspendAfterSeconds ?? 0) / 60)} 分钟空闲后`}`,
        `  ${describeLease(machineId)}`,
      ]
      try {
        const info = await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/connection-info`, { signal: exec.signal })
        const sshCommand = account.sshCommand
          ?? `ssh -p ${info.port} ${info.username}@${info.host}`
        lines.push(`  SSH       ${sshCommand}`)
        if (Array.isArray(info.capabilities) && info.capabilities.length > 0) {
          lines.push(`  能力      ${info.capabilities.join(', ')}`)
        }
      } catch (error) {
        lines.push(`  SSH       读取失败：${error.message}`)
      }
      try {
        const disk = await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/disk`, { signal: exec.signal })
        const formatted = formatDisk(disk)
        if (formatted !== undefined) lines.push(`  磁盘      ${formatted}`)
      } catch (error) {
        lines.push(`  磁盘      读取失败：${error.message}`)
      }
      return { text: lines.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'instabox_exec',
    description: 'Run one shell command (bash -lc) inside a configured InstaBox sandbox through the InstaBox API and return its stdout, stderr and exit code. The sandbox must be running; use instabox_power with action=start (or wake) first. Command runs as the sandbox user; output is capped at 1 MiB per stream by the API.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        machine: { type: 'string', description: 'Sandbox alias, machine ID or configured name.' },
        command: { type: 'string', description: 'Shell command, run with bash -lc (at most 64 KiB).' },
        cwd: { type: 'string', description: 'Working directory; defaults to the sandbox HOME (/data/home).' },
        timeoutSec: { type: 'integer', description: 'Command timeout in seconds (1-600, default 60).' },
      },
      required: ['machine', 'command'],
    },
    output: textResult,
    timeoutMs: 640_000,
    async execute(args, exec) {
      const config = readConfig()
      const account = accountFor(config, args?.machine)
      const command = String(args?.command ?? '')
      if (command.trim().length === 0) throw new Error('instabox_exec 需要非空 command')
      const machineId = await machineIdOf(config, account, exec.signal)
      const body = { cmd: command }
      if (typeof args?.cwd === 'string' && args.cwd.trim().length > 0) body.cwd = args.cwd
      if (Number.isInteger(args?.timeoutSec)) body.timeoutSeconds = Math.min(600, Math.max(1, args.timeoutSec))
      const result = await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/exec`, {
        method: 'POST',
        body,
        signal: exec.signal,
      })
      const stdout = typeof result?.stdout === 'string' ? result.stdout : ''
      const stderr = typeof result?.stderr === 'string' ? result.stderr : ''
      const exitCode = result?.exitCode ?? 'unknown'
      const head = `$ ${command}`
      const meta = [
        `exit ${exitCode}`,
        result?.durationMs === undefined ? undefined : `${result.durationMs} ms`,
        result?.timedOut ? 'TIMED OUT' : undefined,
        result?.truncated ? '输出已截断' : undefined,
        result?.invalidUtf8 ? '输出含非 UTF-8 字节' : undefined,
        result?.oomKilled ? 'OOM killed' : undefined,
      ].filter(Boolean).join(' · ')
      const parts = [head, `[${account.alias} / ${machineId}] ${meta}`]
      if (stdout.length > 0) parts.push(stdout.replace(/\n$/, ''))
      if (stderr.length > 0) parts.push(`--- stderr ---\n${stderr.replace(/\n$/, '')}`)
      if (result?.diskWarning !== undefined) parts.push(`磁盘警告：${JSON.stringify(result.diskWarning)}`)
      return { text: parts.join('\n') }
    },
  })

  ctx.tools.register({
    name: 'instabox_power',
    description: 'Start, stop, suspend, resume or wake one configured InstaBox sandbox and wait for the operation to finish. start/resume take a stopped or paused sandbox back to running; suspend pauses it with its processes; stop shuts it down; wake resumes a sandbox that paused itself and waits for it to run.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        machine: { type: 'string', description: 'Sandbox alias, machine ID or configured name.' },
        action: { type: 'string', enum: ['start', 'stop', 'suspend', 'resume', 'wake'], description: 'Lifecycle action to apply.' },
      },
      required: ['machine', 'action'],
    },
    output: textResult,
    async execute(args, exec) {
      const config = readConfig()
      const result = await runPower(config, args?.machine, String(args?.action ?? ''), exec.signal)
      return { text: result.text }
    },
  })

  ctx.tools.register({
    name: 'instabox_lease',
    description: 'Hold an InstaBox activity lease (`keepalive`) so a sandbox is not auto-suspended after 30 idle minutes, and optionally rotate it before the free-plan max-run pause. action=start PUTs the lease with ttlSeconds (default 300, range 30-3600) and the Host renews it every 0.6×ttl; action=stop DELETEs the lease and resumes idle auto-suspend; action=renew renews once; action=status reports the held leases; action=cycle runs one suspend→resume rotation now (resets runStartedAt and the cooldown escalation count); action=cycle-enable/cycle-disable toggles automatic rotation, which fires when the run has 20 minutes left (DSH_INSTABOX_CYCLE_MARGIN_MIN). The lease must stay alive from outside the sandbox, which is why the Host owns it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        machine: { type: 'string', description: 'Sandbox alias, machine ID or configured name; optional for status.' },
        action: {
          type: 'string',
          enum: ['start', 'stop', 'renew', 'status', 'cycle', 'cycle-enable', 'cycle-disable'],
          description: 'start/stop/renew/status for the lease; cycle rotates once now; cycle-enable/cycle-disable toggles automatic rotation.',
        },
        ttlSeconds: { type: 'integer', description: 'Lease lifetime in seconds, 30-3600 (default 300). Renewal runs every 0.6×ttl.' },
      },
      required: ['action'],
    },
    output: textResult,
    async execute(args, exec) {
      const config = readConfig()
      const result = await runLease(config, args?.machine, String(args?.action ?? ''), args?.ttlSeconds, exec.signal)
      return { text: result.text }
    },
  })

  // ---- PocketBox 手机网关（令牌鉴权、允许跨源） ------------------------------
  // 保活、轮转、批量动作都由 DSH 宿主执行；手机只是控制面板，可以随时退出。
  const remoteToken = () => {
    const fromEnv = typeof process.env.DSH_INSTABOX_REMOTE_TOKEN === 'string' ? process.env.DSH_INSTABOX_REMOTE_TOKEN.trim() : ''
    if (fromEnv.length > 0) return fromEnv
    try {
      const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'))
      return String(parsed?.remoteToken ?? '').trim()
    } catch {
      return ''
    }
  }

  const applyCors = (res) => {
    res.setHeader?.('access-control-allow-origin', '*')
    res.setHeader?.('access-control-allow-methods', 'GET, POST, OPTIONS')
    res.setHeader?.('access-control-allow-headers', 'content-type, x-pocketbox-token, authorization')
    res.setHeader?.('access-control-max-age', '600')
  }

  const remoteGuard = (req, res) => {
    applyCors(res)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'content-length': 0 })
      res.end()
      return false
    }
    const token = remoteToken()
    if (token.length === 0) {
      replyJson(res, 503, { ok: false, reason: '宿主未配置网关令牌：在 ~/.dsh/instabox-manager.json 里加 "remoteToken":"..." 或设置 DSH_INSTABOX_REMOTE_TOKEN 后重启 dsh' })
      return false
    }
    const raw = String(req.headers['x-pocketbox-token'] ?? req.headers['authorization'] ?? '')
    const presented = raw.toLowerCase().startsWith('bearer ') ? raw.slice(7).trim() : raw.trim()
    if (presented !== token) {
      replyJson(res, 401, { ok: false, reason: '网关令牌不对' })
      return false
    }
    return true
  }

  ctx.inject(['webServer'], (scoped) => {
    const webServer = scoped.webServer
    if (webServer === undefined || typeof webServer.register !== 'function') {
      ctx.logger?.warn?.('instabox-manager: webServer service unavailable; the sidebar panel route is not mounted')
      return
    }
    const denied = createTrustCheck(ctx)
    const guard = (req, res) => {
      const rejection = denied(req)
      if (rejection !== undefined) {
        replyJson(res, rejection, { ok: false, reason: 'request failed the connection trust check' })
        return false
      }
      return true
    }
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/state`,
      handler: async (req, res) => {
        try {
          if (!guard(req, res)) return
          if (req.method !== 'GET') {
            replyJson(res, 405, { ok: false, reason: 'GET only' })
            return
          }
          replyJson(res, 200, await collectState(readConfig()))
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/lease`,
      handler: async (req, res) => {
        try {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            replyJson(res, 405, { ok: false, reason: 'POST only' })
            return
          }
          const body = await readJsonBody(req)
          const action = typeof body?.action === 'string' ? body.action : ''
          if (action.length === 0) {
            replyJson(res, 400, { ok: false, reason: 'action is required' })
            return
          }
          const machine = typeof body?.machine === 'string' && body.machine.trim().length > 0 ? body.machine : undefined
          if (machine === undefined && action !== 'status') {
            replyJson(res, 400, { ok: false, reason: 'machine is required' })
            return
          }
          const result = await runLease(readConfig(), machine, action, body?.ttlSeconds)
          replyJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
    // ---- 手机网关路由：/instabox-manager/api/*（令牌鉴权，不要求同源） ----
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/api/ping`,
      handler: async (req, res) => {
        if (!remoteGuard(req, res)) return
        try {
          const config = readConfig()
          replyJson(res, 200, {
            ok: true,
            gateway: 'pocketbox',
            accounts: config.accounts.map(entry => entry.alias),
            leaseCount: Object.keys(ledger.entries).length,
            heartbeat: { lastTickAt, tickMs: LEASE_TICK_MS, cycleMarginMinutes: CYCLE_MARGIN_MIN },
          })
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/api/state`,
      handler: async (req, res) => {
        if (!remoteGuard(req, res)) return
        if (req.method !== 'GET') {
          replyJson(res, 405, { ok: false, reason: 'GET only' })
          return
        }
        try {
          replyJson(res, 200, await collectState(readConfig()))
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/api/action`,
      handler: async (req, res) => {
        if (!remoteGuard(req, res)) return
        if (req.method !== 'POST') {
          replyJson(res, 405, { ok: false, reason: 'POST only' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const machine = typeof body?.machine === 'string' ? body.machine : ''
          const action = typeof body?.action === 'string' ? body.action : ''
          if (machine.length === 0 || action.length === 0) {
            replyJson(res, 400, { ok: false, reason: 'machine 和 action 都要给' })
            return
          }
          const result = await runPower(readConfig(), machine, action)
          replyJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/api/lease`,
      handler: async (req, res) => {
        if (!remoteGuard(req, res)) return
        if (req.method !== 'POST') {
          replyJson(res, 405, { ok: false, reason: 'POST only' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const machine = typeof body?.machine === 'string' ? body.machine : ''
          const action = typeof body?.action === 'string' ? body.action : ''
          if (action.length === 0) {
            replyJson(res, 400, { ok: false, reason: 'action 要给（start/stop/renew/status）' })
            return
          }
          const result = await runLease(readConfig(), machine || undefined, action, body?.ttlSeconds)
          replyJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/api/exec`,
      handler: async (req, res) => {
        if (!remoteGuard(req, res)) return
        if (req.method !== 'POST') {
          replyJson(res, 405, { ok: false, reason: 'POST only' })
          return
        }
        try {
          const body = await readJsonBody(req)
          const machine = typeof body?.machine === 'string' ? body.machine : ''
          const cmd = typeof body?.cmd === 'string' ? body.cmd : ''
          if (machine.length === 0 || cmd.length === 0) {
            replyJson(res, 400, { ok: false, reason: 'machine 和 cmd 都要给' })
            return
          }
          const config = readConfig()
          const account = accountFor(config, machine)
          const machineId = await machineIdOf(config, account)
          const timeout = Number.isFinite(Number(body?.timeoutSeconds)) ? Math.min(600, Math.max(1, Math.round(Number(body.timeoutSeconds)))) : 60
          const result = await request(config, account, `/v1/machines/${encodeURIComponent(machineId)}/exec`, {
            method: 'POST',
            body: { cmd, timeoutSeconds: timeout },
          })
          replyJson(res, 200, { ok: true, machine: machineId, exec: result })
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })

    webServer.register({
      kind: 'exact',
      path: `${API_ROOT}/action`,
      handler: async (req, res) => {
        try {
          if (!guard(req, res)) return
          if (req.method !== 'POST') {
            replyJson(res, 405, { ok: false, reason: 'POST only' })
            return
          }
          const body = await readJsonBody(req)
          const machine = typeof body?.machine === 'string' ? body.machine : ''
          const action = typeof body?.action === 'string' ? body.action : ''
          if (machine.length === 0 || action.length === 0) {
            replyJson(res, 400, { ok: false, reason: 'machine and action are required' })
            return
          }
          const result = await runPower(readConfig(), machine, action)
          replyJson(res, result.ok ? 200 : 500, result)
        } catch (error) {
          replyJson(res, 500, { ok: false, reason: error?.message ?? String(error) })
        }
      },
    })
  })

  // Resume renewals for leases that survived a Host restart.
  ensureLeaseTimer()
  if (Object.keys(ledger.entries).length > 0) {
    const startup = setTimeout(() => { void renewDue(true) }, 1_500)
    startup.unref?.()
  }
  const stopLeaseTimer = () => {
    if (leaseTimer !== undefined) clearInterval(leaseTimer)
    leaseTimer = undefined
  }
  if (typeof ctx.effect === 'function') ctx.effect(() => stopLeaseTimer)
  else if (typeof ctx.on === 'function') ctx.on('dispose', stopLeaseTimer)
}