// Conversa grande: compactar, abrir conversa nova (/handoff) ou seguir? A resposta depende de
// o assunto ter mudado e de quanto custa reler a conversa a cada mensagem, não só do tamanho.
// Arquivo puro (sem `$`), testado isoladamente.

import type { RoteadorFamilia } from '../types'
import { precoDe, usd } from './custo'
import { palavras } from './diario'
import { milhar, nivelDoContexto, type Limites } from './economia'

// Tamanho aproximado da conversa logo depois do /compact (prompt do sistema + ferramentas + resumo)
// e o tamanho do resumo que o modelo escreve. Estimativas: o valor real varia.
const CONTEXTO_APOS_COMPACTAR = 30000
const RESUMO_TOKENS = 5000
// Compactar a terceira vez em diante já perde muito detalhe: melhor levar o estado para uma conversa nova.
const COMPACTACOES_ANTES_DE_HANDOFF = 2
// Abaixo disto a economia por mensagem não vale mencionar.
const MINIMO_POR_MENSAGEM_USD = 0.005

export type Assunto = 'mesmo' | 'novo'
export type Acao = 'nada' | 'compactar' | 'handoff'

// A mensagem de agora continua o assunto das anteriores? `undefined`: curta ou sem base para saber
// (então o roteador mantém o que já achava). Erra para "mesmo": sugerir conversa nova à toa irrita
// mais que deixar de sugerir.
export function assuntoDaMensagem(anteriores: string[], atual: string, comecoDeOutroAssunto: boolean): Assunto | undefined {
  if (comecoDeOutroAssunto) return 'novo'
  const agora = palavras(atual)
  if (agora.size < 4) return undefined
  const antes = new Set<string>()
  for (const t of anteriores) for (const p of palavras(t)) antes.add(p)
  if (antes.size < 4) return undefined
  let comuns = 0
  for (const p of agora) if (antes.has(p)) comuns++
  return comuns / agora.size < 0.1 ? 'novo' : 'mesmo'
}

// US$ que cada mensagem gasta só para rereler a conversa (cache quente), contando as requisições do turno.
export function custoDeReler(familia: RoteadorFamilia, contexto: number, passos: number): number {
  return (passos * contexto * precoDe(familia, contexto).leitura) / 1e6
}

// US$ do /compact, uma vez: o modelo relê a conversa, escreve o resumo e a conversa nova é gravada no cache.
export function custoDeCompactar(familia: RoteadorFamilia, contexto: number): number {
  const c = precoDe(familia, contexto)
  const depois = precoDe(familia, CONTEXTO_APOS_COMPACTAR)
  return (contexto * c.leitura + RESUMO_TOKENS * c.saida + CONTEXTO_APOS_COMPACTAR * depois.escrita) / 1e6
}

export type Conselho = {
  acao: Acao
  alerta: string // curto, para a linha de status
  detalhe: string // completo, para o aviso e o /economia
  porMensagem: number // US$ por mensagem só relendo a conversa
}

export type EntradaDoConselho = {
  contexto: number
  familia: RoteadorFamilia
  passos: number
  assunto: Assunto
  compactacoes: number
  limites: Limites
}

export function aconselhar(d: EntradaDoConselho): Conselho {
  const porMensagem = custoDeReler(d.familia, d.contexto, d.passos)
  if (nivelDoContexto(d.contexto, d.limites) === 0) return { acao: 'nada', alerta: '', detalhe: '', porMensagem }

  const poupa = porMensagem - custoDeReler(d.familia, CONTEXTO_APOS_COMPACTAR, d.passos)
  const custa = custoDeCompactar(d.familia, d.contexto)
  const paga = poupa > 0 ? Math.max(1, Math.ceil(custa / poupa)) : undefined
  const situacao = `Conversa com ${milhar(d.contexto)} tokens: cada mensagem gasta ~${usd(porMensagem)} só para reler tudo.`
  const poupanca =
    poupa >= MINIMO_POR_MENSAGEM_USD && paga !== undefined
      ? ` Compactar custa ~${usd(custa)} uma vez e poupa ~${usd(poupa)} por mensagem (se paga em ${paga === 1 ? '1 mensagem' : `${paga} mensagens`}).`
      : ''
  const poupaCurto = poupa >= MINIMO_POR_MENSAGEM_USD ? ` · poupa ${usd(poupa)}/msg` : ''

  if (d.assunto === 'novo') {
    return {
      acao: 'handoff',
      alerta: `⚠ assunto novo: /handoff e conversa nova${poupaCurto}`,
      detalhe: `${situacao} O assunto mudou: rode /handoff para levar só o que importa e abra uma conversa nova.${poupanca}`,
      porMensagem,
    }
  }
  if (d.compactacoes >= COMPACTACOES_ANTES_DE_HANDOFF) {
    return {
      acao: 'handoff',
      alerta: `⚠ já compactou ${d.compactacoes}×: /handoff e conversa nova${poupaCurto}`,
      detalhe: `${situacao} Esta conversa já foi compactada ${d.compactacoes} vezes e cada compactação perde detalhe: rode /handoff e continue numa conversa nova.${poupanca}`,
      porMensagem,
    }
  }
  return {
    acao: 'compactar',
    alerta: `⚠ /compact${poupaCurto}`,
    detalhe: `${situacao} Mesmo assunto, então compacte em vez de abrir outra conversa: /compact mantenha decisões, arquivos mexidos e próximos passos.${poupanca}`,
    porMensagem,
  }
}
