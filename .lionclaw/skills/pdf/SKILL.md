---
name: pdf
description: Use this skill whenever the user wants to do anything with PDF files. This includes reading or extracting text/tables from PDFs, combining or merging multiple PDFs into one, splitting PDFs apart, rotating pages, adding watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting PDFs, extracting images, and OCR processing on scanned PDFs to make them searchable. If the user mentions a .pdf file or asks to produce one, use this skill.
category: Documentos
---

# PDF Processing Guide

## Quick Start

```python
from pypdf import PdfReader, PdfWriter

reader = PdfReader("document.pdf")
print(f"Pages: {len(reader.pages)}")

text = ""
for page in reader.pages:
    text += page.extract_text()
```

---

## Operações Comuns

### Merge PDFs

```python
from pypdf import PdfWriter, PdfReader

writer = PdfWriter()
for pdf_file in ["doc1.pdf", "doc2.pdf", "doc3.pdf"]:
    reader = PdfReader(pdf_file)
    for page in reader.pages:
        writer.add_page(page)

with open("merged.pdf", "wb") as f:
    writer.write(f)
```

### Split PDF

```python
reader = PdfReader("input.pdf")
for i, page in enumerate(reader.pages):
    writer = PdfWriter()
    writer.add_page(page)
    with open(f"page_{i+1}.pdf", "wb") as f:
        writer.write(f)
```

### Rotate Pages

```python
reader = PdfReader("input.pdf")
writer = PdfWriter()
page = reader.pages[0]
page.rotate(90)
writer.add_page(page)
with open("rotated.pdf", "wb") as f:
    writer.write(f)
```

### Password Protection

```python
reader = PdfReader("input.pdf")
writer = PdfWriter()
for page in reader.pages:
    writer.add_page(page)
writer.encrypt("userpassword", "ownerpassword")
with open("encrypted.pdf", "wb") as f:
    writer.write(f)
```

---

## Extração de Texto e Tabelas (pdfplumber)

```python
import pdfplumber

# Texto
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        print(page.extract_text())

# Tabelas
with pdfplumber.open("document.pdf") as pdf:
    for page in pdf.pages:
        tables = page.extract_tables()
        for table in tables:
            for row in table:
                print(row)
```

---

## Criar PDF (reportlab)

```python
from reportlab.lib.pagesizes import letter
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer
from reportlab.lib.styles import getSampleStyleSheet

doc = SimpleDocTemplate("report.pdf", pagesize=letter)
styles = getSampleStyleSheet()
story = []

story.append(Paragraph("Título do Relatório", styles['Title']))
story.append(Spacer(1, 12))
story.append(Paragraph("Conteúdo do relatório aqui.", styles['Normal']))

doc.build(story)
```

> **Atenção**: Nunca use caracteres Unicode de subscript/superscript (₀¹²) no reportlab. Use tags XML: `H<sub>2</sub>O`, `x<super>2</super>`.

---

## OCR em PDFs Escaneados

```python
import pytesseract
from pdf2image import convert_from_path

images = convert_from_path('scanned.pdf')
text = ""
for i, image in enumerate(images):
    text += f"Página {i+1}:\n"
    text += pytesseract.image_to_string(image, lang='por')
    text += "\n\n"
print(text)
```

---

## Adicionar Watermark

```python
from pypdf import PdfReader, PdfWriter

watermark = PdfReader("watermark.pdf").pages[0]
reader = PdfReader("document.pdf")
writer = PdfWriter()

for page in reader.pages:
    page.merge_page(watermark)
    writer.add_page(page)

with open("watermarked.pdf", "wb") as f:
    writer.write(f)
```

---

## Command-Line (alternativas rápidas)

```bash
# Extrair texto
pdftotext input.pdf output.txt
pdftotext -layout input.pdf output.txt  # preserva layout

# Merge via qpdf
qpdf --empty --pages file1.pdf file2.pdf -- merged.pdf

# Split via qpdf
qpdf input.pdf --pages . 1-5 -- pages1-5.pdf

# Remover senha
qpdf --password=senha --decrypt encrypted.pdf decrypted.pdf
```

---

## Quick Reference

| Task | Ferramenta |
|------|-----------|
| Merge | pypdf ou qpdf |
| Split | pypdf ou qpdf |
| Extrair texto | pdfplumber |
| Extrair tabelas | pdfplumber |
| Criar PDF | reportlab |
| OCR | pytesseract + pdf2image |
| Watermark | pypdf |
| Encrypt/Decrypt | pypdf ou qpdf |

---

## Dependencies

```bash
pip install pypdf pdfplumber reportlab pytesseract pdf2image
brew install poppler tesseract tesseract-lang qpdf
```
