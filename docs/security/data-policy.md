# Política de dados no repositório

## Permitido

- código-fonte e testes unitários estruturais;
- nomes de campos e contratos dos templates;
- hashes SHA-256 de artefatos oficiais;
- contagens agregadas de homologação;
- documentação arquitetural.

## Proibido

- bases PF/PJ, planilhas operacionais e arquivos de retorno;
- nomes, documentos, telefones, e-mails ou endereços de titulares;
- arquivos `.env`, tokens, senhas ou códigos de acesso;
- templates XLSX contendo linhas de exemplo;
- artefatos gerados, logs operacionais e exports do PPN.

O script `npm run policy:repo` bloqueia categorias de arquivos incompatíveis com
essa política. Revisão humana e secret scanning continuam obrigatórios no PR.
