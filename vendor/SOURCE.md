# Proveniência do pacote vendored (xlsx)

## Por quê vendored

O SheetJS Community Edition **não é mais publicado no npm registry**; a última
versão publicada lá é a 0.18.5, que possui advisories conhecidos (prototype
pollution e ReDoS) sem correção disponível no registry. A correção oficial do
fornecedor é distribuída apenas pelo CDN próprio.

Para garantir reproducibilidade e auditabilidade sem depender de rede externa
nem de `postinstall`, o tarball oficial é versionado neste repositório.

## Origem

- URL: `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz`
- Versão: `0.20.3` (corrige prototype pollution e ReDoS de 0.18.5)
- SHA-256 do tarball:
  `8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8`

## Instalação

`package.json` referencia diretamente
`"xlsx": "file:vendor/xlsx-0.20.3.tgz"`. O repositório não mantém uma cópia
extraída nem modifica o `package.json` do fornecedor. Dependências de
desenvolvimento declaradas dentro do pacote não são instaladas quando o
tarball é consumido como dependência da aplicação.

`npm run policy:repo` recalcula o SHA-256 do tarball e confere a referência
exata do `package.json`. Qualquer alteração do binário ou troca silenciosa da
origem falha no quality gate.

Resultado do `npm audit` após a mudança: as vulnerabilidades atribuídas a
`xlsx` deixam de existir; restam apenas 2 moderadas em `@vitest/mocker`
(ferramenta de teste, sem caminho de execução em runtime; correção exige
upgrade breaking para vitest 5 — tratado em PR própria).

## Atualização

1. Baixe o novo tarball do CDN oficial e versione-o em `vendor/`.
2. Atualize a referência `file:` no `package.json` e o hash esperado no gate.
3. Atualize este documento com URL, versão e SHA-256.
4. Rode `npm install`, `npm run policy:repo` e `npm audit`.

## Política de uso

O importador usa **apenas leitura** (`XLSX.read`) sobre arquivos do usuário,
com inspeção estrutural própria anterior à chamada (magic OLE2/CFB e
marcadores VBA/ActiveX). Nenhuma funcionalidade de escrita do SheetJS é
invocada em caminho operacional.
