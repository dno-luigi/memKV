// worker.js
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (url.pathname === "/health" && request.method === "GET") return health(env);
    if (url.pathname === "/resolve" && request.method === "POST") return resolveRequest(request, env);
    return new Response("ara", { headers: { "Content-Type": "text/plain" } });
  },
};

// --- constants & helpers ---

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...corsHeaders } });
}

async function hashKey(text) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function webSearch(query, maxResults = 3) {
  // Minimal stub: return synthetic structured findings so the test works offline.
  // Replace with real DuckDuckGo Lite fetch in production.
  return [
    { source: "web", title: "test result", snippet: query.length > 0 ? `explanation about "${query.substring(0, 20)}"` : "sample snippet" },
  ];
}

function scoreConfidence(findings, loop) {
  // Simple confidence proxy for testing
  const base = 0.2 + findings.length * 0.15 + (loop + 1) * 0.15;
  return { score: Math.min(base, 1.0), E: 0.1, M: 0.1, C: 0 };
}

function summarizeTrail(trail) {
  return trail.map((t) => ({
    loop: t.loop,
    web: t.webCount,
    conf: t.confidence.score.toFixed(2),
    sources: t.sources,
    memory: t.memoryBoost ? "boosted" : "none",
  }));
}

function checkEthics(query) {
  const harmPatterns = [
    /how to (make|build|create|synthesi[sz]e).*(bomb|weapon|poison|explosive|chemical.agent)/i,
    /how to (harm|hurt|kill|injure|poison|maim).*(person|human|people|child|animal)/i,
  ];
  for (const p of harmPatterns) if (p.test(query)) return { blocked: true, reason: "Do no harm to humans." };
  return { blocked: false };
}

// --- main resolve with KV-only cumulative memory ---

async function resolveQuery(query, env) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]/g, "_").substring(0, 50);
  const memKey = `mem:v4:${normalizedQuery}`;
  const cacheKey = `v4:${await hashKey(query)}`;

  // precise response cache
  if (env.KV) {
    const cached = await env.KV.get(cacheKey);
    if (cached) {
      const entry = JSON.parse(cached);
      return { response: entry.response, trail: entry.trail, resolvedBy: "cache", cached: true };
    }
  }

  const ethics = checkEthics(query);
  if (ethics.blocked) {
    const trailSummary = [{ loop: 0, web: 0, conf: "1.00", sources: [], memory: "none" }];
    if (env.KV) await env.KV.put(cacheKey, JSON.stringify({ response: `BLOCKED: ${ethics.reason}`, trail: trailSummary, resolvedBy: "ethical" }), { expirationTtl: 3600 });
    return { response: `BLOCKED: ${ethics.reason}`, trail: trailSummary, resolvedBy: "ethical", cached: false };
  }

  // load cumulative memory from KV
  let historicalMemory = [];
  if (env.KV) {
    const raw = await env.KV.get(memKey);
    if (raw) { try { historicalMemory = JSON.parse(raw) || []; } catch {} }
  }

  const trail = [];
  const allFindings = [...historicalMemory];
  let bestConfidence = { score: 0, E: 0.1, M: 0.1, C: 0 };

  for (let loop = 0; loop < 3; loop++) {
    const searchQuery = loop === 0 ? query : loop === 1 ? `${query} explained` : `${query} definition facts`;
    const findings = await webSearch(searchQuery, 3);
    allFindings.push(...findings);

    const confidence = scoreConfidence(findings, loop);
    if (confidence.score > bestConfidence.score) bestConfidence = confidence;

    trail.push({
      loop: loop + 1,
      webCount: findings.length,
      confidence,
      sources: [...new Set(findings.map((f) => f.source))],
      memoryBoost: historicalMemory.length > 0,
    });

    if (confidence.score >= 0.55 && allFindings.length >= 3) break;
  }

  // deduplicate by snippet, cap
  const seen = new Set();
  const unique = [];
  for (const f of allFindings) {
    const key = f.snippet || "";
    if (key && !seen.has(key)) { seen.add(key); unique.push(f); }
  }
  const capped = unique.slice(0, 15);

  // store cumulative memory back to KV (30d TTL)
  if (env.KV && capped.length) {
    await env.KV.put(memKey, JSON.stringify(capped), { expirationTtl: 2592000 });
  }

  // CRAC-style synthesis
  const response = `Query: ${query}

Findings:
${capped.map((f, i) => `  ${i + 1}. [${f.source}] ${f.title || ""}: ${f.snippet.substring(0, 160)}`).join("\n")}

Principles (light):
${["Information precedes form.","Pattern mirrors elsewhere.","Nothing rests; observe change.","Opposites differ by degree.","Flows in cycles.","Nothing happens by chance.","Creation via duals.","Nothing lost, only transformed."].map((l, i) => `  ${i + 1}) ${l}`).join("\n")}

Resolved by: ${capped.length > 0 ? (historicalMemory.length > 0 ? "cumulative_memory+web" : "principles+web") : "principles"}`;

  if (env.KV) {
    await env.KV.put(cacheKey, JSON.stringify({ response, trail, resolvedBy: capped.length > 0 ? (historicalMemory.length > 0 ? "cumulative_memory+web" : "principles+web") : "principles" }), { expirationTtl: 3600 });
  }

  return { response, trail, resolvedBy: capped.length > 0 ? (historicalMemory.length > 0 ? "cumulative_memory+web" : "principles+web") : "principles", cached: false };
}

async function resolveRequest(request, env) {
  const body = await request.json().catch(() => ({}));
  const query = body.prompt || "";
  if (!query) return json({ error: "No prompt provided" }, 400);
  const { response, trail, resolvedBy, cached } = await resolveQuery(query, env);
  const trailSummary = summarizeTrail(trail);
  if (cached) return json({ response, trail_summary: trailSummary, cached, resolved_by: resolvedBy });
  const isStream = request.url.includes("?stream=1");
  if (isStream) return streamSSE(response, trailSummary, cached, resolvedBy);
  return json({ response, trail_summary: trailSummary, cached, resolved_by: resolvedBy });
}

function streamSSE(text, trailSummary, cached, resolvedBy) {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream({
    start(ctrl) {
      const send = (data) => ctrl.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
      send({ trail_summary: trailSummary, cached, resolved_by: resolvedBy, done: false });
      const words = text.split(/\s+/);
      let i = 0;
      const interval = setInterval(() => {
        if (i >= words.length) { clearInterval(interval); send({ done: true }); ctrl.close(); return; }
        const chunk = words.slice(i, i + 3).join(" ");
        send({ token: chunk });
        i += 3;
      }, 30);
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders } });
}

async function health(env) {
  const start = Date.now();
  return json({ status: "ok", kv: !!env.KV, latencyMs: Date.now() - start });
}