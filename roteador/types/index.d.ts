export type RoteadorFamilia = 'haiku' | 'sonnet' | 'opus'

// Esforço de raciocínio que o roteador escolhe sozinho (`max` fica de fora).
export type RoteadorEsforco = 'low' | 'medium' | 'high' | 'xhigh'

// A escolha feita na primeira requisição de um turno, mantida até o fim dele.
// `esforco` ausente: o esforço da sessão fica como está.
export type RoteadorDecisao = { turnId: string; modelo: string; motivo: string; esforco?: RoteadorEsforco }

// Uma requisição ao modelo, como a API cobrou.
export type RoteadorRequisicao = {
  quando: number
  origem: 'principal' | 'subagente' | 'classificador'
  modelo: string
  entrada: number
  saida: number
  cacheLido: number
  cacheEscrito: number
  usd?: number
}

declare module 'claude-code' {
  interface PluginState {
    roteador: {
      ativo: boolean
      textoTurno: { turnId: string; text: string } | null
      decisao: RoteadorDecisao | null
      ultimoModelo: string | null
      requisicoes: RoteadorRequisicao[]
      // Níveis de aviso já dados (0 nenhum, 1 compactar/atenção, 2 conversa nova/perto do limite).
      avisos: { contexto: 0 | 1 | 2; plano: 0 | 1 | 2 }
      // Modelo aberto no painel "Models" (família), ou null com nenhum aberto.
      modeloAberto: RoteadorFamilia | null
    }
  }
}
