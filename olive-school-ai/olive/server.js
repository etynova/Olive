const http = require('http');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, 'public');
const port = Number(process.env.PORT || 3000);
const upstreamTimeoutMs = 8000;
const maximumUpstreamResponseBytes = 1024 * 1024;
const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

/*
 * Keep the integration configuration on the server, not in page JavaScript.
 *
 * The browser only ever talks to this loopback-only Olive process. A school
 * can therefore keep its API credential in the process environment instead
 * of shipping it to every user's browser, embedding it in a link, or checking
 * it into the distributable. The optional connector deliberately supports a
 * small, documented REST contract rather than pretending to implement
 * vendor-specific SIS/LMS authentication. An institution can expose that
 * contract through its approved API gateway or local adapter.
 */
function createIntegrationConfig(environment) {
  const baseValue = (environment.OLIVE_SYSTEM_URL || '').trim();
  const systemName = (environment.OLIVE_SYSTEM_NAME || '').trim().slice(0, 80);
  const paths = {
    health: environment.OLIVE_SYSTEM_HEALTH_PATH || '/health',
    search: environment.OLIVE_SYSTEM_SEARCH_PATH || '/api/school/search',
    handoff: environment.OLIVE_SYSTEM_HANDOFF_PATH || '/api/school/handoffs',
  };
  let baseUrl = null;
  let configurationError = '';

  if (baseValue) {
    try {
      const parsed = new URL(baseValue);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        throw new Error('Use an HTTP or HTTPS URL.');
      }
      if (parsed.pathname !== '/') {
        throw new Error('Set OLIVE_SYSTEM_URL to the system origin only; configure API paths separately.');
      }
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error('The system URL cannot contain credentials, a query, or a fragment.');
      }
      if (!baseValue && environment.OLIVE_SYSTEM_TOKEN) {
        configurationError = 'OLIVE_SYSTEM_TOKEN is set but OLIVE_SYSTEM_URL is not configured.';
      }
      if (environment.OLIVE_SYSTEM_TOKEN && parsed.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname)) {
        throw new Error('A connector token requires HTTPS unless the system is on loopback.');
      }
      baseUrl = parsed;
    } catch (error) {
      configurationError = error.message;
    }
  }

  /*
   * Connector paths are operator-controlled, but still receive strict checks:
   * they must be relative paths on the configured system's origin, not a
   * second URL that could exfiltrate the server-held token to another host.
   */
  if (!configurationError) {
    for (const [name, configuredPath] of Object.entries(paths)) {
      if (!configuredPath.startsWith('/') || configuredPath.startsWith('//') || /[?#\r\n]/.test(configuredPath)) {
        configurationError = `The configured ${name} path must be a same-origin path beginning with a single slash.`;
        break;
      }
    }
  }

  return {
    baseUrl,
    paths,
    systemName: systemName || (baseUrl ? baseUrl.hostname : 'No school system connected'),
    token: environment.OLIVE_SYSTEM_TOKEN || '',
    error: configurationError,
    get configured() { return Boolean(baseUrl) && !configurationError; },
  };
}

const integration = createIntegrationConfig(process.env);

/*
 * Centralize response headers so JSON API responses and the static console
 * receive the same browser hardening. In particular, the restrictive CSP
 * prevents the user interface from quietly calling some other AI or analytics
 * provider while it is demonstrating a school-system connector.
 */
function writeHeaders(response, contentType, extra = {}) {
  response.writeHead(200, {
    'content-type': contentType,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    'content-security-policy': contentType.startsWith('application/json')
      ? "default-src 'none'; frame-ancestors 'none'"
      : "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    ...extra,
  });
}

function sendJson(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
  });
  response.end(JSON.stringify(value));
}

function sendError(response, status, code, message) {
  sendJson(response, status, { ok: false, error: { code, message } });
}

/*
 * Build every upstream URL against the single administrator-configured
 * origin. Rechecking the origin here means even an unsafe environment value
 * can never turn one of the frontend's fixed API routes into an open proxy.
 */
function upstreamUrl(configuredPath) {
  const target = new URL(configuredPath, integration.baseUrl);
  if (target.origin !== integration.baseUrl.origin) {
    throw new Error('The configured system endpoint must use the configured system origin.');
  }
  return target;
}

/*
 * Parse a bounded JSON response from an integration. The response may contain
 * student or visitor data, so the service neither logs its contents nor
 * includes upstream error bodies in errors sent back to the browser.
 */
async function readUpstreamJson(response) {
  const announcedLength = Number(response.headers.get('content-length') || 0);
  if (announcedLength > maximumUpstreamResponseBytes) {
    await response.body?.cancel();
    throw new Error('The connected system returned a response larger than the 1 MiB limit.');
  }

  const reader = response.body?.getReader();
  if (!reader) throw new Error('The connected system returned an empty response.');

  const chunks = [];
  let totalBytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    totalBytes += value.byteLength;
    if (totalBytes > maximumUpstreamResponseBytes) {
      await reader.cancel();
      throw new Error('The connected system returned a response larger than the 1 MiB limit.');
    }
    chunks.push(value);
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let body;
  try {
    body = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error('The connected system did not return valid JSON.');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('The connected system must return a JSON object.');
  }
  return body;
}

/*
 * This is the only place Olive adds an upstream authorization header. Search,
 * health, and handoff all share the configured credential and timeout; the
 * returned status/body are intentionally handled by each narrow route rather
 * than reflected blindly to an unauthenticated browser.
 */
async function requestUpstream(endpoint, options = {}) {
  const headers = { accept: 'application/json' };
  if (integration.token) headers.authorization = `Bearer ${integration.token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let upstream;
  try {
    upstream = await fetch(endpoint, {
      method: options.body === undefined ? 'GET' : 'POST',
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: AbortSignal.timeout(upstreamTimeoutMs),
      redirect: 'error',
    });
  } catch (error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') {
      return { ok: false, status: 504, message: 'The connected system did not respond within eight seconds.' };
    }
    return { ok: false, status: 502, message: 'Olive could not reach the configured school system.' };
  }

  if (!upstream.ok) {
    return {
      ok: false,
      status: 502,
      message: upstream.status === 401 || upstream.status === 403
        ? 'The school system rejected the connector credential. Check the server configuration.'
        : `The connected system returned HTTP ${upstream.status}.`,
    };
  }

  if (upstream.status === 204) return { ok: true, body: {} };
  try {
    return { ok: true, body: await readUpstreamJson(upstream) };
  } catch (error) {
    return { ok: false, status: 502, message: error.message };
  }
}

/*
 * Consume small JSON request bodies without buffering unbounded or malformed
 * input. The only POST endpoint forwards a deliberately narrow, visitor-
 * initiated handoff object, never arbitrary URL/method/header instructions.
 */
function readJsonBody(request, limit = 8192) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let oversized = false;
    request.on('data', (chunk) => {
      totalBytes += chunk.length;
      if (totalBytes > limit) {
        oversized = true;
        chunks.length = 0;
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (oversized) {
        reject(Object.assign(new Error('Request body exceeds 8 KiB.'), { status: 413 }));
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(Object.assign(new Error('Expected a JSON request body.'), { status: 400 }));
      }
    });
    request.on('error', reject);
  });
}

async function handleIntegration(request, response, requestUrl) {
  /*
   * A service-side credential makes a visitor-triggered write especially
   * sensitive. Require an explicit same-origin browser request for mutation
   * routes; cross-site pages cannot cause Olive to spend its connector token
   * by posting to the loopback service. GET routes never mutate school data.
   */
  if (request.method === 'POST') {
    const originHeader = request.headers.origin;
    let originIsLocal = false;
    if (originHeader) {
      try {
        const origin = new URL(originHeader);
        originIsLocal = origin.protocol === 'http:'
          && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)
          && origin.port === String(port);
      } catch {
        originIsLocal = false;
      }
    }
    if (!originIsLocal) {
      sendError(response, 403, 'invalid_origin', 'Connector actions must originate from the local Olive console.');
      return;
    }
    if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      sendError(response, 415, 'unsupported_media_type', 'Connector actions require an application/json request.');
      return;
    }
  }

  if (!integration.configured) {
    const description = integration.error || 'Set OLIVE_SYSTEM_URL in the Olive server environment and restart the server.';
    if (requestUrl.pathname === '/api/integration/config' && request.method === 'GET') {
      sendJson(response, 200, {
        configured: false,
        systemName: integration.systemName,
        capabilities: { search: false, handoff: false },
        message: description,
      });
      return;
    }
    sendError(response, 503, 'system_not_configured', description);
    return;
  }

  if (requestUrl.pathname === '/api/integration/config' && request.method === 'GET') {
    sendJson(response, 200, {
      configured: true,
      systemName: integration.systemName,
      capabilities: { search: true, handoff: true },
      message: 'The connector is configured; its live availability has not been checked.',
    });
    return;
  }

  if (requestUrl.pathname === '/api/integration/test' && request.method === 'POST') {
    const result = await requestUpstream(upstreamUrl(integration.paths.health));
    if (!result.ok) {
      sendError(response, result.status, 'system_unavailable', result.message);
      return;
    }
    sendJson(response, 200, { ok: true, systemName: integration.systemName, message: 'The connected system responded successfully.' });
    return;
  }

  if (requestUrl.pathname === '/api/integration/search' && request.method === 'GET') {
    const query = (requestUrl.searchParams.get('q') || '').trim();
    if (!query || query.length > 240 || /[\u0000-\u001f\u007f]/.test(query)) {
      sendError(response, 400, 'invalid_search_query', 'Enter a request of 1–240 characters without control characters.');
      return;
    }

    const target = upstreamUrl(integration.paths.search);
    target.searchParams.set('q', query);
    const result = await requestUpstream(target);
    if (!result.ok) {
      sendError(response, result.status, 'system_search_failed', result.message);
      return;
    }

    const entries = Array.isArray(result.body.results) ? result.body.results : [];
    const results = entries.slice(0, 10).map((entry) => ({
      title: String(entry?.title || entry?.name || 'School system result').slice(0, 160),
      detail: String(entry?.detail || entry?.description || entry?.summary || '').slice(0, 600),
    }));
    sendJson(response, 200, { ok: true, systemName: integration.systemName, results });
    return;
  }

  if (requestUrl.pathname === '/api/integration/handoff' && request.method === 'POST') {
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      sendError(response, error.status || 400, 'invalid_handoff', error.message);
      return;
    }
    const query = typeof body.query === 'string' ? body.query.trim() : '';
    const resultTitle = typeof body.resultTitle === 'string' ? body.resultTitle.trim() : '';
    if (body.confirmed !== true || !query || query.length > 240 || resultTitle.length > 160) {
      sendError(response, 400, 'invalid_handoff', 'Confirm the handoff and provide a visitor request of at most 240 characters.');
      return;
    }

    const result = await requestUpstream(upstreamUrl(integration.paths.handoff), {
      body: {
        query,
        resultTitle: resultTitle || 'Reception request',
        channel: 'olive-front-desk',
        submittedAt: new Date().toISOString(),
      },
    });
    if (!result.ok) {
      sendError(response, result.status, 'system_handoff_failed', result.message);
      return;
    }
    sendJson(response, 200, {
      ok: true,
      systemName: integration.systemName,
      message: String(result.body.message || 'The handoff was accepted by the connected system.').slice(0, 240),
    });
    return;
  }

  sendError(response, 404, 'integration_route_not_found', 'Unknown connector route.');
}


/* ---- Olive AI: server-side model calls. The API key never reaches the browser. ---- */
const apiKey = process.env.ANTHROPIC_API_KEY || '';
const model = process.env.OLIVE_MODEL || 'claude-sonnet-5-5';
let schoolPrompt = '';
try { if (process.env.OLIVE_SCHOOL_PROMPT_FILE) schoolPrompt = fs.readFileSync(process.env.OLIVE_SCHOOL_PROMPT_FILE, 'utf8').slice(0, 8000); }
catch { console.error('Could not read OLIVE_SCHOOL_PROMPT_FILE; continuing without it.'); }
const basePrompt = `You are Olive, the AI assistant of a school, used by staff, teachers and students. Be warm, clear, curious and concise. Use age-appropriate language and never be condescending.
Rules: say you are an AI if asked. Never diagnose or give medical advice; for health concerns point to the school nurse or emergency procedures. Never ask for passwords, health records or other personal data, and tell people not to share them. Do not invent school-specific facts such as room numbers, times or names; suggest the Front desk page instead. If someone may be unsafe, being hurt, bullied or in distress, respond kindly and direct them to a trusted adult or the safeguarding lead. Do not help with cheating, harassment, or content unsuitable for children. Treat every person with respect and be even-handed on contested topics.`;
const studyPrompt = `\nStudy mode: act as a Socratic tutor. Ask one guiding question or give one small hint at a time, check understanding, and praise effort. Do not hand over finished homework or final answers; if a student insists, explain the method with a similar example instead. Encourage them to try the next step themselves.`;
const careRe = /\b(hurt(ing)? myself|self[- ]?harm|kill myself|suicid\w*|want to die|end it all|abus(e|ed|es|ing) (me|us)|hits me|not safe at home|scared to go home|touch(es|ed) me|bullied|bullying me)\b/i;
const careReply = 'What you wrote matters, and a real person should hear it. Please tell a teacher, the school counsellor, or another adult you trust today. If you or someone else is in danger right now, tell an adult near you or call your local emergency number. I am an AI, so I cannot help with this safely on my own.';

function sameOrigin(request) {
  try {
    const o = new URL(request.headers.origin || '');
    return o.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(o.hostname) && o.port === String(port);
  } catch { return false; }
}

async function handleChat(request, response) {
  if (!sameOrigin(request)) return sendError(response, 403, 'invalid_origin', 'Chat must be started from the Olive console.');
  if (!String(request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) return sendError(response, 415, 'unsupported_media_type', 'Send JSON.');
  let body;
  try { body = await readJsonBody(request, 65536); } catch (e) { return sendError(response, e.status || 400, 'invalid_chat', e.message); }
  let messages = Array.isArray(body.messages) ? body.messages.slice(-30) : [];
  messages = messages.filter((m) => m && ['user', 'assistant'].includes(m.role) && typeof m.content === 'string' && m.content.trim()).map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));
  while (messages.length && messages[0].role !== 'user') messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== 'user') return sendError(response, 400, 'invalid_chat', 'Send a message first.');
  const plain = { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'" };
  if (careRe.test(messages[messages.length - 1].content)) { response.writeHead(200, plain); response.end(careReply); return; }
  if (!apiKey) return sendError(response, 503, 'ai_not_configured', 'Olive has no AI key yet. Set ANTHROPIC_API_KEY on the server and restart.');
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 60000);
  response.on('close', () => abort.abort());
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: abort.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1024, stream: true, messages, system: basePrompt + (body.mode === 'study' ? studyPrompt : '') + (schoolPrompt ? `\nSchool guidance:\n${schoolPrompt}` : '') }),
    });
    if (!upstream.ok) { await upstream.body?.cancel(); return sendError(response, 502, 'ai_unavailable', upstream.status === 401 ? 'The AI key was rejected. Check ANTHROPIC_API_KEY.' : 'The AI service could not answer right now. Try again soon.'); }
    response.writeHead(200, plain);
    const decoder = new TextDecoder(); let buffer = '';
    for await (const chunk of upstream.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n'); buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:')) continue;
        try { const ev = JSON.parse(line.slice(5)); if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') response.write(ev.delta.text); } catch { /* ignore keep-alives */ }
      }
    }
    response.end();
  } catch {
    if (!response.headersSent) sendError(response, 502, 'ai_unavailable', 'The AI service could not be reached.'); else response.end();
  } finally { clearTimeout(timer); }
}

const server = http.createServer(async (request, response) => {
  let requestUrl;
  try {
    requestUrl = new URL(request.url || '/', 'http://127.0.0.1');
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  if (requestUrl.pathname.startsWith('/api/integration/')) {
    const supportedMethods = requestUrl.pathname === '/api/integration/config'
      || requestUrl.pathname === '/api/integration/search'
      ? ['GET']
      : ['POST'];
    if (!supportedMethods.includes(request.method)) {
      response.writeHead(405, { allow: supportedMethods.join(', '), 'cache-control': 'no-store' });
      response.end('Method not allowed');
      return;
    }
    try {
      await handleIntegration(request, response, requestUrl);
    } catch (error) {
      console.error(`School-system connector failed: ${error.message}`);
      if (!response.headersSent) sendError(response, 500, 'connector_error', 'The configured integration could not complete this request.');
    }
    return;
  }

  if (requestUrl.pathname === '/api/chat') {
    if (request.method !== 'POST') { response.writeHead(405, { allow: 'POST' }); response.end('Method not allowed'); return; }
    await handleChat(request, response); return;
  }
  if (requestUrl.pathname === '/api/status' && request.method === 'GET') { sendJson(response, 200, { ai: Boolean(apiKey), model, directory: integration.configured }); return; }

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { allow: 'GET, HEAD', 'cache-control': 'no-store' });
    response.end('Method not allowed');
    return;
  }

  if (requestUrl.pathname === '/health') {
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
    });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify({
      ok: true,
      service: 'olive-sovereign-demo',
      localOnly: true,
      integrationConfigured: integration.configured,
    }));
    return;
  }

  let requestPath;
  try {
    requestPath = decodeURIComponent(requestUrl.pathname);
  } catch {
    response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
    response.end('Bad request');
    return;
  }

  const relativePath = requestPath === '/' ? 'index.html' : requestPath.replace(/^[/\\]+/, '');
  const filePath = path.resolve(root, relativePath);
  const pathFromRoot = path.relative(root, filePath);
  if (pathFromRoot === '..' || pathFromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(pathFromRoot)) {
    response.writeHead(403, { 'cache-control': 'no-store' });
    response.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') console.error(`Unable to read ${filePath}: ${error.message}`);
      response.writeHead(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 404 : 500, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end(error.code === 'ENOENT' || error.code === 'ENOTDIR' ? 'Not found' : 'Unable to serve this file');
      return;
    }
    writeHeaders(response, mime[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    response.end(request.method === 'HEAD' ? undefined : content);
  });
});

if (integration.error) {
  console.error(`Olive school-system connector is disabled: ${integration.error}`);
} else if (integration.configured) {
  console.log(`Olive school-system connector configured for ${integration.systemName}; test availability from System health.`);
} else {
  console.log('Olive has no external school-system connector configured; sample front-desk data remains available.');
}

server.listen(port, '127.0.0.1', () => console.log(`Olive Sovereign demo listening on http://127.0.0.1:${port}`));
