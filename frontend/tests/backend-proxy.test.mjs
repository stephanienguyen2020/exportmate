import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import handler from '../api/backend.ts';
const originalFetch = globalThis.fetch;
const previousURL = process.env.BACKEND_URL;
const server = createServer(handler);
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  globalThis.fetch = originalFetch;
  if (previousURL === undefined) delete process.env.BACKEND_URL; else process.env.BACKEND_URL = previousURL;
  await new Promise(resolve => server.close(resolve));
});
test('missing configuration returns JSON 503 instead of a misleading AI response', async () => {
  delete process.env.BACKEND_URL;
  const response = await originalFetch(origin + '/api/backend?path=orders');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /not configured/);
});
test('forwards bearer auth, query, JSON and multipart bodies to the fixed backend', async () => {
  process.env.BACKEND_URL = 'https://backend.example';
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    return Response.json({ data: { accepted: true }, meta: {} }, { status: 201 });
  };
  const json = JSON.stringify({ text: 'Do not lose this rule', category: 'Policy' });
  let response = await originalFetch(origin + '/api/backend?path=playbook/rules&q=wood&cursor=a%2Bb', {
    method: 'POST', headers: { Authorization: 'Bearer test-token', 'Content-Type': 'application/json', 'Idempotency-Key': 'k-1' }, body: json,
  });
  assert.equal(response.status, 201);
  assert.equal(calls[0].url, 'https://backend.example/api/v1/playbook/rules?q=wood&cursor=a%2Bb');
  assert.equal(calls[0].options.headers.get('authorization'), 'Bearer test-token');
  assert.equal(calls[0].options.headers.get('idempotency-key'), 'k-1');
  assert.equal(calls[0].options.body.toString(), json);
  const form = new FormData();
  form.append('file', new Blob(['id,hsCode\nTEST,0401.10']), 'test.csv');
  response = await originalFetch(origin + '/api/backend?path=imports', { method: 'POST', body: form });
  assert.equal(response.status, 201);
  assert.match(calls[1].options.headers.get('content-type'), /multipart\/form-data; boundary=/);
  assert.match(calls[1].options.body.toString(), /0401\.10/);
});
test('upstream failures return a readable error without internal details', async () => {
  globalThis.fetch = async () => { throw new Error('private connection details'); };
  const response = await originalFetch(origin + '/api/backend?path=orders');
  assert.equal(response.status, 502);
  assert.doesNotMatch(JSON.stringify(await response.json()), /private connection/);
});
test('document downloads preserve original bytes and attachment security headers', async () => {
  process.env.BACKEND_URL = 'https://backend.example';
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0xff, 0x00]);
  globalThis.fetch = async () => new Response(bytes, { headers: {
    'content-type': 'application/pdf',
    'content-disposition': "attachment; filename*=UTF-8''source.pdf",
    'x-content-type-options': 'nosniff',
  } });
  const response = await originalFetch(origin + '/api/backend?path=regulation-documents/doc-1/file');
  assert.equal(response.headers.get('content-disposition'), "attachment; filename*=UTF-8''source.pdf");
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), bytes);
});
