import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import type { IncomingMessage } from 'node:http';
import type { ValidateFunction } from 'ajv';
import { parse } from 'yaml';
import { ApiError } from './api-data.js';

type Schema = Record<string, unknown>;
type Parameter = { name: string; in: 'path' | 'query' | 'header'; schema: Schema; required?: boolean };
type Operation = {
  operationId: string;
  'x-omu-permission'?: string;
  parameters?: Parameter[];
  requestBody?: { content: { 'application/json': { schema: Schema } } };
  responses: Record<string, Record<string, unknown>>;
};
type Document = { paths: Record<string, Record<string, Operation>>; components: Schema };
type Route = { path: RegExp; names: string[]; method: string; operation: Operation };

const require = createRequire(import.meta.url);
const Ajv = require('ajv/dist/2020.js').default as typeof import('ajv/dist/2020.js').default;
const addFormats = require('ajv-formats').default as typeof import('ajv-formats').default;

export const apiDocument = parse(readFileSync(new URL('../docs/openapi.yaml', import.meta.url), 'utf8')) as Document;

const contractId = 'urn:open-mobile-use:http-contract';
const ajv = new Ajv({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: contractId, components: apiDocument.components });
const compiled = new Map<Schema, ValidateFunction>();

function validation(schema: Schema) {
  let validator = compiled.get(schema);
  if (validator) return validator;
  // Inline operation schemas refer to schemas defined within the OpenAPI document.
  const install = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(install);
    if (value === null || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) =>
      [key, key === '$ref' && typeof item === 'string' && item.startsWith('#') ? contractId + item : install(item)]));
  };
  validator = ajv.compile(install(schema) as Schema);
  compiled.set(schema, validator);
  return validator;
}

const routes: Route[] = [];
for (const [template, methods] of Object.entries(apiDocument.paths)) {
  const names: string[] = [];
  const pattern = template.split('/').map((part) => {
    const identifier = /^\{(.+)\}$/.exec(part);
    if (!identifier) return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    names.push(identifier[1]);
    return '([^/]+)';
  }).join('/');
  const path = new RegExp('^' + pattern + '$');
  for (const [method, operation] of Object.entries(methods)) {
    routes.push({ path, names, method: method.toUpperCase(), operation });
    for (const parameter of operation.parameters ?? []) validation(parameter.schema);
    if (operation.requestBody) validation(operation.requestBody.content['application/json'].schema);
  }
}
export const operationIds = routes.map(({ operation }) => operation.operationId);

export function matchOperation(pathname: string, method: string) {
  const allowed: string[] = [];
  for (const route of routes) {
    const hit = route.path.exec(pathname);
    if (!hit) continue;
    allowed.push(route.method);
    if (route.method !== method) continue;
    try {
      return {
        operation: route.operation,
        pathValues: Object.fromEntries(route.names.map((name, index) => [name, decodeURIComponent(hit[index + 1])])),
        allowed,
      };
    } catch {
      throw new ApiError(400, 'INVALID_PATH');
    }
  }
  return { operation: undefined, pathValues: {}, allowed };
}

export const header = (request: IncomingMessage, name: string) => {
  const value = request.headers[name.toLowerCase()];
  if (Array.isArray(value)) throw new ApiError(400, 'INVALID_HEADER');
  return value;
};

export function operationParameters(operation: Operation, request: IncomingMessage, url: URL, pathValues: Record<string, string>) {
  const result: Record<string, string | number | boolean> = {};
  for (const parameter of operation.parameters ?? []) {
    const { name, in: location, schema } = parameter;
    const query = location === 'query' ? url.searchParams.getAll(name) : [];
    if (query.length > 1) throw new ApiError(400, 'DUPLICATE_PARAMETER');
    const raw = location === 'path' ? pathValues[name] : location === 'header' ? header(request, name) : query[0];
    if (raw === undefined) {
      if (parameter.required) throw new ApiError(name === 'If-Match' ? 428 : 400,
        name === 'If-Match' ? 'PRECONDITION_REQUIRED' : 'MISSING_PARAMETER', name);
      continue;
    }
    const value = schema.type === 'integer' && /^\d+$/.test(raw) ? Number(raw) :
      schema.type === 'boolean' && ['true', 'false'].includes(raw) ? raw === 'true' : raw;
    if (!validation(schema)(value)) throw new ApiError(400, 'INVALID_PARAMETER', name);
    result[name] = value;
  }
  return result;
}

export async function operationBody(operation: Operation, request: IncomingMessage, maxBytes: number) {
  if (!operation.requestBody) return undefined;
  if (header(request, 'content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json')
    throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE');
  if (Number(header(request, 'content-length')) > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE');
  // Use the event iterator without destroying the socket when rejecting a large request.
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBytes) throw new ApiError(413, 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  let body: unknown;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'INVALID_JSON');
  }
  if (!validation(operation.requestBody.content['application/json'].schema)(body))
    throw new ApiError(400, 'INVALID_REQUEST');
  return body;
}
