// Gestão de tokens do roteador: quando avisar para compactar, abrir conversa nova ou
// poupar o plano, e o texto do /economia. Arquivo puro (sem `$`), testado isoladamente.

export type Limites = {
  compactar: number // conversa a partir daqui: avisar para compactar
  novaConversa: number // conversa a partir daqui: avisar para abrir uma NOVA
  plano: number // % da janela de 5 h a partir da qual avisar (90 % sempre avisa mais forte)
}

export type Nivel = 0 | 1 | 2

// O que já foi avisado, para não repetir o mesmo aviso a cada resposta.
export type Avisos = { contexto: Nivel; plano: Nivel }
export const SEM_AVISOS: Avisos = { contexto: 0, plano: 0 }

// Abaixo disto, "assunto novo" não vale um aviso: a conversa ainda é barata de reler.
export const MINIMO_PARA_SUGERIR_CONVERSA_NOVA = 40000

export function milhar(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}

export function nivelDoContexto(tokens: number, l: Limites): Nivel {
  return tokens >= l.novaConversa ? 2 : tokens >= l.compactar ? 1 : 0
}

export function nivelDoPlano(percentual: number, l: Limites): Nivel {
  return percentual >= 90 ? 2 : percentual >= l.plano ? 1 : 0
}

// Só devolve texto quando o nível SOBE. Se o contexto cai (depois de /compact ou
// numa conversa nova) o nível desce e o aviso volta a valer na próxima subida.
// `conselho`: o texto de conselho.ts (leva em conta o assunto e o custo); sem ele vale o texto genérico.
export function avisoDeContexto(anterior: Nivel, tokens: number, l: Limites, conselho?: string): { nivel: Nivel; texto?: string } {
  const nivel = nivelDoContexto(tokens, l)
  if (nivel <= anterior) return { nivel }
  if (conselho) return { nivel, texto: conselho }
  const texto =
    nivel === 2
      ? `Conversa com ${milhar(tokens)} tokens, grande demais: cada resposta relê tudo. Melhor salvar o estado (/handoff), abrir uma conversa NOVA e continuar de lá. Compactar de novo perde detalhe.`
      : `Conversa com ${milhar(tokens)} tokens. Se a tarefa atual acabou, rode /compact antes da próxima (ou /handoff e conversa nova). Rode /economia para as boas práticas.`
  return { nivel, texto }
}

export function avisoDoPlano(
  anterior: Nivel,
  percentual: number,
  renovaEm: string | undefined,
  l: Limites,
): { nivel: Nivel; texto?: string } {
  const nivel = nivelDoPlano(percentual, l)
  if (nivel <= anterior) return { nivel }
  const renova = renovaEm ? ` Renova em ${renovaEm}.` : ''
  const texto =
    nivel === 2
      ? `Plano: ${percentual}% da janela de 5 h usado.${renova} Perto do limite: deixe só o essencial, use tarefas curtas e considere esperar a renovação.`
      : `Plano: ${percentual}% da janela de 5 h usado.${renova} Prefira tarefas simples (o roteador manda para o Haiku/Sonnet) e evite colar textos longos.`
  return { nivel, texto }
}

// "Agora vamos para…", "outro assunto": o começo de uma conversa nova em outra
// tarefa. É só uma sugestão (um aviso), então prefere errar para menos.
const ASSUNTO_NOVO =
  /^(agora (vamos|eu quero|quero|vamos para|vamos pra|a gente)|outro assunto|outra coisa|mudando de assunto|novo assunto|proxima tarefa|vamos para outra|esquece isso)\b/

export function pareceAssuntoNovo(textoNormalizado: string): boolean {
  return ASSUNTO_NOVO.test(textoNormalizado)
}

export function sugestaoDeAssuntoNovo(tokens: number): string {
  return `Parece assunto novo e a conversa já tem ${milhar(tokens)} tokens. Uma conversa nova (com /handoff para levar o que importa) evita reler tudo isso a cada resposta.`
}

export type DadosDoEconomia = {
  contexto?: number
  percentualDaJanela?: number
  plano: { nome: string; percentual: number }[]
  limites: Limites
  conselho?: string // o que fazer com a conversa agora (conselho.ts), quando há algo a fazer
}

// O /economia: números de agora e as boas práticas, em ordem de quanto poupam.
export function textoEconomia(d: DadosDoEconomia): string {
  const linhas: string[] = []
  const nivel = d.contexto !== undefined ? nivelDoContexto(d.contexto, d.limites) : 0
  const situacao =
    d.contexto === undefined
      ? 'sem medida ainda'
      : `${milhar(d.contexto)} tokens${d.percentualDaJanela !== undefined ? ` (${d.percentualDaJanela}% da janela)` : ''}`
  const veredito =
    nivel === 2
      ? 'grande demais: abra uma conversa nova'
      : nivel === 1
        ? 'hora de compactar quando acabar a tarefa'
        : 'leve'
  linhas.push(`**Conversa agora:** ${situacao} — ${veredito}`)
  if (d.conselho) linhas.push(`**O que fazer:** ${d.conselho.replace(/^Conversa com [\d.]+ tokens: /, '')}`)
  linhas.push(
    d.plano.length > 0
      ? `**Plano:** ${d.plano.map(p => `${p.nome} ${p.percentual}%`).join(' · ')}`
      : '**Plano:** sem leitura (uso por chave de API, ou nenhuma resposta ainda)',
  )
  linhas.push(
    `**Avisos:** compactar a partir de ${milhar(d.limites.compactar)} tokens · conversa nova a partir de ${milhar(d.limites.novaConversa)} · plano a partir de ${d.limites.plano}% (ajustáveis nas configurações do plugin)`,
  )
  linhas.push(
    '',
    '**Boas práticas, das que mais poupam para as que menos poupam**',
    '',
    '1. **Uma tarefa por conversa.** Terminou? `/handoff` para levar o que importa e abra uma conversa nova. A conversa inteira é relida a cada resposta, então conversa longa custa mais a cada mensagem.',
    '2. **`/compact` entre tarefas, não no meio.** E diga o que manter: `/compact mantenha decisões, arquivos mexidos e próximos passos`.',
    '3. **Não cole texto longo.** Cole só o trecho que falhou, não o log inteiro. Mensagem acima de 1.200 caracteres vai para o Opus.',
    '4. **Arquivo grande: peça só a parte.** Em vez de "leia o ESTADO.md", diga "leia a seção 3 do ESTADO.md".',
    '5. **Deixe o roteador ligado.** Pergunta simples vai para o Haiku; só o que é pesado ou sensível (banco, pagamento, deploy) vai para o Opus.',
    '6. **Mensagens curtas de aprovação continuam o trabalho.** "pode seguir" não troca de modelo nem reclassifica.',
    '7. **Subagentes têm contexto próprio.** Servem para pesquisa ampla, mas cada um gasta o seu: veja em `/custo`.',
  )
  return linhas.join('\n')
}

// A linha de status é estreita: o motivo vai resumido (o texto inteiro fica no /roteador e no /decisoes).
export function motivoCurto(motivo: string): string {
  const [principal = '', ...extras] = motivo.split(';')
  const limpar = (t: string): string => {
    let x = t.replace(/\s*\((US\$|palavra-chave|\d)[^)]*\)/g, '').trim()
    if (x.startsWith('mantido (cache)')) return 'mantido (cache)'
    if (x.startsWith('mantido (custo)')) return 'mantido (custo)'
    if (x.includes('Haiku vetado')) return 'Haiku vetado'
    if (x.startsWith('classificado pelo Haiku')) return 'Haiku classificou'
    const corte = x.indexOf(':')
    if (x.startsWith('plano apertado: Opus')) return 'Opus → Sonnet'
    if (x.startsWith('plano ')) return '' // a linha já diz "economizando"
    if (corte > 0 && x.startsWith('assunto sensível')) x = x.slice(0, corte)
    return x
  }
  return [limpar(principal), ...extras.map(e => limpar(e.trim()))].filter(Boolean).join(', ')
}

// 62.294 → "62 mil"
export function milCurto(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)} mil` : String(n)
}
