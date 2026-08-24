import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join, resolve as resolvePath } from 'node:path';
import { URL } from 'node:url';

import { resolveCodexCliInvocation } from '../utils/resolveCodexCliInvocation';
import { resolveConfiguredCodexHome } from '../utils/resolveConfiguredCodexHome';
import { CODEX_OPENROUTER_PROFILE_NAME } from './openrouterProfile';

const OPENROUTER_API_KEY_ENV_VAR = 'OPENROUTER_API_KEY';
const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models';
const MANAGED_CATALOG_FILE_NAME = 'openrouter-models.json';

export type CodexOpenRouterMachineConfigurationState =
  | 'ready'
  | 'needs_configuration'
  | 'invalid';

export type CodexOpenRouterMachineConfiguration = Readonly<{
  state: CodexOpenRouterMachineConfigurationState;
  code: string;
  message: string;
  profileName: string;
  canConfigure: boolean;
  modelCount?: number;
}>;

export class CodexOpenRouterConfigurationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'CodexOpenRouterConfigurationError';
  }
}

type OpenRouterFetchResponse = Readonly<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export type OpenRouterFetch = (
  url: string,
  options?: Readonly<{ headers?: Readonly<Record<string, string>> }>,
) => Promise<OpenRouterFetchResponse>;

export type ConfigureCodexOpenRouterMachineOptions = Readonly<{
  processEnv: NodeJS.ProcessEnv;
  fetchImpl?: OpenRouterFetch;
  resolveCodexVersion?: (processEnv: NodeJS.ProcessEnv) => Promise<string>;
  publicModelsUrl?: string;
  codexModelsUrl?: string;
}>;

type OpenRouterCatalog = Readonly<{ models: ReadonlyArray<Record<string, unknown>> }>;

function result(
  state: CodexOpenRouterMachineConfigurationState,
  code: string,
  message: string,
  options: Readonly<{ canConfigure?: boolean; modelCount?: number }> = {},
): CodexOpenRouterMachineConfiguration {
  return {
    state,
    code,
    message,
    profileName: CODEX_OPENROUTER_PROFILE_NAME,
    canConfigure: options.canConfigure ?? state !== 'ready',
    ...(options.modelCount === undefined ? {} : { modelCount: options.modelCount }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isZeroPrice(value: unknown): boolean {
  if ((typeof value !== 'string' && typeof value !== 'number') || String(value).trim() === '') {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed === 0;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const PUBLISHED_EFFORT_ORDER = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];

function highestPublishedEffort(levels: ReadonlyArray<Record<string, unknown>>): string | null {
  let highest: string | null = null;
  let highestRank = -1;
  for (const level of levels) {
    const effort = level.effort;
    if (typeof effort !== 'string') continue;
    const rank = PUBLISHED_EFFORT_ORDER.indexOf(effort.toLowerCase());
    if (rank > highestRank) {
      highest = effort;
      highestRank = rank;
    }
  }
  if (highest !== null) return highest;
  const fallback = levels.at(-1)?.effort;
  return typeof fallback === 'string' ? fallback : null;
}

function hasPlaintextOpenRouterToken(value: string): boolean {
  return (
    /sk-or-[A-Za-z0-9_-]{8,}/.test(value) ||
    /^\s*OPENROUTER_API_KEY\s*=/m.test(value)
  );
}

function managedProfilePath(processEnv: NodeJS.ProcessEnv): string {
  return join(resolveConfiguredCodexHome(processEnv), `${CODEX_OPENROUTER_PROFILE_NAME}.config.toml`);
}

function managedCatalogPath(processEnv: NodeJS.ProcessEnv): string {
  return join(resolveConfiguredCodexHome(processEnv), MANAGED_CATALOG_FILE_NAME);
}

function parseTomlStringLiteral(raw: string): string | null {
  const value = raw.replace(/\s+#.*$/, '').trim();
  if (value.startsWith('"')) {
    try {
      const parsed = JSON.parse(value);
      return typeof parsed === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return null;
}

function readTomlString(
  text: string,
  key: string,
  tableName?: string,
): string | null {
  let activeTable: string | null = null;
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const tableMatch = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (tableMatch) {
      activeTable = tableMatch[1]?.trim() ?? null;
      continue;
    }
    if ((tableName === undefined && activeTable !== null) || activeTable !== (tableName ?? null)) {
      continue;
    }
    const keyMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (keyMatch?.[1] !== key) continue;
    return parseTomlStringLiteral(keyMatch[2] ?? '');
  }
  return null;
}

function parseCatalog(raw: string): OpenRouterCatalog | null {
  try {
    const parsed = JSON.parse(raw);
    if (!isRecord(parsed) || !Array.isArray(parsed.models) || parsed.models.length === 0) {
      return null;
    }
    const models: Record<string, unknown>[] = [];
    for (const model of parsed.models) {
      if (!isRecord(model) || typeof model.slug !== 'string' || model.slug.trim() === '') {
        return null;
      }
      models.push(model);
    }
    return { models };
  } catch {
    return null;
  }
}

async function readOptionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function readOptionalBuffer(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function profilesUseSameCatalog(configuredPath: string, expectedPath: string): boolean {
  return resolvePath(configuredPath) === resolvePath(expectedPath);
}

export async function inspectCodexOpenRouterMachineConfiguration(params: Readonly<{
  processEnv: NodeJS.ProcessEnv;
}>): Promise<CodexOpenRouterMachineConfiguration> {
  const profilePath = managedProfilePath(params.processEnv);
  const expectedCatalogPath = managedCatalogPath(params.processEnv);
  let profileText: string | null;
  try {
    profileText = await readOptionalText(profilePath);
  } catch {
    return result(
      'invalid',
      'openrouter-profile-unreadable',
      'Nie można odczytać profilu OpenRoutera Codeksa na tej maszynie.',
    );
  }
  if (profileText === null) {
    return result(
      'needs_configuration',
      'openrouter-profile-missing',
      'Ta maszyna nie ma jeszcze profilu OpenRoutera dla Codeksa.',
    );
  }
  if (hasPlaintextOpenRouterToken(profileText)) {
    return result(
      'invalid',
      'openrouter-profile-contains-plaintext-secret',
      'Profil OpenRoutera zawiera klucz w plaintext. Usuń go przed konfiguracją i użyj Saved Secret.',
      { canConfigure: false },
    );
  }

  if (readTomlString(profileText, 'model_provider') !== 'openrouter') {
    return result(
      'invalid',
      'openrouter-provider-not-selected',
      'Profil OpenRoutera nie wybiera providera OpenRouter.',
    );
  }
  const catalogPath = readTomlString(profileText, 'model_catalog_json');
  if (!catalogPath || !profilesUseSameCatalog(catalogPath, expectedCatalogPath)) {
    return result(
      'invalid',
      'openrouter-catalog-not-managed',
      'Profil OpenRoutera nie wskazuje zarządzanego katalogu darmowych modeli.',
    );
  }
  if (
    readTomlString(profileText, 'name', 'model_providers.openrouter') !== 'OpenRouter' ||
    readTomlString(profileText, 'base_url', 'model_providers.openrouter') !==
      'https://openrouter.ai/api/v1' ||
    readTomlString(profileText, 'env_key', 'model_providers.openrouter') !==
      OPENROUTER_API_KEY_ENV_VAR ||
    readTomlString(profileText, 'wire_api', 'model_providers.openrouter') !== 'responses'
  ) {
    return result(
      'invalid',
      'openrouter-provider-incomplete',
      'Profil OpenRoutera nie ma kompletnej konfiguracji providera.',
    );
  }

  let catalogText: string | null;
  try {
    catalogText = await readOptionalText(expectedCatalogPath);
  } catch {
    return result(
      'invalid',
      'openrouter-catalog-unreadable',
      'Nie można odczytać katalogu darmowych modeli OpenRoutera.',
    );
  }
  if (catalogText === null) {
    return result(
      'invalid',
      'openrouter-catalog-missing',
      'Brakuje katalogu darmowych modeli OpenRoutera.',
    );
  }
  const catalog = parseCatalog(catalogText);
  if (catalog === null) {
    return result(
      'invalid',
      'openrouter-catalog-invalid',
      'Katalog darmowych modeli OpenRoutera jest niepoprawny.',
    );
  }
  return result('ready', 'ready', 'OpenRouter jest gotowy na tej maszynie.', {
    canConfigure: false,
    modelCount: catalog.models.length,
  });
}

function cloneModel(value: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
}

export function transformCodexOpenRouterCatalog(
  publicRoot: unknown,
  codexRoot: unknown,
): OpenRouterCatalog {
  if (!isRecord(publicRoot) || !Array.isArray(publicRoot.data)) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-public-catalog-invalid',
      'Publiczny katalog modeli OpenRoutera ma niepoprawny format.',
    );
  }
  if (!isRecord(codexRoot) || !Array.isArray(codexRoot.models)) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-codex-catalog-invalid',
      'Katalog kompatybilności Codeksa z OpenRouterem ma niepoprawny format.',
    );
  }

  const freeModels: Array<{ id: string; created: number }> = [];
  const publicIds = new Set<string>();
  for (const rawModel of publicRoot.data) {
    if (!isRecord(rawModel)) continue;
    const pricing = isRecord(rawModel.pricing) ? rawModel.pricing : null;
    if (!pricing || !isZeroPrice(pricing.prompt) || !isZeroPrice(pricing.completion)) {
      continue;
    }
    const id = typeof rawModel.id === 'string' ? rawModel.id.trim() : '';
    if (!id) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-public-model-invalid',
        'Darmowy model OpenRoutera nie ma poprawnego identyfikatora.',
      );
    }
    const created = rawModel.created;
    if (typeof created !== 'number' || !Number.isFinite(created)) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-public-model-invalid',
        `Darmowy model ${id} nie ma poprawnego czasu publikacji.`,
      );
    }
    if (publicIds.has(id)) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-public-model-duplicate',
        `Darmowy model ${id} występuje w katalogu więcej niż raz.`,
      );
    }
    publicIds.add(id);
    freeModels.push({ id, created });
  }
  if (freeModels.length === 0) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-public-catalog-empty',
      'Publiczny katalog OpenRoutera nie zawiera darmowych modeli.',
    );
  }
  freeModels.sort((left, right) => right.created - left.created || compareText(left.id, right.id));

  const codexBySlug = new Map<string, Record<string, unknown>[]>();
  for (const rawModel of codexRoot.models) {
    if (!isRecord(rawModel) || typeof rawModel.slug !== 'string') continue;
    const matches = codexBySlug.get(rawModel.slug) ?? [];
    matches.push(rawModel);
    codexBySlug.set(rawModel.slug, matches);
  }

  const models = freeModels.map(({ id }, priority) => {
    const matches = codexBySlug.get(id) ?? [];
    if (matches.length !== 1) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-missing',
        `Brakuje jednoznacznej definicji Codeksa dla darmowego modelu ${id}.`,
      );
    }
    const model = cloneModel(matches[0]!);
    if (model.supported_in_api !== true || model.visibility !== 'list') {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-unavailable',
        `Model ${id} nie jest dostępny w katalogu API Codeksa.`,
      );
    }
    if (typeof model.base_instructions !== 'string' || model.base_instructions.trim() === '') {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-invalid',
        `Model ${id} nie ma instrukcji bazowych wymaganych przez Codeks.`,
      );
    }
    if (!Array.isArray(model.supported_reasoning_levels)) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-invalid',
        `Model ${id} nie ma poprawnych poziomów effortu.`,
      );
    }
    if (
      model.default_reasoning_level !== null &&
      model.default_reasoning_level !== undefined &&
      typeof model.default_reasoning_level !== 'string'
    ) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-invalid',
        `Model ${id} ma niepoprawny domyślny effort.`,
      );
    }

    if (model.default_reasoning_level === 'xhigh') {
      model.default_reasoning_level = 'max';
    }
    const levels = model.supported_reasoning_levels.map((rawLevel) => {
      if (!isRecord(rawLevel) || typeof rawLevel.effort !== 'string') {
        throw new CodexOpenRouterConfigurationError(
          'openrouter-codex-model-invalid',
          `Model ${id} ma niepoprawny poziom effortu.`,
        );
      }
      return rawLevel.effort === 'xhigh'
        ? { ...rawLevel, effort: 'max' }
        : rawLevel;
    });
    const efforts = levels.map((level) => level.effort as string);
    if (new Set(efforts).size !== efforts.length) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-invalid',
        `Model ${id} ma powielone poziomy effortu.`,
      );
    }
    if (
      model.default_reasoning_level !== null &&
      model.default_reasoning_level !== undefined &&
      !efforts.includes(model.default_reasoning_level as string)
    ) {
      throw new CodexOpenRouterConfigurationError(
        'openrouter-codex-model-invalid',
        `Model ${id} ma domyślny effort spoza opublikowanej listy.`,
      );
    }
    model.supported_reasoning_levels = levels;
    model.default_reasoning_level = highestPublishedEffort(levels);
    // Codex sorts ascending by priority. `freeModels` was sorted newest first.
    model.priority = priority;
    return model;
  });
  return { models };
}

function renderManagedOpenRouterProfile(
  original: string,
  catalogPath: string,
  catalog: OpenRouterCatalog,
): string {
  if (hasPlaintextOpenRouterToken(original)) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-profile-contains-plaintext-secret',
      'Profil OpenRoutera zawiera klucz w plaintext. Usuń go przed konfiguracją i użyj Saved Secret.',
    );
  }
  const defaultModel = catalog.models[0];
  if (!defaultModel || typeof defaultModel.slug !== 'string' || defaultModel.slug.trim() === '') {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-catalog-invalid',
      'Katalog darmowych modeli OpenRoutera nie ma modelu domyślnego.',
    );
  }
  const defaultEffort = defaultModel.default_reasoning_level;
  if (
    defaultEffort !== null &&
    defaultEffort !== undefined &&
    typeof defaultEffort !== 'string'
  ) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-catalog-invalid',
      'Domyślny model OpenRoutera ma niepoprawny effort.',
    );
  }

  const managedRootKeys = new Set([
    'model',
    'model_provider',
    'model_reasoning_effort',
    'model_catalog_json',
  ]);
  const kept: string[] = [];
  let seenTable = false;
  let skipManagedTable = false;
  for (const line of original.replace(/\r\n/g, '\n').split('\n')) {
    const tableMatch = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
    if (tableMatch) {
      seenTable = true;
      const tableName = tableMatch[1]?.trim() ?? '';
      skipManagedTable =
        tableName === 'model_providers.openrouter' ||
        tableName.startsWith('model_providers.openrouter.');
      if (skipManagedTable) continue;
    }
    if (skipManagedTable) continue;
    if (!seenTable) {
      const keyMatch = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/);
      if (keyMatch && managedRootKeys.has(keyMatch[1]!)) continue;
    }
    kept.push(line);
  }
  while (kept.length > 0 && kept[0]!.trim() === '') kept.shift();
  while (kept.length > 0 && kept.at(-1)!.trim() === '') kept.pop();

  const managedRoot = [
    `model = ${JSON.stringify(defaultModel.slug)}`,
    'model_provider = "openrouter"',
    ...(defaultEffort === null || defaultEffort === undefined
      ? []
      : [`model_reasoning_effort = ${JSON.stringify(defaultEffort)}`]),
    `model_catalog_json = ${JSON.stringify(catalogPath)}`,
  ].join('\n');
  const managedProvider = [
    '[model_providers.openrouter]',
    'name = "OpenRouter"',
    'base_url = "https://openrouter.ai/api/v1"',
    `env_key = "${OPENROUTER_API_KEY_ENV_VAR}"`,
    'wire_api = "responses"',
  ].join('\n');
  const output = [managedRoot, kept.join('\n'), managedProvider]
    .filter((section) => section.trim().length > 0)
    .join('\n\n');
  if (hasPlaintextOpenRouterToken(output)) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-profile-contains-plaintext-secret',
      'Profil OpenRoutera zawiera klucz w plaintext. Usuń go przed konfiguracją i użyj Saved Secret.',
    );
  }
  return `${output}\n`;
}

async function runCodexVersion(processEnv: NodeJS.ProcessEnv): Promise<string> {
  const versionProcessEnv = { ...processEnv };
  delete versionProcessEnv[OPENROUTER_API_KEY_ENV_VAR];
  let invocation: Readonly<{ command: string; args: string[] }>;
  try {
    invocation = await resolveCodexCliInvocation({
      args: ['--version'],
      processEnv: versionProcessEnv,
      targetLabel: 'Codex CLI',
    });
  } catch {
    throw new CodexOpenRouterConfigurationError(
      'codex-cli-unavailable',
      'Codex CLI nie jest dostępny na tej maszynie.',
    );
  }
  const output = await new Promise<string>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(invocation.command, invocation.args, {
      env: versionProcessEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const settle = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      callback();
    };
    const timeout = setTimeout(() => {
      child.kill();
      settle(() => reject(new Error('timed out')));
    }, 15_000);
    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on('error', () => settle(() => reject(new Error('spawn failed'))));
    child.on('close', (code) => {
      if (code === 0) {
        settle(() => resolve(`${stdout}\n${stderr}`));
      } else {
        settle(() => reject(new Error('non-zero exit')));
      }
    });
  }).catch(() => {
    throw new CodexOpenRouterConfigurationError(
      'codex-cli-unavailable',
      'Codex CLI nie jest dostępny na tej maszynie.',
    );
  });
  const versions = output.match(/\b[0-9][0-9A-Za-z.+-]*\b/g) ?? [];
  const version = versions.at(-1) ?? '';
  if (!version) {
    throw new CodexOpenRouterConfigurationError(
      'codex-version-invalid',
      'Nie można odczytać wersji Codexa na tej maszynie.',
    );
  }
  return version;
}

async function readJsonResponse(
  fetchImpl: OpenRouterFetch,
  url: string,
  headers?: Readonly<Record<string, string>>,
): Promise<unknown> {
  let response: OpenRouterFetchResponse;
  try {
    response = await fetchImpl(url, headers ? { headers } : undefined);
  } catch {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-catalog-unavailable',
      'Nie można pobrać bieżącego katalogu modeli OpenRoutera.',
    );
  }
  if (!response.ok) {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-catalog-unavailable',
      'OpenRouter nie udostępnił bieżącego katalogu modeli.',
    );
  }
  try {
    return await response.json();
  } catch {
    throw new CodexOpenRouterConfigurationError(
      'openrouter-catalog-invalid',
      'OpenRouter zwrócił niepoprawny katalog modeli.',
    );
  }
}

async function fetchCurrentCodexOpenRouterCatalog(
  params: ConfigureCodexOpenRouterMachineOptions,
): Promise<OpenRouterCatalog> {
  const fetchImpl: OpenRouterFetch = params.fetchImpl ?? (async (url, options) => {
    const headers = options?.headers === undefined ? undefined : { ...options.headers };
    return await fetch(url, headers === undefined ? undefined : { headers });
  });
  const version = await (params.resolveCodexVersion ?? runCodexVersion)(params.processEnv);
  const publicModelsUrl = params.publicModelsUrl ?? OPENROUTER_MODELS_URL;
  const codexUrl = new URL(params.codexModelsUrl ?? OPENROUTER_MODELS_URL);
  codexUrl.searchParams.set('client_version', version);
  const [publicRoot, codexRoot] = await Promise.all([
    readJsonResponse(fetchImpl, publicModelsUrl),
    readJsonResponse(fetchImpl, codexUrl.toString(), {
      originator: 'codex_cli_rs',
      'User-Agent': `codex_cli_rs/${version} happier`,
    }),
  ]);
  return transformCodexOpenRouterCatalog(publicRoot, codexRoot);
}

async function replaceManagedCatalog(
  codexHome: string,
  catalogPath: string,
  catalog: OpenRouterCatalog,
): Promise<void> {
  await mkdir(codexHome, { recursive: true, mode: 0o700 });
  const stagedCatalogPath = join(
    codexHome,
    `.${MANAGED_CATALOG_FILE_NAME}.${randomUUID()}`,
  );
  try {
    await writeFile(stagedCatalogPath, `${JSON.stringify(catalog, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await chmod(stagedCatalogPath, 0o600);
    await rename(stagedCatalogPath, catalogPath);
  } finally {
    await rm(stagedCatalogPath, { force: true });
  }
}

// Odświeża katalog najwyżej raz na dobę, tuż przed sondą modeli. Błąd sieci
// zwraca się do wywołującego, który zachowuje poprzedni poprawny katalog.
export async function refreshCodexOpenRouterCatalogIfStale(
  params: ConfigureCodexOpenRouterMachineOptions & Readonly<{ maxAgeMs?: number }>,
): Promise<boolean> {
  const configuration = await inspectCodexOpenRouterMachineConfiguration({
    processEnv: params.processEnv,
  });
  if (configuration.state !== 'ready') return false;
  const catalogPath = managedCatalogPath(params.processEnv);
  const maxAgeMs = Math.max(0, params.maxAgeMs ?? 24 * 60 * 60 * 1000);
  try {
    const metadata = await stat(catalogPath);
    if (Date.now() - metadata.mtimeMs < maxAgeMs) return false;
  } catch {
    // The validation above observed a usable file. A concurrent replacement is
    // harmless; fetching a fresh catalog is safer than treating its timestamp
    // as authoritative.
  }
  const catalog = await fetchCurrentCodexOpenRouterCatalog(params);
  await replaceManagedCatalog(
    resolveConfiguredCodexHome(params.processEnv),
    catalogPath,
    catalog,
  );
  return true;
}

async function restoreCatalog(path: string, original: Buffer | null): Promise<void> {
  if (original === null) {
    await rm(path, { force: true });
    return;
  }
  const stagedPath = `${path}.restore-${randomUUID()}`;
  try {
    await writeFile(stagedPath, original, { mode: 0o600 });
    await chmod(stagedPath, 0o600);
    await rename(stagedPath, path);
  } finally {
    await rm(stagedPath, { force: true });
  }
}

export async function configureCodexOpenRouterMachine(
  params: ConfigureCodexOpenRouterMachineOptions,
): Promise<CodexOpenRouterMachineConfiguration> {
  const processEnv = params.processEnv;
  const codexHome = resolveConfiguredCodexHome(processEnv);
  const profilePath = managedProfilePath(processEnv);
  const catalogPath = managedCatalogPath(processEnv);
  try {
    const before = await inspectCodexOpenRouterMachineConfiguration({ processEnv });
    if (before.code === 'openrouter-profile-contains-plaintext-secret') {
      throw new CodexOpenRouterConfigurationError(before.code, before.message);
    }
    const catalog = await fetchCurrentCodexOpenRouterCatalog(params);
    const existingProfile = (await readOptionalText(profilePath)) ?? '';
    const profile = renderManagedOpenRouterProfile(existingProfile, catalogPath, catalog);
    const catalogText = `${JSON.stringify(catalog, null, 2)}\n`;

    await mkdir(codexHome, { recursive: true, mode: 0o700 });
    const suffix = randomUUID();
    const stagedCatalogPath = join(codexHome, `.${MANAGED_CATALOG_FILE_NAME}.${suffix}`);
    const stagedProfilePath = join(
      codexHome,
      `.${CODEX_OPENROUTER_PROFILE_NAME}.config.toml.${suffix}`,
    );
    const previousCatalog = await readOptionalBuffer(catalogPath);
    try {
      await writeFile(stagedCatalogPath, catalogText, { encoding: 'utf8', mode: 0o600 });
      await writeFile(stagedProfilePath, profile, { encoding: 'utf8', mode: 0o600 });
      await chmod(stagedCatalogPath, 0o600);
      await chmod(stagedProfilePath, 0o600);
      await rename(stagedCatalogPath, catalogPath);
      try {
        await rename(stagedProfilePath, profilePath);
      } catch (error) {
        await restoreCatalog(catalogPath, previousCatalog).catch(() => undefined);
        throw error;
      }
    } finally {
      await rm(stagedCatalogPath, { force: true });
      await rm(stagedProfilePath, { force: true });
    }
    const configured = await inspectCodexOpenRouterMachineConfiguration({ processEnv });
    if (configured.state !== 'ready') {
      throw new CodexOpenRouterConfigurationError(
        configured.code,
        'Profil OpenRoutera został zapisany, ale nie przeszedł własnej walidacji.',
      );
    }
    return configured;
  } catch (error) {
    if (error instanceof CodexOpenRouterConfigurationError) throw error;
    throw new CodexOpenRouterConfigurationError(
      'openrouter-configuration-failed',
      'Nie udało się skonfigurować OpenRoutera na tej maszynie.',
    );
  }
}
