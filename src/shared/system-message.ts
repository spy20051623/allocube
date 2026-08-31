export type SystemMessageParam = string | number | boolean | null;

export interface ResolvedSystemMessage {
  code: string;
  params: Record<string, SystemMessageParam>;
}

interface MessageTemplate extends ResolvedSystemMessage {
  source: string;
  translated: string;
  names: string[];
  pattern: RegExp;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stableCode(source: string) {
  let hash = 0x811c9dc5;
  for (const character of source) {
    hash ^= character.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193);
  }
  return `SYSTEM_MESSAGE_${(hash >>> 0).toString(16).padStart(8, "0").toUpperCase()}`;
}

export function createSystemMessageCatalog(translations: Record<string, string>) {
  const byCode = new Map<string, MessageTemplate>();
  const exact = new Map<string, MessageTemplate>();
  const templates: MessageTemplate[] = [];

  for (const [source, translated] of Object.entries(translations)) {
    const names = Array.from(source.matchAll(/\{\{(v\d+)\}\}/g), (match) => match[1]);
    const parts = source.split(/\{\{v\d+\}\}/g).map(escapeRegExp);
    const entry: MessageTemplate = {
      source,
      translated,
      code: stableCode(source),
      params: {},
      names,
      pattern: new RegExp(`^${parts.join("(.*?)")}$`, "u")
    };
    const collision = byCode.get(entry.code);
    if (collision && collision.source !== source) {
      throw new Error(`System message code collision: ${collision.source} / ${source}`);
    }
    byCode.set(entry.code, entry);
    if (names.length > 0) templates.push(entry);
    else exact.set(source, entry);
  }

  function resolve(message: string): ResolvedSystemMessage | null {
    const exactEntry = exact.get(message);
    if (exactEntry) return { code: exactEntry.code, params: {} };
    for (const entry of templates) {
      const match = entry.pattern.exec(message);
      if (!match) continue;
      return {
        code: entry.code,
        params: Object.fromEntries(entry.names.map((name, index) => [name, match[index + 1]]))
      };
    }
    return null;
  }

  function translate(code: string, params: Record<string, unknown> = {}) {
    const entry = byCode.get(code);
    if (!entry) return null;
    return entry.translated.replace(/\{\{(v\d+)\}\}/g, (placeholder, name: string) =>
      params[name] === undefined ? placeholder : String(params[name])
    );
  }

  return {
    resolve,
    translate,
    entries: Array.from(byCode.values(), ({ source, translated, code }) => ({
      source,
      translated,
      code
    }))
  };
}
