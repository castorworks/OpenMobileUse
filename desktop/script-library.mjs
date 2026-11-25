export async function listItems(api, path, { query = {}, signal, maximum = Infinity } = {}) {
  const items = [];
  const parameters = new URLSearchParams(query);
  parameters.set('limit', String(Math.min(maximum, 200)));
  let cursor;
  do {
    if (cursor) parameters.set('cursor', cursor);
    const page = await api.json(path + '?' + parameters, { signal });
    items.push(...page.items);
    cursor = page.nextCursor;
  } while (cursor && items.length < maximum);
  return items.slice(0, maximum);
}

const scriptPath = (id) => '/api/scripts/' + encodeURIComponent(id);

export class ScriptLibrary {
  constructor(api, signal) {
    this.api = api;
    this.signal = signal;
  }

  list(includeArchived) {
    return listItems(this.api, '/api/scripts', {
      query: includeArchived ? { includeArchived: 'true' } : {}, signal: this.signal,
    });
  }

  create(body) {
    return this.api.json('/api/scripts', { method: 'POST', body, signal: this.signal });
  }

  async entry(id) {
    const response = await this.api.request(scriptPath(id), { signal: this.signal });
    const revision = response.headers.get('etag');
    if (!revision) throw Error('API_INVALID_RESPONSE');
    return { ...(await response.json()), revision };
  }

  async patch(id, body, revision) {
    const expected = revision ?? (await this.entry(id)).revision;
    return this.api.json(scriptPath(id), {
      method: 'PATCH', body, headers: { 'If-Match': expected }, signal: this.signal,
    });
  }

  async export(id) {
    const path = scriptPath(id);
    const [entry, script] = await Promise.all([
      this.api.json(path, { signal: this.signal }),
      this.api.json(path + '/content', { signal: this.signal }),
    ]);
    return { title: entry.title, script };
  }
}
