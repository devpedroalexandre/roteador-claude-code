# roteador (plugin para o Claude Code)

Plugin pessoal que ajuda a controlar o gasto de tokens no Claude Code. Versão **0.7.0**.

## O que ele faz

- Escolhe o modelo (Haiku, Sonnet ou Opus) e o esforço a cada mensagem. Liga e desliga com `/roteador on` e `/roteador off`.
- Mostra o custo por modelo com `/custo`.
- Dá boas práticas de economia com `/economia`.
- Abre o painel de modelos com `/models`.
- Mostra na linha de status o tamanho do contexto e o uso do plano, e avisa quando é hora de compactar ou abrir uma conversa nova.

As regras e os limites podem ser ajustados pelas opções do plugin (por exemplo `limiteTrocaTokens`, `avisoCompactarTokens` e `avisoPlanoPercentual`). A lista completa, com a explicação de cada uma, está em `roteador/.claude-plugin/plugin.json`.

## Como instalar

No Claude Code, rode:

```
/plugin marketplace add devpedroalexandre/roteador-claude-code
/plugin install roteador@mods-locais
```

Se algum comando for recusado, use `/plugin` e escolha pela tela.

## Como está organizado

```
.claude-plugin/marketplace.json     (lista o plugin)
roteador/
├── .claude-plugin/plugin.json      (nome, versão e opções)
├── hooks/                          (o código em TypeScript)
├── tests/                          (testes)
└── types/index.d.ts
```

O código usa só a API de plugins do próprio Claude Code. Ele não acessa a internet nem lê arquivos do computador.

## Aviso

Projeto pessoal e de estudo, sem garantia. Ainda não tem licença definida.
