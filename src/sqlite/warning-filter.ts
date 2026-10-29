/**
 * Node 22/24 print an ExperimentalWarning on stderr when node:sqlite loads. Drop only that warning;
 * everything else (including other experimental warnings) is passed through untouched. Never writes to stdout.
 */
export function isSqliteExperimentalWarning(warning: unknown, type?: unknown): boolean {
  const name = warning instanceof Error
    ? warning.name
    : typeof type === 'string' ? type : typeof type === 'object' && type !== null ? String((type as { type?: unknown }).type ?? '') : '';
  const message = warning instanceof Error ? warning.message : typeof warning === 'string' ? warning : '';
  return name === 'ExperimentalWarning' && /SQLite/i.test(message);
}

type EmitWarning = typeof process.emitWarning;
const installed = Symbol.for('youtube-mcp.sqlite-warning-filter');

export function suppressSqliteExperimentalWarning(target: NodeJS.Process = process): void {
  const marked = target as unknown as Record<symbol, boolean>;
  if (marked[installed]) return;
  marked[installed] = true;
  const original: EmitWarning = target.emitWarning.bind(target);
  target.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    if (isSqliteExperimentalWarning(warning, rest[0])) return;
    return (original as (...args: unknown[]) => void)(warning, ...rest);
  }) as EmitWarning;
}
