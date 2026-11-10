import { describe, expect, test } from 'claude-code/testing'

import { MODELOS } from '../hooks/classificar'
import { MAX_DIARIO, categoriaDoMotivo, parecidas, resumoDoDiario, trechoDe, type Registro } from '../hooks/diario'
import { aplicarPressao, pressaoDoPlano, ritmoDaJanela, textoDoPlano } from '../hooks/plano'

const AGORA = 1_700_000_000_000
const H = 3600000
// Janela de 5 h que renova daqui a `restanteH` horas.
const cinco = (percentUsed: number, restanteH: number) => ({
  kind: 'five_hour',
  percentUsed,
  resetsAt: new Date(AGORA + restanteH * H).toISOString(),
})

describe('ritmo da janela', () => {
  test('50% usado com metade do tempo passado: acaba exatamente na renovação, não antes', () => {
    const r = ritmoDaJanela(cinco(50, 2.5), AGORA)!
    expect(r.encheAntesDeRenovar).toBe(false)
  })
  test('80% usado com 1 h decorrida: acaba antes de renovar', () => {
    const r = ritmoDaJanela(cinco(80, 4), AGORA)!
    expect(r.encheAntesDeRenovar).toBe(true)
    expect(Math.round(r.ateEncherMs! / 60000)).toBe(15)
  })
  test('janela recém-aberta ou 0% não faz previsão', () => {
    expect(ritmoDaJanela(cinco(30, 4.95), AGORA)!.ateEncherMs).toBeUndefined()
    expect(ritmoDaJanela(cinco(0, 2), AGORA)!.ateEncherMs).toBeUndefined()
  })
  test('sem horário de renovação, janela vencida ou tipo desconhecido: sem ritmo', () => {
    expect(ritmoDaJanela({ kind: 'five_hour', percentUsed: 10 }, AGORA)).toBeUndefined()
    expect(ritmoDaJanela(cinco(10, -1), AGORA)).toBeUndefined()
    expect(ritmoDaJanela({ kind: 'spend_limit', percentUsed: 10, resetsAt: new Date(AGORA + H).toISOString() }, AGORA)).toBeUndefined()
  })
})

describe('pressão do plano', () => {
  test('85% com 3 h pela frente: apertado', () => expect(pressaoDoPlano([cinco(85, 3)], AGORA)).toBe('apertado'))
  test('90% mas faltando 10 min: não aperta (já vai renovar)', () => expect(pressaoDoPlano([cinco(90, 0.15)], AGORA)).toBe('normal'))
  test('65% no ritmo de estourar antes de renovar: apertado', () => expect(pressaoDoPlano([cinco(65, 2)], AGORA)).toBe('apertado'))
  test('30% com 10 min para renovar: folga', () => expect(pressaoDoPlano([cinco(30, 0.15)], AGORA)).toBe('folga'))
  test('40% no meio da janela: normal', () => expect(pressaoDoPlano([cinco(40, 2.5)], AGORA)).toBe('normal'))
  test('semana a 92% aperta mesmo com a janela de 5 h vazia', () => {
    const semana = { kind: 'seven_day', percentUsed: 92, resetsAt: new Date(AGORA + 24 * H).toISOString() }
    expect(pressaoDoPlano([cinco(5, 4), semana], AGORA)).toBe('apertado')
  })
  test('o limite é ajustável', () => expect(pressaoDoPlano([cinco(70, 3)], AGORA, 65)).toBe('apertado'))
  test('sem leitura do plano: normal', () => expect(pressaoDoPlano([], AGORA)).toBe('normal'))
})

describe('aplicar pressão', () => {
  const opus = { modelo: MODELOS.opus, motivo: 'tarefa pesada (palavra-chave)', esforco: 'high' as const }
  test('apertado: não sobe para o Opus a partir do Sonnet', () => {
    const r = aplicarPressao(opus, 'apertado', MODELOS.sonnet)
    expect(r.modelo).toBe(MODELOS.sonnet)
    expect(r.motivo).toContain('plano apertado')
    expect(r.esforco).toBe('high')
  })
  test('apertado: assunto sensível continua no Opus', () => {
    const sens = { ...opus, motivo: 'assunto sensível: banco, dinheiro ou publicação (palavra-chave)' }
    expect(aplicarPressao(sens, 'apertado', MODELOS.sonnet).modelo).toBe(MODELOS.opus)
  })
  test('apertado: já no Opus, fica nele mas pensa um degrau a menos', () => {
    const r = aplicarPressao({ ...opus, esforco: 'xhigh' }, 'apertado', MODELOS.opus)
    expect(r.modelo).toBe(MODELOS.opus)
    expect(r.esforco).toBe('high')
  })
  test('apertado: em conversa grande (sem esforço na escolha) não mexe no esforço', () => {
    const r = aplicarPressao({ modelo: MODELOS.opus, motivo: 'mantido (cache)' }, 'apertado', MODELOS.opus)
    expect(r.esforco).toBeUndefined()
  })
  test('folga: Sonnet medium sobe para high; Haiku não muda', () => {
    expect(aplicarPressao({ modelo: MODELOS.sonnet, motivo: 'x', esforco: 'medium' }, 'folga', MODELOS.sonnet).esforco).toBe('high')
    const h = { modelo: MODELOS.haiku, motivo: 'x', esforco: 'low' as const }
    expect(aplicarPressao(h, 'folga', MODELOS.haiku)).toEqual(h)
  })
  test('normal não muda nada', () => expect(aplicarPressao(opus, 'normal', MODELOS.sonnet)).toEqual(opus))
})

describe('texto do plano na linha de status', () => {
  test('mostra porcentagem, quanto falta e o aviso de ritmo', () => {
    const t = textoDoPlano([cinco(80, 4)], AGORA, 'apertado')
    expect(t).toContain('plano 5 h 80%')
    expect(t).toContain('renova em 4 h 0 min')
    expect(t).toContain('acaba em 15 min')
    expect(t).toContain('economizando')
  })
  test('a semana aparece sempre, com quando renova', () => {
    const semana = { kind: 'seven_day', percentUsed: 12, resetsAt: new Date(AGORA + 48 * H).toISOString() }
    expect(textoDoPlano([cinco(10, 4), semana], AGORA, 'normal')).toContain('semana 12% (renova em 2 dias)')
  })
  test('sem leitura: nada', () => expect(textoDoPlano([], AGORA, 'normal')).toBe(''))
})

describe('diário', () => {
  const reg = (parcial: Partial<Registro> = {}): Registro => ({
    quando: AGORA,
    turnId: 't',
    trecho: 'liste os arquivos',
    modelo: MODELOS.haiku,
    motivo: 'pergunta curta',
    contexto: 1000,
    ...parcial,
  })
  test('trecho tem no máximo 50 caracteres e sem quebras de linha', () => {
    expect(trechoDe('a\n\n  b '.repeat(40)).length).toBeLessThanOrEqual(50)
    expect(trechoDe('a\nb')).toBe('a b')
  })
  test('perguntas parecidas (com acento e pontuação) contam como repetição', () => {
    expect(parecidas('Corrija o erro de login na página inicial', 'corrija o erro do login da pagina inicial?')).toBe(true)
    expect(parecidas('liste os arquivos da pasta', 'explique a arquitetura do pagamento')).toBe(false)
    expect(parecidas('ok', 'ok')).toBe(false)
  })
  test('categoria ignora números e o que vem depois do ponto e vírgula', () => {
    expect(categoriaDoMotivo('mantido (cache): trocar regravaria 57 mil tokens; plano apertado')).toBe('mantido (cache): trocar regravaria # mil tokens')
  })
  test('diário vazio explica por quê', () => expect(resumoDoDiario([])).toContain('vazio'))
  test('resumo conta discordâncias, agrupa por modelo e motivo, e avisa que são poucos dados', () => {
    const t = resumoDoDiario([reg(), reg({ corrigido: 'modelo' }), reg({ modelo: MODELOS.opus, motivo: 'tarefa pesada', corrigido: 'repetiu', trecho: 'refaça o login' })])
    expect(t).toContain('3')
    expect(t).toContain('discordou depois:** 2 (67%)')
    expect(t).toContain('haiku: 2 decisões, 1 com discordância')
    expect(t).toContain('pergunta curta: 1 de 2')
    expect(t).toContain('refaça o login')
    expect(t).toContain('Poucos dados')
  })
  test('com dados suficientes avisa que é pista, não veredito', () => {
    expect(resumoDoDiario(Array.from({ length: 25 }, () => reg()))).toContain('pista')
  })
  test('o diário tem um teto', () => expect(MAX_DIARIO).toBeGreaterThan(0))
})
