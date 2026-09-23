export type ToolScriptTransport = { kind: 'unix'; socketPath: string } | { kind: 'tcp'; host: string; port: number };

export interface PythonStubOptions {
  transport: ToolScriptTransport;
  token: string;
  enabledTools: readonly string[];
  clientTimeoutSeconds: number;
}

const TOOL_POSITIONAL_ARGS: Readonly<Record<string, readonly string[]>> = {
  read_file: ['path'],
  write_file: ['path', 'content'],
  edit: ['path', 'old_string', 'new_string'],
  grep: ['pattern', 'path'],
  search_files: ['pattern', 'path'],
  run_command: ['command'],
  mcp_invoke: ['server_id', 'tool_name', 'args'],
};

const PYTHON_IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const RESERVED_STUB_NAMES = new Set(['json_parse', 'shell_quote', 'retry', 'ToolError']);

export function assertValidStubToolName(name: string): void {
  if (!PYTHON_IDENTIFIER_RE.test(name)) {
    throw new Error(`nome de tool invalido para o stub Python: "${name}" (precisa ser identificador Python)`);
  }
  if (name.startsWith('_') || RESERVED_STUB_NAMES.has(name)) {
    throw new Error(`nome de tool "${name}" colide com built-in/interno do stub Python`);
  }
}

function pyString(value: string): string {
  return JSON.stringify(value);
}

function generateConnectFunction(transport: ToolScriptTransport): string {
  if (transport.kind === 'unix') {
    return [
      `_SOCKET_PATH = ${pyString(transport.socketPath)}`,
      '',
      '',
      'def _connect():',
      '    s = _socket.socket(_socket.AF_UNIX, _socket.SOCK_STREAM)',
      '    s.settimeout(_CLIENT_TIMEOUT_S)',
      '    s.connect(_SOCKET_PATH)',
      '    return s',
    ].join('\n');
  }
  return [
    `_HOST = ${pyString(transport.host)}`,
    `_PORT = ${String(transport.port)}`,
    '',
    '',
    'def _connect():',
    '    s = _socket.create_connection((_HOST, _PORT), timeout=_CLIENT_TIMEOUT_S)',
    '    s.settimeout(_CLIENT_TIMEOUT_S)',
    '    return s',
  ].join('\n');
}

function generateToolFunction(name: string): string {
  const positional = TOOL_POSITIONAL_ARGS[name] ?? [];
  const positionalTuple =
    positional.length === 0
      ? '()'
      : `(${positional.map((p) => pyString(p)).join(', ')}${positional.length === 1 ? ',' : ''})`;
  return [
    `def ${name}(*args, **kwargs):`,
    `    """Tool ${name} do LionClaw via RPC. Erro de tool vira ToolError."""`,
    `    return _call_tool(${pyString(name)}, ${positionalTuple}, args, kwargs)`,
  ].join('\n');
}

export function generateLionclawToolsStub(opts: PythonStubOptions): string {
  for (const tool of opts.enabledTools) {
    assertValidStubToolName(tool);
  }
  const timeoutSeconds = Math.max(0.1, opts.clientTimeoutSeconds);

  const header = [
    '# lionclaw_tools.py - GERADO por execucao pelo LionClaw Tool Script. Nao editar.',
    '# Socket e token sao POR EXECUCAO; este arquivo morre com o temp dir.',
    'import json as _json',
    'import shlex as _shlex',
    'import socket as _socket',
    'import threading as _threading',
    'import time as _time',
    '',
    `_TOKEN = ${pyString(opts.token)}`,
    `_CLIENT_TIMEOUT_S = ${timeoutSeconds.toFixed(3)}`,
    '',
    generateConnectFunction(opts.transport),
    '',
    '',
    'class ToolError(Exception):',
    '    """Erro de tool do LionClaw. Capturavel com try/except ou retry()."""',
    '',
    '',
    '_id_lock = _threading.Lock()',
    '_next_id = [0]',
    '',
    '',
    'def _new_id():',
    '    with _id_lock:',
    '        _next_id[0] += 1',
    '        return _next_id[0]',
    '',
    '',
    'def _rpc(tool, args):',
    '    rid = _new_id()',
    '    frame = _json.dumps({"id": rid, "tool": tool, "args": args, "token": _TOKEN}) + "\\n"',
    '    s = _connect()',
    '    try:',
    '        s.sendall(frame.encode("utf-8"))',
    '        buf = b""',
    '        while True:',
    '            while b"\\n" in buf:',
    '                line, buf = buf.split(b"\\n", 1)',
    '                if not line.strip():',
    '                    continue',
    '                resp = _json.loads(line.decode("utf-8"))',
    '                if resp.get("heartbeat"):',
    '                    # Guard pendente no LionClaw: relogio pausado, segue aguardando.',
    '                    continue',
    '                if resp.get("id") != rid:',
    '                    # Conexao e por chamada; frame de outro id e defensivo.',
    '                    continue',
    '                if resp.get("ok"):',
    '                    result = resp.get("result", "")',
    '                    return result if isinstance(result, str) else _json.dumps(result)',
    '                raise ToolError(str(resp.get("error") or ("erro desconhecido na tool %s" % tool)))',
    '            try:',
    '                chunk = s.recv(65536)',
    '            except _socket.timeout:',
    '                raise ToolError(',
    '                    "timeout aguardando resposta do LionClaw para %s (frame descartado ou RPC lenta)" % tool',
    '                )',
    '            if not chunk:',
    '                raise ToolError("conexao encerrada pelo LionClaw sem resposta para %s" % tool)',
    '            buf += chunk',
    '    finally:',
    '        s.close()',
    '',
    '',
    'def _call_tool(tool, positional_names, args, kwargs):',
    '    if len(args) > len(positional_names):',
    '        raise ToolError(',
    '            "%s: %d argumentos posicionais, maximo %d (%s); use kwargs"',
    '            % (tool, len(args), len(positional_names), ", ".join(positional_names) or "nenhum")',
    '        )',
    '    merged = dict(kwargs)',
    '    for name, value in zip(positional_names, args):',
    '        if name in merged:',
    '            raise ToolError("%s: argumento %r passado posicional E nomeado" % (tool, name))',
    '        merged[name] = value',
    '    return _rpc(tool, merged)',
    '',
  ].join('\n');

  const toolFunctions = opts.enabledTools.map((name) => generateToolFunction(name)).join('\n\n\n');

  const builtins = [
    'def json_parse(text):',
    '    """Parseia JSON (str) em objeto Python."""',
    '    return _json.loads(text)',
    '',
    '',
    'def shell_quote(value):',
    '    """Escapa um valor para uso seguro em linha de shell."""',
    '    return _shlex.quote(str(value))',
    '',
    '',
    'def retry(fn, attempts=3, delay=1.0, backoff=2.0):',
    '    """Reexecuta fn() ate suceder; ultima excecao propaga."""',
    '    last = None',
    '    for i in range(attempts):',
    '        try:',
    '            return fn()',
    '        except Exception as exc:  # noqa: BLE001 - retry generico por design',
    '            last = exc',
    '            if i < attempts - 1:',
    '                _time.sleep(delay)',
    '                delay *= backoff',
    '    raise last',
    '',
  ].join('\n');

  return `${header}\n\n${toolFunctions}\n\n\n${builtins}`;
}
