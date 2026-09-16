# Persistência operacional

As migrations são aplicadas em ordem lexical e sempre com `ON_ERROR_STOP=1`.
A primeira migration cria o modelo mínimo para intake, confirmação cadastral,
comunicação e outbox. Não há seeds: dados operacionais e exemplos cadastrais não
pertencem ao repositório.

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -f database/migrations/0001_operational_persistence.sql
```

## Limites de segurança

- CPF/CNPJ recuperável e snapshots cadastrais são cifrados na aplicação com
  AES-256-GCM; o banco recebe somente ciphertext, nonce, tag e versão da chave.
- comparação e deduplicação usam HMAC-SHA-256 com chave separada;
- tokens de confirmação persistem somente como SHA-256; o payload temporário da
  outbox, que contém o link, também é cifrado;
- tokens OAuth são sempre cifrados;
- `evento_auditoria` rejeita `UPDATE` e `DELETE` por trigger;
- nenhuma FK usa `ON DELETE CASCADE`;
- o índice parcial em `item_lote_comunicacao` impede duas reservas ativas para o
  mesmo profissional.

As chaves nunca devem ser gravadas no banco, em logs, no Git ou em eventos de
auditoria. Rotação usa `chave_versao`, mantendo o material criptográfico apenas
no gerenciador de segredos do ambiente.
