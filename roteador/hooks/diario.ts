// Diário de decisões: o que o roteador escolheu e se a pessoa discordou depois.
// Arquivo puro (sem `$`), testado isoladamente.

export type Correcao = 'modelo' | 'repetiu'

export type Registro = {
  quando: number
  turnId: string
  trecho: string // só o começo da mensagem; fica no computador, no armazenamento do plugin
  modelo: string
  esforco?: string
  motivo: string
  contexto: number
  plano?: number
  corrigido?: Correcao
}

export const MAX_DIARIO = 500
const MINIMO_PARA_CONCLUIR = 20

export function trechoDe(texto: string): string {
  return texto.replace(/\s+/g, ' ').trim().slice(0, 50)
}

export function palavras(t: string): Set<string> {
  const limpo = t
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9 ]/g, ' ')
  return new Set(limpo.split(/\s+/).filter(p => p.length >= 4))
}

// A mesma pergunta de novo (quase): pista de que a resposta anterior não serviu.
export function parecidas(a: string, b: string): boolean {
  const x = palavras(a)
  const y = palavras(b)
  if (x.size < 3 || y.size < 3) return false
  let comuns = 0
  for (const p of x) if (y.has(p)) comuns++
  return comuns / (x.size + y.size - comuns) >= 0.6
}

// O motivo muda de número em número; agrupar pelo texto sem dígitos.
export function categoriaDoMotivo(motivo: string): string {
  return motivo.replace(/\d[\d.,]*/g, '#').split(';')[0]!.slice(0, 60)
}

function nomeCurto(modelo: string): string {
  return modelo.replace(/^claude-/, '').replace(/-\d+(-\d+)*$/, '')
}

export function resumoDoDiario(regs: Registro[]): string {
  if (regs.length === 0) return 'Diário vazio: ainda não há decisões registradas (o roteador precisa estar ligado).'
  const corrigidas = regs.filter(r => r.corrigido)
  const pct = Math.round((corrigidas.length / regs.length) * 100)
  const porModelo = new Map<string, { n: number; c: number }>()
  const porCategoria = new Map<string, { n: number; c: number }>()
  for (const r of regs) {
    for (const [mapa, chave] of [
      [porModelo, nomeCurto(r.modelo)],
      [porCategoria, categoriaDoMotivo(r.motivo)],
    ] as const) {
      const v = mapa.get(chave) ?? { n: 0, c: 0 }
      v.n++
      if (r.corrigido) v.c++
      mapa.set(chave, v)
    }
  }
  const trocou = corrigidas.filter(r => r.corrigido === 'modelo').length
  const repetiu = corrigidas.filter(r => r.corrigido === 'repetiu').length
  const linhas: string[] = [
    `**Decisões registradas:** ${regs.length} · **discordou depois:** ${corrigidas.length} (${pct}%) — trocou de modelo ${trocou}, repetiu a pergunta ${repetiu}`,
    '',
    '**Por modelo escolhido**',
    ...[...porModelo].map(([k, v]) => `- ${k}: ${v.n} decisões, ${v.c} com discordância`),
  ]
  const piores = [...porCategoria]
    .filter(([, v]) => v.c > 0)
    .sort((a, b) => b[1].c - a[1].c || b[1].n - a[1].n)
    .slice(0, 5)
  if (piores.length > 0) {
    linhas.push('', '**Motivos que mais geraram discordância**', ...piores.map(([k, v]) => `- ${k}: ${v.c} de ${v.n}`))
  }
  const ultimas = corrigidas.slice(-5).reverse()
  if (ultimas.length > 0) {
    linhas.push(
      '',
      '**Últimas discordâncias**',
      ...ultimas.map(
        r => `- "${r.trecho}" → ${nomeCurto(r.modelo)} (${r.corrigido === 'modelo' ? 'você trocou o modelo' : 'você repetiu'}) · ${r.motivo}`,
      ),
    )
  }
  linhas.push(
    '',
    regs.length < MINIMO_PARA_CONCLUIR
      ? `Poucos dados (${regs.length} de ${MINIMO_PARA_CONCLUIR}): espere antes de mudar qualquer regra.`
      : 'Leia como pista, não como veredito: repetir a pergunta ou trocar de modelo sugere que o roteador errou, mas não prova.',
  )
  return linhas.join('\n')
}
