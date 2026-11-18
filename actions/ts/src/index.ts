// Benchmark task (identical logic to actions/py-docker/main.py):
// 1. read a JSON file of records
// 2. group by category -> count / sum / mean, plus top 5 amounts
// 3. call the GitHub REST API for the current repo
// 4. write a JSON summary and the in-process work time as step outputs
import * as core from "@actions/core";
import { readFileSync } from "node:fs";

interface Row {
  id: number;
  category: string;
  amount: number;
  timestamp: string;
}

async function run(): Promise<void> {
  const started = performance.now();

  const dataFile = core.getInput("data_file", { required: true });
  const token = core.getInput("token");
  const repo = process.env.GITHUB_REPOSITORY ?? "";

  const rows: Row[] = JSON.parse(readFileSync(dataFile, "utf8"));

  const groups: Record<string, { count: number; sum: number; mean: number }> = {};
  for (const r of rows) {
    const g = (groups[r.category] ??= { count: 0, sum: 0, mean: 0 });
    g.count += 1;
    g.sum += r.amount;
  }
  for (const g of Object.values(groups)) {
    g.sum = Math.round(g.sum * 100) / 100;
    g.mean = Math.round((g.sum / g.count) * 100) / 100;
  }
  const top5 = [...rows].sort((a, b) => b.amount - a.amount).slice(0, 5).map((r) => r.id);

  let stars: number | null = null;
  if (repo) {
    const res = await fetch(`https://api.github.com/repos/${repo}`, {
      headers: {
        Accept: "application/vnd.github+json",
        "User-Agent": "actions-lang-benchmark",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (!res.ok) throw new Error(`GitHub API returned ${res.status}`);
    stars = ((await res.json()) as { stargazers_count: number }).stargazers_count;
  }

  const summary = { rows: rows.length, groups, top5, stars };
  const workMs = Math.round(performance.now() - started);

  core.setOutput("summary", JSON.stringify(summary));
  core.setOutput("work_ms", String(workMs));
  core.info(`rows=${rows.length} groups=${Object.keys(groups).length} stars=${stars} work_ms=${workMs}`);
}

run().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)));
