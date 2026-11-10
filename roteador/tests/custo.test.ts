import { describe, expect, test } from 'claude-code/testing'

import { avaliarTroca, custoDoTurno, precoDe, preverTurno, usd } from '../hooks/custo'

const turno = (contexto: number, passos = 6, saidaPorPasso = 600) => ({ contexto, passos, saidaPorPasso })
const arred = (v: number) => Math.round(v * 1e5) / 1e5
const regra = { cacheQuente: true, certa: true, tetoPalpiteUsd: 0.3 }
const palpite = { ...regra, certa: false }

describe('custo do turno', () => {
  test('cache frio custa a escrita; quente, só a leitura', () => {
    const p = turno(100000, 1, 0)
    expect(arred(custoDoTurno('sonnet', p, false))).toBe(0.25) // 100 mil × US$ 2,50 / mi
    expect(arred(custoDoTurno('sonnet', p, true))).toBe(0.02)
  })
  test('o Haiku encarece acima de 100 mil tokens', () => {
    expect(precoDe('haiku', 100000).entrada).toBe(0.1)
    expect(precoDe('haiku', 100001).entrada).toBe(0.5)
  })
  test('a saída pesa: Opus escreve ao dobro do preço do Sonnet', () => {
    const p = turno(0, 10, 1000)
    expect(arred(custoDoTurno('opus', p, true))).toBe(arred(2 * custoDoTurno('sonnet', p, true)))
  })
})

describe('vale trocar?', () => {
  test('descer para o Haiku quase sempre se paga, até numa conversa de 80 mil e turno de 1 passo', () => {
    const a = avaliarTroca('sonnet', 'haiku', turno(80000, 1), regra)
    expect(a.trocar).toBe(true)
    expect(a.motivo).toContain('poupa')
  })
  test('Opus → Sonnet numa conversa grande e turno curto NÃO se paga (regravar custa mais que a saída poupada)', () => {
    const a = avaliarTroca('opus', 'sonnet', turno(100000, 2), regra)
    expect(a.trocar).toBe(false)
    expect(a.motivo).toContain('mantido (custo)')
  })
  test('o mesmo Opus → Sonnet num turno longo de saída grande se paga', () => {
    expect(avaliarTroca('opus', 'sonnet', turno(100000, 30, 3000), regra).trocar).toBe(true)
  })
  test('cache expirado: trocar não custa regravação a mais, então descer sempre vale', () => {
    expect(avaliarTroca('opus', 'sonnet', turno(100000, 2), { ...regra, cacheQuente: false }).trocar).toBe(true)
  })
  test('subir por regra vale sempre, mesmo caro', () => {
    const a = avaliarTroca('sonnet', 'opus', turno(150000), regra)
    expect(a.trocar).toBe(true)
    expect(a.diferenca).toBeGreaterThan(0.3)
  })
  test('subir por palpite só até o teto', () => {
    expect(avaliarTroca('sonnet', 'opus', turno(20000), palpite).trocar).toBe(true)
    expect(avaliarTroca('sonnet', 'opus', turno(150000), palpite).trocar).toBe(false)
  })
  test('mesmo modelo: nada a avaliar', () => expect(avaliarTroca('opus', 'opus', turno(1000), regra)).toEqual({ trocar: false, diferenca: 0 }))
  test('Haiku acima de 100 mil custa mais: trocar só vale em turno longo', () => {
    expect(avaliarTroca('sonnet', 'haiku', turno(150000, 1, 100), regra).trocar).toBe(false)
    expect(avaliarTroca('sonnet', 'haiku', turno(150000, 20, 1500), regra).trocar).toBe(true)
  })
})

describe('previsão do turno', () => {
  test('usa a mediana dos últimos turnos', () => {
    const p = preverTurno(5000, [2, 30, 4], [100, 900, 300])
    expect(p.passos).toBe(4)
    expect(p.saidaPorPasso).toBe(300)
  })
  test('sem histórico: valores padrão', () => {
    expect(preverTurno(5000, [], [])).toEqual({ contexto: 5000, passos: 6, saidaPorPasso: 600 })
  })
  test('dinheiro em português', () => {
    expect(usd(0.0123)).toBe('US$ 0,012')
    expect(usd(1.5)).toBe('US$ 1,50')
  })
})
