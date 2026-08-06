
// worker.js — LLM-free resolve engine
// Web search (Brave) → parse → confidence loops → KV memory → principles synthesis

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
    if (url.pathname === "/health" && request.method === "GET") return health(env);
    if (url.pathname === "/resolve" && request.method === "POST") return resolveRequest(request, env);
    return new Response("ara", { headers: { "Content-Type": "text/plain" } });
  },
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

async function hashKey(text) {
  const enc = new TextEncoder();
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function stripHtml(text) {
  return text
    .replace(/<[^>]+>/g, "")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

async function webSearch(query, maxResults = 5, env) {
  if (!env.BRAVE_API_KEY) {
    return [
      { source: "web", title: "test result",
        snippet: query.length > 0 ? `explanation about "${query.substring(0, 40)}"` : "sample snippet" },
    ];
  }
  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${maxResults}`,
      { headers: { Accept: "application/json", "X-Subscription-Token": env.BRAVE_API_KEY } }
    );
    if (!res.ok) return [];
    const data = await res.json();
    const results = data.web?.results || [];
    return results.map((r) => ({
      source: r.url ? new URL(r.url).hostname.replace(/^www\./, "") : "web",
      title: stripHtml(r.title || ""),
      snippet: stripHtml(r.description || ""),
      url: r.url || "",
    }));
  } catch {
    return [];
  }
}

function scoreConfidence(findings, loop, query) {
  const queryTerms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
  let termHits = 0, totalTerms = 0;
  for (const f of findings) {
    const text = `${f.title} ${f.snippet}`.toLowerCase();
    for (const term of queryTerms) { totalTerms++; if (text.includes(term)) termHits++; }
  }
  const coverage = totalTerms > 0 ? termHits / totalTerms : 0;
  const volume = Math.min(findings.length / 5, 1.0);
  const loopBonus = loop * 0.05;
  const score = Math.min(0.1 + coverage * 0.5 + volume * 0.25 + loopBonus, 1.0);
  return { score, E: coverage, M: volume, C: loopBonus };
}

function refineQuery(query, loop) {
  if (loop === 0) return query;
  if (loop === 1) return `${query} explained`;
  if (loop === 2) return `${query} definition examples`;
  return `${query} overview`;
}

function summarizeTrail(trail) {
  return trail.map((t) => ({
    loop: t.loop, web: t.webCount, conf: t.confidence.score.toFixed(2),
    sources: t.sources, memory: t.memoryBoost ? "boosted" : "none",
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

function dedupeAndCap(findings, max = 15) {
  const seen = new Set(), unique = [];
  for (const f of findings) {
    const key = f.snippet || f.title || "";
    if (key && !seen.has(key)) { seen.add(key); unique.push(f); }
  }
  return unique.slice(0, max);
}

const PRINCIPLES = [
  "Information precedes form.", "Pattern mirrors elsewhere.", "Nothing rests; observe change.",
  "Opposites differ by degree.", "Flows in cycles.", "Nothing happens by chance.",
  "Creation via duals.", "Nothing lost, only transformed.",
];

function synthesize(query, findings, hadMemory) {
  const findingsBlock = findings.length > 0
    ? findings.map((f, i) => `  ${i + 1}. [${f.source}] ${f.title}: ${f.snippet.substring(0, 200)}`).join("\n")
    : "  (no web results found)";
  const principlesBlock = PRINCIPLES.map((p, i) => `  ${i + 1}) ${p}`).join("\n");
  const resolvedBy = findings.length > 0 ? (hadMemory ? "cumulative_memory+web" : "principles+web") : "principles";
  const termFreq = {};
  for (const f of findings) {
    const words = `${f.title} ${f.snippet}`.toLowerCase().split(/\s+/);
    for (const w of words) { if (w.length > 3) termFreq[w] = (termFreq[w] || 0) + 1; }
  }
  const crossRefs = Object.entries(termFreq)
    .filter(([_, count]) => count >= 2).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([term, count]) => `  - "${term}" appears in ${count} results`);
  const crossRefBlock = crossRefs.length > 0 ? `\nCross-references:\n${crossRefs.join("\n")}` : "";
  return `Query: ${query}\n\nFindings:\n${findingsBlock}\n${crossRefBlock}\nPrinciples (light):\n${principlesBlock}\n\nResolved by: ${resolvedBy}`;
}

async function resolveQuery(query, env) {
  const normalizedQuery = query.toLowerCase().replace(/[^a-z0-9]/g, "_").substring(0, 50);
  const memKey = `mem:v4:${normalizedQuery}`;
  const cacheKey = `v4:${await hashKey(query)}`;

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
    if (env.KV)
      await env.KV.put(cacheKey,
        JSON.stringify({ response: `BLOCKED: ${ethics.reason}`, trail: trailSummary, resolvedBy: "ethical" }),
        { expirationTtl: 3600 });
    return { response: `BLOCKED: ${ethics.reason}`, trail: trailSummary, resolvedBy: "ethical", cached: false };
  }

  let historicalMemory = [];
  if (env.KV) {
    const raw = await env.KV.get(memKey);
    if (raw) { try { historicalMemory = JSON.parse(raw) || []; } catch {} }
  }

  const trail = [];
  const allFindings = [...historicalMemory];
  let bestConfidence = { score: 0, E: 0, M: 0, C: 0 };

  for (let loop = 0; loop < 3; loop++) {
    const searchQuery = refineQuery(query, loop);
    const findings = await webSearch(searchQuery, 5, env);
    allFindings.push(...findings);
    const confidence = scoreConfidence(findings, loop, query);
    if (confidence.score > bestConfidence.score) bestConfidence = confidence;
    trail.push({
      loop: loop + 1, webCount: findings.length, confidence,
      sources: [...new Set(findings.map((f) => f.source))],
      memoryBoost: historicalMemory.length > 0,
    });
    if (confidence.score >= 0.55) break;
  }

  const capped = dedupeAndCap(allFindings);

  if (env.KV && capped.length) {
    await env.KV.put(memKey, JSON.stringify(capped), { expirationTtl: 2592000 });
  }

  const hadMemory = historicalMemory.length > 0;
  const resolvedBy = capped.length > 0 ? (hadMemory ? "cumulative_memory+web" : "principles+web") : "principles";
  const response = synthesize(query, capped, hadMemory);

  if (env.KV) {
    await env.KV.put(cacheKey, JSON.stringify({ response, trail, resolvedBy }), { expirationTtl: 3600 });
  }

  return { response, trail, resolvedBy, cached: false };
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
        send({ token: words.slice(i, i + 3).join(" ") });
        i += 3;
      }, 30);
    },
  }), { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...corsHeaders } });
}

async function health(env) {
  const start = Date.now();
  return json({ status: "ok", kv: !!env.KV, brave: !!env.BRAVE_API_KEY, latencyMs: Date.now() - start });
}

That's the complete file — 218 lines. Copy it into `~/memkv/src/worker.js`, commit, and push.