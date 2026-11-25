/**
 * Classifies pi tool calls. pi's built-in tools are lower-case (`bash`, `edit`, `write`, `read`,
 * `grep`, `find`, `ls`, `powershell`) and take `{ command }` or `{ path }`; names are matched
 * exactly and case-sensitively, so `Bash` is an unknown tool and gets gated, not exempted.
 */
export type ToolKind = 'exempt' | 'shell' | 'edit' | 'powershell' | 'mcp' | 'unknown';

export interface ToolDescriptor {
  readonly kind: ToolKind;
  readonly name: string;
  /** The claude-code tool name the shared guard understands, for shell and edit tools. */
  readonly guardTool?: 'Bash' | 'Edit' | 'Write';
  readonly command?: string;
  readonly path?: string;
}

const EXEMPT = new Set(['read', 'grep', 'find', 'ls', 'tool_search', 'codemode']);

function text(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** Classify a pi tool call by its exact name; `command`/`path` are set only when strings. */
export function classifyTool(name: string, input: Record<string, unknown>): ToolDescriptor {
  if (EXEMPT.has(name)) {
    return { kind: 'exempt', name };
  }
  switch (name) {
    case 'bash':
      return withField({ kind: 'shell', name, guardTool: 'Bash' }, 'command', input['command']);
    case 'edit':
      return withField({ kind: 'edit', name, guardTool: 'Edit' }, 'path', input['path']);
    case 'write':
      return withField({ kind: 'edit', name, guardTool: 'Write' }, 'path', input['path']);
    case 'powershell':
      return withField({ kind: 'powershell', name }, 'command', input['command']);
    default:
      return { kind: name.startsWith('mcp__') ? 'mcp' : 'unknown', name };
  }
}

function withField(
  base: ToolDescriptor,
  field: 'command' | 'path',
  value: unknown,
): ToolDescriptor {
  const found = text(value);
  return found === undefined ? base : { ...base, [field]: found };
}

/**
 * The claude-code-shaped input the shared core helpers read: `{ command }` for a shell tool and
 * `{ file_path }` for an edit tool; undefined when the call has no usable string.
 */
export function mappedInput(d: ToolDescriptor): Record<string, unknown> | undefined {
  if (d.kind === 'shell' && d.command !== undefined) {
    return { command: d.command };
  }
  if (d.kind === 'edit' && d.path !== undefined) {
    return { file_path: d.path };
  }
  return undefined;
}
