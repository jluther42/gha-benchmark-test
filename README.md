# TypeScript vs Python GitHub Actions benchmark

One task, built as three kinds of action, run many times on the same runners:

| Variant | Folder | How it starts |
|---|---|---|
| `ts` | `actions/ts` | Bundled JS run by the runner's own Node 24 |
| `py-docker` | `actions/py-docker` | Docker image built from the Dockerfile each run |
| `py-composite` | `actions/py-composite` | `setup-python` + `pip install`, no cache |
| `py-composite-cached` | `actions/py-composite` | Same, with setup-python's pip cache warmed first |

The task: read `data/sample.json` (5,000 rows), group by category, call the GitHub API, and set outputs.
Both languages produce byte-for-byte the same summary.

## Run it

1. Push this folder to a GitHub repository.
2. **Actions → Action language benchmark → Run workflow** (pick runs per variant, default 20).
3. When it finishes, the run's summary shows the results table. Download the **benchmark-report**
   artifact for `report.html` (charts), `results.csv` and `summary.json`.

## What is measured

- **Action step**: wall time of the `uses:` step, including Docker build / setup-python / pip. This is the main number.
- **Code only**: time inside the script itself. Shows the language barely matters for the actual work.
- **Whole job**: from the jobs API, runner setup to finish.
- **Billed minutes**: each job rounded up to a whole minute, the way GitHub bills.

Report median and p90, not single runs.

## Re-run the report locally

```bash
GH_TOKEN=... node scripts/report.mjs --repo OWNER/REPO --run RUN_ID --results results --out report
```

(`results/` = the downloaded `result-*` artifacts.)

## Changing the TS action

```bash
cd actions/ts && npm install && npm run build
```

Commit `dist/index.js` - the runner runs it directly.
