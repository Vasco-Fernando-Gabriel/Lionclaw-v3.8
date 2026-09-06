---
name: webapp-testing
description: Use this skill when the user wants to test, inspect, or automate interaction with a local web application. This includes verifying frontend functionality, debugging UI behavior, capturing screenshots, analyzing browser logs, clicking buttons, filling forms, and validating rendered HTML. Trigger when the user mentions testing a webapp, validating UI, automating browser actions, or capturing the visual state of a local app.
category: Ferramentas
---

# Web Application Testing (Playwright)

## Decision Tree

```
Tarefa recebida → É HTML estático?
 ├─ Sim → Ler arquivo HTML diretamente para identificar seletores
 │        → Escrever script Playwright com os seletores
 │
 └─ Não (webapp dinâmica) → Servidor já está rodando?
     ├─ Não → Subir servidor primeiro, depois escrever script
     └─ Sim → Reconnaissance → Action:
              1. Navegar e esperar networkidle
              2. Screenshot ou inspecionar DOM
              3. Identificar seletores do estado renderizado
              4. Executar ações com os seletores descobertos
```

---

## Script Básico

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()

    page.goto('http://localhost:3000')
    page.wait_for_load_state('networkidle')  # CRÍTICO: esperar JS executar

    # Screenshot para inspeção
    page.screenshot(path='/tmp/inspect.png', full_page=True)

    # Inspecionar DOM
    content = page.content()
    buttons = page.locator('button').all()

    browser.close()
```

---

## Subir Servidor + Testar

```bash
# Subir servidor em background e rodar script
python -c "
import subprocess, time
server = subprocess.Popen(['npm', 'run', 'dev'])
time.sleep(3)  # aguardar servidor subir
# rodar automação aqui
server.terminate()
"
```

Ou rodar em terminais separados:
```bash
# Terminal 1
npm run dev

# Terminal 2
python meu_teste.py
```

---

## Ações Comuns

```python
# Clicar
page.click('button[type="submit"]')
page.click('text=Entrar')
page.locator('role=button[name="Salvar"]').click()

# Preencher formulário
page.fill('input[name="email"]', 'usuario@email.com')
page.fill('input[type="password"]', 'senha123')

# Aguardar elemento
page.wait_for_selector('.resultado', timeout=5000)
page.wait_for_load_state('networkidle')

# Capturar texto
texto = page.inner_text('.mensagem-sucesso')
valor = page.locator('#preco').text_content()

# Screenshot
page.screenshot(path='/tmp/resultado.png', full_page=True)
page.locator('.componente').screenshot(path='/tmp/componente.png')

# Verificar estado
assert page.is_visible('.modal')
assert 'Sucesso' in page.title()
```

---

## Capturar Logs do Console

```python
logs = []
page.on('console', lambda msg: logs.append(f"[{msg.type}] {msg.text}"))
page.on('pageerror', lambda err: logs.append(f"[ERROR] {err}"))

page.goto('http://localhost:3000')
page.wait_for_load_state('networkidle')

print('\n'.join(logs))
```

---

## Padrão Reconnaissance → Action

```python
# 1. Reconnaissance — entender o que está renderizado
page.goto('http://localhost:3000')
page.wait_for_load_state('networkidle')
page.screenshot(path='/tmp/estado-inicial.png', full_page=True)

# Listar elementos interativos
buttons = [b.text_content() for b in page.locator('button').all()]
inputs = [i.get_attribute('name') for i in page.locator('input').all()]
print(f"Botões: {buttons}")
print(f"Inputs: {inputs}")

# 2. Action — agir com base no que foi encontrado
page.fill('input[name="search"]', 'termo de busca')
page.click('button[type="submit"]')
page.wait_for_selector('.results')
page.screenshot(path='/tmp/resultado-busca.png', full_page=True)
```

---

## Armadilha Comum

❌ **Não** inspecionar DOM antes de esperar `networkidle` em apps dinâmicas (React, Vue, etc.)
✅ **Sempre** aguardar `page.wait_for_load_state('networkidle')` antes de qualquer inspeção

---

## Dependencies

```bash
pip install playwright
playwright install chromium
```
