---
name: xlsx
description: "Use this skill any time a spreadsheet file is the primary input or output. This means any task where the user wants to: open, read, edit, or fix an existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing formulas, formatting, charting, cleaning messy data); create a new spreadsheet from scratch or from other data sources; or convert between tabular file formats. Trigger especially when the user references a spreadsheet file by name or path — even casually — and wants something done to it or produced from it. Also trigger for cleaning or restructuring messy tabular data files into proper spreadsheets. Do NOT trigger when the primary deliverable is um documento Word, relatório HTML, script Python standalone, pipeline de banco de dados, ou integração com Google Sheets API."
category: Documentos
---

# XLSX Skill

## Regras Fundamentais

### NUNCA hardcode valores calculados — use fórmulas Excel

```python
# ❌ ERRADO
total = df['Sales'].sum()
sheet['B10'] = total  # hardcoda 5000

# ✅ CORRETO
sheet['B10'] = '=SUM(B2:B9)'
```

### Zero erros de fórmula obrigatório
Entregar sempre com ZERO erros: `#REF!`, `#DIV/0!`, `#VALUE!`, `#N/A`, `#NAME?`

---

## Leitura e Análise (pandas)

```python
import pandas as pd

# Ler
df = pd.read_excel('file.xlsx')
all_sheets = pd.read_excel('file.xlsx', sheet_name=None)  # todas as abas

# Analisar
df.head()
df.info()
df.describe()

# Escrever
df.to_excel('output.xlsx', index=False)
```

---

## Criar/Editar com Fórmulas e Formatação (openpyxl)

```python
from openpyxl import Workbook, load_workbook
from openpyxl.styles import Font, PatternFill, Alignment

# Criar novo
wb = Workbook()
sheet = wb.active

sheet['A1'] = 'Receita'
sheet['B1'] = 'Custo'
sheet['C1'] = 'Margem'

sheet['A2'] = 1000
sheet['B2'] = 600
sheet['C2'] = '=(A2-B2)/A2'  # fórmula, não valor hardcoded

sheet['A1'].font = Font(bold=True, color='FFFFFF')
sheet['A1'].fill = PatternFill('solid', start_color='1F4E79')
sheet['A1'].alignment = Alignment(horizontal='center')
sheet.column_dimensions['A'].width = 20

wb.save('output.xlsx')
```

```python
# Editar existente
wb = load_workbook('existing.xlsx')
sheet = wb['Março 2026']
sheet['A5'] = 'Novo valor'
wb.save('existing.xlsx')
```

> **Atenção**: `data_only=True` lê valores calculados mas perde fórmulas ao salvar. Nunca usar para edição.

---

## Recalcular Fórmulas (LibreOffice)

openpyxl grava fórmulas como strings. Para recalcular:

```bash
# Se tiver scripts/recalc.py disponível:
python scripts/recalc.py output.xlsx

# Alternativa manual via LibreOffice:
soffice --headless --calc --norestore output.xlsx
```

O script retorna JSON:
```json
{
  "status": "success",
  "total_errors": 0,
  "total_formulas": 42
}
```

Se `status: "errors_found"`, corrigir referências e rodar novamente.

---

## Padrões para Modelos Financeiros

### Color coding padrão da indústria
- **Texto azul** `(0,0,255)`: inputs hardcoded, valores que o usuário vai mudar
- **Texto preto** `(0,0,0)`: fórmulas e cálculos
- **Texto verde** `(0,128,0)`: links de outras abas do mesmo workbook
- **Texto vermelho** `(255,0,0)`: links externos
- **Fundo amarelo** `(255,255,0)`: premissas importantes

### Formatação de números
- Anos: texto (`"2024"`, não `2,024`)
- Moeda: `$#,##0` com unidade no header (`"Receita (R$mil)"`)
- Zeros: `$#,##0;($#,##0);-`
- Percentuais: `0.0%`
- Negativos: parênteses `(123)` não menos `-123`

---

## Checklist de Verificação

- [ ] Todas as referências de células corretas
- [ ] Nenhum valor calculado hardcoded (usar fórmulas)
- [ ] Testado com valores zero e negativos
- [ ] Colunas com largura adequada
- [ ] Headers formatados em negrito
- [ ] Fórmulas recalculadas com sucesso
- [ ] Zero erros `#REF!`, `#DIV/0!`, etc.

---

## Quick Reference

| Task | Ferramenta |
|------|-----------|
| Análise de dados | pandas |
| Criar com fórmulas | openpyxl |
| Editar existente | openpyxl |
| Recalcular | LibreOffice / recalc.py |
| Converter CSV→XLSX | pandas |

---

## Dependencies

```bash
pip install pandas openpyxl
brew install libreoffice  # para recálculo
```
