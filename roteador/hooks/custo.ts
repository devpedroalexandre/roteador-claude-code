// Vale a pena trocar de modelo? Compara o custo de ficar com o de trocar, em dólares da API.
// Arquivo puro (sem `$`), testado isoladamente.
//
// Por que existe: o cache é POR MODELO. Trocar regrava a conversa inteira no cache do modelo
// novo (preço de escrita), enquanto ficar só relê o cache quente (preço de leitura). Mas o
// modelo mais barato também gasta menos por resposta, então em turno longo a troca se paga.
// Em vez de um limite fixo de tokens, o roteador faz essa conta a cada mensagem.

import type { RoteadorFamilia } from '../types'

// US$ por milhão de tokens. Entrada, saída e leitura de cache do Opus 5.5 / Sonnet 5.5 / Haiku 5.5
// vêm da tabela de preços da API (15/10/2026). Escrita de cache = 1,25 × entrada e leitura do Haiku =
// 0,1 × entrada são os múltiplos padrão, ainda não conferidos para estes modelos.
type Preco = { entrada: number; saida: number; escrita: number; leitura: number }

const PRECOS: Record<RoteadorFamilia, Preco> = {
  haiku: { entrada: 0.1, saida: 0.5, escrita: 0.125, leitura: 0.01 },
  sonnet: { entrada: 2, saida: 10, escrita: 2.5, leitura: 0.2 },
  opus: { entrada: 4, saida: 20, escrita: 5, leitura: 0.2 },
}
// O Haiku cobra mais caro quando a conversa passa de 100 mil tokens.
const HAIKU_GRANDE: Preco = { entrada: 0.5, saida: 2.5, escrita: 0.625, leitura: 0.05 }
const LIMITE_PRECO_HAIKU = 100000

const ORDEM: RoteadorFamilia[] = ['haiku', 'sonnet', 'opus']

export function precoDe(familia: RoteadorFamilia, contexto: number): Preco {
  return familia === 'haiku' && contexto > LIMITE_PRECO_HAIKU ? HAIKU_GRANDE : PRECOS[familia]
}

export type Previsao = {
  contexto: number // tokens da conversa agora
  passos: number // requisições que este turno deve fazer
  saidaPorPasso: number // tokens que o modelo escreve em cada uma
}

// Custo (US$) do turno inteiro nesse modelo. `cacheQuente`: o cache dele já tem a conversa.
export function custoDoTurno(familia: RoteadorFamilia, p: Previsao, cacheQuente: boolean): number {
  const c = precoDe(familia, p.contexto)
  const primeira = (p.contexto * (cacheQuente ? c.leitura : c.escrita)) / 1e6
  const demais = (Math.max(0, p.passos - 1) * p.contexto * c.leitura) / 1e6
  const saida = (p.passos * p.saidaPorPasso * c.saida) / 1e6
  return primeira + demais + saida
}

export type Avaliacao = { trocar: boolean; diferenca: number; motivo?: string }

export function usd(v: number): string {
  return `US$ ${v.toFixed(v < 0.1 ? 3 : 2).replace('.', ',')}`
}

// `certa`: veio de uma regra (palavra-chave, assunto sensível, mensagem longa), não de palpite.
// Subir de modelo por qualidade vale sempre que a regra manda; por palpite, só até `tetoPalpiteUsd` a mais.
// Descer de modelo só vale se o turno inteiro sai mais barato (ou igual).
export function avaliarTroca(
  atual: RoteadorFamilia,
  desejada: RoteadorFamilia,
  p: Previsao,
  opcoes: { cacheQuente: boolean; certa: boolean; tetoPalpiteUsd: number },
): Avaliacao {
  if (atual === desejada) return { trocar: false, diferenca: 0 }
  const ficar = custoDoTurno(atual, p, opcoes.cacheQuente)
  const trocar = custoDoTurno(desejada, p, false)
  const diferenca = trocar - ficar // negativo: a troca poupa
  const sobe = ORDEM.indexOf(desejada) > ORDEM.indexOf(atual)
  if (sobe) {
    if (opcoes.certa || diferenca <= opcoes.tetoPalpiteUsd) {
      return { trocar: true, diferenca, motivo: diferenca > 0 ? `troca custa +${usd(diferenca)}` : undefined }
    }
    return { trocar: false, diferenca, motivo: `mantido (custo): subir custaria +${usd(diferenca)} por um palpite` }
  }
  if (diferenca <= 0) return { trocar: true, diferenca, motivo: `poupa ${usd(-diferenca)}` }
  return { trocar: false, diferenca, motivo: `mantido (custo): trocar custaria +${usd(diferenca)} neste turno` }
}

function mediana(xs: number[]): number | undefined {
  if (xs.length === 0) return undefined
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)]
}

// Previsão do próximo turno a partir dos últimos: passos por turno e saída por requisição (medianas).
export function preverTurno(contexto: number, passosRecentes: number[], saidasRecentes: number[]): Previsao {
  return {
    contexto,
    passos: Math.max(1, Math.round(mediana(passosRecentes) ?? 6)),
    saidaPorPasso: Math.max(50, Math.round(mediana(saidasRecentes) ?? 600)),
  }
}
