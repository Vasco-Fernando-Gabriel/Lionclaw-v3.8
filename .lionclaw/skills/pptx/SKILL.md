---
name: pptx
description: "Use this skill any time a .pptx file is involved in any way — as input, output, or both. This includes: creating slide decks, pitch decks, or presentations; reading, parsing, or extracting text from any .pptx file (even if the extracted content will be used elsewhere, like in an email or summary); editing, modifying, or updating existing presentations; combining or splitting slide files; working with templates, layouts, speaker notes, or comments. Trigger whenever the user mentions \"deck,\" \"slides,\" \"presentation,\" or references a .pptx filename, regardless of what they plan to do with the content afterward. If a .pptx file needs to be opened, created, or touched, use this skill."
category: Documentos
---

# PPTX Skill

## Quick Reference

| Task | Guide |
|------|-------|
| Read/analyze content | `python -m markitdown presentation.pptx` |
| Edit or create from template | Follow editing workflow below |
| Create from scratch | Use pptxgenjs |

---

## Reading Content

```bash
# Text extraction
python -m markitdown presentation.pptx

# Raw XML
python -c "
import zipfile, os
with zipfile.ZipFile('presentation.pptx', 'r') as z:
    z.extractall('unpacked/')
"
```

---

## Editing Workflow

1. Extract current content with `markitdown`
2. Unpack PPTX (zip format) to inspect XML
3. Edit slide XML content
4. Repack into .pptx

```python
import zipfile, shutil, os

# Unpack
with zipfile.ZipFile('input.pptx', 'r') as z:
    z.extractall('unpacked/')

# Edit files in unpacked/ ...

# Repack
shutil.make_archive('output', 'zip', 'unpacked/')
os.rename('output.zip', 'output.pptx')
```

---

## Creating from Scratch (pptxgenjs)

```bash
npm install -g pptxgenjs
```

```javascript
const pptx = require('pptxgenjs');
let pres = new pptx();

let slide = pres.addSlide();
slide.addText('Title', { x: 1, y: 1, fontSize: 36, bold: true });
slide.addText('Body text', { x: 1, y: 2, fontSize: 18 });

pres.writeFile({ fileName: 'output.pptx' });
```

---

## Design Guidelines

### Color Palettes

| Theme | Primary | Secondary | Accent |
|-------|---------|-----------|--------|
| Midnight Executive | `1E2761` | `CADCFC` | `FFFFFF` |
| Forest & Moss | `2C5F2D` | `97BC62` | `F5F5F5` |
| Coral Energy | `F96167` | `F9E795` | `2F3C7E` |
| Warm Terracotta | `B85042` | `E7E8D1` | `A7BEAE` |
| Charcoal Minimal | `36454F` | `F2F2F2` | `212121` |

### Typography

| Element | Size |
|---------|------|
| Slide title | 36-44pt bold |
| Section header | 20-24pt bold |
| Body text | 14-16pt |
| Captions | 10-12pt |

### Layout Options
- Two-column (text left, visual right)
- Icon + text rows
- 2x2 or 2x3 grid
- Half-bleed image with overlay

### Avoid
- Text-only slides (sempre adicionar visual)
- Repetir o mesmo layout em todos os slides
- Linhas de acento abaixo de títulos (padrão de IA óbvio)
- Texto centralizado em corpo/listas

---

## QA

```bash
# Verificar conteúdo extraído
python -m markitdown output.pptx

# Verificar placeholders esquecidos
python -m markitdown output.pptx | grep -iE "xxxx|lorem|ipsum"
```

---

## Converting to Images

```bash
# Requer LibreOffice e Poppler
soffice --headless --convert-to pdf output.pptx
pdftoppm -jpeg -r 150 output.pdf slide
# Gera slide-01.jpg, slide-02.jpg, etc.
```

---

## Dependencies

```bash
pip install "markitdown[pptx]" Pillow
npm install -g pptxgenjs
# LibreOffice: brew install libreoffice
# Poppler: brew install poppler
```
