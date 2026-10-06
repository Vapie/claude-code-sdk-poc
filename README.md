# Claude workspace API

Runs the Claude Agent SDK in one workspace folder. Swagger is at [http://127.0.0.1:8787/docs](http://127.0.0.1:8787/docs) after `npm start`.

```bash
npm install
npm start
```

Put `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY` in `.env`. That file is not committed. Set `API_TOKEN` if callers must send `Authorization: Bearer <token>`.

A workspace id is a short lowercase name: `alpha`, `beta`, `gamma`.

## List workspaces

`GET /workspaces`

```bash
curl -s http://127.0.0.1:8787/workspaces
```

```json
{ "workspaces": ["alpha", "beta"] }
```

## Create a workspace

`POST /workspaces`

Copies `workspaces/_template`. `{{id}}` and `{{title}}` in those files are replaced. `title` defaults to `id`.

```bash
curl -s http://127.0.0.1:8787/workspaces \
  -H 'content-type: application/json' \
  -d '{"id":"gamma","title":"Gamma"}'
```

| Status | Meaning |
| --- | --- |
| 201 | Created |
| 400 | `id` is missing or not a short lowercase name |
| 409 | That workspace already exists |

## Read

`POST /workspaces/{id}/read`

The agent can use Read, Glob, and Grep. It cannot edit files.

```bash
curl -s http://127.0.0.1:8787/workspaces/alpha/read \
  -H 'content-type: application/json' \
  -d '{"prompt":"Reply with the secret phrase and the client name."}'
```

## Write

`POST /workspaces/{id}/write`

Same call, and Edit and Write are allowed. Changes land in that workspace folder.

```bash
curl -s http://127.0.0.1:8787/workspaces/alpha/write \
  -H 'content-type: application/json' \
  -d '{"prompt":"Set secret.txt to the single line NEW-SECRET."}'
```

## Answer

Read and write return:

```json
{
  "ok": true,
  "workspace": "alpha",
  "mode": "read",
  "answer": "...",
  "sessionId": "...",
  "durationMs": 5000,
  "numTurns": 2,
  "costUsd": 0.01
}
```

| Status | Meaning |
| --- | --- |
| 200 | The agent finished |
| 400 | `prompt` is missing |
| 404 | Unknown workspace |
| 409 | Another agent call is still running |
| 502 | The agent finished with an error |
| 401 | `API_TOKEN` is set and the bearer token does not match |

One agent call runs at a time. Each call is a new session (`persistSession` is off), capped at 4 turns and $1. The next call sees file changes, not the previous chat.
