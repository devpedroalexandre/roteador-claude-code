// O plano (janelas de 5 h e semanal) entra na decisão: ritmo de gasto, pressão e o
// texto da linha de status. Arquivo puro (sem `$`), testado isoladamente.

import type { RoteadorEsforco } from '../types'
import { MODELOS, familiaDe, limitarEsforco, type Escolha } from './classificar'

export type Janela = { kind: string; percentUsed: number; resetsAt?: string }
export type Pressao = 'folga' | 'normal' | 'apertado'

const HORA = 3600000
const DURACAO_DA_JANELA: Record<string, number> = { five_hour: 5 * HORA, seven_day: 168 * HORA }
// Antes disto a janela é nova demais: o ritmo oscila muito para valer uma previsão.
const MINIMO_PARA_RITMO_MS = 10 * 60000

export function duracao(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return 'instantes'
  const min = Math.round(ms / 60000)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  if (h < 48) return `${h} h ${min % 60} min`
  return `${Math.round(h / 24)} dias`
}

export type Ritmo = {
  restanteMs: number
  // Quanto falta, no ritmo de agora, para chegar a 100 %. Ausente com 0 % usado ou janela nova.
  ateEncherMs?: number
  encheAntesDeRenovar: boolean
}

export function ritmoDaJanela(j: Janela, agora: number): Ritmo | undefined {
  const total = DURACAO_DA_JANELA[j.kind]
  if (total === undefined || j.resetsAt === undefined) return undefined
  const restanteMs = Date.parse(j.resetsAt) - agora
  if (!Number.isFinite(restanteMs) || restanteMs <= 0) return undefined
  const decorrido = total - restanteMs
  if (decorrido < MINIMO_PARA_RITMO_MS || j.percentUsed <= 0) return { restanteMs, encheAntesDeRenovar: false }
  const ateEncherMs = ((100 - j.percentUsed) / j.percentUsed) * decorrido
  return { restanteMs, ateEncherMs, encheAntesDeRenovar: ateEncherMs < restanteMs }
}

// Apertado: perto do limite com muito tempo pela frente, ou no ritmo de estourar antes de renovar.
// Folga: a janela de 5 h está acabando com sobra, e o que sobra se perde.
export function pressaoDoPlano(janelas: Janela[], agora: number, limiteApertado = 85): Pressao {
  const cinco = janelas.find(j => j.kind === 'five_hour')
  const semana = janelas.find(j => j.kind === 'seven_day')
  if (semana && semana.percentUsed >= 90) return 'apertado'
  if (cinco) {
    const r = ritmoDaJanela(cinco, agora)
    if (r && r.restanteMs > 30 * 60000) {
      if (cinco.percentUsed >= limiteApertado) return 'apertado'
      if (cinco.percentUsed >= 60 && r.encheAntesDeRenovar) return 'apertado'
    }
    if (r && r.restanteMs <= 20 * 60000 && cinco.percentUsed < 80) return 'folga'
  }
  return 'normal'
}

function umDegrauAbaixo(e: RoteadorEsforco): RoteadorEsforco {
  return e === 'xhigh' ? 'high' : e === 'high' ? 'medium' : e
}

// Aplica a pressão do plano sobre a escolha já restringida pelo cache. O esforço só
// muda quando a escolha já traz um (em conversa grande ele fica como está, por causa do cache).
// Assunto sensível nunca desce de modelo: erro em banco/dinheiro/publicação custa mais que o plano.
export function aplicarPressao(escolha: Escolha, pressao: Pressao, modeloAtual: string | null): Escolha {
  if (pressao === 'normal') return escolha
  const familia = familiaDe(escolha.modelo)
  if (pressao === 'folga') {
    if (familia === null || familia === 'haiku' || escolha.esforco !== 'medium') return escolha
    return { ...escolha, esforco: 'high', motivo: `${escolha.motivo}; plano com folga: esforço sobe` }
  }
  const sensivel = escolha.motivo.includes('sensível')
  if (familia === 'opus' && !sensivel && familiaDe(modeloAtual) !== 'opus') {
    return {
      modelo: MODELOS.sonnet,
      motivo: `${escolha.motivo}; plano apertado: Opus → Sonnet`,
      ...(escolha.esforco !== undefined ? { esforco: limitarEsforco('sonnet', escolha.esforco) } : {}),
    }
  }
  if (escolha.esforco !== undefined && umDegrauAbaixo(escolha.esforco) !== escolha.esforco) {
    return { ...escolha, esforco: umDegrauAbaixo(escolha.esforco), motivo: `${escolha.motivo}; plano apertado: esforço desce` }
  }
  return escolha
}

// "plano 5 h 62% · renova em 2 h 14 min · ⚠ acaba em 1 h 20 min" e a semana, sempre que o plano informa.
export function textoDoPlano(janelas: Janela[], agora: number, pressao: Pressao): string {
  const cinco = janelas.find(j => j.kind === 'five_hour')
  const semana = janelas.find(j => j.kind === 'seven_day')
  let t = ''
  if (cinco) {
    t += ` · plano 5 h ${cinco.percentUsed}%`
    const r = ritmoDaJanela(cinco, agora)
    if (r) t += ` · renova em ${duracao(r.restanteMs)}`
    if (r?.encheAntesDeRenovar && r.ateEncherMs !== undefined) t += ` · ⚠ acaba em ${duracao(r.ateEncherMs)}`
  }
  if (semana) {
    const r = ritmoDaJanela(semana, agora)
    t += ` · semana ${semana.percentUsed}%${r ? ` (renova em ${duracao(r.restanteMs)})` : ''}`
  }
  if (pressao === 'apertado') t += ' · economizando'
  return t
}
