// Vercel Log Drain -> Google Cloud Logging
// Receives Vercel webhook payloads (NDJSON or JSON) and forwards them to GCP.
// Uses native http module (no express) for minimal cold start and image size.
//
// Endpoints:
//   GET  /health  - health check
//   POST /drain   - log drain receiver
//
// Query params on /drain:
//   ?app=<name>     - override app name label (default: Vercel's projectName)
//   ?proxy=true     - include HTTP request (proxy) logs (default: excluded)

const http = require("http")
const { Logging } = require("@google-cloud/logging")
const crypto = require("crypto")

// --- Config ---

const PORT = process.env.PORT || 8080
const GCP_PROJECT_ID = process.env.GCP_PROJECT_ID
const LOG_NAME = process.env.LOG_NAME
const VERCEL_WEBHOOK_SECRET = process.env.VERCEL_WEBHOOK_SECRET?.trim()

if (!GCP_PROJECT_ID) throw new Error("GCP_PROJECT_ID env var is required")
if (!LOG_NAME) throw new Error("LOG_NAME env var is required")

const logging = new Logging({ projectId: GCP_PROJECT_ID })
const log = logging.log(LOG_NAME)

// --- Level mappings ---

// Pino numeric levels -> GCP severity
const PINO_LEVELS = { 10: "DEBUG", 20: "DEBUG", 30: "INFO", 40: "WARNING", 50: "ERROR", 60: "CRITICAL" }

// Vercel string levels -> GCP severity
const VERCEL_LEVELS = { error: "ERROR", warning: "WARNING", warn: "WARNING", info: "INFO", log: "INFO", debug: "DEBUG", verbose: "DEBUG" }

// Pino internal fields to strip from metadata (we extract msg/level separately)
const PINO_IGNORE = new Set(["msg", "level", "time", "pid", "hostname", "env", "app"])

// --- Signature verification ---

// Vercel signs payloads with HMAC-SHA1 (x-vercel-signature header).
// We also try SHA256 as fallback in case they change the algorithm.
function verifySignature(rawBody, signature) {
  if (!VERCEL_WEBHOOK_SECRET) return true
  if (!signature) return false
  const expected = crypto.createHmac("sha1", VERCEL_WEBHOOK_SECRET).update(rawBody).digest("hex")
  if (signature === expected) return true
  return signature === crypto.createHmac("sha256", VERCEL_WEBHOOK_SECRET).update(rawBody).digest("hex")
}

// --- Log parsing ---

// Try to extract structured (Pino) JSON from the log message.
// Returns the parsed message, extra metadata fields, and the Pino numeric level if present.
function parseLogEntry(entry) {
  if (!entry.message || entry.type !== "stdout") return { message: entry.message || "", metadata: {} }

  try {
    const jsonMatch = entry.message.match(/\{[\s\S]*\}/)
    if (!jsonMatch) return { message: entry.message, metadata: {} }

    const parsed = JSON.parse(jsonMatch[0])
    const metadata = {}
    for (const key in parsed) {
      if (!PINO_IGNORE.has(key)) metadata[key] = parsed[key]
    }

    return {
      message: parsed.msg || "",
      metadata,
      pinoLevel: typeof parsed.level === "number" ? parsed.level : null,
    }
  } catch {
    return { message: entry.message, metadata: {} }
  }
}

// --- Log processing ---

// Converts an array of Vercel log entries into Google Cloud Logging entries.
function processLogs(logs, appName, includeProxy) {
  const entries = []

  for (const entry of logs) {
    // Skip proxy-only logs (no message content) if proxy logging is disabled.
    // Note: Vercel v1 schema attaches proxy data to ALL entries, so we can't
    // filter on entry.proxy alone — that would drop every log.
    if (!includeProxy && entry.proxy && !entry.message) continue

    // Use per-entry projectName when available (Vercel batches logs from multiple projects)
    const entryAppName = entry.projectName || appName

    const { message: parsedMsg, metadata, pinoLevel } = parseLogEntry(entry)
    let message = parsedMsg

    // Map severity: prefer Pino numeric level, fall back to Vercel string level
    let severity = VERCEL_LEVELS[entry.level?.toLowerCase()] || "INFO"
    if (pinoLevel != null) severity = PINO_LEVELS[pinoLevel] || severity

    // Strip AWS Lambda boilerplate (START/END/REPORT lines)
    if (message) {
      message = message
        .replace(/START RequestId:.*?\n?/g, "")
        .replace(/END RequestId:.*?\n?/g, "")
        .replace(/REPORT RequestId:.*/g, "")
        .trim()
    }

    // Skip Vercel auto-generated request summary logs (e.g. "[GET] /api/...")
    // Check each line — the summary can be wrapped by Lambda RequestId UUIDs
    if (!includeProxy && message) {
      const lines = message.split("\n").map(l => l.trim()).filter(Boolean)
      const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      const SUMMARY_RE = /^\[(GET|POST|PUT|DELETE|PATCH)\]\s/
      const isBoilerplate = lines.every(l => UUID_RE.test(l) || SUMMARY_RE.test(l))
      if (isBoilerplate) continue
    }

    // Handle proxy (HTTP request) logs
    if (!message && entry.proxy) {
      message = `${entry.proxy.method} ${entry.proxy.path} - ${entry.proxy.statusCode}`
    }

    // Skip completely empty entries
    if (!message && !entry.proxy) continue
    if (!message) message = "Request"

    // Collect Vercel context metadata for the log entry
    const vercel = {}
    if (entry.proxy) {
      vercel.method = entry.proxy.method
      vercel.path = entry.proxy.path
      vercel.statusCode = entry.proxy.statusCode
      vercel.host = entry.proxy.host
      if (entry.proxy.userAgent) vercel.userAgent = entry.proxy.userAgent
    }
    if (entry.requestId) vercel.requestId = entry.requestId
    if (entry.invocationId) vercel.invocationId = entry.invocationId
    if (entry.deploymentId) vercel.deploymentId = entry.deploymentId
    if (entry.executionRegion) vercel.region = entry.executionRegion

    // Use Vercel requestId as GCP trace ID for log correlation
    const traceId = entry.requestId || entry.invocationId

    entries.push(
      log.entry(
        {
          labels: {
            app_name: entryAppName,
            env: entry.environment || "production",
            source: "vercel-log-drain",
            ...(entry.proxy?.path ? { url: entry.proxy.path } : {}),
          },
          resource: {
            type: "cloud_run_revision",
            labels: {
              service_name: entryAppName,
              location: entry.executionRegion || "europe-west1",
            },
          },
          severity,
          timestamp: new Date(entry.timestamp || Date.now()),
          ...(traceId ? { trace: `projects/${GCP_PROJECT_ID}/traces/${traceId}`, traceSampled: true } : {}),
        },
        // jsonPayload: application message + metadata + Vercel context
        { message, ...metadata, vercel },
      ),
    )
  }

  return entries
}

// --- HTTP helpers ---

function parseQuery(url) {
  const idx = url.indexOf("?")
  if (idx === -1) return {}
  const params = {}
  for (const pair of url.slice(idx + 1).split("&")) {
    const [k, v] = pair.split("=")
    params[decodeURIComponent(k)] = decodeURIComponent(v || "")
  }
  return params
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on("data", (c) => chunks.push(c))
    req.on("end", () => resolve(Buffer.concat(chunks)))
    req.on("error", reject)
  })
}

function sendJson(res, status, data) {
  const body = JSON.stringify(data)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(body) })
  res.end(body)
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0]

  // Health check
  if (req.method === "GET" && path === "/health") {
    return sendJson(res, 200, { status: "healthy" })
  }

  // Log drain endpoint
  if (req.method === "POST" && path === "/drain") {
    try {
      const raw = await readBody(req)
      const rawStr = raw.toString("utf8")

      // Verify HMAC signature if present
      const signature = req.headers["x-vercel-signature"] || req.headers["x-webhook-signature"]
      if (signature && !verifySignature(rawStr, signature)) {
        return sendJson(res, 401, { error: "Invalid signature" })
      }

      // Parse body: NDJSON (one JSON object per line) or regular JSON array
      let logs
      if (req.headers["content-type"] === "application/x-ndjson") {
        logs = []
        for (const line of rawStr.split("\n")) {
          if (!line) continue
          try { logs.push(JSON.parse(line)) } catch {}
        }
      } else {
        const parsed = JSON.parse(rawStr)
        logs = Array.isArray(parsed) ? parsed : [parsed]
      }

      const query = parseQuery(req.url)
      const includeProxy = query.proxy === "true"

      // Resolve default app name: query param > first entry's projectName > "unknown"
      const defaultAppName = query.app || logs[0]?.projectName || "unknown"

      const entries = processLogs(logs, defaultAppName, includeProxy)

      // Batch write to Google Cloud Logging
      if (entries.length > 0) {
        await log.write(entries)
      }

      return sendJson(res, 200, { success: true, processed: entries.length, total: logs.length })
    } catch (error) {
      console.error("Error processing log drain:", error)
      return sendJson(res, 500, { error: "Internal server error" })
    }
  }

  sendJson(res, 404, { error: "Not found" })
})

server.listen(PORT, () => {
  console.log(`Log drain listening on port ${PORT}`)
})
