# ADR-003 — Formatos documentais não são banco

- Estado: aceito
- Data: 2026-09-15

## Decisão

XLSX, CSV, JSON, TXT e PDF são formatos de entrada, saída, interoperabilidade ou
evidência. Nenhum deles é tratado como futuro estado transacional multiusuário.

Os quatro XLSX oficiais não são versionados no repositório público. O Git contém
somente nomes, hashes e contratos de cabeçalhos. Linhas exemplificativas e dados
cadastrais ficam fora do código.
