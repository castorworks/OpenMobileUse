import type { Tool } from './chat.js';
export function tool(
  id: string,
  name: string,
  description: string,
  fields: Record<string, string[]> = {},
): Tool {
  const args = { observationId: [id], ...fields };
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: {
        type: 'object',
        required: Object.keys(args),
        additionalProperties: false,
        properties: Object.fromEntries(
          Object.entries(args).map(([k, values]) => [k, { type: 'string', enum: values }]),
        ),
      },
    },
  };
}
export function decode(tools: Tool[], name: string, raw: string) {
  const schema = tools.find((t) => t.function.name === name)?.function.parameters;
  if (!schema) return 'TOOL_UNAVAILABLE';
  let args;
  try {
    args = JSON.parse(raw);
  } catch {
    return 'INVALID_ARGUMENTS';
  }
  if (
    !args ||
    typeof args !== 'object' ||
    Array.isArray(args) ||
    Object.keys(args).length !== schema.required.length
  )
    return 'INVALID_ARGUMENTS';
  if (args.observationId !== (schema.properties.observationId as { enum: string[] }).enum[0])
    return 'STALE_OBSERVATION';
  return schema.required.every(
    (k) =>
      Object.hasOwn(args, k) &&
      (schema.properties[k].type === 'number'
        ? typeof args[k] === 'number' && Number.isFinite(args[k]) && args[k] >= 0 && args[k] <= 1
        : typeof args[k] === 'string' &&
          (schema.properties[k].enum?.includes(args[k]) ??
            args[k].length <= (schema.properties[k].maxLength ?? 0))),
  )
    ? null
    : 'INVALID_ARGUMENTS';
}
