// Painel "Models" (comando /models). Abre um painel lateral
// com Haiku, Sonnet e Opus; clicar num modelo mostra o resumo dele, com o uso
// real desta sessão. Só mostra: quem troca de modelo é o /roteador (ou /model).

import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { RoteadorFamilia, RoteadorRequisicao } from '../types'
import { MODELOS, familiaDe } from './classificar'

const PAINEL = 'models'

// Os mesmos átomos de register.ts (a referência é o que os identifica).
const ativo = atom({ plugin: 'roteador', key: 'ativo' } as const, false)
const ultimoModelo = atom({ plugin: 'roteador', key: 'ultimoModelo' } as const, null)
const requisicoes = atom({ plugin: 'roteador', key: 'requisicoes' } as const, [] as RoteadorRequisicao[])
const modeloAberto = atom({ plugin: 'roteador', key: 'modeloAberto' } as const, null)

type Ficha = {
  nome: string
  resumo: string
  usarPara: string[]
  esforco: string
}

const FICHAS: Record<RoteadorFamilia, Ficha> = {
  haiku: {
    nome: 'Haiku',
    resumo: 'O mais rápido e econômico dos três.',
    usarPara: ['Listar e buscar informação', 'Perguntas curtas', 'Renomear, formatar, traduzir'],
    esforco: 'low. Nunca recebe conversa acima do limite do Haiku.',
  },
  sonnet: {
    nome: 'Sonnet',
    resumo: 'O equilíbrio entre velocidade e capacidade: o padrão do dia a dia.',
    usarPara: ['Explicar código', 'Corrigir bug pequeno', 'Revisar, resumir e editar um arquivo'],
    esforco: 'medium; high ao corrigir defeito.',
  },
  opus: {
    nome: 'Opus',
    resumo: 'O mais capaz: para o que exige raciocínio longo e cuidado.',
    usarPara: ['Criar site ou app do zero', 'Arquitetura e bug difícil', 'Mexer em vários arquivos'],
    esforco: 'high; xhigh em arquitetura, causa raiz, concorrência, auditoria e migração.',
  },
}

const ORDEM: RoteadorFamilia[] = ['haiku', 'sonnet', 'opus']

// Chamado por register.ts (um plugin tem um só módulo de hooks).
// Não há mais o botão acima do prompt: o painel abre só pelo /models.
export const registrarModels: Register = (on, options) => {
  const limiteTroca = Number(options.limiteTrocaTokens ?? 1000000)
  const limiteHaiku = Number(options.limiteHaikuTokens ?? 100000)

  on('command.run', { command: 'models' }, async $ => {
    const aberto = await $.ui.open({ id: PAINEL, title: 'Models', focus: true, closeOnEscape: true })
    return { text: aberto.isPlaced ? 'Painel Models aberto.' : 'Painel Models: aumente a janela para ver o painel.' }
  })

  on('ui.render', { component: 'Pane', requestId: PAINEL }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const aberto = await read($, modeloAberto)
    const atual = familiaDe(await read($, ultimoModelo))
    const roteador = await read($, ativo)
    const lista = await read($, requisicoes)
    // O que o modelo aberto fez nesta sessão.
    const minhas = lista.filter(r => aberto !== null && familiaDe(r.modelo) === aberto)
    const soma = (campo: 'entrada' | 'saida' | 'cacheLido') => minhas.reduce((t, r) => t + r[campo], 0)

    return (
      <Box flexDirection="column" gap={1}>
        <Text dimColor>
          Roteador {roteador ? 'ligado' : 'desligado'}
          {atual !== null ? ` · respondendo agora: ${FICHAS[atual].nome}` : ''}
        </Text>

        <Box flexDirection="column">
          {ORDEM.map(familia => (
            <Button
              key={familia}
              label={`${aberto === familia ? '▸ ' : '  '}${FICHAS[familia].nome}${atual === familia ? '  (em uso)' : ''}`}
              hotkey={String(ORDEM.indexOf(familia) + 1)}
              onPress={() => update($, modeloAberto, () => familia)}
            />
          ))}
        </Box>

        {aberto === null ? (
          <Text dimColor>Escolha um modelo para ver o resumo.</Text>
        ) : (
          <Box flexDirection="column" borderStyle="round" paddingX={1}>
            <Text bold>{FICHAS[aberto].nome}</Text>
            <Text dimColor>{MODELOS[aberto]}</Text>
            <Text>{FICHAS[aberto].resumo}</Text>
            <Text bold>Bom para</Text>
            {FICHAS[aberto].usarPara.map(linha => (
              <Text>• {linha}</Text>
            ))}
            <Text bold>Esforço no roteador</Text>
            <Text>{FICHAS[aberto].esforco}</Text>
            <Text bold>Nesta sessão</Text>
            {minhas.length === 0 ? (
              <Text dimColor>Ainda não respondeu nada.</Text>
            ) : (
              <Text>
                {minhas.length} requisições · entrada {milhar(soma('entrada'))} · saída {milhar(soma('saida'))} · cache lido{' '}
                {milhar(soma('cacheLido'))}
              </Text>
            )}
            <Text dimColor>
              Troca de modelo só abaixo de {milhar(limiteTroca)} tokens de conversa; o Haiku sai acima de {milhar(limiteHaiku)}.
            </Text>
          </Box>
        )}

        <Button key="fechar" label="Fechar" plain onPress={() => $.ui.close({ id: PAINEL })} />
      </Box>
    )
  })
}

function milhar(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, '.')
}
