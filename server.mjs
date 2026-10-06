import express from "express";
import swaggerUi from "swagger-ui-express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";

const root = path.dirname(fileURLToPath(import.meta.url));
const workspacesDir = path.join(root, "workspaces");
const templateDir = path.join(workspacesDir, "_template");
const openapi = JSON.parse(fs.readFileSync(path.join(root, "openapi.json"), "utf8"));
const port = Number(process.env.PORT || 8787);
const host = process.env.HOST || "127.0.0.1";
const idPattern = /^[a-z][a-z0-9-]{0,31}$/;

const modes = {
  read: {
    tools: ["Read", "Glob", "Grep"],
    systemPrompt: "Answer only from files in this working directory. Do not edit files. If a fact is not in those files, say it is not in this workspace.",
  },
  write: {
    tools: ["Read", "Glob", "Grep", "Edit", "Write"],
    systemPrompt: "Answer from files in this working directory. When the prompt asks for a change, edit only files in this directory.",
  },
};

let busy = false;

function listWorkspaces() {
  return fs.readdirSync(workspacesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name !== "_template")
    .map((entry) => entry.name)
    .sort();
}

function workspaceDir(id) {
  if (!idPattern.test(id)) return null;
  const dir = path.resolve(workspacesDir, id);
  if (!dir.startsWith(workspacesDir + path.sep)) return null;
  return dir;
}

function authorized(req) {
  const token = process.env.API_TOKEN;
  if (!token) return true;
  return req.get("authorization") === `Bearer ${token}`;
}

function fillTemplate(text, id, title) {
  return text.replaceAll("{{id}}", id).replaceAll("{{title}}", title);
}

async function ask(id, prompt, mode) {
  const dir = workspaceDir(id);
  if (!dir || !fs.existsSync(dir) || id === "_template") {
    const error = new Error("Unknown workspace");
    error.status = 404;
    throw error;
  }

  const spec = modes[mode];
  let stderr = "";
  let resultMessage = null;
  const stream = query({
    prompt,
    options: {
      cwd: dir,
      model: process.env.CLAUDE_MODEL || "haiku",
      maxTurns: 4,
      maxBudgetUsd: 1,
      permissionMode: "dontAsk",
      tools: spec.tools,
      allowedTools: spec.tools,
      settingSources: ["project"],
      persistSession: false,
      strictMcpConfig: true,
      mcpServers: {},
      systemPrompt: spec.systemPrompt,
      env: { ...process.env, CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1" },
      stderr: (chunk) => {
        stderr += chunk;
      },
    },
  });

  for await (const message of stream) {
    if (message.type === "result") resultMessage = message;
  }
  if (!resultMessage) throw new Error(stderr.trim() || "The agent returned no result");

  return {
    ok: resultMessage.subtype === "success" && !resultMessage.is_error,
    workspace: id,
    mode,
    answer: resultMessage.result || "",
    sessionId: resultMessage.session_id,
    durationMs: resultMessage.duration_ms,
    numTurns: resultMessage.num_turns,
    costUsd: resultMessage.total_cost_usd,
    permissionDenials: resultMessage.permission_denials || [],
  };
}

function createWorkspace(id, title) {
  const dir = workspaceDir(id);
  if (!dir) {
    const error = new Error("id must be a short lowercase name");
    error.status = 400;
    throw error;
  }
  if (fs.existsSync(dir)) {
    const error = new Error("Workspace already exists");
    error.status = 409;
    throw error;
  }

  fs.mkdirSync(dir);
  for (const name of fs.readdirSync(templateDir)) {
    const source = path.join(templateDir, name);
    if (!fs.statSync(source).isFile()) continue;
    const text = fs.readFileSync(source, "utf8");
    fs.writeFileSync(path.join(dir, name), fillTemplate(text, id, title));
  }
  return { id, title, dir };
}

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.set("Access-Control-Allow-Origin", "*");
  res.set("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  if (!authorized(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
});

app.get("/openapi.json", (_req, res) => {
  res.json(openapi);
});
app.use("/docs", swaggerUi.serve, swaggerUi.setup(openapi, { customSiteTitle: "Claude workspace API" }));

app.get("/workspaces", (_req, res) => {
  res.json({ workspaces: listWorkspaces() });
});

app.post("/workspaces", (req, res, next) => {
  try {
    const id = String(req.body?.id || "").trim();
    const title = String(req.body?.title || id).trim();
    res.status(201).json(createWorkspace(id, title));
  } catch (error) {
    next(error);
  }
});

async function handleAsk(req, res, next, mode) {
  if (busy) {
    res.status(409).json({ error: "An agent call is already running" });
    return;
  }
  const prompt = String(req.body?.prompt || "").trim();
  if (!prompt) {
    res.status(400).json({ error: "prompt is required" });
    return;
  }
  busy = true;
  try {
    const outcome = await ask(req.params.id, prompt, mode);
    res.status(outcome.ok ? 200 : 502).json(outcome);
  } catch (error) {
    next(error);
  } finally {
    busy = false;
  }
}

app.post("/workspaces/:id/read", (req, res, next) => handleAsk(req, res, next, "read"));
app.post("/workspaces/:id/write", (req, res, next) => handleAsk(req, res, next, "write"));

app.use((error, _req, res, _next) => {
  const status = error.status || 500;
  res.status(status).json({ error: error.message || "Request failed" });
});

const server = app.listen(port, host, () => {
  console.log(`Claude workspace API on http://${host}:${port}`);
  console.log(`Swagger on http://${host}:${port}/docs`);
});
server.requestTimeout = 180_000;
