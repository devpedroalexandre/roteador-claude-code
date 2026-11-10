import { describe, expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { aplicarRestricoes, classificarPorRegras, lerRespostaClassificador, textoDigitado } from '../hooks/classificar'
import { avisoDeContexto, avisoDoPlano, nivelDoContexto, pareceAssuntoNovo, textoEconomia } from '../hooks/economia'

// Um "motor" falso por baixo do mod: contexto da conversa, custo da sessão,
// a resposta do Haiku classificador e o que cada requisição pediu.
type Mundo = {
  contexto: number
  custo: number
  respostaHaiku: string
  chamadasHaiku: number
  modelosPedidos: string[]
  esforcosPedidos: (string | number | undefined)[]
  status: (string | undefined)[]
  toasts: string[]
  plano: number
  renovaEmH?: number // quando a janela de 5 h renova, em horas a partir de agora
  lido: number // cache lido que a resposta simulada informa (o contexto que o modelo leu)
}

function mundo(parcial: Partial<Mundo> = {}): Mundo {
  return { contexto: 1000, custo: 0.5, respostaHaiku: 'SONNET', chamadasHaiku: 0, modelosPedidos: [], esforcosPedidos: [], status: [], toasts: [], plano: 23.5, lido: 50, ...parcial }
}

function montar(on: On, m: Mundo) {
  mock.store(on)
  mock.clock(on, { now: 1_700_000_000_000 })
  // O que o engine responde por conta própria numa sessão de verdade.
  // Eventos respondem o resultado; chamadas feitas por `$` respondem { value }.
  on('session.start', () => ({ cwd: '/projeto' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { tokens: m.contexto, window: 200000, percent: Math.round((m.contexto / 200000) * 100) },
      rateLimits: [
        {
          kind: 'five_hour',
          percentUsed: m.plano,
          ...(m.renovaEmH !== undefined ? { resetsAt: new Date(1_700_000_000_000 + m.renovaEmH * 3600000).toISOString() } : {}),
        },
      ],
      cost: { usd: m.custo },
    },
  }))
  on('model.complete', () => {
    m.chamadasHaiku += 1
    m.custo += 0.0004
    return {
      value: {
        isAnswered: true as const,
        text: m.respostaHaiku,
        usage: { input_tokens: 120, output_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('turn.step', async function* (_$, e) {
    m.modelosPedidos.push(e.model)
    m.esforcosPedidos.push(e.effort)
    return {
      turnId: e.turnId,
      index: e.index,
      answer: 'ok',
      toolUses: [],
      stopReason: 'end_turn' as const,
      usage: { model: e.model, input_tokens: 100, output_tokens: 20, cache_read_input_tokens: m.lido, cache_creation_input_tokens: 10 },
    }
  })
  on('ui.status', (_$, e) => {
    m.status.push(e.text)
    return { value: undefined }
  })
  on('ui.toast', (_$, e) => {
    m.toasts.push(e.text)
    return { value: undefined }
  })
}

async function iniciar($: Engine, ligar: boolean) {
  await $.session.start({ cwd: '/projeto', surface: null, isInteractive: true })
  if (ligar) await comando($, 'roteador', 'on')
}

// Um comando digitado pela pessoa no terminal.
function comando($: Engine, command: string, args = '') {
  return $.command.run({ command, args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
}

// Um turno: a mensagem e `passos` requisições ao modelo (com uso de ferramentas).
async function turno($: Engine, texto: string, turnId: string, passos = 1, agentId?: string) {
  await $.turn.start({ text: texto, turnId })
  for (let index = 0; index < passos; index++) {
    const fluxo = $.turn.step({ turnId, index, model: 'claude-sonnet-5-5', messageCount: 1, ...(agentId ? { agentId } : {}) })
    for await (const _ of fluxo) {
      // só consome
    }
    await fluxo.result
  }
}

const ultimoStatus = (m: Mundo) => m.status[m.status.length - 1] ?? ''

describe('roteador', () => {
  test('desligado: não troca o modelo nem escreve motivo', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, false)
    await turno($, 'liste os arquivos', 't1')
    expect(m.modelosPedidos).toEqual(['claude-sonnet-5-5'])
    expect(m.chamadasHaiku).toBe(0)
  })

  test('tarefa simples e curta vai para o Haiku, sem gastar a chamada', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos da pasta db', 't1')
    expect(m.modelosPedidos).toEqual(['claude-haiku-5-5'])
    expect(m.chamadasHaiku).toBe(0)
    expect(ultimoStatus(m)).toContain('on: haiku · low · tarefa simples e curta')
    expect(ultimoStatus(m).length).toBeLessThan(100)
  })

  test('tarefa pesada vai para o Opus; dia a dia para o Sonnet', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero para a padaria', 't1', 6)
    await turno($, 'explique o que faz a função creditar_deposito', 't2')
    expect(m.modelosPedidos.slice(0, 6)).toEqual(Array(6).fill('claude-opus-5-5'))
    expect(m.modelosPedidos[6]).toBe('claude-sonnet-5-5')
  })

  test('decide na primeira requisição e mantém o modelo no turno inteiro', async ($, on) => {
    const m = mundo({ respostaHaiku: 'OPUS' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't1', 3)
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5', 'claude-opus-5-5', 'claude-opus-5-5'])
    expect(m.chamadasHaiku).toBe(1)
  })

  test('regra indecisa: uma chamada curta ao Haiku, e o custo dela aparece', async ($, on) => {
    const m = mundo({ respostaHaiku: 'OPUS' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't1')
    expect(m.chamadasHaiku).toBe(1)
    expect(m.toasts.some(t => t.includes('US$ 0.00040'))).toBe(true)
    expect(ultimoStatus(m)).toContain('Haiku classificou')
  })

  test('acima de 30 mil tokens mantém o modelo em uso e diz o motivo', { options: { limiteTrocaTokens: 30000, limiteTrocaCertaTokens: 120000 } }, async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero', 't1') // vai para o Opus
    m.contexto = 45000
    await turno($, 'liste os arquivos', 't2') // queria Haiku
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(ultimoStatus(m)).toContain('mantido (cache)')
    expect(ultimoStatus(m)).toContain('45 mil')
  })

  test('a linha de status termina sempre com contexto e saída em tokens', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'pode seguir', 't1')
    // O contexto vem do motor (session.usage), não da soma do uso da resposta (100 + 10 + 50).
    expect(ultimoStatus(m)).toMatch(/ · contexto 1 mil · plano 5 h 23.5%$/)
  })

  test('acima do limite, regra indecisa não gasta a chamada ao Haiku', { options: { limiteTrocaTokens: 30000, limiteTrocaCertaTokens: 120000 } }, async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    m.contexto = 45000
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't1')
    expect(m.chamadasHaiku).toBe(0)
  })

  test('o limite de troca é configurável', { options: { limiteTrocaTokens: 50000 } }, async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero', 't1')
    m.contexto = 45000 // abaixo do novo limite de 50 mil: troca liberada
    await turno($, 'liste os arquivos', 't2')
    expect(m.modelosPedidos[1]).toBe('claude-haiku-5-5')
  })

  test('Haiku nunca recebe conversa acima de 100 mil tokens', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos', 't1') // Haiku
    m.contexto = 120000
    await turno($, 'sim', 't2') // continuação: manteria o Haiku
    expect(m.modelosPedidos).toEqual(['claude-haiku-5-5', 'claude-sonnet-5-5'])
    expect(ultimoStatus(m)).toContain('Haiku vetado')
  })

  test('cada família recebe o esforço certo', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos da pasta db', 't1') // haiku
    await turno($, 'explique o que faz a função creditar_deposito', 't2') // sonnet
    await turno($, 'corrija o erro no login', 't3') // sonnet, defeito
    await turno($, 'crie um site do zero para a padaria', 't4') // opus
    await turno($, 'investigue a causa raiz da fila travada', 't5') // opus, máximo
    expect(m.esforcosPedidos).toEqual(['low', 'medium', 'high', 'high', 'xhigh'])
    expect(ultimoStatus(m)).toContain('opus · xhigh')
  })

  test('o esforço escolhido vale no turno inteiro', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'planeje a arquitetura do módulo de pagamentos', 't1', 3)
    expect(m.esforcosPedidos).toEqual(['xhigh', 'xhigh', 'xhigh'])
  })

  test('o Haiku classificador também diz o esforço', async ($, on) => {
    const m = mundo({ respostaHaiku: 'OPUS XHIGH' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't1')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
    expect(m.esforcosPedidos).toEqual(['xhigh'])
  })

  test('acima do limite por regra (120 mil) nem o modelo nem o esforço mudam', { options: { limiteTrocaTokens: 30000, limiteTrocaCertaTokens: 120000 } }, async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    m.contexto = 130000
    await turno($, 'crie um site do zero', 't1')
    expect(m.modelosPedidos).toEqual(['claude-sonnet-5-5'])
    expect(m.esforcosPedidos).toEqual([undefined])
    expect(ultimoStatus(m)).toContain('mantido (cache)')
    expect(ultimoStatus(m)).toContain('contexto 130 mil')
  })

  test('regra CERTA troca de modelo acima de 30 mil (até 120 mil), com o esforço dela', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    m.contexto = 45000
    await turno($, 'crie um site do zero', 't1') // estava no Sonnet
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
    expect(m.esforcosPedidos).toEqual(['high'])
  })

  test('assunto sensível vai ao Opus mesmo numa conversa de 80 mil', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    m.contexto = 80000
    await turno($, 'qual o valor da caução do sábado?', 't1')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
    expect(ultimoStatus(m)).toContain('assunto sensível')
  })

  test('continuação longa fica com quem está trabalhando, sem chamar o Haiku', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero', 't1') // Opus
    await turno($, 'pode aplicar tudo que achar que vai melhorar, e faça do jeito que achar melhor', 't2')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(m.chamadasHaiku).toBe(0)
    expect(ultimoStatus(m)).toContain('continua o trabalho anterior')
  })

  test('o Haiku classificador pode responder MANTER', async ($, on) => {
    const m = mundo({ respostaHaiku: 'MANTER' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero', 't1') // Opus
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't2')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(m.chamadasHaiku).toBe(1)
    expect(m.esforcosPedidos[1]).toBe(undefined)
  })

  test('Haiku vetado por tamanho NÃO puxa outro modelo quando já não se estava no Haiku', { options: { limiteTrocaTokens: 30000, limiteTrocaCertaTokens: 120000 } }, async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero', 't1') // Opus
    m.contexto = 110000
    await turno($, 'liste os arquivos', 't2') // queria Haiku: nem Haiku, nem Sonnet
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5', 'claude-opus-5-5'])
    expect(ultimoStatus(m)).toContain('mantido (cache)')
  })

  test('desligado: o esforço da sessão não é tocado', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, false)
    await turno($, 'crie um site do zero', 't1')
    expect(m.esforcosPedidos).toEqual([undefined])
  })

  test('subagentes são ignorados pelo roteador', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos', 't1', 1, 'agente-1')
    expect(m.modelosPedidos).toEqual(['claude-sonnet-5-5'])
  })

  test('/custo mostra custo, plano e tokens por modelo com cache', async ($, on) => {
    const m = mundo({ respostaHaiku: 'OPUS' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos', 't1')
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't2')
    const r = await comando($, 'custo')
    const texto = r.text ?? ''
    expect(texto).toContain('**Custo da sessão:** US$ 0.5004')
    expect(texto).toContain('janela de 5 h: 23.5%')
    expect(texto).toContain('| claude-haiku-5-5 | 2 | 220 | 22 | 50 | 10 |')
    expect(texto).toContain('| claude-opus-5-5 | 1 | 100 | 20 | 50 | 10 |')
    expect(texto).toContain('**Classificações pelo Haiku:** 1')
  })

  test('/roteador off desliga e para de trocar', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await comando($, 'roteador', 'off')
    await turno($, 'liste os arquivos', 't1')
    expect(m.modelosPedidos).toEqual(['claude-sonnet-5-5'])
    // Desligado, a linha deixa de falar de rota mas segue mostrando os tokens.
    expect(m.status[m.status.length - 1]).toMatch(/^off: sonnet · contexto 1 mil/)
  })
})

describe('regras de classificação', () => {
  test('continuação curta mantém o modelo anterior', () => {
    expect(classificarPorRegras('sim').familia).toBe('manter')
    expect(classificarPorRegras('pode seguir!').familia).toBe('manter')
  })
  test('"faça um resumo do projeto" é dia a dia, não tarefa pesada', () => {
    expect(classificarPorRegras('faça um resumo do projeto').familia).toBe('sonnet')
  })
  test('esforço sai das regras: simples low, dia a dia medium, defeito high, pesada high, extrema xhigh', () => {
    expect(classificarPorRegras('liste os arquivos')).toMatchObject({ familia: 'haiku', esforco: 'low' })
    expect(classificarPorRegras('explique esse código')).toMatchObject({ familia: 'sonnet', esforco: 'medium' })
    expect(classificarPorRegras('corrija o bug do login')).toMatchObject({ familia: 'sonnet', esforco: 'high' })
    expect(classificarPorRegras('crie um site do zero')).toMatchObject({ familia: 'opus', esforco: 'high' })
    expect(classificarPorRegras('ache a causa raiz da race condition')).toMatchObject({ familia: 'opus', esforco: 'xhigh' })
  })
  test('concorrência é tarefa pesada com raciocínio máximo', () => {
    expect(classificarPorRegras('tem um deadlock nesse job')).toMatchObject({ familia: 'opus', esforco: 'xhigh' })
  })
  test('resposta do Haiku classificador: família e esforço, com padrão e teto', () => {
    expect(lerRespostaClassificador('OPUS XHIGH')).toEqual({ familia: 'opus', esforco: 'xhigh' })
    expect(lerRespostaClassificador('Opus high')).toEqual({ familia: 'opus', esforco: 'high' })
    expect(lerRespostaClassificador('OPUS')).toEqual({ familia: 'opus', esforco: 'high' }) // padrão
    expect(lerRespostaClassificador('SONNET XHIGH')).toEqual({ familia: 'sonnet', esforco: 'high' }) // teto
    expect(lerRespostaClassificador('HAIKU HIGH')).toEqual({ familia: 'haiku', esforco: 'low' }) // teto
    expect(lerRespostaClassificador('???')).toEqual({ familia: 'sonnet', esforco: 'medium' })
  })
  test('mensagem longa é tratada como especificação', () => {
    expect(classificarPorRegras('a'.repeat(1300)).familia).toBe('opus')
  })
  test('sem palavra-chave fica indefinido (vai ao Haiku classificador)', () => {
    expect(classificarPorRegras('dê uma olhada geral nesse módulo').familia).toBe('indefinido')
  })
  test('continuação longa sem assunto pesado: manter; com assunto pesado: Opus', () => {
    expect(classificarPorRegras('pode aplicar tudo que achar que vai melhorar, em relação ao 7 faça do jeito que achar melhor').familia).toBe('manter')
    expect(classificarPorRegras('segue com as tarefas que você achar necessárias').familia).toBe('manter')
    expect(classificarPorRegras('faça do jeito que achar melhor').familia).toBe('manter')
    expect(classificarPorRegras('pode aplicar a migration no supabase')).toMatchObject({ familia: 'opus', certa: true })
  })
  test('"pode" e "faça" com pedido NOVO não são continuação', () => {
    expect(classificarPorRegras('pode explicar esse código?').familia).toBe('sonnet')
    expect(classificarPorRegras('faça um resumo do projeto').familia).toBe('sonnet')
  })
  test('assuntos sensíveis vão ao Opus: banco, dinheiro, publicação', () => {
    for (const t of ['qual o valor da caução?', 'rode a migration nova', 'revise a policy de RLS', 'faça o deploy', 'o pagamento falhou no stripe']) {
      expect(classificarPorRegras(t), t).toMatchObject({ familia: 'opus', esforco: 'high' })
    }
  })
  test('investigar, auditar e migrar pedem high; xhigh só arquitetura, causa raiz, bug difícil e concorrência', () => {
    expect(classificarPorRegras('investigue por que o botão sumiu')).toMatchObject({ familia: 'opus', esforco: 'high' })
    expect(classificarPorRegras('faça uma auditoria do painel')).toMatchObject({ familia: 'opus', esforco: 'high' })
    expect(classificarPorRegras('qual a causa raiz disso?')).toMatchObject({ familia: 'opus', esforco: 'xhigh' })
  })
  test('o classificador pode mandar MANTER', () => {
    expect(lerRespostaClassificador('MANTER')).toEqual({ familia: 'manter' })
    expect(lerRespostaClassificador('manter.')).toEqual({ familia: 'manter' })
  })
  test('regra é "certa"; o que sobra para o Haiku não é', () => {
    expect(classificarPorRegras('liste os arquivos')).toMatchObject({ certa: true })
    expect(classificarPorRegras('explique esse código')).toMatchObject({ certa: true })
    expect('certa' in classificarPorRegras('dê uma olhada geral nesse módulo')).toBe(false)
  })
})

describe('motivos da linha de status', () => {
  const base = { limiteTroca: 30000, limiteTrocaCerta: 120000, limiteHaiku: 100000, modeloAtual: 'claude-opus-5-5' }

  test('mesmo modelo em conversa grande: o motivo diz que o esforço não foi aplicado', () => {
    const e = aplicarRestricoes('opus', 'tarefa pesada (palavra-chave)', { ...base, contextoTokens: 50000 }, 'xhigh', true)
    expect(e.modelo).toBe('claude-opus-5-5')
    expect(e.esforco).toBeUndefined()
    expect(e.motivo).toContain('esforço xhigh não aplicado')
  })

  test('troca recusada explica a conta em palavras e diz se era palpite', () => {
    const palpite = aplicarRestricoes('sonnet', 'classificado pelo Haiku', { ...base, contextoTokens: 50000 }, 'medium', false)
    expect(palpite.motivo).toContain('mantido (cache)')
    expect(palpite.motivo).toContain('regravaria 50 mil tokens')
    expect(palpite.motivo).toContain('palpite')
    const regra = aplicarRestricoes('sonnet', 'trabalho do dia a dia', { ...base, contextoTokens: 150000 }, 'medium', true)
    expect(regra.motivo).toContain('limite 120 mil')
    expect(regra.motivo).not.toContain('palpite')
  })
})

describe('gestão de tokens', () => {
  const L = { compactar: 100000, novaConversa: 200000, plano: 75 }

  test('o aviso de contexto só aparece quando o nível sobe, e volta depois de compactar', () => {
    expect(avisoDeContexto(0, 50000, L)).toEqual({ nivel: 0 })
    const a = avisoDeContexto(0, 110000, L)
    expect(a.nivel).toBe(1)
    expect(a.texto).toContain('/compact')
    expect(avisoDeContexto(1, 120000, L)).toEqual({ nivel: 1 }) // já avisado
    const b = avisoDeContexto(1, 210000, L)
    expect(b.nivel).toBe(2)
    expect(b.texto).toContain('conversa NOVA')
    expect(avisoDeContexto(2, 30000, L)).toEqual({ nivel: 0 }) // compactou: re-arma
    expect(avisoDeContexto(0, 110000, L).texto).toContain('/compact') // e avisa de novo
  })

  test('o aviso do plano diz quando renova e fica mais forte com 90%', () => {
    expect(avisoDoPlano(0, 60, '2 h 10 min', L)).toEqual({ nivel: 0 })
    const a = avisoDoPlano(0, 80, '2 h 10 min', L)
    expect(a.nivel).toBe(1)
    expect(a.texto).toContain('Renova em 2 h 10 min')
    expect(avisoDoPlano(1, 82, undefined, L)).toEqual({ nivel: 1 })
    expect(avisoDoPlano(1, 93, undefined, L).nivel).toBe(2)
  })

  test('assunto novo: só começos claros de outra tarefa', () => {
    expect(pareceAssuntoNovo('agora vamos para o cadastro')).toBe(true)
    expect(pareceAssuntoNovo('outro assunto: o deploy')).toBe(true)
    expect(pareceAssuntoNovo('agora o botao esta azul?')).toBe(false)
    expect(pareceAssuntoNovo('corrija o erro da tela')).toBe(false)
  })

  test('/economia traz os números de agora e as boas práticas', () => {
    const t = textoEconomia({ contexto: 120000, percentualDaJanela: 12, plano: [{ nome: 'janela de 5 h', percentual: 40 }], limites: L })
    expect(t).toContain('120.000 tokens (12% da janela) — hora de compactar')
    expect(t).toContain('janela de 5 h 40%')
    expect(t).toContain('/handoff')
    expect(nivelDoContexto(120000, L)).toBe(1)
  })

  test('conversa grande: um aviso só, a linha de status marca ⚠ e vale com o roteador desligado', async ($, on) => {
    const m = mundo({ contexto: 110000, lido: 110000 })
    montar(on, m)
    await iniciar($, false) // roteador desligado
    await turno($, 'liste os arquivos', 't1')
    await turno($, 'liste os arquivos', 't2')
    expect(m.toasts.filter(t => t.includes('/compact'))).toHaveLength(1)
    expect(ultimoStatus(m)).toContain('off: sonnet')
    expect(ultimoStatus(m)).toContain('⚠ /compact')
  })

  test('292 mil tokens no mesmo assunto: aconselha /compact com o custo, não conversa nova', async ($, on) => {
    const m = mundo({ contexto: 292596, lido: 292596 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'corrija o erro de login na pagina inicial', 't1')
    await turno($, 'o botao de login continua quebrado na pagina inicial', 't2')
    const s = ultimoStatus(m)
    expect(s).toContain('⚠ /compact')
    expect(s).toContain('/msg')
    expect(s).not.toContain('conversa nova')
    expect(m.toasts.some(t => t.includes('Mesmo assunto'))).toBe(true)
  })

  test('assunto muda numa conversa grande: aconselha /handoff', async ($, on) => {
    const m = mundo({ contexto: 150000, lido: 150000 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'corrija o erro de login na pagina inicial', 't1')
    await turno($, 'o botao de login continua quebrado na pagina inicial', 't2')
    await turno($, 'quero um relatorio mensal das vendas por vendedor', 't3')
    expect(ultimoStatus(m)).toContain('⚠ assunto novo: /handoff')
  })

  test('plano acima do limite avisa uma vez', async ($, on) => {
    const m = mundo({ plano: 80 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'pode seguir', 't1')
    await turno($, 'pode seguir', 't2')
    expect(m.toasts.filter(t => t.includes('Plano: 80%'))).toHaveLength(1)
  })

  test('/economia roda como comando', async ($, on) => {
    const m = mundo({ contexto: 5000 })
    montar(on, m)
    await iniciar($, false)
    const r = await comando($, 'economia')
    expect(JSON.stringify(r)).toContain('Boas práticas')
  })
})

describe('só o que a pessoa digitou classifica', () => {
  const selecao = `<ide_selection>The user selected the lines 1 to 159 from verificar.sql:\n${'-- migration RLS policy supabase sql\n'.repeat(40)}</ide_selection>`

  test('textoDigitado tira seleção, colado e avisos do sistema', () => {
    expect(textoDigitado(`${selecao}leia o arquivo`)).toBe('leia o arquivo')
    expect(textoDigitado('oi <pasted_content id="b22a">migration enorme</pasted_content id="b22a"> tchau')).toBe('oi   tchau')
    expect(textoDigitado('<system-reminder>regras</system-reminder>pode seguir')).toBe('pode seguir')
    expect(textoDigitado('pode seguir <ide_selection>sem fechar migration')).toBe('pode seguir')
    expect(textoDigitado('só texto, sem tags')).toBe('só texto, sem tags')
  })

  test('seleção de SQL anexada não faz uma pergunta simples virar tarefa pesada', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, `${selecao}liste os arquivos`, 't1')
    expect(m.modelosPedidos).toEqual(['claude-haiku-5-5'])
    expect(ultimoStatus(m)).toContain('tarefa simples')
  })

  test('mensagem que é só colado não classifica: mantém o modelo', () => {
    expect(classificarPorRegras(textoDigitado('<pasted_content id="x">migration RLS</pasted_content id="x">')).familia).toBe('manter')
  })
})

describe('plano na decisão e diário', () => {
  test('plano apertado: tarefa pesada fica no Sonnet e a linha de status diz que está economizando', async ($, on) => {
    const m = mundo({ plano: 90, renovaEmH: 3 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero para a padaria', 't1')
    expect(m.modelosPedidos).toEqual(['claude-sonnet-5-5'])
    expect(ultimoStatus(m)).toContain('sonnet · high · tarefa pesada')
    expect(ultimoStatus(m)).toContain('renova em 3 h 0 min')
    expect(ultimoStatus(m)).toContain('Opus → Sonnet')
    expect(ultimoStatus(m)).toContain('economizando')
  })

  test('plano apertado: assunto sensível continua no Opus', async ($, on) => {
    const m = mundo({ plano: 90, renovaEmH: 3 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'ajuste a policy de RLS do Supabase', 't1')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
  })

  test('plano folgado: a mesma tarefa pesada vai ao Opus', async ($, on) => {
    const m = mundo({ plano: 30, renovaEmH: 2.5 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero para a padaria', 't1')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
  })

  test('/decisoes: registra a decisão e marca discordância quando a pergunta se repete', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos da pasta db', 't1')
    await turno($, 'liste os arquivos da pasta db', 't2')
    const r = await comando($, 'decisoes')
    expect(r.text).toContain('Decisões registradas:** 2')
    expect(r.text).toContain('discordou depois:** 1')
    expect(r.text).toContain('repetiu a pergunta 1')
  })

  test('/decisoes: perguntas diferentes não contam como discordância', async ($, on) => {
    const m = mundo()
    montar(on, m)
    await iniciar($, true)
    await turno($, 'liste os arquivos da pasta db', 't1')
    await turno($, 'explique o que faz a função creditar_deposito', 't2')
    const r = await comando($, 'decisoes')
    expect(r.text).toContain('discordou depois:** 0')
  })
})

describe('sem limite de cache por padrão', () => {
  test('conversa grande: cada mensagem é avaliada sozinha (tarefa simples vai ao Haiku, pesada ao Opus)', async ($, on) => {
    const m = mundo({ contexto: 80000 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero para a padaria', 't1')
    await turno($, 'liste os arquivos da pasta db', 't2')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5', 'claude-haiku-5-5'])
  })

  test('conversa grande e regras indecisas: o Haiku classifica, mas subir por palpite caro não se paga', async ($, on) => {
    const m = mundo({ contexto: 150000, respostaHaiku: 'OPUS HIGH' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't1')
    expect(m.chamadasHaiku).toBe(1)
    expect(m.modelosPedidos).toEqual(['claude-sonnet-5-5'])
    expect(ultimoStatus(m)).toContain('mantido (custo)')
  })

  test('conversa média: o mesmo palpite para o Opus sai barato o bastante e troca', async ($, on) => {
    const m = mundo({ contexto: 20000, respostaHaiku: 'OPUS HIGH' })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'dê uma olhada geral nesse módulo de relatórios', 't1')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
  })

  test('conversa grande: tarefa pesada por REGRA sobe para o Opus mesmo custando mais', async ($, on) => {
    const m = mundo({ contexto: 150000 })
    montar(on, m)
    await iniciar($, true)
    await turno($, 'crie um site do zero para a padaria', 't1')
    expect(m.modelosPedidos).toEqual(['claude-opus-5-5'])
  })
})
