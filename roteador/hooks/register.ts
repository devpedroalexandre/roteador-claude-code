// roteador: escolhe Haiku, Sonnet ou Opus a cada mensagem da conversa
// principal, mantém o modelo durante o turno inteiro e mostra na linha de
// status quem respondeu de fato e por quê. /custo mostra o gasto.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelUsage, Register, TurnStepInput } from 'claude-code'

import type { RoteadorDecisao, RoteadorEsforco, RoteadorFamilia, RoteadorRequisicao } from '../types'
import {
  MODELOS,
  aplicarRestricoes,
  classificarPorRegras,
  familiaDe,
  lerRespostaClassificador,
  normalizar,
  textoDigitado,
  type Classificacao,
} from './classificar'
import {
  MINIMO_PARA_SUGERIR_CONVERSA_NOVA,
  SEM_AVISOS,
  avisoDeContexto,
  avisoDoPlano,
  milCurto,
  milhar,
  motivoCurto,
  pareceAssuntoNovo,
  sugestaoDeAssuntoNovo,
  textoEconomia,
  type Limites,
} from './economia'
import { aconselhar, assuntoDaMensagem, type Assunto, type Conselho } from './conselho'
import { avaliarTroca, preverTurno, usd } from './custo'
import { MAX_DIARIO, parecidas, resumoDoDiario, trechoDe, type Registro } from './diario'
import { registrarModels } from './models'
import { aplicarPressao, duracao, pressaoDoPlano, textoDoPlano } from './plano'

const ativo = atom({ plugin: 'roteador', key: 'ativo' } as const, false)
const textoTurno = atom({ plugin: 'roteador', key: 'textoTurno' } as const, null)
const decisao = atom({ plugin: 'roteador', key: 'decisao' } as const, null)
const ultimoModelo = atom({ plugin: 'roteador', key: 'ultimoModelo' } as const, null)
const requisicoes = atom({ plugin: 'roteador', key: 'requisicoes' } as const, [] as RoteadorRequisicao[])
const avisos = atom({ plugin: 'roteador', key: 'avisos' } as const, SEM_AVISOS)
// (o painel "Models", em models.tsx, declara o próprio átomo `modeloAberto`)

const CHAVE_STORE_ATIVO = 'ativo'
const CHAVE_STORE_DIARIO = 'diario'
const MAX_REGISTROS = 1000

// O classificador responde DUAS palavras: o modelo e o esforço. `xhigh` não é
// oferecido aqui: raciocínio máximo só sai das regras (palavra-chave), nunca de
// um palpite. MANTER existe porque muita mensagem só continua o trabalho anterior,
// e o classificador não vê a conversa — trocar nesses casos é o pior caso do cache.
const SISTEMA_CLASSIFICADOR = [
  'Classifique o pedido de um usuário a um assistente de programação. Responda só DUAS palavras: o modelo e o esforço (LOW, MEDIUM ou HIGH). Exemplo: SONNET MEDIUM',
  'HAIKU = tarefa simples e rápida (listar, pergunta curta, buscar uma informação, renomear, formatar).',
  'SONNET = trabalho do dia a dia (explicar código, corrigir bug pequeno, revisar ou resumir texto, editar um arquivo).',
  'OPUS = tarefa pesada ou arriscada (criar do zero, arquitetura, bug difícil, vários arquivos, banco de dados, permissões, pagamento, publicação).',
  'MANTER = o pedido só continua, aprova ou comenta o trabalho anterior, ou depende do que já foi conversado (responda só MANTER).',
].join('\n')

type Dollar = EngineInterface

export const register: Register = (on, options) => {
  // Limites ajustáveis em /config (userConfig do plugin.json).
  const limiteTroca = Number(options.limiteTrocaTokens ?? 1000000)
  const limiteTrocaCerta = Number(options.limiteTrocaCertaTokens ?? 1000000)
  const limiteHaiku = Number(options.limiteHaikuTokens ?? 100000)
  // Gestão de tokens: quando avisar (também em /config).
  const limites: Limites = {
    compactar: Number(options.avisoCompactarTokens ?? 100000),
    novaConversa: Number(options.avisoNovaConversaTokens ?? 200000),
    plano: Number(options.avisoPlanoPercentual ?? 75),
  }
  // A partir de quantos % da janela de 5 h o roteador passa a economizar.
  const limiteApertado = Number(options.pressaoPlanoPercentual ?? 85)
  // Conta de custo da troca de modelo.
  const custo = {
    tetoPalpiteUsd: Number(options.tetoPalpiteUsd ?? 0.3),
    validadeCacheMin: Number(options.validadeCacheMinutos ?? 60),
  }

  // Botão "Models" acima do prompt e o painel lateral.
  registrarModels(on, options)

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'roteador',
      description: 'Liga ou desliga a escolha automática de modelo (Haiku, Sonnet, Opus).',
      argumentHint: 'on | off',
    })
    await $.command.register({
      name: 'models',
      description: 'Abre o painel Models: Haiku, Sonnet e Opus com um resumo de cada um.',
    })
    await $.command.register({
      name: 'custo',
      description: 'Custo da sessão, uso do plano e tokens por modelo (com cache).',
    })
    await $.command.register({
      name: 'decisoes',
      description: 'Diário do roteador: o que ele escolheu e em quais casos você discordou depois.',
    })
    await $.command.register({
      name: 'economia',
      description: 'Situação dos tokens (conversa e plano) e boas práticas para gastar menos.',
    })
    // Conversa nova: o histórico de assunto e de compactações recomeça.
    memoria.recentes = []
    memoria.assunto = 'mesmo'
    memoria.compactacoes = 0
    memoria.ultimoContexto = undefined
    const salvo = await $.store.get(CHAVE_STORE_ATIVO)
    await update($, ativo, () => salvo === true)
    $.ui.status(salvo === true ? 'roteador: ligado' : undefined)
    return next(e)
  })

  on('command.run', { command: 'roteador' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'on' || arg === 'off') {
      const ligar = arg === 'on'
      await update($, ativo, () => ligar)
      await $.store.set(CHAVE_STORE_ATIVO, ligar)
      $.ui.status(ligar ? 'roteador: ligado' : undefined)
      return {
        text: ligar
          ? `Roteador ligado. Cada mensagem vai para Haiku, Sonnet ou Opus. Troca de modelo: por palavra-chave até ${milhar(limiteTrocaCerta)} tokens de conversa; por palpite do Haiku, até ${milhar(limiteTroca)}; Haiku só no começo da conversa.`
          : 'Roteador desligado. O modelo da sessão volta a responder tudo.',
      }
    }
    const ligado = await read($, ativo)
    const ultima = await read($, decisao)
    const detalhe = ligado && ultima ? ` Última decisão: ${ultima.modelo}${ultima.esforco ? ` · ${ultima.esforco}` : ''} · ${ultima.motivo}.` : ''
    return { text: `Roteador ${ligado ? 'ligado' : 'desligado'}. Use /roteador on ou /roteador off.${detalhe}` }
  })

  on('command.run', { command: 'custo' }, async $ => ({ text: await relatorioCusto($) }))

  on('command.run', { command: 'decisoes' }, async $ => ({ text: resumoDoDiario(await carregarDiario($)) }))

  on('command.run', { command: 'economia' }, async $ => {
    const uso = await $.session.usage()
    const familia = familiaDe((await read($, ultimoModelo)) ?? '')
    const aconselhado = conselhoDaConversa(uso.context.tokens, familia, limites)
    return {
      text: textoEconomia({
        conselho: aconselhado?.detalhe || undefined,
        contexto: uso.context.tokens,
        percentualDaJanela: uso.context.percent,
        plano: (uso.rateLimits ?? []).map(r => ({ nome: nomeDaJanela(r.kind), percentual: r.percentUsed })),
        limites,
      }),
    }
  })

  // Guarda o texto da mensagem que abre o turno (só a conversa principal
  // tem turn.start com o texto digitado).
  on('turn.start', async ($, e, next) => {
    // Só o que a pessoa digitou: seleção do editor e textos colados não classificam.
    const digitado = textoDigitado(e.text)
    await update($, textoTurno, () => ({ turnId: e.turnId, text: digitado }))
    // A mesma pergunta de novo logo depois de uma decisão: pista de que ela não serviu.
    const regs = await carregarDiario($)
    const ultima = regs[regs.length - 1]
    if (ultima && !ultima.corrigido && ultima.turnId !== e.turnId && parecidas(ultima.trecho, trechoDe(digitado))) {
      ultima.corrigido = 'repetiu'
      await salvarDiario($)
    }
    // O assunto continua? Decide entre /compact (mesmo assunto) e /handoff com conversa nova.
    const comecoNovo = pareceAssuntoNovo(normalizar(digitado))
    memoria.assunto = assuntoDaMensagem(memoria.recentes, digitado, comecoNovo) ?? memoria.assunto
    memoria.recentes = [...memoria.recentes, digitado].slice(-6)
    // Conversa já grande e a mensagem parece outro assunto: sugere conversa nova.
    // Vale com o roteador ligado ou não (gestão de tokens não depende dele).
    if (comecoNovo) {
      const tokens = (await $.session.usage()).context.tokens ?? 0
      if (tokens >= MINIMO_PARA_SUGERIR_CONVERSA_NOVA) $.ui.toast(sugestaoDeAssuntoNovo(tokens))
    }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagentes: o roteador não mexe, só contabiliza para o /custo.
    if (e.agentId !== undefined) {
      const resposta = yield* next(e)
      if (resposta.usage) await registrar($, 'subagente', resposta.usage, resposta.usage.model)
      return resposta
    }

    const ligado = await read($, ativo)
    let pedido: TurnStepInput = e
    let motivo = ''
    if (e.index === 0) await notarTrocaManual($, e.model)
    // Quantas requisições cada turno faz: base da previsão de custo do próximo.
    if (memoria.passosDoTurno === null || memoria.passosDoTurno.turnId !== e.turnId) {
      if (memoria.passosDoTurno !== null) memoria.passosRecentes = [...memoria.passosRecentes, memoria.passosDoTurno.n].slice(-10)
      memoria.passosDoTurno = { turnId: e.turnId, n: 0 }
    }
    memoria.passosDoTurno.n++
    if (ligado) {
      const d = await decisaoDoTurno($, e, limiteTroca, limiteTrocaCerta, limiteHaiku, limiteApertado, custo)
      if (e.index === 0) await anotarDecisao($, e.turnId, d)
      motivo = d.motivo
      const esforcoMuda = d.esforco !== undefined && d.esforco !== e.effort
      if (d.modelo !== e.model || esforcoMuda) {
        pedido = { ...e, model: d.modelo, ...(d.esforco !== undefined ? { effort: d.esforco } : {}) }
      }
    }

    const resposta = yield* next(pedido)
    memoria.ultimoPedidoEm = await $.clock.now()

    if (resposta.usage) {
      const respondeu = resposta.usage.model
      await registrar($, 'principal', resposta.usage, respondeu)
      await update($, ultimoModelo, () => respondeu)
    }
    // A linha de status e os avisos de tokens valem com o roteador ligado ou não.
    // O modelo que respondeu de fato, como a API informou.
    const modeloQueRespondeu = resposta.usage?.model ?? pedido.model
    const quem = familiaDe(modeloQueRespondeu) ?? modeloQueRespondeu
    const esforco = pedido.effort !== undefined ? ` · ${pedido.effort}` : ''
    // Contexto = o número do próprio motor (o mesmo do /context e da linha de status
    // dele). NÃO somar entrada + cache da resposta por conta própria: em 15/10 essa
    // soma deu 190.835 numa conversa que o /context media em 134 mil. Saída = o que o
    // modelo escreveu. Atualizados a cada passo do turno.
    const uso = await $.session.usage()
    const conversa = uso.context.tokens
    notarCompactacao(conversa)
    const conselho = conselhoDaConversa(conversa, familiaDe(modeloQueRespondeu), limites)
    // Quanto custa reler a conversa a cada mensagem: o número que mostra se vale compactar.
    const releitura = conselho !== undefined && conselho.porMensagem >= 0.05 ? ` (${usd(conselho.porMensagem)}/msg)` : ''
    const tamanho = conversa !== undefined ? ` · contexto ${milCurto(conversa)}${releitura}` : ''
    const janelas = uso.rateLimits ?? []
    const cinco = janelas.find(r => r.kind === 'five_hour')
    const agora = await $.clock.now()
    const plano = textoDoPlano(janelas, agora, pressaoDoPlano(janelas, agora, limiteApertado))
    const alerta = conselho?.alerta ? ` · ${conselho.alerta}` : ''
    const inicio = ligado ? `on: ${quem}${esforco} · ${motivoCurto(motivo)}` : `off: ${quem}`
    $.ui.status(`${inicio}${tamanho}${plano}${alerta}`)
    await avisar($, conversa, cinco, limites, conselho?.detalhe)
    return resposta
  })}

// Diário de decisões (guardado entre sessões). Lido uma vez e mantido aqui.
const memoria: {
  diario: Registro[] | null
  modeloSessaoVisto: string | undefined
  // Para prever o custo do turno: passos dos últimos turnos e quando foi o último pedido (cache quente?).
  passosRecentes: number[]
  passosDoTurno: { turnId: string; n: number } | null
  ultimoPedidoEm: number | undefined
  // Para aconselhar /compact ou /handoff: as últimas mensagens, se o assunto mudou e quantas vezes a conversa já encolheu.
  recentes: string[]
  assunto: Assunto
  compactacoes: number
  ultimoContexto: number | undefined
} = {
  diario: null,
  modeloSessaoVisto: undefined,
  passosRecentes: [],
  passosDoTurno: null,
  ultimoPedidoEm: undefined,
  recentes: [],
  assunto: 'mesmo',
  compactacoes: 0,
  ultimoContexto: undefined,
}

// O contexto caiu de repente: a conversa foi compactada (ou limpa). Conta para não sugerir
// compactar uma terceira vez, que já perde muito detalhe.
function notarCompactacao(conversa: number | undefined): void {
  if (conversa === undefined) return
  const antes = memoria.ultimoContexto
  memoria.ultimoContexto = conversa
  if (antes !== undefined && antes >= 50000 && conversa < antes * 0.6) memoria.compactacoes++
}

function conselhoDaConversa(conversa: number | undefined, familia: RoteadorFamilia | null, limites: Limites): Conselho | undefined {
  if (conversa === undefined || familia === null) return undefined
  return aconselhar({
    contexto: conversa,
    familia,
    passos: preverTurno(conversa, memoria.passosRecentes, []).passos,
    assunto: memoria.assunto,
    compactacoes: memoria.compactacoes,
    limites,
  })
}

async function carregarDiario($: Dollar): Promise<Registro[]> {
  if (memoria.diario === null) {
    const salvo = await $.store.get(CHAVE_STORE_DIARIO)
    memoria.diario = Array.isArray(salvo) ? (salvo as Registro[]) : []
  }
  return memoria.diario
}

async function salvarDiario($: Dollar): Promise<void> {
  await $.store.set(CHAVE_STORE_DIARIO, memoria.diario ?? [])
}

// O modelo da sessão mudou entre dois turnos sem ser pelo roteador: a pessoa discordou da decisão anterior.
// Se o novo modelo é o último que o próprio roteador pediu, não dá para saber quem trocou: não conta.
async function notarTrocaManual($: Dollar, modeloDaSessao: string): Promise<void> {
  const anterior = memoria.modeloSessaoVisto
  memoria.modeloSessaoVisto = modeloDaSessao
  if (anterior === undefined || anterior === modeloDaSessao) return
  if (modeloDaSessao === (await read($, ultimoModelo))) return
  const regs = await carregarDiario($)
  const ultima = regs[regs.length - 1]
  if (ultima && !ultima.corrigido) {
    ultima.corrigido = 'modelo'
    await salvarDiario($)
  }
}

async function anotarDecisao($: Dollar, turnId: string, d: RoteadorDecisao): Promise<void> {
  const regs = await carregarDiario($)
  if (regs.some(r => r.turnId === turnId)) return
  const guardado = await read($, textoTurno)
  const uso = await $.session.usage()
  const cinco = (uso.rateLimits ?? []).find(r => r.kind === 'five_hour')
  regs.push({
    quando: await $.clock.now(),
    turnId,
    trecho: guardado !== null && guardado.turnId === turnId ? trechoDe(guardado.text) : '',
    modelo: d.modelo,
    ...(d.esforco !== undefined ? { esforco: d.esforco } : {}),
    motivo: d.motivo,
    contexto: uso.context.tokens ?? 0,
    ...(cinco ? { plano: cinco.percentUsed } : {}),
  })
  if (regs.length > MAX_DIARIO) regs.splice(0, regs.length - MAX_DIARIO)
  await salvarDiario($)
}

// Avisa (toast) quando a conversa ou o plano sobem de nível; cada nível uma vez só.
async function avisar(
  $: Dollar,
  conversa: number | undefined,
  cinco: { percentUsed: number; resetsAt?: string } | undefined,
  limites: Limites,
  conselho?: string,
): Promise<void> {
  const antes = (await read($, avisos)) ?? SEM_AVISOS
  let depois = antes
  if (conversa !== undefined) {
    const a = avisoDeContexto(antes.contexto, conversa, limites, conselho)
    depois = { ...depois, contexto: a.nivel }
    if (a.texto) $.ui.toast(a.texto)
  }
  if (cinco) {
    const renova = cinco.resetsAt ? duracao(Date.parse(cinco.resetsAt) - (await $.clock.now())) : undefined
    const a = avisoDoPlano(antes.plano, cinco.percentUsed, renova, limites)
    depois = { ...depois, plano: a.nivel }
    if (a.texto) $.ui.toast(a.texto)
  }
  if (depois.contexto !== antes.contexto || depois.plano !== antes.plano) await update($, avisos, () => depois)
}

function nomeDaJanela(kind: string): string {
  return kind === 'five_hour' ? 'janela de 5 h' : kind === 'seven_day' ? 'semana' : kind
}

// Decide uma vez por turno, na primeira requisição; as seguintes repetem.
async function decisaoDoTurno(
  $: Dollar,
  e: TurnStepInput,
  limiteTroca: number,
  limiteTrocaCerta: number,
  limiteHaiku: number,
  limiteApertado: number,
  custo: { tetoPalpiteUsd: number; validadeCacheMin: number },
): Promise<RoteadorDecisao> {
  const atual = await read($, decisao)
  if (atual !== null && atual.turnId === e.turnId) return atual

  let nova: RoteadorDecisao
  if (e.index > 0) {
    // O turno começou sem decisão (o mod recarregou no meio dele): não troca.
    nova = { turnId: e.turnId, modelo: e.model, motivo: 'turno já em andamento' }
  } else {
    const guardado = await read($, textoTurno)
    const texto = guardado !== null && guardado.turnId === e.turnId ? guardado.text : ''
    const contexto = (await $.session.usage()).context.tokens ?? 0
    const modeloAtual = (await read($, ultimoModelo)) ?? e.model

    let c: Classificacao = classificarPorRegras(texto)
    if (c.familia === 'indefinido') {
      // Acima do limite de troca o modelo não muda: não vale gastar a chamada.
      c = contexto > limiteTroca
        ? { familia: 'manter', motivo: `mantido (cache): regras indecisas e conversa de ${milhar(contexto)} tokens (limite do palpite ${milhar(limiteTroca)})` }
        : await classificarComHaiku($, texto)
    }
    const familia: RoteadorFamilia | 'manter' = c.familia === 'indefinido' ? 'sonnet' : c.familia
    const esforco = 'esforco' in c ? c.esforco : undefined
    const certa = 'certa' in c ? c.certa : false
    const restrita = aplicarRestricoes(
      familia,
      c.motivo,
      { contextoTokens: contexto, limiteTroca, limiteTrocaCerta, limiteHaiku, modeloAtual },
      esforco,
      certa,
    )
    // Vale o custo da troca? Cache por modelo: trocar regrava a conversa; ficar só relê.
    const efetiva = await avaliarCusto($, restrita, modeloAtual, contexto, certa, custo)
    // O plano pesa por último: com o limite perto, não sobe para o Opus nem pensa fundo à toa.
    const janelas = (await $.session.usage()).rateLimits ?? []
    const final = aplicarPressao(efetiva, pressaoDoPlano(janelas, await $.clock.now(), limiteApertado), modeloAtual)
    nova = {
      turnId: e.turnId,
      modelo: final.modelo,
      motivo: final.motivo,
      ...(final.esforco !== undefined ? { esforco: final.esforco } : {}),
    }
  }
  await update($, decisao, () => nova)
  return nova
}

// Compara o custo do turno ficando no modelo atual com o de trocar (ver custo.ts). Troca que não
// se paga volta ao modelo atual (e ao esforço dele); a que se paga leva o valor da conta no motivo.
async function avaliarCusto(
  $: Dollar,
  escolha: { modelo: string; motivo: string; esforco?: RoteadorEsforco },
  modeloAtual: string,
  contexto: number,
  certa: boolean,
  custo: { tetoPalpiteUsd: number; validadeCacheMin: number },
): Promise<{ modelo: string; motivo: string; esforco?: RoteadorEsforco }> {
  const de = familiaDe(modeloAtual)
  const para = familiaDe(escolha.modelo)
  if (de === null || para === null || de === para) return escolha
  const saidas = ((await read($, requisicoes)) ?? []).filter(r => r.origem === 'principal').slice(-20).map(r => r.saida)
  const agora = await $.clock.now()
  const quente = memoria.ultimoPedidoEm !== undefined && agora - memoria.ultimoPedidoEm <= custo.validadeCacheMin * 60000
  const av = avaliarTroca(de, para, preverTurno(contexto, memoria.passosRecentes, saidas), {
    cacheQuente: quente,
    certa,
    tetoPalpiteUsd: custo.tetoPalpiteUsd,
  })
  const motivo = av.motivo ? `${escolha.motivo}; ${av.motivo}` : escolha.motivo
  return av.trocar ? { ...escolha, motivo } : { modelo: modeloAtual, motivo }
}

// A chamada curta ao Haiku quando as regras não decidem. O custo é o que o
// livro de custos da sessão subiu com ela; os tokens vão sempre para o /custo.
async function classificarComHaiku($: Dollar, texto: string): Promise<Classificacao> {
  const antes = (await $.session.usage()).cost?.usd
  const r = await $.model.complete({
    model: MODELOS.haiku,
    system: SISTEMA_CLASSIFICADOR,
    prompt: texto.slice(0, 4000),
    maxTokens: 16,
    effort: 'low',
    timeoutMs: 8000,
  })
  const depois = (await $.session.usage()).cost?.usd
  const delta = antes !== undefined && depois !== undefined ? depois - antes : undefined
  const usd = delta !== undefined && delta > 0 ? delta : undefined

  await registrar($, 'classificador', r.usage, MODELOS.haiku, usd)
  const custo = usd !== undefined ? `US$ ${usd.toFixed(5)}` : 'custo não lançado na sessão'
  $.ui.toast(
    `roteador: classificação pelo Haiku custou ${custo} (${r.usage.input_tokens} tokens de entrada, ${r.usage.output_tokens} de saída)`,
  )

  if (!r.isAnswered) return { familia: 'sonnet', esforco: 'medium', motivo: `Haiku não classificou (${r.reason}): Sonnet`, certa: false }
  const lido = lerRespostaClassificador(r.text)
  if (lido.familia === 'manter') return { familia: 'manter', motivo: `Haiku: continua o trabalho anterior (${custo})` }
  return { familia: lido.familia, esforco: lido.esforco, motivo: `classificado pelo Haiku (${custo})`, certa: false }
}

async function registrar(
  $: Dollar,
  origem: RoteadorRequisicao['origem'],
  uso: ModelUsage,
  modelo: string,
  usd?: number,
): Promise<void> {
  const quando = await $.clock.now()
  const linha: RoteadorRequisicao = {
    quando,
    origem,
    modelo,
    entrada: uso.input_tokens,
    saida: uso.output_tokens,
    cacheLido: uso.cache_read_input_tokens,
    cacheEscrito: uso.cache_creation_input_tokens,
    ...(usd !== undefined ? { usd } : {}),
  }
  await update($, requisicoes, lista => [...(lista ?? []), linha].slice(-MAX_REGISTROS))
}

async function relatorioCusto($: Dollar): Promise<string> {
  const uso = await $.session.usage()
  const agora = await $.clock.now()
  const lista = await read($, requisicoes)
  const linhas: string[] = []

  linhas.push(`**Custo da sessão:** ${uso.cost ? `US$ ${uso.cost.usd.toFixed(4)}` : 'não disponível'}`)

  if (uso.rateLimits.length === 0) {
    linhas.push('**Uso do plano:** sem leitura (uso por chave de API, ou nenhuma resposta ainda)')
  } else {
    const janelas = uso.rateLimits.map(r => {
      const nome = r.kind === 'five_hour' ? 'janela de 5 h' : r.kind === 'seven_day' ? 'semana' : r.kind
      const renova = r.resetsAt ? `, renova em ${duracao(Date.parse(r.resetsAt) - agora)}` : ''
      return `${nome}: ${r.percentUsed}%${renova}`
    })
    linhas.push(`**Uso do plano:** ${janelas.join(' · ')}`)
  }

  const ctx = uso.context
  linhas.push(
    `**Conversa agora:** ${ctx.tokens !== undefined ? `${milhar(ctx.tokens)} tokens (${ctx.percent ?? 0}% da janela)` : 'sem medida ainda'}`,
  )

  if (lista.length === 0) {
    linhas.push('', 'Nenhuma requisição registrada desde que o roteador carregou.')
    return linhas.join('\n')
  }

  // Totais por modelo.
  const porModelo = new Map<string, { n: number; entrada: number; saida: number; lido: number; escrito: number }>()
  for (const r of lista) {
    const t = porModelo.get(r.modelo) ?? { n: 0, entrada: 0, saida: 0, lido: 0, escrito: 0 }
    t.n += 1
    t.entrada += r.entrada
    t.saida += r.saida
    t.lido += r.cacheLido
    t.escrito += r.cacheEscrito
    porModelo.set(r.modelo, t)
  }
  linhas.push('', '**Tokens por modelo**', '', '| Modelo | Requisições | Entrada | Saída | Cache lido | Cache escrito |', '|---|---:|---:|---:|---:|---:|')
  for (const [modelo, t] of porModelo) {
    linhas.push(`| ${modelo} | ${t.n} | ${milhar(t.entrada)} | ${milhar(t.saida)} | ${milhar(t.lido)} | ${milhar(t.escrito)} |`)
  }

  const classificacoes = lista.filter(r => r.origem === 'classificador')
  if (classificacoes.length > 0) {
    const usd = classificacoes.reduce((s, r) => s + (r.usd ?? 0), 0)
    linhas.push('', `**Classificações pelo Haiku:** ${classificacoes.length}, US$ ${usd.toFixed(5)} lançados na sessão`)
  }

  // Cada requisição, agrupada por modelo (as 40 mais recentes).
  const recentes = lista.slice(-40)
  linhas.push('', `**Requisições (${recentes.length} mais recentes de ${lista.length}), por modelo**`)
  for (const modelo of new Set(recentes.map(r => r.modelo))) {
    linhas.push('', `*${modelo}*`, '', '| Origem | Entrada | Saída | Cache lido | Cache escrito |', '|---|---:|---:|---:|---:|')
    for (const r of recentes.filter(x => x.modelo === modelo)) {
      linhas.push(`| ${r.origem} | ${milhar(r.entrada)} | ${milhar(r.saida)} | ${milhar(r.cacheLido)} | ${milhar(r.cacheEscrito)} |`)
    }
  }
  return linhas.join('\n')
}

