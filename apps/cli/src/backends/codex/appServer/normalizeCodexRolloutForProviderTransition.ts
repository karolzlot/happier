import { randomUUID } from 'node:crypto';
import { chmod, chown, open, readFile, rename, stat, unlink } from 'node:fs/promises';

import { resolveCodexNativeSessionLogPath } from '../utils/resolveCodexNativeSessionLogPath';

type JsonRecord = Record<string, unknown>;

type ProviderTransitionCounters = {
  clearedItemIds: number;
  clearedReasoningContents: number;
  clearedEncryptedReasoningItems: number;
};

export type CodexProviderTransitionRolloutResult =
  | Readonly<{
      status: 'same_provider';
      sourceModelProvider: string;
      targetModelProvider: string;
    }>
  | Readonly<{
      status: 'missing_source_provider';
      targetModelProvider: string;
    }>
  | Readonly<{
      status: 'normalized';
      sourceModelProvider: string;
      targetModelProvider: string;
      clearedItemIds: number;
      clearedReasoningContents: number;
      clearedEncryptedReasoningItems: number;
    }>;

export class CodexProviderTransitionRolloutError extends Error {
  constructor(
    readonly code: 'invalid_jsonl' | 'invalid_target_provider',
    message: string,
  ) {
    super(message);
    this.name = 'CodexProviderTransitionRolloutError';
  }
}

function readRecord(value: unknown): JsonRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function readNonBlankString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function normalizeResponseItem(
  item: JsonRecord,
  counters: ProviderTransitionCounters,
): boolean {
  let changed = false;
  if (hasOwn(item, 'id')) {
    if (item.id !== null && item.id !== undefined) {
      counters.clearedItemIds += 1;
    }
    delete item.id;
    changed = true;
  }

  if (item.type !== 'reasoning') return changed;

  if (Array.isArray(item.content) && item.content.length > 0) {
    counters.clearedReasoningContents += 1;
  }
  if (!Array.isArray(item.content) || item.content.length > 0) {
    item.content = [];
    changed = true;
  }

  if (readNonBlankString(item.encrypted_content)) {
    counters.clearedEncryptedReasoningItems += 1;
    item.encrypted_content = null;
    changed = true;
  }
  return changed;
}

function normalizeReplacementHistory(
  payload: JsonRecord,
  counters: ProviderTransitionCounters,
): boolean {
  if (!Array.isArray(payload.replacement_history)) return false;
  let changed = false;
  for (const value of payload.replacement_history) {
    const item = readRecord(value);
    if (item && normalizeResponseItem(item, counters)) {
      changed = true;
    }
  }
  return changed;
}

type ParsedJsonlLine = {
  body: string;
  eol: string;
  value: JsonRecord | null;
  changed: boolean;
};

function splitJsonl(source: string): Array<Readonly<{ body: string; eol: string }>> {
  const lines: Array<Readonly<{ body: string; eol: string }>> = [];
  let start = 0;
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] !== '\n') continue;
    const hasCarriageReturn = index > start && source[index - 1] === '\r';
    lines.push({
      body: source.slice(start, hasCarriageReturn ? index - 1 : index),
      eol: hasCarriageReturn ? '\r\n' : '\n',
    });
    start = index + 1;
  }
  if (start < source.length) {
    lines.push({ body: source.slice(start), eol: '' });
  }
  return lines;
}

function parseJsonl(source: string): ParsedJsonlLine[] {
  return splitJsonl(source).map((line, index) => {
    if (line.body.trim().length === 0) {
      return { ...line, value: null, changed: false };
    }
    try {
      const value = readRecord(JSON.parse(line.body));
      if (!value) throw new Error('record is not an object');
      return { ...line, value, changed: false };
    } catch {
      throw new CodexProviderTransitionRolloutError(
        'invalid_jsonl',
        `Codex rollout contains invalid JSONL at line ${index + 1}`,
      );
    }
  });
}

async function replaceFileAtomically(params: Readonly<{
  path: string;
  contents: string;
}>): Promise<void> {
  const originalStat = await stat(params.path);
  const temporaryPath = `${params.path}.happier-provider-transition-${process.pid}-${randomUUID()}.tmp`;
  const mode = originalStat.mode & 0o777;
  let handle: Awaited<ReturnType<typeof open>> | null = null;
  try {
    handle = await open(temporaryPath, 'wx', mode);
    await handle.writeFile(params.contents, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    await chmod(temporaryPath, mode);
    if (process.platform !== 'win32') {
      await chown(temporaryPath, originalStat.uid, originalStat.gid);
    }
    await rename(temporaryPath, params.path);
  } catch (error) {
    if (handle) {
      await handle.close().catch(() => undefined);
    }
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function normalizeCodexRolloutForProviderTransition(params: Readonly<{
  rolloutPath: string;
  targetModelProvider: string;
}>): Promise<CodexProviderTransitionRolloutResult> {
  const targetModelProvider = readNonBlankString(params.targetModelProvider);
  if (!targetModelProvider) {
    throw new CodexProviderTransitionRolloutError(
      'invalid_target_provider',
      'Codex provider transition requires a non-empty target provider',
    );
  }

  const source = await readFile(params.rolloutPath, 'utf8');
  const lines = parseJsonl(source);
  const sessionMetadataLine = lines.find((line) => line.value?.type === 'session_meta');
  const sessionMetadataPayload = readRecord(sessionMetadataLine?.value?.payload);
  const sourceModelProvider = readNonBlankString(sessionMetadataPayload?.model_provider);
  if (!sourceModelProvider) {
    return {
      status: 'missing_source_provider',
      targetModelProvider,
    };
  }
  if (sourceModelProvider === targetModelProvider) {
    return {
      status: 'same_provider',
      sourceModelProvider,
      targetModelProvider,
    };
  }

  const counters: ProviderTransitionCounters = {
    clearedItemIds: 0,
    clearedReasoningContents: 0,
    clearedEncryptedReasoningItems: 0,
  };
  for (const line of lines) {
    const record = line.value;
    if (!record) continue;
    if (record.type === 'session_meta') {
      const payload = readRecord(record.payload);
      if (payload && payload.model_provider !== targetModelProvider) {
        payload.model_provider = targetModelProvider;
        line.changed = true;
      }
    }
    if (record.type === 'response_item') {
      const payload = readRecord(record.payload);
      if (payload && normalizeResponseItem(payload, counters)) {
        line.changed = true;
      }
    }
    const payload = readRecord(record.payload);
    if (payload && normalizeReplacementHistory(payload, counters)) {
      line.changed = true;
    }
  }

  const output = lines
    .map((line) => `${line.changed ? JSON.stringify(line.value) : line.body}${line.eol}`)
    .join('');
  await replaceFileAtomically({ path: params.rolloutPath, contents: output });
  return {
    status: 'normalized',
    sourceModelProvider,
    targetModelProvider,
    ...counters,
  };
}

export type PrepareCodexRolloutForProviderResumeResult =
  | Readonly<{ status: 'rollout_not_found' }>
  | Readonly<{ status: 'target_provider_unavailable' }>
  | CodexProviderTransitionRolloutResult;

type CodexAppServerConfigReader = Readonly<{
  request: (method: string, params?: unknown) => Promise<unknown>;
}>;

type ResolveCodexRolloutPath = typeof resolveCodexNativeSessionLogPath;
type NormalizeCodexRollout = typeof normalizeCodexRolloutForProviderTransition;

export async function prepareCodexRolloutForProviderResume(params: Readonly<{
  client: CodexAppServerConfigReader;
  vendorResumeId: string;
  cwd: string;
  processEnv?: NodeJS.ProcessEnv;
  resolveRolloutPath?: ResolveCodexRolloutPath;
  normalizeRollout?: NormalizeCodexRollout;
}>): Promise<PrepareCodexRolloutForProviderResumeResult> {
  const resolveRolloutPath = params.resolveRolloutPath ?? resolveCodexNativeSessionLogPath;
  const rolloutPath = await resolveRolloutPath({
    vendorResumeId: params.vendorResumeId,
    env: params.processEnv ?? process.env,
  });
  if (!rolloutPath) return { status: 'rollout_not_found' };

  const configReadResponse = readRecord(await params.client.request('config/read', {
    includeLayers: false,
    cwd: params.cwd,
  }));
  const config = readRecord(configReadResponse?.config);
  const targetModelProvider = readNonBlankString(config?.modelProvider);
  if (!targetModelProvider) return { status: 'target_provider_unavailable' };

  const normalizeRollout = params.normalizeRollout ?? normalizeCodexRolloutForProviderTransition;
  return await normalizeRollout({
    rolloutPath,
    targetModelProvider,
  });
}
