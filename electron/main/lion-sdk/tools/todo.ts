
export interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export class LionTodoStore {
  private state: TodoItem[] = [];

  list(): TodoItem[] {
    return [...this.state];
  }

  write(todos: TodoItem[]): TodoItem[] {
    const next: TodoItem[] = [];
    const seen = new Set<string>();
    for (const t of todos) {
      if (!t || typeof t.id !== 'string' || typeof t.content !== 'string') continue;
      if (!['pending', 'in_progress', 'completed'].includes(t.status)) continue;
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      next.push({ id: t.id, content: t.content, status: t.status });
    }
    this.state = next;
    return [...this.state];
  }

  reset(): void {
    this.state = [];
  }
}

export interface TodoWriteInput {
  todos: TodoItem[];
}

export interface TodoWriteResult {
  ok: boolean;
  todos?: TodoItem[];
  error?: string;
}

export function lionTodoWrite(store: LionTodoStore, input: TodoWriteInput): TodoWriteResult {
  if (!input || !Array.isArray(input.todos)) {
    return { ok: false, error: 'TodoWrite: todos deve ser um array.' };
  }
  const inProgressCount = input.todos.filter((t) => t?.status === 'in_progress').length;
  if (inProgressCount > 1) {
    return {
      ok: false,
      error: `TodoWrite: apenas um item pode estar in_progress (recebi ${inProgressCount}).`,
    };
  }
  const next = store.write(input.todos);
  return { ok: true, todos: next };
}
