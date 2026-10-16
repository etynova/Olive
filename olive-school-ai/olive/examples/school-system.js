const http = require('node:http');

const host = '127.0.0.1';
const port = Number(process.env.SCHOOL_SYSTEM_PORT || 4100);
const expectedToken = process.env.SCHOOL_SYSTEM_TOKEN || '';
const handoffs = [];

/*
 * This deliberately tiny local service is a safe integration target for
 * developing the Olive connector without credentials or an actual school's
 * information. A real school can adapt its approved API/gateway to the same
 * three documented operations instead of copying this in-memory data store.
 */
const server = http.createServer((request, response) => {
  const requestUrl = new URL(request.url || '/', `http://${host}:${port}`);
  response.setHeader('cache-control', 'no-store');
  response.setHeader('x-content-type-options', 'nosniff');

  /*
   * Keep the fixture safe to expose in a test environment: operators may
   * require a throwaway token to verify that Olive really forwards the
   * server-side credential. With no fixture token it remains convenient to
   * run locally with the zero-secret `.env.example` settings.
   */
  if (expectedToken && request.headers.authorization !== `Bearer ${expectedToken}`) {
    response.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ message: 'A valid sample connector token is required.' }));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/health') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ ok: true, service: 'sample-school-directory' }));
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/api/school/search') {
    const query = (requestUrl.searchParams.get('q') || '').toLowerCase();
    const directory = [
      { keywords: ['library', 'book'], title: 'Library · Room 1.08', detail: 'Local school directory sample. Follow the green corridor past the atrium. Open 08:00–16:30.' },
      { keywords: ['hours', 'time', 'school end', 'gate'], title: 'School hours · local directory', detail: 'Local school directory sample. Main gate 07:30–17:00; teaching day ends at 15:30.' },
      { keywords: ['nurse', 'health office'], title: 'School nurse · reception handoff', detail: 'The health office can be contacted through the school front desk. Never send medical emergencies through this sample directory.' },
      { keywords: ['it', 'custodian', 'technology'], title: 'IT Custodian · reception handoff', detail: 'Ask reception to contact the school IT Custodian. This sample directory does not disclose personal contact details.' },
      { keywords: ['office', 'reception'], title: 'Main office · Room 1.01', detail: 'The main office is beside the front entrance. Ask reception for a staff handoff.' },
    ];
    const matches = directory
      .filter((entry) => entry.keywords.some((keyword) => query.includes(keyword)))
      .map(({ title, detail }) => ({ title, detail }));
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ results: matches, source: 'sample school directory' }));
    return;
  }

  if (request.method === 'POST' && requestUrl.pathname === '/api/school/handoffs') {
    let body = '';
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      try {
        const handoff = JSON.parse(body);
        if (typeof handoff.query !== 'string' || handoff.channel !== 'olive-front-desk') {
          response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          response.end(JSON.stringify({ message: 'A visitor question and Olive front-desk channel are required.' }));
          return;
        }
        handoffs.push({ receivedAt: new Date().toISOString(), resultTitle: String(handoff.resultTitle || '').slice(0, 160) });
        response.writeHead(202, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message: 'Sample handoff accepted by the local directory adapter.' }));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ message: 'A valid JSON handoff is required.' }));
      }
    });
    return;
  }

  if (request.method === 'GET' && requestUrl.pathname === '/admin/demo-handoffs') {
    response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ total: handoffs.length, items: handoffs }));
    return;
  }

  response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ message: 'No matching sample school-system endpoint.' }));
});

server.listen(port, host, () => {
  console.log(`Sample school-system adapter listening on http://${host}:${port}`);
});
