# Etapa 6: Security - Seguranca e Checklist Final

Voce esta na Etapa 6 do workflow BuildPlan. Esta eh a ultima etapa tecnica antes da geracao da SPEC.

Antes de comecar, **rele o discovery-notes.md completo** para recuperar todo o contexto.

## Objetivo

Definir as decisoes de seguranca do produto e gerar um checklist completo. Em seguida, apresentar o resumo final de todas as etapas para aprovacao do usuario.

## Perguntas de confirmacao (rapidas, uma por vez)

**Q1.** "Auth: session cookie httpOnly + secure + sameSite=lax como padrao - ok? Ou quer OAuth social (Google, GitHub, etc)?"

> Opcoes:
> - Session cookie (mais simples, menos fricao no cadastro)
> - OAuth social (facilita onboarding, depende de terceiros)
> - Ambos (cookie para email/senha, OAuth como adicional)

**Q2.** "Rate limiting: 100 requisicoes por minuto por usuario - razoavel pro seu caso?"

> Ajuste se o produto tiver uso intenso (ex: API publica, processamento em batch).

**Q3.** "File upload: o produto aceita upload de arquivos? Se sim, quais tipos e qual o tamanho maximo?"

> Se nao tiver upload, pule essa pergunta.

## Gerar checklist de seguranca

Apos as confirmacoes, gere o checklist completo:

**Session config:**
- [ ] Cookie flags: httpOnly, secure, sameSite
- [ ] Duracao da sessao e renovacao
- [ ] Invalidacao no logout

**Auth flow:**
- [ ] Register: validacao de email, hash de senha (bcrypt/argon2)
- [ ] Login: verificacao de credenciais, criacao de sessao
- [ ] Logout: invalidacao de sessao
- [ ] Session expired: redirect para login
- [ ] Password reset: token com expiracao, invalidacao apos uso

**OAuth** (se aplicavel):
- [ ] State parameter para prevenir CSRF
- [ ] Callback URL validado
- [ ] Account linking (email ja existe)

**Row Level Security:**
- [ ] Revisao de cada tabela: usuario so acessa seus proprios dados
- [ ] Policies de SELECT, INSERT, UPDATE, DELETE
- [ ] Service role key nunca exposta no frontend

**CORS:**
- [ ] Origins permitidas (apenas o dominio do app)
- [ ] Methods e headers permitidos
- [ ] Credentials: true se usar cookies

**Input validation:**
- [ ] Validacao server-side de todos os inputs (nunca confiar no frontend)
- [ ] Sanitizacao de HTML se aceitar rich text
- [ ] SQL injection: usar ORM/prepared statements

**Rate limiting:**
- [ ] [X] req/min por usuario autenticado
- [ ] Endpoints sensiveis (login, register, reset): limite mais restritivo
- [ ] IP-based limit para endpoints publicos

**File upload** (se aplicavel):
- [ ] Tipos permitidos: [lista]
- [ ] Tamanho maximo: [X]MB
- [ ] Scan de malware se necessario
- [ ] Storage em bucket privado, acesso via URL assinada

**Webhook verification** (se tiver pagamento/integracoes):
- [ ] Verificar assinatura do webhook (HMAC)
- [ ] Idempotency key para evitar processamento duplicado

**Variáveis de ambiente (.env.example):**
- [ ] Listar todas as variaveis necessarias
- [ ] Nunca commitar .env real
- [ ] Segredos separados por ambiente (dev/staging/prod)

## Aprovacao do checklist

Pergunte:
> "Seguranca ok? Quer adicionar algum requisito especifico?"

Aguarde feedback. Aplique ajustes se necessario.

## Salvar no discovery-notes.md

Apos aprovacao, atualize a secao `## Security - Decisoes` no discovery-notes.md com o checklist completo aprovado.

## Resumo final de todas as etapas

Apos salvar a secao de seguranca, apresente um **resumo consolidado** de tudo que foi decidido nas 6 etapas:

1. **Visao**: [pitch, problema, usuario, referencia]
2. **Produto**: [core features, integracoes, monetizacao]
3. **Stack**: [tecnologias escolhidas, plataforma]
4. **PRD**: [numero de user stories, dominios dos requisitos]
5. **Database**: [numero de tabelas, destaques do schema]
6. **Backend**: [numero de endpoints, destaques da arquitetura]
7. **Frontend**: [numero de paginas, design system escolhido]
8. **Security**: [modelo de auth, destaques do checklist]

Finalize com:
> "Discovery completo! Revise o resumo acima. Se estiver tudo certo, clique em **[Aprovar]** para gerar a SPEC. Se quiser ajustar algo, clique em **[Revisar]** e me diga o que mudar."

> IMPORTANTE: Aguarde o usuario clicar em [Aprovar] ou [Revisar] na interface. Nao avance automaticamente.
