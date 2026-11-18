#!/usr/bin/env node
// Collects benchmark results and writes report.html, results.csv, summary.json
// and (in CI) a Markdown table in the job summary. No dependencies.
//
//   node scripts/report.mjs --results <dir of result JSON files> --out <dir>
//                           [--repo owner/name --run <run id>]   # adds whole-job times from the API
//
// Needs GH_TOKEN (or GITHUB_TOKEN) when --repo/--run are given.
import { readdirSync, readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const resultsDir = args.results ?? "results";
const outDir = args.out ?? "report";
const ORDER = ["ts", "py-docker", "py-composite", "py-composite-cached"];
const LABEL = {
  ts: "TypeScript (node24)",
  "py-docker": "Python – Docker",
  "py-composite": "Python – composite",
  "py-composite-cached": "Python – composite + pip cache",
};

// ---- 1. per-job results written by the workflow -------------------------------------------
const rows = existsSync(resultsDir)
  ? readdirSync(resultsDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => JSON.parse(readFileSync(join(resultsDir, f), "utf8")))
  : [];
const key = (v, i) => `${v}#${i}`;
const byKey = new Map(rows.map((r) => [key(r.variant, r.iteration), { ...r, job_s: null }]));

// ---- 2. whole-job durations from the API (includes runner setup, checkout, Docker pull) -----
const token = process.env.GH_TOKEN ?? process.env.GITHUB_TOKEN;
if (args.repo && args.run) {
  for (let page = 1; ; page++) {
    const res = await fetch(
      `https://api.github.com/repos/${args.repo}/actions/runs/${args.run}/jobs?filter=latest&per_page=100&page=${page}`,
      { headers: { Accept: "application/vnd.github+json", "User-Agent": "actions-lang-benchmark", ...(token && { Authorization: `Bearer ${token}` }) } },
    );
    if (!res.ok) throw new Error(`jobs API returned ${res.status}: ${await res.text()}`);
    const { jobs } = await res.json();
    for (const j of jobs) {
      const m = /^bench (\S+) (\d+)$/.exec(j.name);
      if (!m || !j.started_at || !j.completed_at) continue;
      const k = key(m[1], Number(m[2]));
      const row = byKey.get(k) ?? { variant: m[1], iteration: Number(m[2]), step_ms: null, work_ms: null };
      row.job_s = (Date.parse(j.completed_at) - Date.parse(j.started_at)) / 1000;
      row.conclusion = j.conclusion;
      byKey.set(k, row);
    }
    if (jobs.length < 100) break;
  }
}
const all = [...byKey.values()].sort((a, b) => ORDER.indexOf(a.variant) - ORDER.indexOf(b.variant) || a.iteration - b.iteration);
if (!all.length) {
  console.error(`No results found in ${resultsDir}`);
  process.exit(1);
}

// ---- 3. stats ------------------------------------------------------------------------------
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  return s[Math.floor(i)] + (s[Math.ceil(i)] - s[Math.floor(i)]) * (i - Math.floor(i));
};
const stat = (xs) => {
  xs = xs.filter((x) => typeof x === "number");
  return { n: xs.length, median: pct(xs, 0.5), p90: pct(xs, 0.9), min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null };
};
const variants = ORDER.filter((v) => all.some((r) => r.variant === v));
const summary = Object.fromEntries(
  variants.map((v) => {
    const rs = all.filter((r) => r.variant === v);
    return [v, {
      label: LABEL[v] ?? v,
      step_ms: stat(rs.map((r) => r.step_ms)),
      work_ms: stat(rs.map((r) => r.work_ms)),
      job_s: stat(rs.map((r) => r.job_s)),
      // GitHub bills each job rounded UP to the next whole minute.
      billed_minutes: rs.some((r) => r.job_s != null) ? rs.reduce((t, r) => t + (r.job_s != null ? Math.max(1, Math.ceil(r.job_s / 60)) : 0), 0) : null,
      failures: rs.filter((r) => r.conclusion && r.conclusion !== "success").length,
    }];
  }),
);

// ---- 4. write files ------------------------------------------------------------------------
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
writeFileSync(
  join(outDir, "results.csv"),
  ["variant,iteration,step_ms,work_ms,job_s,conclusion", ...all.map((r) => [r.variant, r.iteration, r.step_ms ?? "", r.work_ms ?? "", r.job_s ?? "", r.conclusion ?? ""].join(","))].join("\n") + "\n",
);

const fmt = (x, unit) => (x == null ? "–" : unit === "s" ? `${x.toFixed(1)} s` : x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${Math.round(x)} ms`);
const ratio = (v, field) => {
  const t = summary.ts?.[field]?.median, o = summary[v]?.[field]?.median;
  return t && o ? `${(o / t).toFixed(1)}×` : "–";
};

const md = [
  "## Action language benchmark",
  "",
  "| Variant | Runs | Action step (median / p90) | Code only (median) | Whole job (median) | Billed min | vs TS (step) |",
  "|---|---:|---:|---:|---:|---:|---:|",
  ...variants.map((v) => {
    const s = summary[v];
    return `| ${s.label} | ${s.step_ms.n} | ${fmt(s.step_ms.median)} / ${fmt(s.step_ms.p90)} | ${fmt(s.work_ms.median)} | ${fmt(s.job_s.median, "s")} | ${s.billed_minutes ?? "–"} | ${v === "ts" ? "1.0×" : ratio(v, "step_ms")} |`;
  }),
  "",
  "*Action step* = wall time of the `uses:` step, including Docker build, setup-python and pip install. *Code only* = time inside the script itself. *vs TS* = how many times slower than TypeScript.",
].join("\n");
writeFileSync(join(outDir, "summary.md"), md + "\n");
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");

// ---- 5. HTML report with inline SVG bar charts ---------------------------------------------
const COLOR = { ts: "var(--c-ts)", "py-docker": "var(--c-a)", "py-composite": "var(--c-b)", "py-composite-cached": "var(--c-c)" };
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function chart(title, field, unit) {
  const data = variants.map((v) => ({ v, s: summary[v][field] })).filter((d) => d.s.median != null);
  if (!data.length) return "";
  const max = Math.max(...data.map((d) => d.s.p90 ?? d.s.median)) * 1.12;
  const W = 640, labelW = 210, rowH = 34, H = data.length * rowH + 8, plotW = W - labelW - 70;
  const x = (val) => labelW + (val / max) * plotW;
  const bars = data.map((d, i) => {
    const y = i * rowH + 6;
    const tip = `${LABEL[d.v]}: median ${fmt(d.s.median, unit)}, p90 ${fmt(d.s.p90, unit)}, min ${fmt(d.s.min, unit)}, max ${fmt(d.s.max, unit)} (n=${d.s.n})`;
    return `<g><title>${esc(tip)}</title>
      <text x="${labelW - 10}" y="${y + 15}" text-anchor="end" class="lbl">${esc(LABEL[d.v])}</text>
      <rect x="${labelW}" y="${y}" width="${Math.max(2, x(d.s.median) - labelW)}" height="20" rx="3" fill="${COLOR[d.v]}"/>
      ${d.s.p90 != null ? `<line x1="${x(d.s.p90)}" x2="${x(d.s.p90)}" y1="${y - 2}" y2="${y + 22}" class="p90"/>` : ""}
      <text x="${x(Math.max(d.s.median, d.s.p90 ?? 0)) + 8}" y="${y + 15}" class="val">${fmt(d.s.median, unit)}</text></g>`;
  }).join("");
  return `<section><h2>${esc(title)}</h2><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title)}">${bars}</svg>
    <p class="note">Bar = median · tick = 90th percentile (p90) · hover a bar for min/max</p></section>`;
}

const tableRows = variants.map((v) => {
  const s = summary[v];
  return `<tr><td><span class="dot" style="background:${COLOR[v]}"></span>${esc(s.label)}</td><td>${s.step_ms.n}</td>
    <td>${fmt(s.step_ms.median)}</td><td>${fmt(s.step_ms.p90)}</td><td>${fmt(s.work_ms.median)}</td>
    <td>${fmt(s.job_s.median, "s")}</td><td>${s.billed_minutes ?? "–"}</td><td>${v === "ts" ? "1.0×" : ratio(v, "step_ms")}</td></tr>`;
}).join("");

const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Action Language Benchmark</title>
<style>
:root{--bg:#fafaf9;--fg:#1c1917;--muted:#78716c;--line:#e7e5e4;--card:#fff;--c-ts:#2563eb;--c-a:#d97706;--c-b:#ca8a04;--c-c:#65a30d}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--c-ts:#60a5fa;--c-a:#fbbf24;--c-b:#facc15;--c-c:#a3e635}}
:root[data-theme="dark"]{--bg:#1c1917;--fg:#f5f5f4;--muted:#a8a29e;--line:#44403c;--card:#292524;--c-ts:#60a5fa;--c-a:#fbbf24;--c-b:#facc15;--c-c:#a3e635}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:32px 16px}
h1{font-size:1.6rem;margin:0 0 4px}h2{font-size:1.05rem;margin:0 0 12px}
section{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin:18px 0;overflow-x:auto}
svg{width:100%;min-width:480px;height:auto}.lbl,.val{font-size:12px;fill:var(--fg)}.val{fill:var(--muted)}
.p90{stroke:var(--fg);stroke-width:2}.note,.sub{color:var(--muted);font-size:13px;margin:6px 0 0}
table{border-collapse:collapse;width:100%;font-size:13px;min-width:600px}th,td{padding:7px 8px;border-bottom:1px solid var(--line);text-align:right}
th:first-child,td:first-child{text-align:left}.dot{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px}
</style></head><body><main>
<h1>Action language benchmark</h1>
<p class="sub">The same task (read a 5,000-row JSON file, group it, call the GitHub API, set outputs), built as a TypeScript action and as two kinds of Python action.${args.run ? ` Run ${esc(args.run)} in ${esc(args.repo)}.` : ""}</p>
${chart("Action step time (what users wait for)", "step_ms", "ms")}
${chart("Code-only time (inside the script)", "work_ms", "ms")}
${chart("Whole job time (runner setup → done)", "job_s", "s")}
<section><h2>Numbers</h2><table><thead><tr><th>Variant</th><th>Runs</th><th>Step median</th><th>Step p90</th><th>Code median</th><th>Job median</th><th>Billed min</th><th>vs TS</th></tr></thead><tbody>${tableRows}</tbody></table>
<p class="note">“vs TS” = median action-step time ÷ TypeScript's. Billed minutes round each job up to a whole minute, so small differences can disappear there.</p></section>
</main></body></html>`;
writeFileSync(join(outDir, "report.html"), html);
console.log(md);
console.log(`\nWrote ${outDir}/report.html, results.csv, summary.json`);
