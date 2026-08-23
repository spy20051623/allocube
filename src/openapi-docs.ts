const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "options", "head"] as const;
const PUBLIC_OPEN_API_BASE_PATH = "/api/open/v1";

type JsonObject = Record<string, unknown>;

export type OpenApiOperation = {
  method: string;
  path: string;
  tag: string;
  summary: string;
  description: string;
  operationId: string;
  parameters: JsonObject[];
  requestBody?: JsonObject;
  responses: JsonObject;
};

export function listOpenApiOperations(document: unknown): OpenApiOperation[] {
  if (!isObject(document) || !isObject(document.paths)) return [];
  const operations: OpenApiOperation[] = [];
  for (const [path, pathValue] of Object.entries(document.paths)) {
    if (!isObject(pathValue)) continue;
    const sharedParameters = resolveParameters(document, pathValue.parameters);
    for (const method of HTTP_METHODS) {
      const raw = pathValue[method];
      if (!isObject(raw)) continue;
      const parameters = [
        ...sharedParameters,
        ...resolveParameters(document, raw.parameters)
      ];
      operations.push({
        method: method.toUpperCase(),
        path,
        tag: stringArray(raw.tags)[0] ?? "Other",
        summary: stringValue(raw.summary),
        description: stringValue(raw.description),
        operationId: stringValue(raw.operationId),
        parameters,
        requestBody: resolveObject(document, raw.requestBody),
        responses: isObject(raw.responses) ? raw.responses : {}
      });
    }
  }
  return operations.sort((left, right) =>
    left.tag.localeCompare(right.tag) ||
    left.path.localeCompare(right.path) ||
    left.method.localeCompare(right.method)
  );
}

export function openApiOperationMatches(operation: OpenApiOperation, query: string) {
  const terms = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return false;
  const haystack = [
    operation.method,
    operation.path,
    operation.tag,
    operation.summary,
    operation.description,
    operation.operationId
  ].join(" ").toLocaleLowerCase();
  return terms.every((term) => haystack.includes(term));
}

export function buildOpenApiOperationUrl(origin: string, path: string) {
  const normalizedOrigin = origin.replace(/\/+$/u, "");
  const normalizedPath = path.startsWith("/") ? path : `/${path}`;
  return `${normalizedOrigin}${PUBLIC_OPEN_API_BASE_PATH}${normalizedPath}`;
}

export function schemaForMediaType(container: JsonObject | undefined) {
  const details = mediaTypeDetails(container);
  return details?.schema ?? details?.example ?? details?.examples;
}

export function mediaTypeDetails(container: JsonObject | undefined) {
  if (!container || !isObject(container.content)) return undefined;
  for (const mediaType of ["application/json", "application/problem+json", "text/plain"] ) {
    const media = container.content[mediaType];
    if (isObject(media)) {
      return {
        mediaType,
        schema: media.schema,
        example: media.example,
        examples: media.examples
      };
    }
  }
  const first = Object.values(container.content).find(isObject);
  if (!first) return undefined;
  return {
    mediaType: Object.entries(container.content).find(([, value]) => value === first)?.[0] ?? "",
    schema: first.schema,
    example: first.example,
    examples: first.examples
  };
}

export function resolveOpenApiValue(document: unknown, value: unknown): unknown {
  if (isObject(value) && typeof value.$ref === "string") {
    return resolveReference(document, value.$ref) ?? value;
  }
  return value;
}

function resolveParameters(document: unknown, value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .map((parameter) => resolveObject(document, parameter))
    .filter((parameter): parameter is JsonObject => Boolean(parameter));
}

function resolveObject(document: unknown, value: unknown) {
  const resolved = resolveOpenApiValue(document, value);
  return isObject(resolved) ? resolved : undefined;
}

function resolveReference(document: unknown, reference: string) {
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = document;
  for (const encodedPart of reference.slice(2).split("/")) {
    if (!isObject(current)) return undefined;
    const part = encodedPart.replace(/~1/g, "/").replace(/~0/g, "~");
    current = current[part];
  }
  return current;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : "";
}

export function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
