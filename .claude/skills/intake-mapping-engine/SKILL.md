---
name: intake-mapping-engine
description: Implement and review safe PF/PJ spreadsheet ingestion, mapping, normalization, preview and validation without coupling source spreadsheets to Correios PPN output contracts.
---

# Intake Mapping Engine

## Purpose

Implement and review safe ingestion of operational PF/PJ spreadsheets without
forcing source files into Correios/PPN output formats.

## Architectural rule

Operational spreadsheet != Correios template.

The ingestion layer produces a canonical PF/PJ representation.

Correios 15/34/87-column contracts are independent input/output contracts and
must not dictate the operational source spreadsheet structure.

## Supported input

Initial scope:

- XLSX
- CSV

Do not support XLSM or executable macros.

## Required ingestion sequence

file
→ safety inspection
→ workbook/sheet discovery
→ header-row selection
→ header extraction
→ mapping suggestions
→ explicit operator confirmation
→ canonical normalization
→ preview
→ validation report

No email sending.
No PPN call.
No automatic promotion to APTO_PREPOSTAGEM.

## Workbook safety

Require configurable limits for:

- file size;
- row count;
- column count;
- worksheet count.

Reject:

- macros;
- executable content;
- unsupported workbook types;
- duplicate headers after normalization.

Never execute formulas.

Formula cells must either be rejected or imported only as explicitly safe,
non-executed cached values according to the implementation policy.

## Mapping profile

A saved mapping profile stores structure only.

Example:

name: AR DIGITAL PROFISSIONAIS
version: 1
origin: PF
sheet: Profissionais
headerRow: 1

NOME COMPLETO -> nome
CPF -> documento
ENDEREÇO RESIDENCIAL -> logradouro
Nº -> numero
MUNICÍPIO -> cidade
CEP -> cep

Never store imported records inside the mapping profile.

## Operator confirmation

Automatic mapping may suggest fields but must never silently finalize mappings.

The operator must explicitly confirm the mapping before normalization.

## Canonical identifiers

Treat as strings:

- CPF
- CNPJ
- CEP
- Correios codes

Preserve leading zeros.

## Duplicates

Do not remove duplicate source rows during ingestion.

Preserve them and report them for later deterministic handling.

## File integrity

Calculate SHA-256 of the original uploaded file.

The hash identifies the imported artifact, not the person.

## Required PF fields

Define and validate independently from PJ fields.

Do not assume PF and PJ have identical mandatory attributes.

## Existing contracts

Reuse the exact existing contracts in `packages/importers`.

Do not recreate the 15, 34 or 87-column schemas unless correcting an evidenced
defect.

## Testing

Use synthetic fixtures only.

Tests must cover:

- multiple worksheets;
- custom header row;
- duplicate headers;
- leading-zero CPF/CNPJ/CEP;
- empty required fields;
- duplicate rows;
- unknown columns;
- malformed XLSX/CSV;
- file limits;
- mapping confirmation;
- PF/PJ differences.

## Out of scope

This skill does not authorize:

- PostgreSQL persistence;
- email delivery;
- Resend configuration;
- Gmail configuration;
- PPN submission;
- production deployment.