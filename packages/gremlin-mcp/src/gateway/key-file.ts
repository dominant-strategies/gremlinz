/** Keys stay in the tool/gateway processes; inference clients receive neither files nor secrets. */
import { readFileSync } from 'node:fs'
export function apiKeyFromFile(file?: string): string | undefined {
  if (!file) return undefined
  try {
    const k = JSON.parse(readFileSync(file, 'utf8')) as { apiKey?: unknown }
    return typeof k.apiKey === 'string' && k.apiKey.length > 0 ? k.apiKey : undefined
  } catch { return undefined }
}
