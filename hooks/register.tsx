import { atom, read, update } from 'claude-code'
import type { Register, EngineInterface, SessionRateLimit } from 'claude-code'

import type { Window } from '../types'

const chatTokens = atom({ plugin: 'headroom', key: 'chatTokens' } as const, 0)
const windows = atom({ plugin: 'headroom', key: 'windows' } as const, [] as Window[])

/** Per-window calibration, kept across sessions in $.store. */
type Calib = {
  lastPct?: number
  resetsAt?: string
  pending: number // tokens counted since the last percent reading
  estTotal?: number // smoothed estimate of the window's size in tokens
}

/** The bar's zones: a bright fill for progress, a muted track that pre-marks each zone. */
const ZONES = [
  { from: 0, to: 50, fill: '#e3b341', track: '#8a7536' },
  { from: 50, to: 80, fill: '#f0883e', track: '#9a6232' },
  { from: 80, to: 100, fill: '#ef5350', track: '#9e3f3f' },
] as const

const LABELS: Record<string, string> = { five_hour: '5h', seven_day: 'Week' }
const calibKey = (kind: string) => `calib:${kind}`

async function getCalib($: EngineInterface, kind: string): Promise<Calib> {
  const v = (await $.store.get(calibKey(kind))) as Calib | undefined
  return v ?? { pending: 0 }
}

export function fmt(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0'
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)}B`
  if (n >= 1e6) return `${(n / 1e6).toFixed(n >= 1e7 ? 0 : 1)}M`
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`
  return String(Math.round(n))
}

function resetIn(iso: string | undefined, now: number): string {
  if (!iso) return ''
  const ms = Date.parse(iso) - now
  if (!Number.isFinite(ms) || ms <= 0) return ''
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

const WINDOW_MS: Record<string, number> = { five_hour: 5 * 3600e3, seven_day: 7 * 86400e3 }

function fmtDur(ms: number): string {
  const m = Math.max(1, Math.round(ms / 60000))
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`
  return `${Math.floor(h / 24)}d ${h % 24}h`
}

/** At the window's average rate so far, when the limit runs out, if before the reset. */
function pace(w: Window, now: number): { text: string; isRisk: boolean; color: string } | undefined {
  const len = WINDOW_MS[w.kind]
  const end = w.resetsAt ? Date.parse(w.resetsAt) : NaN
  if (!len || !Number.isFinite(end)) return undefined
  const toReset = end - now
  const elapsed = len - toReset
  if (elapsed <= 0 || toReset <= 0 || w.pct <= 0) return undefined
  const toEmpty = ((100 - w.pct) / w.pct) * elapsed
  if (w.pct >= 100) return { text: 'limit reached', isRisk: true, color: '#ef5350' }
  if (toEmpty < toReset) return {
    text: `runs out in ~${fmtDur(toEmpty)}`,
    isRisk: true,
    // Red when it runs out well before the reset, orange when it's close.
    color: toEmpty < toReset * 0.5 ? '#ef5350' : '#f0883e',
  }
  const expected = (elapsed / len) * 100
  return w.pct < expected * 0.8
    ? { text: 'under pace', isRisk: false, color: '#7cb87a' }
    : { text: 'on pace', isRisk: false, color: '#e3b341' }
}

async function ingest($: EngineInterface, limits: SessionRateLimit[]) {
  const next: Window[] = []
  for (const l of limits) {
    if (l.kind !== 'five_hour' && l.kind !== 'seven_day') continue
    const c = await getCalib($, l.kind)
    const isNewWindow = c.resetsAt !== undefined && l.resetsAt !== undefined && c.resetsAt !== l.resetsAt
    if (c.lastPct === undefined || isNewWindow || l.percentUsed < c.lastPct) {
      // First reading or a fresh window: start counting from here.
      c.lastPct = l.percentUsed
      c.pending = 0
    } else if (l.percentUsed - c.lastPct >= 0.5) {
      // Only sample on a meaningful move, so rounding doesn't give wild estimates.
      if (c.pending > 0) {
        const sample = (c.pending / (l.percentUsed - c.lastPct)) * 100
        c.estTotal = c.estTotal === undefined ? sample : c.estTotal * 0.7 + sample * 0.3
      }
      c.lastPct = l.percentUsed
      c.pending = 0
    }
    c.resetsAt = l.resetsAt
    await $.store.set(calibKey(l.kind), c)
    next.push({ kind: l.kind, pct: l.percentUsed, resetsAt: l.resetsAt, estTotal: c.estTotal })
  }
  next.sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
  await update($, windows, () => next)
  const now = await $.clock.now()
  for (const w of next) await alert($, w, now)
}

const THRESHOLDS = [50, 80, 95]
const NAMES: Record<string, string> = { five_hour: '5-hour', seven_day: 'Weekly' }

/** Which alerts already fired in a window, kept across sessions so each fires once per window. */
type Alerts = { resetsAt?: string; fired: number[]; pace: boolean }

/** Toast when a window crosses 50/80/95%, or when its pace first says it will run out. */
async function alert($: EngineInterface, w: Window, now: number) {
  const key = `alerts:${w.kind}`
  let a = ((await $.store.get(key)) as Alerts | undefined) ?? { fired: [], pace: false }
  if (a.resetsAt !== w.resetsAt) a = { resetsAt: w.resetsAt, fired: [], pace: false }
  const name = NAMES[w.kind] ?? w.kind
  const reset = resetIn(w.resetsAt, now)
  const crossed = THRESHOLDS.filter(t => w.pct >= t && !a.fired.includes(t))
  const top = crossed[crossed.length - 1]
  if (top !== undefined) {
    $.ui.toast(`${name} limit at ${Math.round(w.pct)}%${reset ? `, resets in ${reset}` : ''}`, { timeoutMs: 8000 })
    a.fired.push(...crossed)
  }
  const p = pace(w, now)
  if (p?.isRisk && !a.pace && w.pct < 100) {
    // Skip if a threshold toast just fired, to avoid two at once; it stays armed for the next reply.
    if (top === undefined) {
      $.ui.toast(`${name} limit: at this rate it ${p.text}${reset ? `, before it resets in ${reset}` : ''}`, {
        timeoutMs: 8000,
      })
      a.pace = true
    }
  }
  await $.store.set(key, a)
}

/** Reads the latest limits the engine holds and shows them. */
async function refresh($: EngineInterface) {
  const u = await $.session.usage()
  if (u.rateLimits.length) await ingest($, u.rateLimits)
}

/** Once a minute: clear windows that have reset, and redraw so the countdown and pace move. */
async function tick($: EngineInterface) {
  const now = await $.clock.now()
  const ws = await read($, windows)
  if (ws.length === 0) {
    // Nothing shown yet (just enabled, or no reading so far): ask for the latest figures.
    await refresh($)
    return
  }
  const isAnyReset = ws.some(w => w.resetsAt && Date.parse(w.resetsAt) <= now)
  if (isAnyReset) {
    // Keep estTotal (the window's size doesn't change); the next reply brings the new reset time.
    await update($, windows, list =>
      list.map(w =>
        w.resetsAt && Date.parse(w.resetsAt) <= now ? { kind: w.kind, pct: 0, estTotal: w.estTotal } : w,
      ),
    )
  } else {
    $.ui.invalidate('ui.render')
  }
}

let timer: { cancel: () => void } | undefined

/** Starts the minute timer if it isn't running, and fills the band if it's empty. */
async function ensure($: EngineInterface) {
  if (!timer) timer = $.clock.every(60_000, () => void tick($))
  if ((await read($, windows)).length === 0) await refresh($)
}

export const register: Register = on => {

  on('session.start', async ($, e, next) => {
    const r = await next(e)
    timer?.cancel()
    timer = undefined
    await ensure($)
    return r
  })

  // A mod enabled mid-session may miss session.start: catch up on the next prompt.
  on('prompt.submit', async ($, e, next) => {
    await ensure($)
    return next(e)
  })

  // Count tokens toward each window (subagents too: they draw on the same limits).
  // Cache reads are excluded: they weigh far less against limits.
  on('turn.complete', async ($, e, next) => {
    const u = e.usage
    if (u) {
      const spent = u.input_tokens + u.output_tokens + u.cache_creation_input_tokens
      await update($, chatTokens, n => (n ?? 0) + spent)
      for (const kind of ['five_hour', 'seven_day']) {
        const c = await getCalib($, kind)
        c.pending += spent
        await $.store.set(calibKey(kind), c)
      }
    }
    await ensure($)
    return next(e)
  })

  on('session.measure', async ($, e, next) => {
    if (e.changed.includes('rateLimits')) await ingest($, e.rateLimits)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const ws = await read($, windows)
    if (e.props.hasSurvey || ws.length === 0) return next(e)

    const { Box, Text } = $.ui.resolve(e)
    const chat = await read($, chatTokens)
    const now = await $.clock.now()
    const BAR = 22
    const FILL = '━'
    const TRACK = '─'
    const SIZE = 'caption' as const

    // Laid out by column, not by row: each column holds both rows' cells,
    // so every column starts at the same point on both rows whatever the text.
    const rows = ws.map(w => {
      const pct = Math.min(100, Math.max(0, w.pct))
      const filled = Math.max(pct > 0 ? 1 : 0, Math.round((pct / 100) * BAR))
      const color = (ZONES.find(z => pct < z.to) ?? ZONES[2]!).fill
      const left = w.estTotal !== undefined ? w.estTotal * (1 - pct / 100) : undefined
      const used = w.estTotal !== undefined ? w.estTotal * (pct / 100) : undefined
      return { w, pct, filled, color, left, used, reset: resetIn(w.resetsAt, now), p: pace(w, now) }
    })

    return (
      <Box key="band" position="relative" flexDirection="row" flexWrap="nowrap" gap="md">
        <Box flexDirection="column" rowGap="xs" flexShrink={0}>
          {rows.map(r => (
            <Text key={r.w.kind} size={SIZE} weight="bold" dimColor>
              {LABELS[r.w.kind] ?? r.w.kind}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" rowGap="xs" flexShrink={0}>
          {rows.map(r => (
            <Text key={r.w.kind} size={SIZE}>
              <Text color={r.color}>{FILL.repeat(r.filled)}</Text>
              {ZONES.map(z => {
                const from = Math.max(r.filled, Math.round((z.from / 100) * BAR))
                const to = Math.round((z.to / 100) * BAR)
                return to > from ? (
                  <Text key={z.from} color={z.track}>
                    {TRACK.repeat(to - from)}
                  </Text>
                ) : null
              })}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" rowGap="xs" flexShrink={0}>
          {rows.map(r => (
            <Text key={r.w.kind} size={SIZE} color={r.color} weight="semibold" tabular>
              {r.pct.toFixed(r.pct < 10 ? 1 : 0)}%
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" rowGap="xs" flexShrink={1}>
          {rows.map(r =>
            r.left !== undefined && r.used !== undefined ? (
              <Text key={r.w.kind} size={SIZE} tabular wrap="truncate-end">
                {fmt(r.used)}
                <Text dimColor> / {fmt(r.w.estTotal!)}</Text>
                {'  '}~{fmt(r.left)}
                <Text dimColor> left</Text>
              </Text>
            ) : (
              <Text key={r.w.kind} size={SIZE} dimColor wrap="truncate-end">
                calibrating…
              </Text>
            ),
          )}
        </Box>
        <Box flexGrow={1} />
        <Box flexDirection="column" rowGap="xs" flexShrink={1}>
          {rows.map(r => (
            <Text key={r.w.kind} size={SIZE} color={r.p?.color} wrap="truncate-end">
              {r.p ? `${r.p.isRisk ? '⚠' : '✓'} ${r.p.text}` : ' '}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column" rowGap="xs" flexShrink={0}>
          {rows.map(r => (
            <Text key={r.w.kind} size={SIZE} dimColor tabular>
              {r.reset ? `resets in ${r.reset}` : r.w.resetsAt ? ' ' : 'fresh window'}
            </Text>
          ))}
        </Box>
        {/* Revealed while the pointer is over the band: this chat's own usage, as a small card. */}
        <Box
          position="absolute"
          top={0}
          right={0}
          display="none"
          hover={{ display: 'flex' }}
          backgroundColor="#3a3a3a"
          paddingX={1}
        >
          <Text size={SIZE} tabular>
            <Text dimColor>this chat </Text>
            {fmt(chat)}
            <Text dimColor> tokens</Text>
          </Text>
        </Box>
      </Box>
    )
  })
}
