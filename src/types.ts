export type Provider = 'codex' | 'claude';
export type Ownership = 'external' | 'managed';
export type CollectionMode = 'default' | 'live' | 'cached';
export type Freshness = 'live' | 'cached' | 'stale' | 'expired' | 'unavailable';

export const ERROR_CODES = [
  'invalid_configuration',
  'missing_vendor_executable',
  'unsupported_vendor_version',
  'logged_out_account',
  'identity_mismatch',
  'timeout',
  'provider_failure',
  'parse_failure',
  'missing_cache',
  'expired_cache',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface UsageErrorData {
  code: ErrorCode;
  message: string;
  provider?: Provider;
  accountLabel?: string;
  retryable: boolean;
  details?: Record<string, boolean | number | string | null>;
}

export interface QuotaWindow {
  id: string;
  label?: string;
  usedPercent: number;
  remainingPercent: number;
  resetOriginal?: number | string | null;
  resetAt?: string | null;
  durationSeconds?: number;
  reached?: boolean;
}

export interface Credits {
  available?: number;
  balance?: number | string;
  unit?: string;
  details?: Array<Record<string, boolean | number | string | null>>;
}

export interface AccountResult {
  provider: Provider;
  label: string;
  plan?: string;
  source: string;
  status: Freshness;
  collectedAt: string;
  cacheAgeSeconds?: number;
  windows: QuotaWindow[];
  credits?: Credits;
  warnings?: string[];
  error?: UsageErrorData;
}

export interface PublicDocument {
  schemaVersion: 1;
  generatedAt: string;
  mode: CollectionMode;
  results: AccountResult[];
  errors: UsageErrorData[];
}

export interface AccountConfig {
  provider: Provider;
  label: string;
  stateDir: string;
  ownership: Ownership;
  claudeDefault?: boolean;
  ownershipMarker?: string;
  identityHash?: string;
  identityMetadata?: {
    maskedEmail?: string;
    plan?: string;
  };
  claudeCollector?: {
    wrapperCommand: string;
    previousStatusLine?: unknown;
  };
}

export interface UsageConfig {
  schemaVersion: 1;
  defaults: {
    codexTimeout: string;
    claudeTimeout: string;
    staleAfter: string;
    codexExecutable?: string;
    claudeExecutable?: string;
  };
  accounts: AccountConfig[];
}

export interface ProviderAdapter {
  readonly provider: Provider;
  collect(account: AccountConfig, options: CollectionOptions): Promise<AccountResult>;
}

export interface CollectionOptions {
  timeoutMs: number;
  now?: Date;
  signal?: AbortSignal;
  verbose?: (message: string) => void;
}
