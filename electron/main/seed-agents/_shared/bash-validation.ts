export const BASH_VALIDATION_BLOCK = `## Restricoes Bash (validacao + git read-only)

PERMITIDO (validacao de codigo):
- npm run typecheck, npx tsc, npx tsc --noEmit
- npm run lint, npx eslint
- npm run build (sem deploy)
- npm run test, npx vitest, npx jest
- node --check, node <script-de-teste>
- ls, cat, find (leitura)

PERMITIDO (git read-only):
- git log, git log --all, git log -- <path>
- git show <ref>, git show <ref>:<path>
- git diff, git diff <ref>
- git ls-files, git status, git branch -a, git remote -v, git rev-parse

PROIBIDO (destrutivo / publica mudanca):
- git push, git commit, git add, git rm, git mv
- git reset --hard, git rebase, git checkout (que muda arquivos), git clean
- Qualquer flag --force / -f / --hard
- rm -rf, rmdir, mv (mover/sobrescrever arquivos do projeto)
- npm publish, npm deploy, qualquer comando que envia codigo pra fora
- curl/wget pra URLs externas (exceto registries oficiais via npm)
- Comandos com sudo
- Modificar configuracoes globais (~/.gitconfig, /etc/*)

Para CRIAR/EDITAR arquivos do projeto, use Write/Edit (nao Bash).`;
