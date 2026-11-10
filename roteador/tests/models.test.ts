import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// Um "motor" falso: guarda os painéis que o mod pediu para abrir.
function montar(on: On, abertos: string[]) {
  on('session.start', () => ({ cwd: '/projeto' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.open', (_$, e) => {
    abertos.push(e.id)
    return { value: { isPlaced: true as const } }
  })
}

const propsPainel = { title: 'Models', isFocused: true, bodyColumns: 60 } as any

describe('comando /models', () => {
  test('/models abre o painel', async ($, on) => {
    const abertos: string[] = []
    montar(on, abertos)
    await $.session.start({ cwd: '/projeto', surface: null, isInteractive: true })
    const r = await $.command.run({
      command: 'models', args: '', origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 },
    })
    expect(abertos).toEqual(['models'])
    expect(r.text).toContain('aberto')
  })
})

describe('painel Models', () => {
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    test(`${surface}: lista os três modelos e mostra o resumo do escolhido`, async ($, on) => {
      montar(on, [])
      await $.session.start({ cwd: '/projeto', surface: null, isInteractive: true })
      const painel = await $.ui.mount({
        plugin: 'roteador', surface, component: 'Pane', requestId: 'models', props: propsPainel,
      })
      for (const nome of ['Haiku', 'Sonnet', 'Opus']) {
        expect(await painel.find({ type: 'Button', text: nome })).toBeDefined()
      }
      expect(await painel.find({ type: 'Text', text: 'Escolha um modelo' })).toBeDefined()
      await painel.press({ key: 'opus' })
      expect(await painel.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeDefined()
      expect(await painel.find({ type: 'Text', text: /xhigh/ })).toBeDefined()
      await painel.press({ key: 'haiku' })
      expect(await painel.find({ type: 'Text', text: 'claude-haiku-5-5' })).toBeDefined()
      expect(await painel.find({ type: 'Text', text: 'claude-opus-5-5' })).toBeUndefined()
    })
  }
})
