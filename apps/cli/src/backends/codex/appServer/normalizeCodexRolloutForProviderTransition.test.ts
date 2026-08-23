import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  CodexProviderTransitionRolloutError,
  normalizeCodexRolloutForProviderTransition,
} from './normalizeCodexRolloutForProviderTransition';

let root = '';
let rolloutPath = '';

function line(type: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ timestamp: '2026-08-23T20:00:00.000Z', type, payload });
}

async function writeRollout(lines: readonly string[]): Promise<string> {
  const body = `${lines.join('\n')}\n`;
  await writeFile(rolloutPath, body, 'utf8');
  return body;
}

async function readRollout(): Promise<Array<Record<string, any>>> {
  const body = await readFile(rolloutPath, 'utf8');
  return body
    .trimEnd()
    .split('\n')
    .map((entry) => JSON.parse(entry) as Record<string, any>);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'codex-provider-transition-'));
  rolloutPath = join(root, 'rollout.jsonl');
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('normalizeCodexRolloutForProviderTransition', () => {
  it('keeps a same-provider rollout byte-for-byte unchanged', async () => {
    const original = await writeRollout([
      line('session_meta', { id: 'thread-1', model_provider: 'openrouter' }),
      line('response_item', {
        id: 'rs_openrouter',
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'private reasoning' }],
        encrypted_content: null,
      }),
    ]);

    await expect(normalizeCodexRolloutForProviderTransition({
      rolloutPath,
      targetModelProvider: 'openrouter',
    })).resolves.toEqual({
      status: 'same_provider',
      sourceModelProvider: 'openrouter',
      targetModelProvider: 'openrouter',
    });
    await expect(readFile(rolloutPath, 'utf8')).resolves.toBe(original);
  });

  it('neutralizes provider-owned reasoning and item ids while preserving tool call pairs', async () => {
    await writeRollout([
      line('session_meta', { id: 'thread-1', model_provider: 'openrouter' }),
      line('response_item', {
        id: 'rs_openrouter',
        type: 'reasoning',
        summary: [],
        content: [{ type: 'reasoning_text', text: 'private reasoning' }],
        encrypted_content: null,
      }),
      line('response_item', {
        id: 'fc_openrouter',
        type: 'function_call',
        name: 'example',
        arguments: '{}',
        call_id: 'call_shared',
      }),
      line('response_item', {
        id: 'fco_openrouter',
        type: 'function_call_output',
        call_id: 'call_shared',
        output: 'ok',
      }),
      line('response_item', {
        id: 'msg_openrouter',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'visible answer' }],
      }),
      line('compacted', {
        message: 'summary',
        replacement_history: [
          {
            id: 'rs_nested',
            type: 'reasoning',
            summary: [],
            content: [{ type: 'reasoning_text', text: 'nested private reasoning' }],
            encrypted_content: null,
          },
          {
            id: 'msg_nested',
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'visible summary' }],
          },
        ],
      }),
    ]);

    await expect(normalizeCodexRolloutForProviderTransition({
      rolloutPath,
      targetModelProvider: 'openai',
    })).resolves.toEqual({
      status: 'normalized',
      sourceModelProvider: 'openrouter',
      targetModelProvider: 'openai',
      clearedItemIds: 6,
      clearedReasoningContents: 2,
      clearedEncryptedReasoningItems: 0,
    });

    const records = await readRollout();
    expect(records[0].payload.model_provider).toBe('openai');
    expect(records[1].payload).toMatchObject({
      type: 'reasoning',
      summary: [],
      content: [],
      encrypted_content: null,
    });
    expect(records[1].payload).not.toHaveProperty('id');
    expect(records[2].payload).not.toHaveProperty('id');
    expect(records[2].payload.call_id).toBe('call_shared');
    expect(records[3].payload).not.toHaveProperty('id');
    expect(records[3].payload.call_id).toBe('call_shared');
    expect(records[4].payload.content[0].text).toBe('visible answer');
    expect(records[5].payload.replacement_history[0]).toMatchObject({
      type: 'reasoning',
      content: [],
      encrypted_content: null,
    });
    expect(records[5].payload.replacement_history[0]).not.toHaveProperty('id');
    expect(records[5].payload.replacement_history[1].content[0].text).toBe('visible summary');
  });

  it('removes foreign encrypted reasoning when returning to a custom provider', async () => {
    await writeRollout([
      line('session_meta', { id: 'thread-1', model_provider: 'openai' }),
      line('response_item', {
        id: 'rs_openai',
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: 'safe summary' }],
        encrypted_content: 'provider-owned-ciphertext',
      }),
    ]);

    await expect(normalizeCodexRolloutForProviderTransition({
      rolloutPath,
      targetModelProvider: 'openrouter',
    })).resolves.toMatchObject({
      status: 'normalized',
      sourceModelProvider: 'openai',
      targetModelProvider: 'openrouter',
      clearedItemIds: 1,
      clearedReasoningContents: 0,
      clearedEncryptedReasoningItems: 1,
    });

    const records = await readRollout();
    expect(records[1].payload).toEqual({
      type: 'reasoning',
      summary: [{ type: 'summary_text', text: 'safe summary' }],
      content: [],
      encrypted_content: null,
    });
  });

  it('preserves the rollout mode after an atomic rewrite', async () => {
    await writeRollout([
      line('session_meta', { id: 'thread-1', model_provider: 'openrouter' }),
      line('response_item', {
        id: 'msg_openrouter',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      }),
    ]);
    await chmod(rolloutPath, 0o640);

    await normalizeCodexRolloutForProviderTransition({
      rolloutPath,
      targetModelProvider: 'openai',
    });

    expect((await stat(rolloutPath)).mode & 0o777).toBe(0o640);
  });

  it('leaves the original untouched when any JSONL record is invalid', async () => {
    const original = await writeRollout([
      line('session_meta', { id: 'thread-1', model_provider: 'openrouter' }),
      '{invalid-json',
    ]);

    await expect(normalizeCodexRolloutForProviderTransition({
      rolloutPath,
      targetModelProvider: 'openai',
    })).rejects.toMatchObject({
      name: 'CodexProviderTransitionRolloutError',
      code: 'invalid_jsonl',
    } satisfies Partial<CodexProviderTransitionRolloutError>);
    await expect(readFile(rolloutPath, 'utf8')).resolves.toBe(original);
  });

  it('does not guess provenance when session metadata has no provider', async () => {
    const original = await writeRollout([
      line('session_meta', { id: 'thread-1' }),
      line('response_item', {
        id: 'msg_unknown',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'answer' }],
      }),
    ]);

    await expect(normalizeCodexRolloutForProviderTransition({
      rolloutPath,
      targetModelProvider: 'openai',
    })).resolves.toEqual({
      status: 'missing_source_provider',
      targetModelProvider: 'openai',
    });
    await expect(readFile(rolloutPath, 'utf8')).resolves.toBe(original);
  });
});
