# VLM bake-off — dial-reader smoke corpus

Each (fixture, model) is run 3× with EXIF anchor = truth ± a fresh random offset in [-10, +10]s — production-realistic. The model sees a chain-of-thought prompt that walks it through hand identification (thinnest = second; shortest = hour; minute hand is the priority) and explicitly tells it NOT to echo the anchor.

**Production target: MM:SS error ≤ 5 s on every run, every fixture.** Only the minute+second components matter for verification (the hour comes from the server clock).

## Per-model summary (production-realistic round)

| Model            | Parsed | MM:SS ≤ 5 s | ≤ 60 s | ≤ 5 min | median \|err\| | p90 \|err\| | mean latency | total cost |
| ---------------- | ------ | ----------- | ------ | ------- | -------------- | ----------- | ------------ | ---------- |
| `openai/gpt-5.2` | 17/18  | 13/18       | 15/18  | 17/18   | 2s             | 119s        | 14545 ms     | $0.1049    |

## Per-fixture × per-model (3 runs each)

### `bambino_10_19_34.jpeg` — truth `10:19:34` (MM:SS = `19:34`)

**Run 1** — anchor `10:19:24` (offset `-10s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:21:33` | +119s     | 11692 ms |

**Run 2** — anchor `10:19:37` (offset `+3s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:19:36` | **+2s**   | 14007 ms |

**Run 3** — anchor `10:19:39` (offset `+5s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:19:34` | **+0s**   | 10431 ms |

### `greenseiko_07_56_06.jpeg` — truth `07:56:06` (MM:SS = `56:06`)

**Run 1** — anchor `07:56:15` (offset `+9s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `07:56:10` | **+4s**   | 16492 ms |

**Run 2** — anchor `07:56:09` (offset `+3s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `07:56:09` | **+3s**   | 13030 ms |

**Run 3** — anchor `07:56:15` (offset `+9s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `07:56:10` | **+4s**   | 14588 ms |

### `sinn_10_38_29.jpeg` — truth `10:38:29` (MM:SS = `38:29`)

**Run 1** — anchor `10:38:31` (offset `+2s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:38:29` | **+0s**   | 10833 ms |

**Run 2** — anchor `10:38:39` (offset `+10s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:36:30` | -119s     | 17235 ms |

**Run 3** — anchor `10:38:33` (offset `+4s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:38:28` | **-1s**   | 22906 ms |

### `snk803_01_07_20.jpeg` — truth `01:07:20` (MM:SS = `07:20`)

**Run 1** — anchor `01:07:20` (offset `+0s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `01:07:20` | **+0s**   | 14964 ms |

**Run 2** — anchor `01:07:22` (offset `+2s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `01:07:21` | **+1s**   | 22531 ms |

**Run 3** — anchor `01:07:21` (offset `+1s`)

| Model            | Predicted  | MM:SS err | latency |
| ---------------- | ---------- | --------- | ------- |
| `openai/gpt-5.2` | `01:08:20` | +60s      | 7000 ms |

### `snk803_10_15_40.jpeg` — truth `10:15:40` (MM:SS = `15:40`)

**Run 1** — anchor `10:15:43` (offset `+3s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:15:40` | **+0s**   | 14251 ms |

**Run 2** — anchor `10:15:42` (offset `+2s`)

| Model            | Predicted  | MM:SS err | latency |
| ---------------- | ---------- | --------- | ------- |
| `openai/gpt-5.2` | `10:15:42` | **+2s**   | 9914 ms |

**Run 3** — anchor `10:15:46` (offset `+6s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `10:15:40` | **+0s**   | 15903 ms |

### `waterbury_02_38_16.jpeg` — truth `02:38:16` (MM:SS = `38:16`)

**Run 1** — anchor `02:38:14` (offset `-2s`)

| Model                   | Predicted | MM:SS err       | latency |
| ----------------------- | --------- | --------------- | ------- |
| `openai/gpt-5.2`        | `❌`      | <!DOCTYPE html> |
| <!--[if lt IE 7]> <html | 13112 ms  |

**Run 2** — anchor `02:38:14` (offset `-2s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `02:38:14` | **-2s**   | 19593 ms |

**Run 3** — anchor `02:38:14` (offset `-2s`)

| Model            | Predicted  | MM:SS err | latency  |
| ---------------- | ---------- | --------- | -------- |
| `openai/gpt-5.2` | `02:38:45` | +29s      | 13338 ms |

## Robustness — anchor with large offset

Anchor = truth ± 90s. The model should still read pixels and ignore the misleading anchor. If a model produces an answer ≈ anchor in this round but ≈ truth in the production-realistic round, it's anchoring rather than reading.

| Fixture                 | Anchor            | Model            | Predicted  | err vs truth | err vs anchor |
| ----------------------- | ----------------- | ---------------- | ---------- | ------------ | ------------- |
| `bambino_10_19_34.jpeg` | `10:18:04` (-90s) | `openai/gpt-5.2` | `10:18:34` | -60s         | +30s          |
| `bambino_10_19_34.jpeg` | `10:21:04` (+90s) | `openai/gpt-5.2` | `10:21:31` | +117s        | +27s          |
| `snk803_10_15_40.jpeg`  | `10:14:10` (-90s) | `openai/gpt-5.2` | `10:15:40` | +0s          | +90s          |
| `snk803_10_15_40.jpeg`  | `10:17:10` (+90s) | `openai/gpt-5.2` | `10:15:40` | +0s          | -90s          |

## Notes

- All calls go through AI Gateway gateway `dial-reader-bakeoff`, billed via unified-billing credits.
- MM:SS error wraps on the 60-min circle: a `+1799s` error means the read was 30 minutes off in the worse direction. Wrap-aware shortest-path is used so we never report `+3500s`.
- Bold MM:SS errors (e.g. **`-2s`**) hit the production target.

_Generated by `scripts/vlm-bakeoff/bakeoff.py` at 2026-04-29 14:55:34 UTC._
