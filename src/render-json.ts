import type { AccountResult, CollectionMode, PublicDocument, UsageErrorData } from './types.js';

export function publicDocument(
  mode: CollectionMode,
  results: AccountResult[],
  errors: UsageErrorData[],
  now = new Date(),
): PublicDocument {
  return { schemaVersion: 1, generatedAt: now.toISOString(), mode, results, errors };
}

export function renderJson(document: PublicDocument): string {
  return `${JSON.stringify(document, null, 2)}\n`;
}
