const os = require('os');
const { monitorEventLoopDelay } = require('perf_hooks');

function percentile(values, p) {
  if (!Array.isArray(values) || !values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

function toMsFromNs(value) {
  return Number(value || 0) / 1e6;
}

function nowIso() {
  return new Date().toISOString();
}

class RuntimeMonitor {
  constructor(options = {}) {
    this.startedAt = Date.now();
    this.maxRecentRequests = Number(options.maxRecentRequests || 600);
    this.maxTimelinePoints = Number(options.maxTimelinePoints || 240);
    this.slowRequestThresholdMs = Number(options.slowRequestThresholdMs || 1200);

    this.requestTotals = {
      total: 0,
      success: 0,
      redirect: 0,
      clientError: 0,
      serverError: 0
    };

    this.routeStats = new Map();
    this.recentRequests = [];
    this.timeline = [];
    this.lastCpu = {
      at: Date.now(),
      usage: process.cpuUsage()
    };

    this.loopDelayMonitor = monitorEventLoopDelay({ resolution: 20 });
    this.loopDelayMonitor.enable();
  }

  recordRequest({ method, path, statusCode, durationMs }) {
    const cleanMethod = String(method || 'GET').toUpperCase();
    const cleanPath = String(path || '/').split('?')[0];
    const code = Number(statusCode || 0);
    const ms = Number(durationMs || 0);
    const routeKey = `${cleanMethod} ${cleanPath}`;

    this.requestTotals.total += 1;
    if (code >= 500) this.requestTotals.serverError += 1;
    else if (code >= 400) this.requestTotals.clientError += 1;
    else if (code >= 300) this.requestTotals.redirect += 1;
    else this.requestTotals.success += 1;

    const route = this.routeStats.get(routeKey) || {
      routeKey,
      count: 0,
      totalMs: 0,
      maxMs: 0,
      slowCount: 0,
      serverErrorCount: 0,
      durations: [],
      lastSeenAt: null
    };

    route.count += 1;
    route.totalMs += ms;
    route.maxMs = Math.max(route.maxMs, ms);
    route.lastSeenAt = Date.now();
    route.durations.push(ms);
    if (route.durations.length > 300) route.durations.shift();
    if (ms >= this.slowRequestThresholdMs) route.slowCount += 1;
    if (code >= 500) route.serverErrorCount += 1;
    this.routeStats.set(routeKey, route);

    this.recentRequests.push({
      at: nowIso(),
      method: cleanMethod,
      path: cleanPath,
      statusCode: code,
      durationMs: ms
    });
    if (this.recentRequests.length > this.maxRecentRequests) this.recentRequests.shift();

    this.timeline.push({
      ts: Date.now(),
      durationMs: ms,
      statusCode: code
    });
    if (this.timeline.length > this.maxTimelinePoints) this.timeline.shift();
  }

  getCpuPercent() {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - this.lastCpu.at);
    const currentUsage = process.cpuUsage();
    const diffUser = currentUsage.user - this.lastCpu.usage.user;
    const diffSystem = currentUsage.system - this.lastCpu.usage.system;
    this.lastCpu = { at: now, usage: currentUsage };

    const elapsedMicros = elapsedMs * 1000;
    const usedMicros = Math.max(0, diffUser + diffSystem);
    const singleCorePercent = (usedMicros / elapsedMicros) * 100;
    const coreCount = Math.max(1, os.cpus().length);
    return Math.min(100, singleCorePercent / coreCount);
  }

  buildWarnings(snapshot) {
    const warnings = [];
    const critical = [];

    if (snapshot.system.eventLoopLagP95Ms >= 140) {
      critical.push(`Event-Loop-Lag ist kritisch (${snapshot.system.eventLoopLagP95Ms} ms p95).`);
    } else if (snapshot.system.eventLoopLagP95Ms >= 80) {
      warnings.push(`Event-Loop-Lag ist erhöht (${snapshot.system.eventLoopLagP95Ms} ms p95).`);
    }

    if (snapshot.process.heapUsedPercent >= 88) {
      critical.push(`Heap-Auslastung sehr hoch (${snapshot.process.heapUsedPercent}%).`);
    } else if (snapshot.process.heapUsedPercent >= 75) {
      warnings.push(`Heap-Auslastung hoch (${snapshot.process.heapUsedPercent}%).`);
    }

    if (snapshot.http.errorRate5xxPercent >= 5) {
      critical.push(`5xx-Rate ist hoch (${snapshot.http.errorRate5xxPercent}%).`);
    } else if (snapshot.http.errorRate5xxPercent >= 1.5) {
      warnings.push(`5xx-Rate ist erhöht (${snapshot.http.errorRate5xxPercent}%).`);
    }

    if (snapshot.http.avgResponseMs >= 1200) {
      critical.push(`Durchschnittliche Antwortzeit kritisch (${snapshot.http.avgResponseMs} ms).`);
    } else if (snapshot.http.avgResponseMs >= 600) {
      warnings.push(`Durchschnittliche Antwortzeit erhöht (${snapshot.http.avgResponseMs} ms).`);
    }

    if (snapshot.system.load1 >= Math.max(1, snapshot.system.cpuCores * 1.2)) {
      warnings.push(`Systemlast (1m) ist hoch (${snapshot.system.load1}).`);
    }

    return { warnings, critical };
  }

  getSnapshot() {
    const mem = process.memoryUsage();
    const upSec = Math.floor(process.uptime());
    const routeRows = Array.from(this.routeStats.values());
    const totalRouteMs = routeRows.reduce((acc, row) => acc + row.totalMs, 0);
    const totalRequests = Math.max(1, this.requestTotals.total);
    const avgResponseMs = totalRouteMs > 0
      ? Number((totalRouteMs / totalRequests).toFixed(1))
      : 0;

    const allDurations = this.timeline.map((t) => t.durationMs);
    const p95 = Number(percentile(allDurations, 95).toFixed(1));
    const p99 = Number(percentile(allDurations, 99).toFixed(1));

    const routeSummary = routeRows
      .map((row) => {
        const avgMs = row.count ? row.totalMs / row.count : 0;
        const errorRate = row.count ? (row.serverErrorCount / row.count) * 100 : 0;
        return {
          routeKey: row.routeKey,
          count: row.count,
          avgMs: Number(avgMs.toFixed(1)),
          p95Ms: Number(percentile(row.durations, 95).toFixed(1)),
          maxMs: Number(row.maxMs.toFixed(1)),
          slowCount: row.slowCount,
          errorRate5xxPercent: Number(errorRate.toFixed(2)),
          lastSeenAt: row.lastSeenAt ? new Date(row.lastSeenAt).toISOString() : null
        };
      })
      .sort((a, b) => b.p95Ms - a.p95Ms)
      .slice(0, 15);

    const timeline = this.timeline
      .slice(-90)
      .map((item) => ({
        at: new Date(item.ts).toISOString(),
        durationMs: Number(item.durationMs.toFixed(1)),
        statusCode: item.statusCode
      }));

    const loopP95 = Number(toMsFromNs(this.loopDelayMonitor.percentile(95)).toFixed(1));
    const loopMax = Number(toMsFromNs(this.loopDelayMonitor.max).toFixed(1));
    this.loopDelayMonitor.reset();

    const cpuPercent = Number(this.getCpuPercent().toFixed(1));
    const rssMb = Number((mem.rss / (1024 * 1024)).toFixed(1));
    const heapUsedMb = Number((mem.heapUsed / (1024 * 1024)).toFixed(1));
    const heapTotalMb = Number((mem.heapTotal / (1024 * 1024)).toFixed(1));
    const heapUsedPercent = heapTotalMb > 0
      ? Number(((heapUsedMb / heapTotalMb) * 100).toFixed(1))
      : 0;

    const snapshot = {
      generatedAt: nowIso(),
      process: {
        pid: process.pid,
        nodeVersion: process.version,
        uptimeSeconds: upSec,
        uptimeHuman: `${Math.floor(upSec / 3600)}h ${Math.floor((upSec % 3600) / 60)}m ${upSec % 60}s`,
        cpuPercent,
        rssMb,
        heapUsedMb,
        heapTotalMb,
        heapUsedPercent
      },
      system: {
        hostname: os.hostname(),
        platform: os.platform(),
        cpuCores: os.cpus().length,
        load1: Number(os.loadavg()[0].toFixed(2)),
        load5: Number(os.loadavg()[1].toFixed(2)),
        load15: Number(os.loadavg()[2].toFixed(2)),
        eventLoopLagP95Ms: loopP95,
        eventLoopLagMaxMs: loopMax
      },
      http: {
        totalRequests: this.requestTotals.total,
        success: this.requestTotals.success,
        redirect: this.requestTotals.redirect,
        clientError: this.requestTotals.clientError,
        serverError: this.requestTotals.serverError,
        errorRate5xxPercent: Number(((this.requestTotals.serverError / totalRequests) * 100).toFixed(2)),
        avgResponseMs,
        p95ResponseMs: p95,
        p99ResponseMs: p99,
        slowRequestThresholdMs: this.slowRequestThresholdMs
      },
      topSlowRoutes: routeSummary,
      recentRequests: this.recentRequests.slice(-60).reverse(),
      timeline
    };

    snapshot.health = this.buildWarnings(snapshot);
    return snapshot;
  }
}

module.exports = RuntimeMonitor;
