// Regras do roteador: escolher Haiku, Sonnet ou Opus pela mensagem, sem
// gastar tokens. Arquivo puro (sem `$`), para ser testado isoladamente.

import type { RoteadorEsforco, RoteadorFamilia } from '../types'

export const MODELOS: Record<RoteadorFamilia, string> = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
}

// Tamanhos da mensagem, em caracteres.
export const TAMANHO_CURTA = 160 // até aqui uma tarefa simples cabe no Haiku
export const TAMANHO_LONGA = 1200 // acima disso é uma especificação: Opus

// Esforço de raciocínio por família: o que cada modelo aceita e o padrão dele.
// Haiku só trabalha em `low`; Sonnet vai até `high`; `xhigh` é do Opus, e
// `max` nunca é escolhido sozinho (caro demais para ser automático).
const ESFORCO_MAXIMO: Record<RoteadorFamilia, RoteadorEsforco> = { haiku: 'low', sonnet: 'high', opus: 'xhigh' }
const ESFORCO_PADRAO: Record<RoteadorFamilia, RoteadorEsforco> = { haiku: 'low', sonnet: 'medium', opus: 'high' }
const ORDEM_ESFORCO: RoteadorEsforco[] = ['low', 'medium', 'high', 'xhigh']

// Nunca pede mais esforço do que o modelo aceita.
export function limitarEsforco(familia: RoteadorFamilia, esforco: RoteadorEsforco): RoteadorEsforco {
  const teto = ESFORCO_MAXIMO[familia]
  return ORDEM_ESFORCO.indexOf(esforco) > ORDEM_ESFORCO.indexOf(teto) ? teto : esforco
}

// `certa`: a escolha veio de uma REGRA (palavra-chave, tamanho), não do palpite do
// Haiku classificador. Só escolha certa troca de modelo em conversa grande (até
// `limiteTrocaCerta`): regravar o cache inteiro só compensa quando se sabe para quê.
export type Classificacao =
  | { familia: RoteadorFamilia; esforco: RoteadorEsforco; motivo: string; certa: boolean }
  | { familia: 'manter'; motivo: string }
  | { familia: 'indefinido'; motivo: string }

// O que a pessoa DIGITOU. O editor anexa à mensagem o trecho de código selecionado
// (<ide_selection>), o arquivo aberto, textos colados (<pasted_content>) e avisos do
// sistema; se entrarem na classificação, um SQL selecionado com "migration" e "RLS"
// faz "leia este arquivo" virar "tarefa pesada" e mandar a mensagem ao Opus.
const BLOCOS_ANEXADOS = ['ide_selection', 'ide_opened_file', 'pasted_content', 'system-reminder', 'local-command-stdout', 'local-command-caveat']

export function textoDigitado(texto: string): string {
  let t = texto
  for (const tag of BLOCOS_ANEXADOS) {
    // Bloco fechado (o fechamento pode repetir atributos, como o id do colado) ...
    t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*?</${tag}\\b[^>]*>`, 'g'), ' ')
    // ... e bloco aberto sem fechamento: vale até o fim do texto.
    t = t.replace(new RegExp(`<${tag}\\b[^>]*>[\\s\\S]*$`), ' ')
  }
  return t.trim()
}

// Minúsculas e sem acentos: "Explique" e "explíque" casam igual.
export function normalizar(texto: string): string {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
}

// Tarefas pesadas: criar do zero, arquitetura, bug difícil, muitos arquivos.
const PESADAS: RegExp[] = [
  /\bdo zero\b/,
  /\b(cri[ae]r?|construa|construir|desenvolva|desenvolver|monte|montar)\s+(um|uma|o|a|meu|minha|nosso|nossa)?\s*(novo\s+|nova\s+)?(site|app|aplicativo|sistema|plataforma|api|saas|jogo|projeto)\b/,
  /\barquitetura\b/,
  /\bplanej/,
  /\binvestig/,
  /\bbug\b.{0,20}\b(dificil|complexo|intermitente|estranho|misterioso)\b/,
  /\bcausa raiz\b/,
  /\b(varios|muitos|todos os) arquivos\b/,
  /\bprojeto inteiro\b/,
  /\b(concorrencia|race condition|deadlock|condicao de corrida)\b/,
  /\brefator/,
  /\bmigr(ar|acao|acoes|ation|ations)\b/,
  /\bauditori/,
]

// Assuntos SENSÍVEIS: banco, permissão, dinheiro, publicação. Um erro aqui custa
// caro (no Reservou, um furo de RLS numa migration foi pego só pelo teste), então
// vão ao Opus mesmo quando a frase parece simples ("qual o valor da caução?").
const SENSIVEIS: RegExp[] = [
  /\b(rls|row level security|policy|politica de seguranca|grant|revoke)\b/,
  /\bsupabase\b/,
  /\b(caucao|pagamento|stripe|mercado pago|cobranca|estorno|reembolso)/,
  /\b(deploy|producao|publicar no ar|push)\b/,
  /\bsql\b/,
]

// Dentro das pesadas, as que pedem raciocínio MÁXIMO do Opus. Só o que é difícil
// por natureza: arquitetura, causa raiz, bug difícil, concorrência. Investigar,
// auditar e migrar ficam em `high` — `xhigh` é caro para ser o padrão deles.
const EXTREMAS: RegExp[] = [
  /\barquitetura\b/,
  /\bcausa raiz\b/,
  /\bbug\b.{0,20}\b(dificil|complexo|intermitente|estranho|misterioso)\b/,
  /\b(concorrencia|race condition|deadlock|condicao de corrida)\b/,
]

// Dia a dia que mexe em defeito: vale pensar mais que num ajuste comum.
const DEFEITO: RegExp[] = [/\b(corrij|corrig|consert)/, /\bbug\b/, /\berro\b/]

// Tarefas simples e rápidas.
const SIMPLES: RegExp[] = [
  /^(liste|listar|lista|mostre|mostrar|qual|quais|quanto|quantos|quantas|quando|onde|quem)\b/,
  /^(o que e|oque e|o que significa)\b/,
  /\brenome(ie|ar|ia)\b/,
  /\bformat(e|ar|a)\b/,
  /\btraduz/,
  /\b(busque|buscar|procure|procurar|encontre|encontrar|ache|achar)\b/,
]

// Trabalho do dia a dia.
const DIA_A_DIA: RegExp[] = [
  /\bexplic|\bexpliqu/,
  /\b(corrij|corrig|consert)/,
  /\bbug\b/,
  /\berro\b/,
  /\brevis|\brevej|\brevise\b/,
  /\bresum/,
  /\bedit(e|ar|a)\b/,
  /\balter(e|ar|a)\b/,
  /\bajust(e|ar|a)\b/,
  /\bmelhor(e|ar)\b/,
  /\b(adicion|acrescent|inclu)/,
  /\bteste/,
]

// "sim", "pode", "continue": a resposta curta continua o trabalho do turno
// anterior, que pode ser pesado. Mandar isso ao Haiku seria um erro.
const CONTINUACAO = /^(sim|s|ok|okay|pode|pode sim|pode seguir|pode ir|continue|continua|siga|segue|manda|vai|beleza|blz|isso|perfeito|certo|ok pode|fechado|bora)[\s.!]*$/

// Mensagem que COMEÇA aprovando ou mandando seguir ("pode aplicar tudo que achar
// melhor…", "faça do jeito que achar melhor", "segue com as tarefas"): continua o
// trabalho do turno anterior, mesmo sendo longa. Trocar de modelo no meio dele é
// o pior caso — regrava o cache e muda quem está com o raciocínio na cabeça.
// ⚠️ "pode" e "faça" sozinhos NÃO bastam: "pode explicar esse código?" e "faça um
// resumo" são pedidos NOVOS. Só os verbos de aprovação contam.
const INICIO_DE_CONTINUACAO =
  /^(sim|ok|okay|segue|siga|continue|continua|beleza|blz|perfeito|certo|fechado|bora|isso|vai em frente|pode (sim|seguir|ir|continuar|prosseguir|aplicar|fazer|executar|commitar|mandar)|podemos (seguir|continuar|retomar)|faca (do jeito|como|o que) )\b/
const TAMANHO_CONTINUACAO = 600

const casa = (lista: RegExp[], t: string) => lista.some(r => r.test(t))

// Classifica só por regras. "indefinido" pede a chamada curta ao Haiku.
export function classificarPorRegras(texto: string): Classificacao {
  const t = normalizar(texto)
  if (t === '') return { familia: 'manter', motivo: 'turno sem texto' }
  if (t.length <= 30 && CONTINUACAO.test(t)) return { familia: 'manter', motivo: 'continuação curta' }
  const pesada = casa(PESADAS, t) || casa(SENSIVEIS, t)
  // Continuação sem assunto pesado: fica com quem está trabalhando.
  if (!pesada && t.length <= TAMANHO_CONTINUACAO && INICIO_DE_CONTINUACAO.test(t)) {
    return { familia: 'manter', motivo: 'continua o trabalho anterior' }
  }
  if (pesada) {
    if (casa(EXTREMAS, t)) return { familia: 'opus', esforco: 'xhigh', motivo: 'tarefa pesada que pede raciocínio máximo (palavra-chave)', certa: true }
    return casa(PESADAS, t)
      ? { familia: 'opus', esforco: 'high', motivo: 'tarefa pesada (palavra-chave)', certa: true }
      : { familia: 'opus', esforco: 'high', motivo: 'assunto sensível: banco, dinheiro ou publicação (palavra-chave)', certa: true }
  }
  if (t.length > TAMANHO_LONGA) return { familia: 'opus', esforco: 'high', motivo: `mensagem longa (${t.length} caracteres)`, certa: true }
  const diaADia = casa(DIA_A_DIA, t)
  if (!diaADia && t.length <= TAMANHO_CURTA && casa(SIMPLES, t)) {
    return { familia: 'haiku', esforco: 'low', motivo: 'tarefa simples e curta', certa: true }
  }
  if (diaADia) {
    return casa(DEFEITO, t)
      ? { familia: 'sonnet', esforco: 'high', motivo: 'correção de defeito (palavra-chave)', certa: true }
      : { familia: 'sonnet', esforco: 'medium', motivo: 'trabalho do dia a dia (palavra-chave)', certa: true }
  }
  return { familia: 'indefinido', motivo: 'regras não decidiram' }
}

// Família de um id de modelo ("claude-opus-5-5" -> "opus").
export function familiaDe(modelo: string | null | undefined): RoteadorFamilia | null {
  const m = String(modelo ?? '').toLowerCase()
  if (m.includes('haiku')) return 'haiku'
  if (m.includes('sonnet')) return 'sonnet'
  if (m.includes('opus')) return 'opus'
  return null
}

// Resposta do Haiku classificador ("OPUS HIGH", "MANTER") -> família e esforço.
// Ilegível vira Sonnet; esforço ausente ou ilegível vira o padrão da família.
export function lerRespostaClassificador(
  resposta: string,
): { familia: 'manter' } | { familia: RoteadorFamilia; esforco: RoteadorEsforco } {
  const r = normalizar(resposta)
  if (r.includes('manter')) return { familia: 'manter' }
  const familia: RoteadorFamilia = r.includes('opus') ? 'opus' : r.includes('haiku') ? 'haiku' : 'sonnet'
  // "xhigh" antes de "high": um contém o outro.
  const lido: RoteadorEsforco | null = r.includes('xhigh')
    ? 'xhigh'
    : r.includes('high')
      ? 'high'
      : r.includes('medium')
        ? 'medium'
        : r.includes('low')
          ? 'low'
          : null
  return { familia, esforco: limitarEsforco(familia, lido ?? ESFORCO_PADRAO[familia]) }
}

export type Restricoes = {
  contextoTokens: number // tamanho atual da conversa
  limiteTroca: number // acima disto, escolha INCERTA (palpite do Haiku) não troca de modelo
  limiteTrocaCerta?: number // acima disto, nem escolha CERTA (regra) troca; padrão = limiteTroca
  limiteHaiku: number // acima disto a conversa sai do Haiku (contexto grande demais para ele)
  modeloAtual: string // o modelo em uso agora
}

export type Escolha = { modelo: string; motivo: string; esforco?: RoteadorEsforco }

// Aplica as regras de custo à família desejada e devolve o modelo final.
//
// A CONTA (cache é por modelo): trocar regrava a conversa inteira no cache do
// modelo novo; a economia vem de cada requisição seguinte ser mais barata. Paga-se
// em ~20 requisições — um turno com ferramentas, ou alguns turnos leves. Daí:
//   - pergunta curta (Haiku) numa conversa já grande NÃO troca: 1 ou 2 requisições
//     nunca pagam a regravação. Haiku só no começo da conversa (≤ limiteTroca);
//   - escolha CERTA (regra) troca até `limiteTrocaCerta`; escolha incerta, só até
//     `limiteTroca`. Acima, mantém e diz por quê.
// O esforço desejado só vale quando o modelo muda ou a conversa ainda é pequena:
// mantido o modelo numa conversa grande, o esforço também fica como está.
export function aplicarRestricoes(
  desejada: RoteadorFamilia | 'manter',
  motivo: string,
  r: Restricoes,
  esforco?: RoteadorEsforco,
  certa = false,
): Escolha {
  const atual = familiaDe(r.modeloAtual)
  const mil = (n: number) => `${Math.round(n / 1000)} mil`

  // Haiku nunca recebe conversa acima do limite dele.
  const vetarHaiku = r.contextoTokens > r.limiteHaiku
  const vetado = (m: string): Escolha => ({
    modelo: MODELOS.sonnet,
    motivo: `${m}contexto ${mil(r.contextoTokens)} > ${mil(r.limiteHaiku)}: Haiku vetado`,
    esforco: ESFORCO_PADRAO.sonnet,
  })

  if (desejada === 'manter') {
    if (atual === 'haiku' && vetarHaiku) return vetado(`${motivo}; `)
    return { modelo: r.modeloAtual, motivo }
  }

  // Haiku pedido numa conversa grande, vindo de outro modelo: não paga a troca.
  if (desejada === 'haiku' && atual !== null && atual !== 'haiku' && r.contextoTokens > r.limiteTroca) {
    return {
      modelo: r.modeloAtual,
      motivo: `mantido (cache): queria haiku, mas trocar regravaria ${mil(r.contextoTokens)} tokens (limite ${mil(r.limiteTroca)})`,
    }
  }

  const limite = certa ? Math.max(r.limiteTroca, r.limiteTrocaCerta ?? r.limiteTroca) : r.limiteTroca
  if (r.contextoTokens > limite && atual !== null && atual !== desejada) {
    // Trocar de modelo aqui jogaria fora o cache da conversa.
    if (atual === 'haiku' && vetarHaiku) {
      const destino = desejada === 'haiku' ? 'sonnet' : desejada
      return {
        modelo: MODELOS[destino],
        motivo: `contexto ${mil(r.contextoTokens)} > ${mil(r.limiteHaiku)}: Haiku vetado`,
        esforco: limitarEsforco(destino, desejada === 'haiku' ? ESFORCO_PADRAO.sonnet : (esforco ?? ESFORCO_PADRAO[destino])),
      }
    }
    return {
      modelo: r.modeloAtual,
      motivo: `mantido (cache): queria ${desejada}, mas trocar regravaria ${mil(r.contextoTokens)} tokens (limite ${mil(limite)}${certa ? '' : ', palpite'})`,
    }
  }

  if (desejada === 'haiku' && vetarHaiku) return vetado('')

  // Mesmo modelo numa conversa grande: o esforço também não muda (mesmo critério
  // do cache). Se o modelo MUDA, o cache já vai ser regravado: vale o esforço novo.
  if (r.contextoTokens > r.limiteTroca && (atual === null || atual === desejada)) {
    // O motivo não pode prometer um esforço que não vai ser aplicado.
    const nota = esforco !== undefined ? `; esforço ${esforco} não aplicado (conversa de ${mil(r.contextoTokens)} tokens)` : ''
    return { modelo: MODELOS[desejada], motivo: `${motivo}${nota}` }
  }
  return { modelo: MODELOS[desejada], motivo, esforco: limitarEsforco(desejada, esforco ?? ESFORCO_PADRAO[desejada]) }
}
