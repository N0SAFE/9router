/**
 * Usage performance analytics.
 *
 * Turns usage rows (tokens, cost, status and latency) into per-dimension
 * metrics: throughput (output tokens/second), input/prefill speed (prompt
 * tokens over TTFT), latency percentiles, cache hit rate, cost efficiency and
 * error rate — by model, provider, connection, API key or endpoint, plus a
 * time series for the trend chart.
 *
 * Pure module: the API feeds it rows, the tests feed it fixtures.
 */

export const PERFORMANCE_DIMENSIONS = [
  { id: "model", label: "Model" },
  { id: "provider", label: "Provider" },
  { id: "connection", label: "Connection" },
  { id: "apiKey", label: "API key" },
  { id: "endpoint", label: "Endpoint" },
];

export function percentile(sortedValues, p) {
  if (!sortedValues || sortedValues.length === 0) return null;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.floor((p / 100) * sortedValues.length)));
  return sortedValues[index];
}

function mean(sum, count) {
  return count > 0 ? sum / count : null;
}

function isSuccess(row) {
  const status = row?.status;
  return !status || status === "ok" || status === "success";
}

export function dimensionKey(row, dimension) {
  switch (dimension) {
    case "provider":
      return row?.provider || "unknown";
    case "connection":
      return row?.connectionId || "unknown";
    case "apiKey":
      return row?.apiKey || "local-no-key";
    case "endpoint":
      return row?.endpoint || "unknown";
    default:
      return `${row?.provider || "unknown"}/${row?.model || "unknown"}`;
  }
}

export function performanceRowLabels(row) {
  return {
    provider: row?.provider || "unknown",
    model: row?.model || "unknown",
    connectionId: row?.connectionId || null,
    apiKey: row?.apiKey || null,
    endpoint: row?.endpoint || null,
  };
}

function emptyBucket(key) {
  return {
    key,
    requests: 0,
    successes: 0,
    failures: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    ttft: [],
    total: [],
    inputSpeed: [],
    outputSpeed: [],
  };
}

/**
 * Feed one row into an aggregate bucket.
 * - output speed = completion tokens over generation time (total - ttft); when
 *   TTFT is unknown (non-streaming), the full latency is used.
 * - input speed = prompt tokens over TTFT — approximate, since TTFT also
 *   contains network and queueing time.
 */
function accumulate(bucket, row) {
  bucket.requests += 1;
  if (isSuccess(row)) bucket.successes += 1;
  else bucket.failures += 1;

  const input = Number(row?.promptTokens) || 0;
  const output = Number(row?.completionTokens) || 0;
  const cached = Number(row?.cachedTokens) || 0;
  const reasoning = Number(row?.reasoningTokens) || 0;
  const cost = Number(row?.costUsd ?? row?.cost) || 0;
  const ttft = Number(row?.ttft) || 0;
  const total = Number(row?.total) || 0;

  bucket.inputTokens += input;
  bucket.outputTokens += output;
  bucket.cachedTokens += cached;
  bucket.reasoningTokens += reasoning;
  bucket.costUsd += cost;

  if (total > 0) bucket.total.push(total);
  if (ttft > 0 && total >= ttft) {
    bucket.ttft.push(ttft);
    if (input > 0) bucket.inputSpeed.push(input / (ttft / 1000));
    const generationMs = total - ttft;
    if (output > 0 && generationMs > 0) bucket.outputSpeed.push(output / (generationMs / 1000));
  } else if (total > 0 && output > 0) {
    bucket.outputSpeed.push(output / (total / 1000));
  }
}

function finalizeBucket(bucket, { label, detail }) {
  const totalTokens = bucket.inputTokens + bucket.outputTokens;
  const ttftSorted = [...bucket.ttft].sort((a, b) => a - b);
  const totalSorted = [...bucket.total].sort((a, b) => a - b);
  const inputSpeedSorted = [...bucket.inputSpeed].sort((a, b) => a - b);
  const outputSpeedSorted = [...bucket.outputSpeed].sort((a, b) => a - b);

  return {
    key: bucket.key,
    label,
    detail: detail || null,
    requests: bucket.requests,
    successes: bucket.successes,
    failures: bucket.failures,
    successRate: bucket.requests > 0 ? bucket.successes / bucket.requests : null,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cachedTokens: bucket.cachedTokens,
    reasoningTokens: bucket.reasoningTokens,
    totalTokens,
    costUsd: bucket.costUsd,
    cacheHitRate: bucket.inputTokens > 0 ? bucket.cachedTokens / bucket.inputTokens : null,
    costPer1kTokens: totalTokens > 0 ? (bucket.costUsd / totalTokens) * 1000 : null,
    ttftAvg: mean(ttftSorted.reduce((sum, value) => sum + value, 0), ttftSorted.length),
    ttftP50: percentile(ttftSorted, 50),
    ttftP95: percentile(ttftSorted, 95),
    totalAvg: mean(totalSorted.reduce((sum, value) => sum + value, 0), totalSorted.length),
    totalP50: percentile(totalSorted, 50),
    totalP95: percentile(totalSorted, 95),
    inputSpeedAvg: mean(inputSpeedSorted.reduce((sum, value) => sum + value, 0), inputSpeedSorted.length),
    inputSpeedP50: percentile(inputSpeedSorted, 50),
    outputSpeedAvg: mean(outputSpeedSorted.reduce((sum, value) => sum + value, 0), outputSpeedSorted.length),
    outputSpeedP50: percentile(outputSpeedSorted, 50),
    outputSpeedP95: percentile(outputSpeedSorted, 95),
    latencySamples: totalSorted.length,
    ttftSamples: ttftSorted.length,
    samples: bucket.requests,
  };
}

function labelForKey(key, dimension, row, { connectionNames, apiKeyNames }) {
  if (dimension === "connection") {
    return connectionNames[key] || (key !== "unknown" ? `${key.slice(0, 8)}…` : "unknown");
  }
  if (dimension === "apiKey") {
    if (key === "local-no-key") return "Local (no key)";
    return apiKeyNames[key] || `${key.slice(0, 8)}…`;
  }
  if (dimension === "model") {
    const provider = row?.provider || "unknown";
    const model = row?.model || "unknown";
    return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
  }
  return key;
}

/**
 * Aggregate rows into per-dimension rows plus a throughput time series.
 * @param {Array<object>} rows normalized usage rows (see usageRepo.getUsagePerformanceRows)
 * @param {object} options
 * @param {string} [options.dimension] one of PERFORMANCE_DIMENSIONS ids
 * @param {object} [options.connectionNames] connectionId → display name
 * @param {object} [options.apiKeyNames] raw api key → display name
 * @param {string} [options.period] used to pick series buckets
 * @param {string} [options.seriesKey] restrict the series to one dimension value
 * @param {string} [options.seriesDimension]
 */
export function aggregatePerformance(rows = [], options = {}) {
  const {
    dimension = "model",
    connectionNames = {},
    apiKeyNames = {},
    period = "7d",
    seriesKey = null,
    seriesDimension = dimension,
  } = options;

  const bucketed = new Map();
  let withLatency = 0;
  let withTtft = 0;

  for (const row of rows) {
    const key = dimensionKey(row, dimension);
    if (!bucketed.has(key)) {
      bucketed.set(key, emptyBucket(key));
    }
    const bucket = bucketed.get(key);
    accumulate(bucket, row);
    if (Number(row?.total) > 0) withLatency += 1;
    if (Number(row?.ttft) > 0) withTtft += 1;
    bucket.lastRow = bucket.lastRow || row;
  }

  const items = [...bucketed.values()]
    .map((bucket) =>
      finalizeBucket(bucket, {
        label: labelForKey(bucket.key, dimension, bucket.lastRow, { connectionNames, apiKeyNames }),
        detail: null,
      })
    )
    .sort((a, b) => b.requests - a.requests);

  const series = buildPerformanceSeries(rows, {
    period,
    key: seriesKey,
    dimension: seriesDimension,
  });

  return {
    dimension,
    items,
    series,
    latencyCoverage: { withLatency, withTtft, total: rows.length },
    generatedAt: new Date().toISOString(),
  };
}

/** Bucket labels: 5-minute for 1h, hourly for today/24h, daily otherwise. */
export function seriesBuckets(period = "7d", now = Date.now()) {
  if (period === "1h") {
    const bucketMs = 5 * 60 * 1000;
    const start = now - 12 * bucketMs;
    return Array.from({ length: 12 }, (_, index) => {
      const time = start + index * bucketMs;
      return {
        start: time,
        end: time + bucketMs,
        label: new Date(time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      };
    });
  }
  if (period === "today" || period === "24h") {
    const bucketMs = 60 * 60 * 1000;
    const start = period === "today"
      ? new Date(new Date(now).setHours(0, 0, 0, 0)).getTime()
      : now - 24 * bucketMs;
    return Array.from({ length: 24 }, (_, index) => {
      const time = start + index * bucketMs;
      return {
        start: time,
        end: time + bucketMs,
        label: new Date(time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false }),
      };
    });
  }
  const days = period === "30d" ? 30 : period === "60d" ? 60 : 7;
  const bucketMs = 24 * 60 * 60 * 1000;
  const end = new Date(now);
  end.setHours(0, 0, 0, 0);
  const start = end.getTime() - (days - 1) * bucketMs;
  return Array.from({ length: days }, (_, index) => {
    const time = start + index * bucketMs;
    return {
      start: time,
      end: time + bucketMs,
      label: new Date(time).toLocaleDateString("en-US", { month: "short", day: "numeric" }),
    };
  });
}

/**
 * Throughput time series. When `key` is set, only rows for that dimension value
 * are used (clicking a table row narrows the chart).
 */
export function buildPerformanceSeries(rows = [], { period = "7d", key = null, dimension = "model" } = {}) {
  const buckets = seriesBuckets(period).map((bucket) => ({
    ...bucket,
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    ttftSum: 0,
    ttftCount: 0,
    inputSpeed: [],
    outputSpeed: [],
  }));

  for (const row of rows) {
    if (key && dimensionKey(row, dimension) !== key) continue;
    const time = row?.timestamp ? new Date(row.timestamp).getTime() : NaN;
    if (!Number.isFinite(time)) continue;
    const bucket = buckets.find((candidate) => time >= candidate.start && time < candidate.end);
    if (!bucket) continue;

    const input = Number(row?.promptTokens) || 0;
    const output = Number(row?.completionTokens) || 0;
    const ttft = Number(row?.ttft) || 0;
    const total = Number(row?.total) || 0;

    bucket.requests += 1;
    bucket.inputTokens += input;
    bucket.outputTokens += output;
    if (ttft > 0) {
      bucket.ttftSum += ttft;
      bucket.ttftCount += 1;
      if (input > 0) bucket.inputSpeed.push(input / (ttft / 1000));
    }
    if (total > 0 && output > 0) {
      const generationMs = ttft > 0 && total > ttft ? total - ttft : total;
      if (generationMs > 0) bucket.outputSpeed.push(output / (generationMs / 1000));
    }
  }

  return buckets.map((bucket) => ({
    label: bucket.label,
    requests: bucket.requests,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    ttftAvg: mean(bucket.ttftSum, bucket.ttftCount),
    inputSpeed: mean(bucket.inputSpeed.reduce((sum, value) => sum + value, 0), bucket.inputSpeed.length),
    outputSpeed: mean(bucket.outputSpeed.reduce((sum, value) => sum + value, 0), bucket.outputSpeed.length),
  }));
}
