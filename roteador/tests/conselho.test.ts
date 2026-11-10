import { describe, expect, test } from 'claude-code/testing'

import { aconselhar, assuntoDaMensagem, custoDeCompactar, custoDeReler } from '../hooks/conselho'

const L = { compactar: 100000, novaConversa: 200000, plano: 75 }
const base = { familia: 'sonnet' as const, passos: 6, assunto: 'mesmo' as const, compactacoes: 0, limites: L }
const arred = (n: number) => Math.round(n * 1000) / 1000

describe('assunto da mensagem', () => {
  const antes = ['corrija o erro de login na pagina inicial', 'o botao de login continua quebrado na pagina']
  test('mesma matéria: continua', () => {
    expect(assuntoDaMensagem(antes, 'agora teste o login com a senha errada na pagina', false)).toBe('mesmo')
  })
  test('nada em comum com as mensagens anteriores: assunto novo', () => {
    expect(assuntoDaMensagem(antes, 'quero um relatorio mensal das vendas por vendedor', false)).toBe('novo')
  })
  test('começo explícito de outro assunto vale mesmo sem comparar', () => {
    expect(assuntoDaMensagem([], 'agora vamos para o cadastro', true)).toBe('novo')
  })
  test('mensagem curta ou sem histórico não decide', () => {
    expect(assuntoDaMensagem(antes, 'pode seguir', false)).toBeUndefined()
    expect(assuntoDaMensagem([], 'quero um relatorio mensal das vendas', false)).toBeUndefined()
  })
})

describe('custo de reler e de compactar', () => {
  test('Sonnet com 292 mil tokens e 6 requisições: cerca de US$ 0,35 por mensagem', () => {
    expect(arred(custoDeReler('sonnet', 292000, 6))).toBe(0.35)
  })
  test('compactar custa uma vez e é bem menos que reler por muitas mensagens', () => {
    expect(custoDeCompactar('sonnet', 292000)).toBeLessThan(0.2)
  })
})

describe('conselho', () => {
  test('conversa leve: nada a fazer', () => {
    const c = aconselhar({ ...base, contexto: 40000 })
    expect(c.acao).toBe('nada')
    expect(c.alerta).toBe('')
  })
  test('grande e no mesmo assunto: compactar, não conversa nova (o caso de 292 mil)', () => {
    const c = aconselhar({ ...base, contexto: 292596 })
    expect(c.acao).toBe('compactar')
    expect(c.alerta).toContain('/compact')
    expect(c.alerta).not.toContain('conversa nova')
    expect(c.detalhe).toContain('Mesmo assunto')
    expect(c.detalhe).toContain('se paga em 1 mensagem')
  })
  test('grande e o assunto mudou: handoff e conversa nova', () => {
    const c = aconselhar({ ...base, contexto: 150000, assunto: 'novo' })
    expect(c.acao).toBe('handoff')
    expect(c.alerta).toContain('/handoff')
  })
  test('já compactada duas vezes: handoff, porque cada compactação perde detalhe', () => {
    const c = aconselhar({ ...base, contexto: 150000, compactacoes: 2 })
    expect(c.acao).toBe('handoff')
    expect(c.detalhe).toContain('2 vezes')
  })
  test('Opus relê pelo mesmo preço de cache do Sonnet; Haiku é bem mais barato', () => {
    expect(custoDeReler('opus', 100000, 6)).toBe(custoDeReler('sonnet', 100000, 6))
    expect(custoDeReler('haiku', 90000, 6)).toBeLessThan(custoDeReler('sonnet', 90000, 6))
  })
})
