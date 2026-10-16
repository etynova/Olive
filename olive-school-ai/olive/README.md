# Olive

A school-owned AI assistant for staff and students. The Overview is a chat with Olive; Study buddy is a Socratic tutor; Front desk searches your school directory and, with the visitor's confirmation, hands a request to a person.

## Run

Node 18+, no installs.

```
export ANTHROPIC_API_KEY=your-key     # set via your secret manager, not shell history
npm start                             # http://127.0.0.1:3000
npm run check && npm test
```

The key stays on the server (`/api/chat` streams the reply to the browser). `OLIVE_MODEL` selects the model. `OLIVE_SCHOOL_PROMPT_FILE` adds school-specific guidance (tone, policies, curriculum notes) without code changes.

## Directory connector

Set `OLIVE_SYSTEM_URL` (plus optional `OLIVE_SYSTEM_NAME`, `OLIVE_SYSTEM_TOKEN`, and `OLIVE_SYSTEM_*_PATH`) to point Olive at your school's API. Contract: `GET /api/school/search?q=` returns `{"results":[{"title","detail"}]}`; `POST /api/school/handoffs` receives a confirmed request; `GET /health`. Try it with `node examples/school-system.js` (fictional data).

## Safeguarding and ethics

See `ETHICS.md`. Olive stops and points to a trusted adult when a message suggests harm, abuse, bullying or distress (checked on the server, before any model call). Messages are not stored or logged. Before real pupil data, add sign-in and per-user authorization: Olive has no user accounts yet.
