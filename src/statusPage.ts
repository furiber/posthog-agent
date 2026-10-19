/**
 * Placeholder status/entry page (SSE consumer) — deliberately minimal, so a
 * real URL-entry UI can be added later. It posts a run and streams progress.
 */

export function statusPageHtml(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Analytics Audit Agent</title>
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; background: #0b0e14; color: #d7dde8; margin: 0; padding: 24px; }
  h1 { font-size: 16px; color: #7ee0c0; margin: 0 0 4px; }
  p.sub { color: #8a93a6; margin: 0 0 20px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 16px; }
  input { background: #141926; color: #d7dde8; border: 1px solid #2a3244; border-radius: 6px; padding: 8px 10px; font: inherit; }
  input#url { width: 340px; }
  button { background: #1b6f5f; border: none; color: #eafff8; border-radius: 6px; padding: 8px 16px; font: inherit; cursor: pointer; }
  button:disabled { opacity: .5; cursor: default; }
  #status { color: #8a93a6; margin-bottom: 12px; }
  #log { background: #10141f; border: 1px solid #222b3d; border-radius: 8px; padding: 10px; max-height: 260px; overflow: auto; white-space: pre-wrap; }
  .ev { margin: 2px 0; }
  .tag { color: #7ee0c0; }
  #report { white-space: pre-wrap; background: #10141f; border: 1px solid #222b3d; border-radius: 8px; padding: 12px; margin-top: 16px; max-height: 640px; overflow: auto; }
  .hide { display: none; }
</style>
</head>
<body>
<h1>Analytics Audit Agent</h1>
<p class="sub">Placeholder status page — crawl a site and stream the analytics instrumentation audit. POST { url, pageBudget } → SSE.</p>
<div class="row">
  <input id="url" placeholder="https://www.posthog.com" value="https://www.posthog.com">
  <input id="budget" type="number" min="1" max="200" value="4" style="width:90px" title="pageBudget">
  <button id="run">Run audit</button>
</div>
<div id="status">idle</div>
<div id="log" class="hide"></div>
<div id="report" class="hide"></div>
<script>
const $ = (id) => document.getElementById(id);
const setStatus = (t) => { $("status").textContent = t; };
function appendEv(event, data) {
  const log = $("log");
  log.classList.remove("hide");
  const line = document.createElement("div");
  line.className = "ev";
  const extra = Object.entries(data).filter(([k]) => !["event","ts","runId"].includes(k)).slice(0,6).map(([k,v]) => k + "=" + (typeof v === "object" ? JSON.stringify(v).slice(0,140) : String(v).slice(0,140))).join(" ");
  line.innerHTML = '<span class="tag">' + event + "</span> " + (extra ? extra : "");
  log.appendChild(line);
  log.scrollTop = log.scrollHeight;
}
$("run").addEventListener("click", async () => {
  const url = $("url").value.trim();
  const pageBudget = Number($("budget").value) || undefined;
  if (!url) { setStatus("enter a URL"); return; }
  $("run").disabled = true; $("report").classList.add("hide"); $("log").innerHTML = ""; $("log").classList.add("hide");
  setStatus("running…");
  try {
    const res = await fetch("/run", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url, pageBudget }) });
    if (!res.ok || !res.body) { setStatus("failed: HTTP " + res.status + " " + (await res.text()).slice(0, 200)); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\\n\\n")) >= 0) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        if (!frame.startsWith("data:")) continue;
        let msg; try { msg = JSON.parse(frame.slice(5).trim()); } catch { continue; }
        appendEv(msg.event, msg);
        if (msg.event === "report") {
          $("report").classList.remove("hide");
          $("report").textContent = msg.markdown || "(no markdown)";
        }
        if (msg.event === "done") setStatus("done" + (msg.partial ? " (partial — see report header)" : "") + " — evidence " + msg.evidenceCount);
        if (msg.event === "error") setStatus("error — see log");
      }
    }
    setStatus("stream closed");
  } catch (e) {
    setStatus("error: " + String(e).slice(0, 200));
  } finally {
    $("run").disabled = false;
  }
});
</script>
</body>
</html>`;
}
