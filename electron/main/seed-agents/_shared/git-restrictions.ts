export const GIT_RESTRICTIONS_BLOCK = `## Restricoes git (apenas leitura)

PERMITIDO:
- git log, git log --all, git log -- <path>
- git show <ref>, git show <ref>:<path>
- git diff, git diff <ref>
- git ls-files, git status, git branch -a, git remote -v, git rev-parse

PROIBIDO:
- git push, git commit, git add, git rm, git mv
- git reset --hard, git rebase, git checkout (que muda arquivos), git clean
- Qualquer flag --force / -f / --hard
- Qualquer comando que NAO comece com 'git ' (sem rm, mv, cp, cat, echo, curl, etc)
- Criar, editar ou deletar arquivos via Bash — use Read/Grep/Glob para leitura de conteudo`;
