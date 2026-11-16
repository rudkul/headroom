import { expect, test } from 'claude-code/testing'

const BAND = {
  plugin: 'headroom',
  component: 'AbovePrompt',
  props: {
    hasSurvey: false,
    isCollapsed: false,
    isWorking: false,
    maxRows: 10,
    bodyColumns: 120,
    scroll: { offset: 0, bodyRows: 9 },
    view: {},
  },
} as const

test('the band draws both limits and the hover card', async ($, on) => {
  on('clock.now', () => ({ value: Date.parse('2098-12-31T22:00:00Z') }))
  on('state.get', (_, e) => {
    if ((e as { key: string }).key === 'windows') {
      return {
        value: {
          value: [
            { kind: 'five_hour', pct: 18, resetsAt: '2099-01-01T00:00:00Z', estTotal: 1_300_000 },
            { kind: 'seven_day', pct: 11, resetsAt: '2099-01-01T00:00:00Z' },
          ],
          version: 1,
        },
      }
    }
    return { value: { value: 11_000, version: 1 } }
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...BAND, surface })
    expect(await ui.find({ type: 'Text', text: /18%/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /this chat/ })).toBeDefined()
    await ui.unmount()
  }
})
