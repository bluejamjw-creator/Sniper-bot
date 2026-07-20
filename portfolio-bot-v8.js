// src/config/env.js
var REQUIRED = {
  supabase: ["SUPABASE_URL", "SUPABASE_SERVICE_KEY"],
  // CHANNEL_CHAT_ID (the public Telegram channel) is deliberately NOT
  // required here. Delivery is currently Bluejam-only (see
  // judge/policy.js's decisionToDeliveryTarget — PUBLIC is never
  // emitted) so there is nothing that actually sends to it yet.
  // Requiring it at boot would force an unused variable just to
  // satisfy a check. If PUBLIC delivery is ever turned back on, this
  // needs revisiting alongside that change — not before.
  telegram: ["BOT_TOKEN", "CHAT_ID"]
};
var OPTIONAL_DEFAULTS = {
  NODE_ENV: "production",
  LOG_LEVEL: "info",
  OBSERVER_SCAN_INTERVAL_SECONDS: "300",
  RADAR_SCAN_INTERVAL_SECONDS: "60",
  INTEL_DISCOVERY_INTERVAL_SECONDS: "3600",
  // 1 hour — matches V104's pool-refresh cadence
  // Defaults to disabled per explicit user request: narrative "what's
  // moving" updates are silenced until portfolio open/hold/close
  // logic exists, at which point this can be flipped back on with a
  // single env var change — no code change needed. Intel's underlying
  // discovery cycle and heat-tracking keep running either way; this
  // only controls whether Telegram actually delivers the resulting
  // INTEL_REPORT events. Set to 'true' in Railway to re-enable.
  NARRATIVE_ALERTS_ENABLED: "false",
  PORTFOLIO_REVIEW_INTERVAL_SECONDS: "14400",
  // 4 hours
  PORTFOLIO_ALERTS_ENABLED: "true",
  PORTFOLIO_HOLD_ALERTS_ONLY_ON_CHANGE: "true",
  SCORING_FROZEN: "true",
  LOG_CHAT_ID: "",
  YAHOO_FINANCE_ENABLED: "true"
};
function validateRequired() {
  const missing = [];
  for (const [group, keys] of Object.entries(REQUIRED)) {
    for (const key of keys) {
      const value = process.env[key];
      if (!value || value.trim() === "") {
        missing.push(`${key} (group: ${group})`);
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(
      `SNIPER X1 cannot start \u2014 missing required environment variables:
` + missing.map((m) => `  - ${m}`).join("\n") + `

Copy .env.example to .env and fill in the missing values.`
    );
  }
}
function resolveOptional() {
  const resolved = {};
  for (const [key, defaultValue] of Object.entries(OPTIONAL_DEFAULTS)) {
    resolved[key] = process.env[key] ?? defaultValue;
  }
  return resolved;
}
function loadEnv() {
  validateRequired();
  const optional = resolveOptional();
  return {
    nodeEnv: optional.NODE_ENV,
    logLevel: optional.LOG_LEVEL,
    scoringFrozen: optional.SCORING_FROZEN === "true",
    supabase: {
      url: process.env.SUPABASE_URL,
      serviceKey: process.env.SUPABASE_SERVICE_KEY
    },
    telegram: {
      botToken: process.env.BOT_TOKEN,
      publicChannelId: process.env.CHANNEL_CHAT_ID ?? null,
      bluejamChannelId: process.env.CHAT_ID,
      logChannelId: optional.LOG_CHAT_ID || null
    },
    adapters: {
      // Binance's market-data endpoint (data-api.binance.vision) needs
      // no key — confirmed against the existing production system,
      // which calls it freely with no auth. This slot is reserved,
      // unused, in case a future authenticated endpoint is needed.
      binance: {
        apiKey: process.env.BINANCE_API_KEY ?? null,
        apiSecret: process.env.BINANCE_API_SECRET ?? null
      },
      alpaca: {
        apiKey: process.env.ALPACA_API_KEY ?? null,
        apiSecret: process.env.ALPACA_SECRET_KEY ?? null,
        baseUrl: process.env.ALPACA_BASE_URL ?? "https://paper-api.alpaca.markets"
      },
      polygon: {
        apiKey: process.env.POLYGON_API_KEY ?? null
      },
      finnhub: {
        apiKey: process.env.FINNHUB_API_KEY ?? null
      },
      fmp: {
        apiKey: process.env.FMP_API_KEY ?? null
      },
      // Credential slots only — no provider built for these yet. Added
      // now so the naming is settled before any of the three get wired,
      // rather than needing another config pass later.
      twelveData: {
        apiKey: process.env.TWELVE_DATA_API_KEY ?? null
      },
      alphaVantage: {
        apiKey: process.env.ALPHA_VANTAGE_API_KEY ?? null
      },
      coingecko: {
        apiKey: process.env.COINGECKO_API_KEY ?? null
      },
      yahooFinance: {
        enabled: optional.YAHOO_FINANCE_ENABLED === "true"
      }
    },
    cadence: {
      observerScanIntervalSeconds: parseInt(optional.OBSERVER_SCAN_INTERVAL_SECONDS, 10),
      radarScanIntervalSeconds: parseInt(optional.RADAR_SCAN_INTERVAL_SECONDS, 10),
      intelDiscoveryIntervalSeconds: parseInt(optional.INTEL_DISCOVERY_INTERVAL_SECONDS, 10),
      narrativeAlertsEnabled: optional.NARRATIVE_ALERTS_ENABLED === "true"
    },
    portfolio: {
      reviewIntervalSeconds: parseInt(optional.PORTFOLIO_REVIEW_INTERVAL_SECONDS, 10),
      alertsEnabled: optional.PORTFOLIO_ALERTS_ENABLED === "true",
      holdAlertsOnlyOnChange: optional.PORTFOLIO_HOLD_ALERTS_ONLY_ON_CHANGE === "true"
    }
  };
}

// src/config/constants.js
var EVENTS = Object.freeze({
  MARKET_STATE_CHANGED: "MARKET_STATE_CHANGED",
  // emitted by Observer
  CANDIDATE_DISCOVERED: "CANDIDATE_DISCOVERED",
  // emitted by Radar
  INTEL_UPDATED: "INTEL_UPDATED",
  // emitted by Intel — per-candidate theme memory update, feeds Judge's reasoning
  INTEL_REPORT: "INTEL_REPORT",
  // emitted by Intel — a standalone narrative broadcast (V104-parity feature), NOT tied to any candidate/decision. Telegram subscribes to this passively, same "view, not participant" rule as DECISION_MADE — this does not make Intel a decision engine, it stays symbol-agnostic informational content.
  PROFILE_COMPLETE: "PROFILE_COMPLETE",
  // emitted by Sniper
  DECISION_MADE: "DECISION_MADE",
  // emitted by Judge
  TRADE_OUTCOME_RECORDED: "TRADE_OUTCOME_RECORDED",
  // emitted by Outcome Recorder, ALSO published by Portfolio on close (see POSITION_CLOSED below) so Memory's expectancy/failure analytics keep working regardless of which engine closed the loop
  POSITION_OPENED: "POSITION_OPENED",
  // emitted by Portfolio — a new open position was created from a qualifying DECISION_MADE
  POSITION_REVIEWED: "POSITION_REVIEWED",
  // emitted by Portfolio — a scheduled review of an open position completed (HOLD or CLOSE)
  POSITION_CLOSED: "POSITION_CLOSED"
  // emitted by Portfolio — a position was closed; always accompanied by a TRADE_OUTCOME_RECORDED publish in the same close flow
});
var DECISIONS = Object.freeze({
  ELITE: "ELITE",
  GOOD: "GOOD",
  WATCH: "WATCH",
  PASS: "PASS"
});
var ASSET_CLASSES = Object.freeze({
  US_STOCK: "us_stock",
  LSE: "lse",
  CRYPTO: "crypto"
});
var RISK_STATE = Object.freeze({
  RISK_ON: "risk_on",
  RISK_OFF: "risk_off",
  NEUTRAL: "neutral"
});
var DELIVERY_TARGETS = Object.freeze({
  PUBLIC: "public",
  BLUEJAM: "bluejam",
  LOG_ONLY: "log_only"
});
var PILLARS = Object.freeze({
  TREND: "trend",
  STRUCTURE: "structure",
  MOMENTUM: "momentum",
  PARTICIPATION: "participation",
  RISK: "risk"
});

// src/config/universe.js
var UNIVERSE = Object.freeze({
  us_stock: Object.freeze({
    minAvgDollarVolume20d: 5e6,
    // DRAFT — min $ volume, 20-day avg
    minPrice: 1,
    // DRAFT — excludes sub-$1 penny stocks
    minMarketCap: 1e8,
    // DRAFT — $100M floor
    excludeOtc: true
  }),
  lse: Object.freeze({
    minAvgDollarVolumeGBP20d: 5e5,
    // DRAFT — GBP, 20-day avg
    minPrice: 0.1,
    // DRAFT — in GBP
    minMarketCapGBP: 5e7,
    // DRAFT
    mainMarketOnly: true
    // excludes AIM unless explicitly enabled
  }),
  crypto: Object.freeze({
    minMarketCap: 5e7,
    // DRAFT
    minAvgDailyVolume24h: 2e6,
    // DRAFT
    // Geo-block constraint carried forward from V104: Bybit/Binance
    // spot APIs are not reachable from Railway's US-region IPs for
    // certain endpoints. Adapter layer must handle this, not Radar.
    excludeIfNoAdapterCoverage: true
  })
});
function getUniverseRules(assetClass) {
  const rules = UNIVERSE[assetClass];
  if (!rules) {
    throw new Error(`No universe rules defined for asset class: ${assetClass}`);
  }
  return rules;
}

// src/config/pillars.js
var PILLAR_WEIGHTS = Object.freeze({
  trend: 0.25,
  structure: 0.25,
  momentum: 0.2,
  participation: 0.15,
  risk: 0.15
});
function validateWeights() {
  const sum = Object.values(PILLAR_WEIGHTS).reduce((acc, w) => acc + w, 0);
  const tolerance = 1e-4;
  if (Math.abs(sum - 1) > tolerance) {
    throw new Error(
      `Sniper pillar weights must sum to 1.0, got ${sum}. Check config/pillars.js.`
    );
  }
}
validateWeights();
var RVOL_REFERENCE = Object.freeze({
  optimalCenter: 1.8,
  exhaustionThreshold: 2.5
});

// src/config/observer.js
var OBSERVER_THRESHOLDS = Object.freeze({
  breadth: {
    // % of universe constituents above their 50-day moving average
    riskOnMinPercent: 60,
    riskOffMaxPercent: 35
  },
  volatility: {
    // Reference index (e.g. VIX-equivalent per asset class) bands
    lowMax: 15,
    elevatedMax: 25,
    highMax: 35
    // anything above highMax is 'extreme'
  },
  rotation: {
    // Minimum number of sectors showing simultaneous leadership change
    // before Observer flags an active rotation
    minSectorsForRotationFlag: 3
  },
  confidence: {
    // Observer's own confidence in its market-state read, 0-1.
    // Below this, Observer reports NEUTRAL rather than committing to
    // risk_on/risk_off on thin evidence.
    minimumForCommittedState: 0.6
  }
});

// src/config/build.js
var BUILD = Object.freeze({
  platform: "SNIPER X1",
  version: "0.1.0",
  architecture: 1,
  judgePolicy: 1,
  scoringModel: 1,
  database: 1
});

// src/config/index.js
function buildConfig() {
  const env = loadEnv();
  return Object.freeze({
    env,
    events: EVENTS,
    decisions: DECISIONS,
    assetClasses: ASSET_CLASSES,
    riskState: RISK_STATE,
    deliveryTargets: DELIVERY_TARGETS,
    pillars: PILLARS,
    universe: UNIVERSE,
    getUniverseRules,
    pillarWeights: PILLAR_WEIGHTS,
    rvolReference: RVOL_REFERENCE,
    observerThresholds: OBSERVER_THRESHOLDS,
    build: BUILD
  });
}
var config = buildConfig();
if (import.meta.url === `file://${process.argv[1]}`) {
  console.log("\u2705 SNIPER X1 config loaded and validated successfully.");
  console.log(`   NODE_ENV: ${config.env.nodeEnv}`);
  console.log(`   Scoring frozen: ${config.env.scoringFrozen}`);
  console.log(`   Pillar weights sum: ${Object.values(config.pillarWeights).reduce((a, b) => a + b, 0)}`);
}

// src/kernel/contracts.js
var EVENT_CONTRACTS = Object.freeze({
  [EVENTS.MARKET_STATE_CHANGED]: Object.freeze({
    requiredFields: Object.freeze([
      "riskState",
      "breadth",
      "volatility",
      "sectorLeadership",
      "rotation",
      "confidence",
      "timestamp"
    ])
  }),
  [EVENTS.CANDIDATE_DISCOVERED]: Object.freeze({
    requiredFields: Object.freeze([
      "symbol",
      "assetClass",
      "sector",
      "interest",
      "marketStateId",
      "discoveredAt",
      "observerVersion"
    ])
  }),
  [EVENTS.INTEL_UPDATED]: Object.freeze({
    requiredFields: Object.freeze(["symbol", "sector", "theme", "narrative", "timestamp"])
  }),
  [EVENTS.INTEL_REPORT]: Object.freeze({
    // Deliberately minimal — `message` is Intel's already-formatted
    // text (narrativeMessageBuilder.js's output) and `reason` is
    // whatever narrativeChangeGate.js attributed the post to (e.g.
    // 'new-sector'). This event carries no symbol/decision fields —
    // it's a standalone broadcast, not tied to any single candidate.
    requiredFields: Object.freeze(["message", "reason", "timestamp"])
  }),
  [EVENTS.PROFILE_COMPLETE]: Object.freeze({
    requiredFields: Object.freeze(["candidateId", "profile", "timestamp"])
  }),
  [EVENTS.DECISION_MADE]: Object.freeze({
    requiredFields: Object.freeze([
      "candidateId",
      "decision",
      "reasoning",
      "explanation",
      "compositeScore",
      "deliveryTarget",
      "judgeVersion",
      "symbol",
      "assetClass",
      "sector",
      "marketStateId",
      // added for Portfolio's position-opening flow — Judge attaches these to the OUTGOING event only, never reads them for its own decision (see judge/index.js's header note)
      "timestamp"
    ])
  }),
  [EVENTS.TRADE_OUTCOME_RECORDED]: Object.freeze({
    requiredFields: Object.freeze(["symbol", "result", "rMultiple", "closedAt", "timestamp"])
  }),
  [EVENTS.POSITION_OPENED]: Object.freeze({
    requiredFields: Object.freeze([
      "positionId",
      "symbol",
      "assetClass",
      "sector",
      "decision",
      "entryPrice",
      "openedAt",
      "marketStateId",
      "riskStateAtEntry",
      "compositeScore",
      "deliveryTarget",
      "timestamp"
    ])
  }),
  [EVENTS.POSITION_REVIEWED]: Object.freeze({
    requiredFields: Object.freeze([
      "positionId",
      "symbol",
      "status",
      "reviewReason",
      "reviewSummary",
      "currentPrice",
      "unrealizedPercent",
      "evaluatedAt",
      "timestamp"
    ])
  }),
  [EVENTS.POSITION_CLOSED]: Object.freeze({
    requiredFields: Object.freeze([
      "positionId",
      "symbol",
      "assetClass",
      "sector",
      "entryPrice",
      "exitPrice",
      "openedAt",
      "closedAt",
      "holdingPeriodDays",
      "result",
      "rMultiple",
      "failureTrigger",
      "closeReason",
      "reviewSummary",
      "timestamp"
    ])
  })
});
function validatePayload(eventType, payload) {
  const contract = EVENT_CONTRACTS[eventType];
  if (!contract) {
    throw new Error(
      `No contract defined for event type "${eventType}". Add one in kernel/contracts.js before publishing this event.`
    );
  }
  if (payload === null || typeof payload !== "object") {
    throw new Error(`Payload for "${eventType}" must be an object, got: ${typeof payload}`);
  }
  const missing = contract.requiredFields.filter((field) => payload[field] === void 0);
  if (missing.length > 0) {
    throw new Error(
      `Payload for "${eventType}" is missing required field(s): ${missing.join(", ")}. Contract requires: ${contract.requiredFields.join(", ")}.`
    );
  }
}

// src/kernel/eventBus.js
var KNOWN_EVENTS = new Set(Object.values(config.events));
var EventBus = class {
  #subscribers = /* @__PURE__ */ new Map();
  // eventType -> Set<handler>
  #wildcardSubscribers = /* @__PURE__ */ new Set();
  // receive every event — used by Memory
  #logger;
  constructor({ logger } = {}) {
    this.#logger = logger ?? null;
  }
  /**
   * Subscribes a handler to a specific, known event type. Returns an
   * unsubscribe function. Throws if the event type isn't declared in
   * config/constants.js — this is what prevents engines from silently
   * inventing new event names.
   */
  subscribe(eventType, handler) {
    this.#assertKnownEvent(eventType);
    this.#assertHandler(handler, eventType);
    if (!this.#subscribers.has(eventType)) {
      this.#subscribers.set(eventType, /* @__PURE__ */ new Set());
    }
    this.#subscribers.get(eventType).add(handler);
    return () => {
      this.#subscribers.get(eventType)?.delete(handler);
    };
  }
  /**
   * Subscribes a handler to every event, regardless of type. This is
   * how Memory records the full event history without every engine
   * needing to know Memory exists — Memory subscribes to everything
   * once, here, rather than each engine writing to Memory directly.
   */
  subscribeAll(handler) {
    this.#assertHandler(handler, "*");
    this.#wildcardSubscribers.add(handler);
    return () => this.#wildcardSubscribers.delete(handler);
  }
  /**
   * Publishes an event to every matching subscriber. Handlers run
   * concurrently and independently — one handler throwing does not
   * stop other handlers from running, but every failure is logged.
   * Returns the envelope that was dispatched, mainly useful for tests.
   */
  async publish(eventType, payload) {
    this.#assertKnownEvent(eventType);
    validatePayload(eventType, payload);
    const envelope = Object.freeze({
      type: eventType,
      payload,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      eventId: globalThis.crypto.randomUUID()
    });
    this.#logger?.debug(`Event published: ${eventType}`, { eventId: envelope.eventId });
    const specificHandlers = [...this.#subscribers.get(eventType) ?? []];
    const allHandlers = [...specificHandlers, ...this.#wildcardSubscribers];
    const results = await Promise.allSettled(
      allHandlers.map((handler) => {
        try {
          return Promise.resolve(handler(envelope));
        } catch (err) {
          return Promise.reject(err);
        }
      })
    );
    for (const result of results) {
      if (result.status === "rejected") {
        this.#logger?.error(`Event handler failed for ${eventType}`, {
          eventId: envelope.eventId,
          error: result.reason?.message ?? String(result.reason)
        });
      }
    }
    return envelope;
  }
  /** Number of specific + wildcard subscribers currently registered for a type. Mainly for tests. */
  subscriberCount(eventType) {
    this.#assertKnownEvent(eventType);
    return (this.#subscribers.get(eventType)?.size ?? 0) + this.#wildcardSubscribers.size;
  }
  #assertKnownEvent(eventType) {
    if (!KNOWN_EVENTS.has(eventType)) {
      throw new Error(
        `Unknown event type "${eventType}". All event names must be declared in config/constants.js EVENTS \u2014 no ad hoc event names are permitted.`
      );
    }
  }
  #assertHandler(handler, context) {
    if (typeof handler !== "function") {
      throw new TypeError(`Event handler for "${context}" must be a function, got ${typeof handler}`);
    }
  }
};

// src/kernel/scheduler.js
var Scheduler = class {
  #tasks = /* @__PURE__ */ new Map();
  // name -> { intervalMs, handler, timer, isRunning }
  #logger;
  constructor({ logger } = {}) {
    this.#logger = logger ?? null;
  }
  /**
   * Registers a named task with a cadence in seconds. Does not start
   * it — call start(name) or startAll() separately, so registration
   * (usually done in an engine's onStart) is decoupled from actually
   * beginning the timer.
   */
  register(name, intervalSeconds, handler) {
    if (this.#tasks.has(name)) {
      throw new Error(`Scheduler task "${name}" is already registered`);
    }
    if (typeof handler !== "function") {
      throw new TypeError(`Scheduler task "${name}" handler must be a function`);
    }
    if (!Number.isFinite(intervalSeconds) || intervalSeconds <= 0) {
      throw new Error(`Scheduler task "${name}" needs a positive intervalSeconds, got ${intervalSeconds}`);
    }
    this.#tasks.set(name, {
      intervalMs: intervalSeconds * 1e3,
      handler,
      timer: null,
      isRunning: false
    });
  }
  /** Removes a registered task, stopping it first if it's running. */
  unregister(name) {
    this.stop(name);
    this.#tasks.delete(name);
  }
  /** Starts a registered task's timer. Safe to call if already started. */
  start(name) {
    const task = this.#tasks.get(name);
    if (!task) {
      throw new Error(`Scheduler task "${name}" is not registered`);
    }
    if (task.timer) return;
    task.timer = setInterval(() => this.#runTask(name), task.intervalMs);
    this.#logger?.info(`Scheduler: started "${name}" every ${task.intervalMs / 1e3}s`);
  }
  startAll() {
    for (const name of this.#tasks.keys()) this.start(name);
  }
  /** Stops a task's timer. Does not remove the registration. */
  stop(name) {
    const task = this.#tasks.get(name);
    if (!task?.timer) return;
    clearInterval(task.timer);
    task.timer = null;
    this.#logger?.info(`Scheduler: stopped "${name}"`);
  }
  stopAll() {
    for (const name of this.#tasks.keys()) this.stop(name);
  }
  /** Runs a registered task immediately, outside its normal cadence. Useful for tests and manual triggers. */
  async runNow(name) {
    if (!this.#tasks.has(name)) {
      throw new Error(`Scheduler task "${name}" is not registered`);
    }
    return this.#runTask(name);
  }
  async #runTask(name) {
    const task = this.#tasks.get(name);
    if (!task) return;
    if (task.isRunning) {
      this.#logger?.warn(`Scheduler: skipped "${name}" \u2014 previous run still in progress`);
      return;
    }
    task.isRunning = true;
    try {
      await task.handler();
    } catch (err) {
      this.#logger?.error(`Scheduler: task "${name}" failed`, { error: err.message });
    } finally {
      task.isRunning = false;
    }
  }
};

// src/kernel/logger.js
var LEVELS = Object.freeze({ debug: 10, info: 20, warn: 30, error: 40 });
function currentLevelThreshold() {
  return LEVELS[config.env.logLevel] ?? LEVELS.info;
}
function write(level, engineName, message, meta) {
  if (LEVELS[level] < currentLevelThreshold()) return;
  const line = {
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    level,
    engine: engineName,
    message,
    ...meta !== void 0 ? { meta } : {},
    build: config.build
  };
  const serialized = JSON.stringify(line);
  if (level === "error") {
    console.error(serialized);
  } else if (level === "warn") {
    console.warn(serialized);
  } else {
    console.log(serialized);
  }
}
function createLogger(engineName) {
  if (!engineName || typeof engineName !== "string") {
    throw new Error("createLogger requires a non-empty engine name string");
  }
  return Object.freeze({
    debug: (message, meta) => write("debug", engineName, message, meta),
    info: (message, meta) => write("info", engineName, message, meta),
    warn: (message, meta) => write("warn", engineName, message, meta),
    error: (message, meta) => write("error", engineName, message, meta)
  });
}

// src/kernel/engine.js
var Engine = class {
  #running = false;
  name;
  eventBus;
  logger;
  memory;
  config;
  /**
   * @param {object} deps
   * @param {string} deps.name - engine name, used in logs and errors
   * @param {import('./eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('./logger.js').createLogger>} deps.logger
   * @param {object} [deps.memory] - Memory interface, optional for engines that don't persist
   * @param {object} [deps.config] - resolved config object, optional if the engine only needs eventBus/logger
   */
  constructor({ name, eventBus, logger, memory, config: config2 } = {}) {
    if (!name || typeof name !== "string") {
      throw new Error("Engine requires a non-empty name string");
    }
    if (!eventBus) {
      throw new Error(`Engine "${name}" requires an eventBus dependency`);
    }
    if (!logger) {
      throw new Error(`Engine "${name}" requires a logger dependency`);
    }
    this.name = name;
    this.eventBus = eventBus;
    this.logger = logger;
    this.memory = memory ?? null;
    this.config = config2 ?? null;
  }
  /**
   * Starts the engine. Idempotent — calling start() on an already-
   * running engine logs a warning and returns rather than double-
   * subscribing to events or double-starting timers.
   */
  async start() {
    if (this.#running) {
      this.logger.warn(`${this.name} is already running \u2014 start() ignored`);
      return;
    }
    await this.onStart();
    this.#running = true;
    this.logger.info(`${this.name} started`);
  }
  /**
   * Stops the engine. Idempotent — calling stop() on an already-stopped
   * engine is a safe no-op.
   */
  async stop() {
    if (!this.#running) {
      return;
    }
    await this.onStop();
    this.#running = false;
    this.logger.info(`${this.name} stopped`);
  }
  get isRunning() {
    return this.#running;
  }
  /**
   * Subclasses override this to subscribe to events, register scheduler
   * tasks, or open connections. Base implementation is a legitimate
   * no-op — an engine with nothing extra to do on start is complete,
   * not unfinished.
   */
  async onStart() {
  }
  /**
   * Subclasses override this to unsubscribe, clear timers, or close
   * connections. Base implementation is a legitimate no-op.
   */
  async onStop() {
  }
};

// src/observer/marketDataPort.js
var REQUIRED_METHODS = Object.freeze(["getMarketSnapshot"]);
function assertValidMarketDataPort(port) {
  if (!port || typeof port !== "object") {
    throw new Error("MarketDataPort must be an object");
  }
  const missing = REQUIRED_METHODS.filter((method) => typeof port[method] !== "function");
  if (missing.length > 0) {
    throw new Error(
      `MarketDataPort is missing required method(s): ${missing.join(", ")}`
    );
  }
}
function assertValidMarketSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("MarketSnapshot must be an object");
  }
  const required = ["breadthPercentAboveMA50", "volatilityIndexValue", "sectorPerformance", "timestamp"];
  const missing = required.filter((field) => snapshot[field] === void 0);
  if (missing.length > 0) {
    throw new Error(`MarketSnapshot is missing required field(s): ${missing.join(", ")}`);
  }
  if (!Array.isArray(snapshot.sectorPerformance)) {
    throw new Error("MarketSnapshot.sectorPerformance must be an array");
  }
  for (const entry of snapshot.sectorPerformance) {
    if (!entry || typeof entry.sector !== "string" || typeof entry.relativeStrength !== "number") {
      throw new Error(
        'Each MarketSnapshot.sectorPerformance entry must have a string "sector" and numeric "relativeStrength"'
      );
    }
  }
}

// src/observer/classifier.js
function classifyVolatility(volatilityIndexValue, volatilityThresholds) {
  if (typeof volatilityIndexValue !== "number" || Number.isNaN(volatilityIndexValue)) {
    throw new Error(`classifyVolatility requires a numeric value, got: ${volatilityIndexValue}`);
  }
  if (volatilityIndexValue <= volatilityThresholds.lowMax) return "low";
  if (volatilityIndexValue <= volatilityThresholds.elevatedMax) return "elevated";
  if (volatilityIndexValue <= volatilityThresholds.highMax) return "high";
  return "extreme";
}
function detectSectorLeadership(sectorPerformance, topN = 3) {
  return [...sectorPerformance].filter((entry) => entry.relativeStrength > 0).sort((a, b) => b.relativeStrength - a.relativeStrength).slice(0, topN).map((entry) => ({ sector: entry.sector, relativeStrength: entry.relativeStrength }));
}
function detectRotation(currentLeadership, previousLeadership, rotationThresholds) {
  if (!previousLeadership) {
    return { rotation: false, changedCount: 0 };
  }
  const currentSet = new Set(currentLeadership.map((entry) => entry.sector));
  const previousSet = new Set(previousLeadership.map((entry) => entry.sector));
  let changedCount = 0;
  for (const sector of currentSet) {
    if (!previousSet.has(sector)) changedCount++;
  }
  for (const sector of previousSet) {
    if (!currentSet.has(sector)) changedCount++;
  }
  return {
    rotation: changedCount >= rotationThresholds.minSectorsForRotationFlag,
    changedCount
  };
}
function computeConfidence(breadthPercent, volatilityRegime, breadthThresholds) {
  const { riskOnMinPercent, riskOffMaxPercent } = breadthThresholds;
  const neutralMid = (riskOnMinPercent + riskOffMaxPercent) / 2;
  const maxDistance = Math.max(riskOnMinPercent - neutralMid, neutralMid - riskOffMaxPercent) || 1;
  const distanceFromNeutral = Math.abs(breadthPercent - neutralMid);
  const breadthConfidence = Math.min(1, distanceFromNeutral / maxDistance);
  const volatilityPenalty = { low: 0, elevated: 0.1, high: 0.3, extreme: 0.5 }[volatilityRegime] ?? 0.3;
  const score = Number(Math.max(0, Math.min(1, breadthConfidence - volatilityPenalty)).toFixed(3));
  const drivers = [];
  if (breadthPercent >= riskOnMinPercent) {
    drivers.push("breadth_positive");
  } else if (breadthPercent <= riskOffMaxPercent) {
    drivers.push("breadth_negative");
  } else {
    drivers.push("breadth_neutral_zone");
  }
  drivers.push(
    {
      low: "volatility_supportive",
      elevated: "volatility_mild_conflict",
      high: "volatility_conflict",
      extreme: "volatility_severe_conflict"
    }[volatilityRegime] ?? "volatility_unknown_regime"
  );
  return { score, drivers };
}
function classifyRiskState(breadthPercent, confidence, breadthThresholds, confidenceThresholds) {
  if (confidence < confidenceThresholds.minimumForCommittedState) {
    return RISK_STATE.NEUTRAL;
  }
  if (breadthPercent >= breadthThresholds.riskOnMinPercent) return RISK_STATE.RISK_ON;
  if (breadthPercent <= breadthThresholds.riskOffMaxPercent) return RISK_STATE.RISK_OFF;
  return RISK_STATE.NEUTRAL;
}
function classifyMarketState(snapshot, previousLeadership, observerThresholds) {
  const volatility = classifyVolatility(snapshot.volatilityIndexValue, observerThresholds.volatility);
  const sectorLeadership = detectSectorLeadership(snapshot.sectorPerformance);
  const { rotation } = detectRotation(sectorLeadership, previousLeadership, observerThresholds.rotation);
  const confidence = computeConfidence(snapshot.breadthPercentAboveMA50, volatility, observerThresholds.breadth);
  if (rotation) {
    confidence.drivers.push("sector_rotation_unclear");
  } else if (sectorLeadership.length === 0) {
    confidence.drivers.push("no_clear_leadership");
  } else {
    confidence.drivers.push("sector_leadership_clear");
  }
  const riskState = classifyRiskState(
    snapshot.breadthPercentAboveMA50,
    confidence.score,
    observerThresholds.breadth,
    observerThresholds.confidence
  );
  return {
    riskState,
    breadth: snapshot.breadthPercentAboveMA50,
    volatility,
    sectorLeadership,
    rotation,
    confidence,
    timestamp: snapshot.timestamp
  };
}

// src/observer/index.js
var SCAN_TASK_NAME = "observer-market-scan";
var ObserverEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('../kernel/scheduler.js').Scheduler} deps.scheduler
   * @param {import('./marketDataPort.js').MarketDataPort} deps.marketDataPort
   * @param {object} deps.observerThresholds - config.observerThresholds
   * @param {number} deps.scanIntervalSeconds - config.env.cadence.observerScanIntervalSeconds
   * @param {object} [deps.memory] - optional Memory interface; degrades gracefully if absent
   */
  constructor(deps) {
    super({ name: "Observer", eventBus: deps.eventBus, logger: deps.logger, memory: deps.memory });
    if (!deps.scheduler) {
      throw new Error("ObserverEngine requires a scheduler dependency");
    }
    assertValidMarketDataPort(deps.marketDataPort);
    if (!deps.observerThresholds) {
      throw new Error("ObserverEngine requires observerThresholds dependency");
    }
    if (!Number.isFinite(deps.scanIntervalSeconds) || deps.scanIntervalSeconds <= 0) {
      throw new Error(`ObserverEngine requires a positive scanIntervalSeconds, got ${deps.scanIntervalSeconds}`);
    }
    this.scheduler = deps.scheduler;
    this.marketDataPort = deps.marketDataPort;
    this.observerThresholds = deps.observerThresholds;
    this.scanIntervalSeconds = deps.scanIntervalSeconds;
    this.previousLeadership = null;
  }
  async onStart() {
    if (this.memory?.getLastMarketState) {
      try {
        const lastState = await this.memory.getLastMarketState();
        if (lastState?.sectorLeadership) {
          this.previousLeadership = lastState.sectorLeadership;
          this.logger.info("Observer seeded previous leadership from Memory");
        }
      } catch (err) {
        this.logger.warn("Observer could not seed previous state from Memory \u2014 starting cold", {
          error: err.message
        });
      }
    }
    this.scheduler.register(SCAN_TASK_NAME, this.scanIntervalSeconds, () => this.runScan());
    this.scheduler.start(SCAN_TASK_NAME);
  }
  async onStop() {
    this.scheduler.stop(SCAN_TASK_NAME);
  }
  /**
   * Runs one full scan cycle: fetch snapshot → classify → emit → persist.
   * Public (not private) so tests and manual triggers can call it
   * directly without waiting on the scheduler's cadence.
   */
  async runScan() {
    let snapshot;
    try {
      snapshot = await this.marketDataPort.getMarketSnapshot();
      assertValidMarketSnapshot(snapshot);
    } catch (err) {
      console.error("=== OBSERVER SCAN FAILURE ===");
      console.error("Error message:", err && err.message);
      console.error("Error name:", err && err.name);
      console.error("Full stack:");
      console.error(err && err.stack);
      console.error("=== END OBSERVER SCAN FAILURE ===");
      this.logger.error("Observer scan failed to obtain a valid market snapshot", { error: err?.message, stack: err?.stack });
      return;
    }
    const marketState = classifyMarketState(snapshot, this.previousLeadership, this.observerThresholds);
    this.logger.info("Observer scan complete", {
      riskState: marketState.riskState,
      breadth: marketState.breadth,
      volatility: marketState.volatility,
      rotation: marketState.rotation,
      confidence: marketState.confidence
    });
    await this.eventBus.publish(config.events.MARKET_STATE_CHANGED, marketState);
    this.previousLeadership = marketState.sectorLeadership;
    if (this.memory?.recordMarketState) {
      try {
        await this.memory.recordMarketState(marketState);
      } catch (err) {
        this.logger.error("Observer failed to persist market state to Memory", { error: err.message });
      }
    } else {
      this.logger.warn("Observer has no Memory dependency wired \u2014 market state was emitted but not persisted");
    }
    return marketState;
  }
};

// src/radar/marketAdapterPort.js
var REQUIRED_ADAPTER_FIELDS = Object.freeze(["assetClass"]);
var REQUIRED_ADAPTER_METHODS = Object.freeze(["getCandidates"]);
function assertValidAssetClassAdapter(adapter) {
  if (!adapter || typeof adapter !== "object") {
    throw new Error("AssetClassAdapter must be an object");
  }
  const missingFields = REQUIRED_ADAPTER_FIELDS.filter((f) => typeof adapter[f] !== "string" || adapter[f] === "");
  if (missingFields.length > 0) {
    throw new Error(`AssetClassAdapter is missing required string field(s): ${missingFields.join(", ")}`);
  }
  const missingMethods = REQUIRED_ADAPTER_METHODS.filter((m) => typeof adapter[m] !== "function");
  if (missingMethods.length > 0) {
    throw new Error(`AssetClassAdapter "${adapter.assetClass}" is missing required method(s): ${missingMethods.join(", ")}`);
  }
}
function assertValidRawCandidate(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("RawCandidate must be an object");
  }
  const required = ["symbol", "assetClass", "price", "avgDollarVolume", "marketCap", "sector", "timestamp"];
  const missing = required.filter((field) => candidate[field] === void 0);
  if (missing.length > 0) {
    throw new Error(`RawCandidate is missing required field(s): ${missing.join(", ")} (symbol: ${candidate.symbol ?? "unknown"})`);
  }
}

// src/radar/eligibility.js
function getThresholdsForClass(assetClass, universeRules) {
  switch (assetClass) {
    case "us_stock":
      return {
        minPrice: universeRules.minPrice,
        minAvgDollarVolume: universeRules.minAvgDollarVolume20d,
        minMarketCap: universeRules.minMarketCap,
        excludeOtc: universeRules.excludeOtc
      };
    case "lse":
      return {
        minPrice: universeRules.minPrice,
        minAvgDollarVolume: universeRules.minAvgDollarVolumeGBP20d,
        minMarketCap: universeRules.minMarketCapGBP,
        mainMarketOnly: universeRules.mainMarketOnly
      };
    case "crypto":
      return {
        minAvgDollarVolume: universeRules.minAvgDailyVolume24h,
        minMarketCap: universeRules.minMarketCap,
        excludeIfNoAdapterCoverage: universeRules.excludeIfNoAdapterCoverage
      };
    default:
      throw new Error(`No eligibility threshold mapping defined for asset class: ${assetClass}`);
  }
}
function isEligible(candidate, getUniverseRules2) {
  const universeRules = getUniverseRules2(candidate.assetClass);
  const thresholds = getThresholdsForClass(candidate.assetClass, universeRules);
  if (thresholds.minPrice !== void 0 && candidate.price < thresholds.minPrice) return false;
  if (thresholds.minAvgDollarVolume !== void 0 && candidate.avgDollarVolume < thresholds.minAvgDollarVolume) return false;
  if (thresholds.minMarketCap !== void 0 && candidate.marketCap < thresholds.minMarketCap) return false;
  if (thresholds.excludeOtc && candidate.isOtc) return false;
  if (thresholds.mainMarketOnly && candidate.isMainMarket === false) return false;
  if (thresholds.excludeIfNoAdapterCoverage && candidate.hasAdapterCoverage === false) return false;
  return true;
}

// src/radar/policy.js
var INTEREST_REASON_WEIGHTS = Object.freeze({
  sector_leader: 30,
  volume_expansion: 25,
  new_high: 20,
  sector_rotation_context: 15,
  earnings_proximity: 10
});
var INTEREST_PENALTY_WEIGHTS = Object.freeze({
  volume_exhaustion_risk: 15
});
var INTEREST_THRESHOLDS = Object.freeze({
  volumeExpansionMinRvol: 1.3,
  // below rvolReference.exhaustionThreshold from config/pillars.js
  newHighMaxDistancePercent: 1,
  // within 1% of the N-day high counts as "at" it
  earningsProximityMaxDays: 5
});
var MIN_INTEREST_SCORE_TO_EMIT = 40;

// src/radar/interestScorer.js
function computeInterestProfile(candidate, marketState, rvolReference) {
  const reasons = [];
  let rawScore = 0;
  const leadershipSectors = new Set((marketState?.sectorLeadership ?? []).map((entry) => entry.sector));
  const isSectorLeader = leadershipSectors.has(candidate.sector);
  if (isSectorLeader) {
    reasons.push("sector_leader");
    rawScore += INTEREST_REASON_WEIGHTS.sector_leader;
  }
  if (typeof candidate.relativeVolume === "number") {
    if (candidate.relativeVolume > rvolReference.exhaustionThreshold) {
      reasons.push("volume_exhaustion_risk");
      rawScore -= INTEREST_PENALTY_WEIGHTS.volume_exhaustion_risk;
    } else if (candidate.relativeVolume >= INTEREST_THRESHOLDS.volumeExpansionMinRvol) {
      reasons.push("volume_expansion");
      rawScore += INTEREST_REASON_WEIGHTS.volume_expansion;
    }
  }
  if (typeof candidate.distanceFromHighPercent === "number" && candidate.distanceFromHighPercent <= INTEREST_THRESHOLDS.newHighMaxDistancePercent) {
    reasons.push("new_high");
    rawScore += INTEREST_REASON_WEIGHTS.new_high;
  }
  if (marketState?.rotation && isSectorLeader) {
    reasons.push("sector_rotation_context");
    rawScore += INTEREST_REASON_WEIGHTS.sector_rotation_context;
  }
  if (typeof candidate.daysToEarnings === "number" && candidate.daysToEarnings >= 0 && candidate.daysToEarnings <= INTEREST_THRESHOLDS.earningsProximityMaxDays) {
    reasons.push("earnings_proximity");
    rawScore += INTEREST_REASON_WEIGHTS.earnings_proximity;
  }
  const score = Math.max(0, Math.min(100, rawScore));
  return { score, reasons };
}

// src/radar/index.js
var SCAN_TASK_NAME2 = "radar-discovery-scan";
var RadarEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('../kernel/scheduler.js').Scheduler} deps.scheduler
   * @param {import('./marketAdapterPort.js').AssetClassAdapter[]} deps.assetClassAdapters
   * @param {number} deps.scanIntervalSeconds
   * @param {object} [deps.memory] - optional Memory interface; degrades gracefully if absent
   */
  constructor(deps) {
    super({ name: "Radar", eventBus: deps.eventBus, logger: deps.logger, memory: deps.memory });
    if (!deps.scheduler) {
      throw new Error("RadarEngine requires a scheduler dependency");
    }
    if (!Array.isArray(deps.assetClassAdapters) || deps.assetClassAdapters.length === 0) {
      throw new Error("RadarEngine requires at least one AssetClassAdapter");
    }
    deps.assetClassAdapters.forEach(assertValidAssetClassAdapter);
    if (!Number.isFinite(deps.scanIntervalSeconds) || deps.scanIntervalSeconds <= 0) {
      throw new Error(`RadarEngine requires a positive scanIntervalSeconds, got ${deps.scanIntervalSeconds}`);
    }
    this.scheduler = deps.scheduler;
    this.assetClassAdapters = deps.assetClassAdapters;
    this.scanIntervalSeconds = deps.scanIntervalSeconds;
    this.latestMarketState = null;
    this.#unsubscribeMarketState = null;
  }
  #unsubscribeMarketState;
  async onStart() {
    this.#unsubscribeMarketState = this.eventBus.subscribe(config.events.MARKET_STATE_CHANGED, (envelope) => {
      this.latestMarketState = envelope.payload;
    });
    this.scheduler.register(SCAN_TASK_NAME2, this.scanIntervalSeconds, () => this.runScan());
    this.scheduler.start(SCAN_TASK_NAME2);
  }
  async onStop() {
    this.scheduler.stop(SCAN_TASK_NAME2);
    this.#unsubscribeMarketState?.();
    this.#unsubscribeMarketState = null;
  }
  /**
   * Runs one full discovery cycle across every registered asset-class
   * adapter. Public (not private) so tests and manual triggers can run
   * it directly. Returns the list of candidates that were actually
   * emitted (cleared eligibility AND interest threshold) — useful for
   * tests and for logging a scan summary.
   */
  async runScan() {
    if (!this.latestMarketState) {
      this.logger.warn("Radar has no market state from Observer yet \u2014 skipping scan");
      return [];
    }
    const hasMemory = typeof this.memory?.recordCandidate === "function";
    if (!hasMemory) {
      this.logger.warn("Radar has no Memory dependency wired \u2014 discovered candidates were emitted but not persisted");
    }
    const emitted = [];
    let rawCount = 0;
    let eligibleCount = 0;
    for (const adapter of this.assetClassAdapters) {
      let rawCandidates;
      try {
        rawCandidates = await adapter.getCandidates();
      } catch (err) {
        this.logger.error(`Radar: adapter "${adapter.assetClass}" failed to return candidates`, { error: err.message });
        continue;
      }
      for (const raw of rawCandidates) {
        rawCount++;
        try {
          assertValidRawCandidate(raw);
        } catch (err) {
          this.logger.warn("Radar: skipped a malformed candidate", { error: err.message });
          continue;
        }
        if (!isEligible(raw, config.getUniverseRules)) continue;
        eligibleCount++;
        const interest = computeInterestProfile(raw, this.latestMarketState, config.rvolReference);
        if (interest.score < MIN_INTEREST_SCORE_TO_EMIT) continue;
        const payload = {
          symbol: raw.symbol,
          assetClass: raw.assetClass,
          sector: raw.sector,
          interest,
          marketStateId: this.latestMarketState.timestamp,
          discoveredAt: (/* @__PURE__ */ new Date()).toISOString(),
          observerVersion: config.build.version
        };
        await this.eventBus.publish(config.events.CANDIDATE_DISCOVERED, payload);
        emitted.push(payload);
        if (hasMemory) {
          try {
            await this.memory.recordCandidate(payload);
          } catch (err) {
            this.logger.error("Radar failed to persist a discovered candidate to Memory", {
              symbol: raw.symbol,
              error: err.message
            });
          }
        }
      }
    }
    this.logger.info("Radar scan complete", {
      rawCount,
      eligibleCount,
      emittedCount: emitted.length
    });
    return emitted;
  }
};

// src/intel/themeMemory.js
function updateThemeMemory(existingEntry, candidate) {
  if (!existingEntry) {
    return {
      firstSeen: candidate.discoveredAt,
      lastSeen: candidate.discoveredAt,
      mentionCount: 1,
      cyclesObserved: 1,
      symbolsSeen: [candidate.symbol],
      lastMarketStateId: candidate.marketStateId
    };
  }
  const isNewCycle = existingEntry.lastMarketStateId !== candidate.marketStateId;
  const symbolsSeen = existingEntry.symbolsSeen.includes(candidate.symbol) ? existingEntry.symbolsSeen : [...existingEntry.symbolsSeen, candidate.symbol];
  return {
    firstSeen: existingEntry.firstSeen,
    lastSeen: candidate.discoveredAt,
    mentionCount: existingEntry.mentionCount + 1,
    cyclesObserved: existingEntry.cyclesObserved + (isNewCycle ? 1 : 0),
    symbolsSeen,
    lastMarketStateId: candidate.marketStateId
  };
}
function daysActive(entry) {
  const first = new Date(entry.firstSeen).getTime();
  const last = new Date(entry.lastSeen).getTime();
  const msPerDay = 24 * 60 * 60 * 1e3;
  return Math.max(0, Math.floor((last - first) / msPerDay));
}

// src/intel/narrativeBuilder.js
var RECURRING_THEME_MIN_CYCLES = 3;
var BROAD_PARTICIPATION_MIN_SYMBOLS = 3;
var SUSTAINED_PRESENCE_MIN_DAYS = 2;
function buildNarrative(sector, entry, rotationContext) {
  const facts = [];
  const days = daysActive(entry);
  if (entry.cyclesObserved === 1) {
    facts.push("new_theme");
  } else if (entry.cyclesObserved >= RECURRING_THEME_MIN_CYCLES) {
    facts.push("recurring_theme");
  }
  if (entry.symbolsSeen.length >= BROAD_PARTICIPATION_MIN_SYMBOLS) {
    facts.push("broad_participation");
  }
  if (days >= SUSTAINED_PRESENCE_MIN_DAYS) {
    facts.push("sustained_presence");
  }
  if (rotationContext) {
    facts.push("rotation_context");
  }
  const parts = [
    `${sector} has been observed in ${entry.cyclesObserved} discovery cycle${entry.cyclesObserved === 1 ? "" : "s"}`,
    `across ${entry.symbolsSeen.length} symbol${entry.symbolsSeen.length === 1 ? "" : "s"}`,
    days > 0 ? `spanning ${days} day${days === 1 ? "" : "s"}` : "first seen this cycle"
  ];
  let summary = parts.join(", ") + ".";
  if (rotationContext) {
    summary += " A sector rotation is currently in progress and includes this theme.";
  }
  return { summary, facts };
}

// src/intel/discoveryPort.js
var REQUIRED_METHODS2 = Object.freeze(["getDiscoverySnapshot"]);
function assertValidDiscoveryPort(port) {
  if (!port || typeof port !== "object") {
    throw new Error("DiscoveryPort must be an object");
  }
  const missing = REQUIRED_METHODS2.filter((method) => typeof port[method] !== "function");
  if (missing.length > 0) {
    throw new Error(`DiscoveryPort is missing required method(s): ${missing.join(", ")}`);
  }
}
function assertValidDiscoverySnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("DiscoverySnapshot must be an object");
  }
  const required = ["newsTexts", "stockMovers", "cryptoMovers", "trendingSymbols", "timestamp"];
  const missing = required.filter((field) => snapshot[field] === void 0);
  if (missing.length > 0) {
    throw new Error(`DiscoverySnapshot is missing required field(s): ${missing.join(", ")}`);
  }
  for (const field of ["newsTexts", "stockMovers", "cryptoMovers", "trendingSymbols"]) {
    if (!Array.isArray(snapshot[field])) {
      throw new Error(`DiscoverySnapshot.${field} must be an array`);
    }
  }
  for (const mover of [...snapshot.stockMovers, ...snapshot.cryptoMovers]) {
    if (!mover || typeof mover.symbol !== "string" || typeof mover.changePercent !== "number") {
      throw new Error('Each mover entry must have a string "symbol" and numeric "changePercent"');
    }
  }
}

// src/intel/heatScore.js
var HEAT_CEILING = 150;
var HEAT_DECAY_MS = 8 * 60 * 60 * 1e3;
var HEAT_HOT_THRESHOLD = 80;
var REPEAT_WINDOW_MS = 30 * 60 * 1e3;
var MENTIONS_KEPT = 5;
function decayedScore(score, lastUpdated, now) {
  const ageMs = now - lastUpdated;
  const decayFraction = Math.max(0, 1 - ageMs / HEAT_DECAY_MS);
  return score * decayFraction;
}
function addHeat(existingEntry, points, reason, now = Date.now()) {
  const current = existingEntry ?? { score: 0, lastUpdated: now, mentions: [] };
  const decayed = decayedScore(current.score, current.lastUpdated, now);
  const recentSameReasonCount = current.mentions.filter(
    (m) => m.reason === reason && now - m.time < REPEAT_WINDOW_MS
  ).length;
  const diminishedPoints = recentSameReasonCount >= 2 ? points * 0.3 : recentSameReasonCount === 1 ? points * 0.6 : points;
  const newScore = Math.min(HEAT_CEILING, decayed + diminishedPoints);
  return {
    score: newScore,
    lastUpdated: now,
    mentions: [...current.mentions.slice(-(MENTIONS_KEPT - 1)), { reason, time: now }]
  };
}
function getHeat(entry, now = Date.now()) {
  if (!entry) return 0;
  return Math.max(0, decayedScore(entry.score, entry.lastUpdated, now));
}
var HEAT_CONSTANTS = Object.freeze({
  CEILING: HEAT_CEILING,
  DECAY_MS: HEAT_DECAY_MS,
  HOT_THRESHOLD: HEAT_HOT_THRESHOLD,
  REPEAT_WINDOW_MS
});

// src/intel/sectorMaps.js
var SECTOR_SYMBOLS = Object.freeze({
  AI: ["NVDA", "PLTR", "AMD", "SMCI", "MSFT", "META", "GOOGL", "IONQ", "CRWD", "ANET", "SOUN"],
  SEMIS: ["NVDA", "AMD", "AVGO", "AMAT", "ASML", "MU", "MRVL", "ARM", "SMH"],
  POWER: ["GEV", "VRT", "ETN", "HUBB", "PWR", "CEG", "VST"],
  SPACE: ["RKLB", "LUNR", "ASTS", "ACHR", "JOBY", "SPCE", "SPCX"],
  NUCLEAR: ["CCJ", "NNE", "SMR", "UUUU", "DNN", "OKLO", "LEU", "BWXT"],
  DEFENSE: ["LMT", "RTX", "NOC", "GD", "AVAV", "KTOS", "RCAT"],
  BIOTECH: ["HIMS", "MRNA", "NVAX", "SAVA", "SMMT", "LLY", "NVO"],
  HEALTHCARE: ["LLY", "NVO", "ISRG", "UNH", "ABT", "MDT"],
  CLOUD: ["MSFT", "SNOW", "DDOG", "CRWD", "PLTR", "NET", "ZS"],
  INFRA: ["CAT", "DE", "URI", "VMC", "PWR", "PRIM"],
  CRYPTO: ["COIN", "MSTR", "RIOT", "CLSK", "MARA"],
  ENERGY: ["XOM", "CVX", "SLB", "HAL", "MPC"],
  GOLD: ["NEM", "GOLD", "AEM", "WPM", "KGC"],
  SILVER: ["SIL", "WPM", "PAAS", "AG"],
  ROBOTICS: ["ROK", "ISRG", "TER", "TSLA"],
  DEFI: ["AAVEUSDT", "UNIUSDT", "MKRUSDT", "ENAUSDT"],
  L1: ["SOLUSDT", "SUIUSDT", "AVAXUSDT", "ETHUSDT"],
  AI_CRYPTO: ["TAOUSDT", "FETUSDT", "RENDERUSDT", "NEARUSDT"],
  ORACLES: ["LINKUSDT", "PYTHUSDT"],
  UK_BANKS: ["BARC.L", "LLOY.L", "NWG.L", "STAN.L", "HSBA.L"],
  UK_ENERGY: ["SHEL.L", "BP.L"],
  UK_MINERS: ["RIO.L", "GLEN.L", "AAL.L"],
  UK_DEFENSE: ["BA.L", "RR.L"],
  UK_TELCO: ["VOD.L"]
});
var SECTOR_EMOJI = Object.freeze({
  AI: "\u{1F916}",
  SEMIS: "\u{1F4BE}",
  POWER: "\u{1F50C}",
  SPACE: "\u{1F6F0}\uFE0F",
  NUCLEAR: "\u2622\uFE0F",
  DEFENSE: "\u{1F6E1}\uFE0F",
  BIOTECH: "\u{1F9EC}",
  HEALTHCARE: "\u{1F3E5}",
  CLOUD: "\u2601\uFE0F",
  INFRA: "\u{1F3D7}\uFE0F",
  CRYPTO: "\u20BF",
  ENERGY: "\u26A1",
  GOLD: "\u{1F947}",
  SILVER: "\u{1F948}",
  ROBOTICS: "\u{1F9BE}",
  DEFI: "\u{1F3E6}",
  L1: "\u26D3\uFE0F",
  AI_CRYPTO: "\u{1F310}",
  ORACLES: "\u{1F4E1}",
  UK_BANKS: "\u{1F3E6}",
  UK_ENERGY: "\u{1F6E2}\uFE0F",
  UK_MINERS: "\u26CF\uFE0F",
  UK_DEFENSE: "\u2708\uFE0F",
  UK_TELCO: "\u{1F4E1}"
});
var NARRATIVE_KEYWORDS = Object.freeze({
  AI: ["artificial intelligence", "ai chip", "machine learning", "llm", "gpu", "nvidia", "generative ai", "openai", "chatgpt", "data centre", "inference"],
  SEMIS: ["semiconductor", "chip shortage", "wafer", "foundry", "tsmc", "nvidia earnings", "amd earnings", "chip demand", "fab"],
  POWER: ["power grid", "data centre power", "electricity demand", "grid infrastructure", "hyperscaler", "energy demand", "gigawatt", "grid upgrade"],
  SPACE: ["rocketlab", "rocket lab", "lunr", "lunar lander", "spacecraft", "spacex launch", "orbital launch", "asts", "achr", "joby"],
  NUCLEAR: ["nuclear energy", "uranium", "small modular reactor", "smr", "nuclear power", "nuclear plant", "oklo", "nne"],
  DEFENSE: ["defense spending", "military budget", "nato", "pentagon", "weapons contract", "drone warfare", "defense contractor"],
  BIOTECH: ["weight loss", "obesity", "glp-1", "biotech", "fda approval", "clinical trial", "drug approval", "ozempic", "wegovy"],
  HEALTHCARE: ["healthcare", "hospital", "medical device", "pharma", "drug pricing", "medicare", "isrg", "lilly"],
  CLOUD: ["cloud computing", "saas", "software earnings", "aws", "azure", "google cloud", "cybersecurity", "crwd", "snowflake"],
  INFRA: ["infrastructure", "construction", "caterpillar", "deere", "heavy equipment", "building materials", "roads", "bridges"],
  CRYPTO: ["bitcoin", "ethereum", "crypto rally", "btc", "eth", "digital assets", "blockchain", "crypto surge", "crypto market"],
  ENERGY: ["oil price", "crude", "energy rally", "opec", "natural gas", "brent", "wti"],
  GOLD: ["gold price", "gold rally", "bullion", "precious metals", "safe haven", "gold futures"],
  SILVER: ["silver price", "silver rally", "industrial metals", "silver futures"],
  ROBOTICS: ["robotics", "automation", "humanoid", "manufacturing robot", "industrial robot"],
  DEFI: ["defi", "decentralised finance", "yield farming", "liquidity", "aave", "uniswap", "lending protocol"],
  L1: ["layer 1", "solana", "avalanche", "ethereum upgrade", "proof of stake", "blockchain network"],
  AI_CRYPTO: ["ai crypto", "decentralised ai", "tao", "bittensor", "fetch.ai", "render network", "ai token"],
  ORACLES: ["chainlink", "oracle", "on-chain data", "price feed", "pyth", "real world assets", "rwa"]
});
var SECTOR_LABELS = Object.freeze({
  AI: "AI",
  SEMIS: "Semis",
  POWER: "Power",
  SPACE: "Space",
  NUCLEAR: "Nuclear",
  DEFENSE: "Defense",
  BIOTECH: "Biotech",
  HEALTHCARE: "Healthcare",
  CLOUD: "Cloud",
  INFRA: "Infrastructure",
  CRYPTO: "Crypto",
  ENERGY: "Energy",
  GOLD: "Gold",
  SILVER: "Silver",
  ROBOTICS: "Robotics",
  DEFI: "DeFi",
  L1: "Layer 1s",
  AI_CRYPTO: "AI Crypto",
  ORACLES: "Oracles",
  UK_BANKS: "UK Banks",
  UK_ENERGY: "UK Energy",
  UK_MINERS: "UK Miners",
  UK_DEFENSE: "UK Defense",
  UK_TELCO: "UK Telecom"
});
var CRYPTO_AI_NAMES = Object.freeze(["RENDERUSDT", "FETUSDT", "NEARUSDT", "TAOUSDT", "AGIXUSDT", "OCEANUSDT"]);

// src/intel/sectorDetection.js
var MIN_KEYWORD_MATCHES = 2;
function detectHotSectorsFromNews(newsTexts) {
  const combinedText = newsTexts.join(" ");
  const scores = {};
  for (const [sector, keywords] of Object.entries(NARRATIVE_KEYWORDS)) {
    scores[sector] = keywords.filter((kw) => combinedText.includes(kw)).length;
  }
  return Object.entries(scores).filter(([, score]) => score >= MIN_KEYWORD_MATCHES).sort((a, b) => b[1] - a[1]).map(([sector]) => sector);
}
function sectorsForSymbols(symbols) {
  const symbolSet = new Set(symbols.map((s) => s.replace("USDT", "").toUpperCase()));
  const matchingSectors = [];
  for (const [sector, members] of Object.entries(SECTOR_SYMBOLS)) {
    const normalizedMembers = members.map((m) => m.replace("USDT", "").toUpperCase());
    if (normalizedMembers.some((m) => symbolSet.has(m))) {
      matchingSectors.push(sector);
    }
  }
  return matchingSectors;
}

// src/intel/narrativeChangeGate.js
var MIN_GAP_MS = 3 * 60 * 60 * 1e3;
var DEFAULT_MAX_POSTS_PER_DAY = 4;
function emptyNarrativeState() {
  return {
    sectorsKey: "",
    stockMoversKey: "",
    cryptoMoversKey: "",
    lastAlertTime: 0,
    postCountToday: 0,
    postCountDay: -1
  };
}
function evaluateNarrativeChange(previousState, proposed, now = Date.now(), options = {}) {
  const maxPostsPerDay = options.maxPostsPerDay ?? DEFAULT_MAX_POSTS_PER_DAY;
  const today = new Date(now).getUTCDate();
  const dayRolled = previousState.postCountDay !== today;
  const postCountToday = dayRolled ? 0 : previousState.postCountToday;
  const postCountDay = today;
  const baseNextState = { ...previousState, postCountToday, postCountDay };
  if (postCountToday >= maxPostsPerDay) {
    return { shouldPost: false, reason: "daily-safety-backstop", nextState: baseNextState };
  }
  const sectorsKey = [...proposed.hotSectors].sort().join(",");
  const stockMoversKey = proposed.stockMovers.slice(0, 6).join(",");
  const cryptoMoversKey = proposed.cryptoMovers.join(",");
  const timeSinceLast = now - previousState.lastAlertTime;
  const minGapPassed = timeSinceLast >= MIN_GAP_MS;
  if (!minGapPassed && sectorsKey === previousState.sectorsKey) {
    return { shouldPost: false, reason: "min-gap-not-passed", nextState: baseNextState };
  }
  const newSector = sectorsKey !== previousState.sectorsKey;
  const prevStockMovers = previousState.stockMoversKey ? previousState.stockMoversKey.split(",") : [];
  const newStockMovers = stockMoversKey ? stockMoversKey.split(",") : [];
  const bigNewMover = newStockMovers.some((s) => s && !prevStockMovers.includes(s));
  const prevCryptoMovers = previousState.cryptoMoversKey ? previousState.cryptoMoversKey.split(",") : [];
  const newCryptoMovers = cryptoMoversKey ? cryptoMoversKey.split(",") : [];
  const newExplosive = newCryptoMovers.some((s) => s && !prevCryptoMovers.includes(s));
  const anyChange = sectorsKey !== previousState.sectorsKey || stockMoversKey !== previousState.stockMoversKey || cryptoMoversKey !== previousState.cryptoMoversKey;
  const shouldPost = newSector || bigNewMover || newExplosive || minGapPassed && anyChange;
  if (!shouldPost) {
    return { shouldPost: false, reason: "no-material-change", nextState: baseNextState };
  }
  const reason = newSector ? "new-sector" : bigNewMover ? "new-mover" : newExplosive ? "explosive-crypto" : "scheduled-gap";
  return {
    shouldPost: true,
    reason,
    nextState: {
      sectorsKey,
      stockMoversKey,
      cryptoMoversKey,
      lastAlertTime: now,
      postCountToday: postCountToday + 1,
      postCountDay
    }
  };
}

// src/intel/narrativeMessageBuilder.js
function directionEmoji(changePercent) {
  return changePercent >= 0 ? "\u{1F4C8}" : "\u{1F4C9}";
}
function describeIntensity(changePercent, heat) {
  const magnitude = Math.abs(changePercent);
  const isHot2 = heat >= 80;
  if (isHot2 && magnitude >= 8) return changePercent >= 0 ? " \u2014 been hot, still climbing" : " \u2014 been hot, now dropping hard";
  if (isHot2) return " \u2014 been hot for a while";
  if (magnitude >= 8) return changePercent >= 0 ? " \u2014 moving hard" : " \u2014 down sharply, watch for reversal";
  if (magnitude >= 5) return changePercent >= 0 ? " \u2014 climbing" : " \u2014 pulling back";
  return "";
}
function formatMoverLine(mover) {
  const sign = mover.changePercent >= 0 ? "+" : "";
  return `${directionEmoji(mover.changePercent)} ${mover.symbol} ${sign}${mover.changePercent.toFixed(1)}%${describeIntensity(mover.changePercent, mover.heat)}`;
}
function formatCryptoLine(cryptoMover) {
  const symbol = cryptoMover.symbol.replace("USDT", "");
  const sign = cryptoMover.changePercent >= 0 ? "+" : "";
  const magnitude = Math.abs(cryptoMover.changePercent);
  let phrase = "";
  if (magnitude >= 15) phrase = cryptoMover.changePercent >= 0 ? " \u2014 explosive move" : " \u2014 sharp drop";
  else if (magnitude >= 8) phrase = cryptoMover.changePercent >= 0 ? " \u2014 strong momentum" : " \u2014 heavy selling";
  return `${directionEmoji(cryptoMover.changePercent)} ${symbol} ${sign}${cryptoMover.changePercent.toFixed(1)}%${phrase}`;
}
function groupMoversBySector(stockMovers, hotSectors, sectorSymbols) {
  const groups = /* @__PURE__ */ new Map();
  const ungrouped = [];
  for (const mover of stockMovers) {
    const matchingSectors = hotSectors.filter((sector) => (sectorSymbols[sector] ?? []).includes(mover.symbol));
    if (matchingSectors.length === 0) {
      ungrouped.push(mover);
      continue;
    }
    const key = [...matchingSectors].sort().join(",");
    if (!groups.has(key)) {
      groups.set(key, { sectors: matchingSectors, movers: [] });
    }
    groups.get(key).movers.push(mover);
  }
  const orderedGroups = [...groups.values()].map(({ sectors, movers }) => ({
    sectorLabel: sectors.map((s) => SECTOR_LABELS[s] ?? s).join(" / "),
    movers
  }));
  return { groups: orderedGroups, ungrouped };
}
function buildNarrativeMessage(content) {
  const lines = ["<b>What's moving</b>", ""];
  const { groups, ungrouped } = groupMoversBySector(content.stockMovers, content.hotSectors, content.sectorSymbols);
  for (const { sectorLabel, movers } of groups) {
    const moverText = movers.map(formatMoverLine).join(", ");
    lines.push(`<b>${sectorLabel}:</b> ${moverText}`);
  }
  if (ungrouped.length > 0) {
    lines.push(`<b>Also moving:</b> ${ungrouped.map(formatMoverLine).join(", ")}`);
  }
  const hasStockContent = groups.length > 0 || ungrouped.length > 0;
  if (content.cryptoMovers.length > 0) {
    if (hasStockContent) lines.push("");
    lines.push(`<b>Crypto:</b> ${content.cryptoMovers.map(formatCryptoLine).join(", ")}`);
  } else if (hasStockContent) {
    lines.push("");
    lines.push("Nothing in crypto worth a look right now.");
  }
  if (!hasStockContent && content.cryptoMovers.length === 0) {
    lines.push("Nothing notable right now.");
  }
  lines.push("");
  lines.push("\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014\u2014");
  lines.push("<i>Educational market commentary only \xB7 Not personalised investment advice \xB7 Not a recommendation to buy or sell</i>");
  return lines.join("\n");
}
function hasContentToSend(content) {
  return content.stockMovers.length > 0 || content.cryptoMovers.length > 0;
}

// src/intel/index.js
var DISCOVERY_TASK_NAME = "intel-discovery-scan";
var IntelEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {object} [deps.memory] - optional Memory interface; degrades gracefully if absent
   * @param {import('../kernel/scheduler.js').Scheduler} [deps.scheduler] - optional; if omitted, no discovery cycle runs at all
   * @param {import('./discoveryPort.js').DiscoveryPort} [deps.discoveryPort] - optional; required together with scheduler for the discovery cycle to run
   * @param {number} [deps.discoveryIntervalSeconds] - defaults to 3600 (1 hour), matching V104's pool-refresh cadence
   */
  constructor(deps) {
    super({ name: "Intel", eventBus: deps.eventBus, logger: deps.logger, memory: deps.memory });
    this.themeRegistry = /* @__PURE__ */ new Map();
    this.latestMarketState = null;
    this.#unsubscribeCandidates = null;
    this.#unsubscribeMarketState = null;
    this.scheduler = deps.scheduler ?? null;
    this.discoveryPort = deps.discoveryPort ?? null;
    if (this.discoveryPort) {
      assertValidDiscoveryPort(this.discoveryPort);
    }
    this.discoveryIntervalSeconds = deps.discoveryIntervalSeconds ?? 3600;
    this.heatRegistry = /* @__PURE__ */ new Map();
    this.narrativeState = emptyNarrativeState();
  }
  #unsubscribeCandidates;
  #unsubscribeMarketState;
  async onStart() {
    if (this.memory?.getThemeRegistry) {
      try {
        const seed = await this.memory.getThemeRegistry();
        if (seed instanceof Map) {
          this.themeRegistry = seed;
          this.logger.info("Intel seeded theme registry from Memory", { themeCount: seed.size });
        }
      } catch (err) {
        this.logger.warn("Intel could not seed theme registry from Memory \u2014 starting cold", { error: err.message });
      }
    }
    this.#unsubscribeMarketState = this.eventBus.subscribe(config.events.MARKET_STATE_CHANGED, (envelope) => {
      this.latestMarketState = envelope.payload;
    });
    this.#unsubscribeCandidates = this.eventBus.subscribe(
      config.events.CANDIDATE_DISCOVERED,
      (envelope) => this.handleCandidate(envelope.payload)
    );
    if (this.scheduler && this.discoveryPort) {
      this.scheduler.register(DISCOVERY_TASK_NAME, this.discoveryIntervalSeconds, () => this.runDiscoveryCycle());
      this.scheduler.start(DISCOVERY_TASK_NAME);
    }
  }
  async onStop() {
    this.#unsubscribeCandidates?.();
    this.#unsubscribeMarketState?.();
    this.#unsubscribeCandidates = null;
    this.#unsubscribeMarketState = null;
    if (this.scheduler && this.discoveryPort) {
      this.scheduler.stop(DISCOVERY_TASK_NAME);
    }
  }
  /**
   * Processes one discovered candidate: updates that sector's theme
   * memory, builds a narrative from the updated memory, and publishes
   * INTEL_UPDATED. Public (not private) so tests can call it directly
   * without going through the event bus.
   */
  async handleCandidate(candidate) {
    const existingEntry = this.themeRegistry.get(candidate.sector) ?? null;
    const updatedEntry = updateThemeMemory(existingEntry, candidate);
    this.themeRegistry.set(candidate.sector, updatedEntry);
    const isSectorRotating = Boolean(
      this.latestMarketState?.rotation && this.latestMarketState.sectorLeadership?.some((entry) => entry.sector === candidate.sector)
    );
    const narrative = buildNarrative(candidate.sector, updatedEntry, isSectorRotating);
    const payload = {
      symbol: candidate.symbol,
      sector: candidate.sector,
      theme: {
        firstSeen: updatedEntry.firstSeen,
        lastSeen: updatedEntry.lastSeen,
        mentionCount: updatedEntry.mentionCount,
        cyclesObserved: updatedEntry.cyclesObserved,
        distinctSymbols: updatedEntry.symbolsSeen.length
      },
      narrative,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    await this.eventBus.publish(config.events.INTEL_UPDATED, payload);
    if (this.memory?.recordThemeUpdate) {
      try {
        await this.memory.recordThemeUpdate(candidate.sector, updatedEntry);
      } catch (err) {
        this.logger.error("Intel failed to persist theme memory to Memory", { sector: candidate.sector, error: err.message });
      }
    } else {
      this.logger.warn("Intel has no Memory dependency wired \u2014 theme memory updated in-process only, not persisted");
    }
    return payload;
  }
  /**
   * Runs one full discovery cycle: fetch a DiscoverySnapshot -> detect
   * hot sectors (from news AND from moving/trending symbols) -> apply
   * heat to every mover -> evaluate the anti-spam change gate -> if it
   * says post, build the message and publish INTEL_REPORT. Public (not
   * private) so tests and manual triggers can call it directly without
   * waiting on the scheduler's cadence — same pattern Observer's
   * runScan() established.
   *
   * Deliberately never throws past this method — a discovery-cycle
   * failure must not affect the CANDIDATE_DISCOVERED-driven theme
   * memory above, which is a fully separate concern running on this
   * same engine.
   */
  async runDiscoveryCycle() {
    let snapshot;
    try {
      snapshot = await this.discoveryPort.getDiscoverySnapshot();
      assertValidDiscoverySnapshot(snapshot);
    } catch (err) {
      this.logger.error("Intel discovery cycle failed to obtain a valid snapshot", { error: err?.message, stack: err?.stack });
      return;
    }
    const sectorsFromNews = detectHotSectorsFromNews(snapshot.newsTexts);
    const allMoverSymbols = [
      ...snapshot.stockMovers.map((m) => m.symbol),
      ...snapshot.cryptoMovers.map((m) => m.symbol),
      ...snapshot.trendingSymbols
    ];
    const sectorsFromMovers = sectorsForSymbols(allMoverSymbols);
    const hotSectors = [.../* @__PURE__ */ new Set([...sectorsFromNews, ...sectorsFromMovers])];
    const now = Date.now();
    for (const mover of [...snapshot.stockMovers, ...snapshot.cryptoMovers]) {
      const existing = this.heatRegistry.get(mover.symbol) ?? null;
      this.heatRegistry.set(mover.symbol, addHeat(existing, 20, "intel", now));
    }
    const stockMoversForGate = snapshot.stockMovers.map((m) => m.symbol);
    const cryptoMoversForGate = snapshot.cryptoMovers.map((m) => m.symbol);
    const decision = evaluateNarrativeChange(
      this.narrativeState,
      { hotSectors, stockMovers: stockMoversForGate, cryptoMovers: cryptoMoversForGate },
      now
    );
    this.narrativeState = decision.nextState;
    this.logger.info("Intel discovery cycle complete", {
      hotSectors,
      stockMoverCount: snapshot.stockMovers.length,
      cryptoMoverCount: snapshot.cryptoMovers.length,
      shouldPost: decision.shouldPost,
      reason: decision.reason
    });
    if (!decision.shouldPost) {
      return;
    }
    const content = {
      hotSectors,
      sectorSymbols: SECTOR_SYMBOLS,
      stockMovers: snapshot.stockMovers.map((m) => ({
        symbol: m.symbol,
        changePercent: m.changePercent,
        heat: getHeat(this.heatRegistry.get(m.symbol), now),
        inSector: sectorsForSymbols([m.symbol]).length > 0
      })),
      cryptoMovers: snapshot.cryptoMovers
    };
    if (!hasContentToSend(content)) {
      return;
    }
    const message = buildNarrativeMessage(content);
    const payload = { message, reason: decision.reason, timestamp: (/* @__PURE__ */ new Date()).toISOString() };
    await this.eventBus.publish(config.events.INTEL_REPORT, payload);
    return payload;
  }
};

// src/memory/store/inMemoryStore.js
var InMemoryStore = class {
  #collections = /* @__PURE__ */ new Map();
  async append(collection, record) {
    if (!this.#collections.has(collection)) {
      this.#collections.set(collection, []);
    }
    this.#collections.get(collection).push(record);
  }
  async queryAll(collection) {
    return [...this.#collections.get(collection) ?? []];
  }
};

// src/memory/store/memoryStorePort.js
var REQUIRED_METHODS3 = Object.freeze(["append", "queryAll"]);
function assertValidMemoryStore(store) {
  if (!store || typeof store !== "object") {
    throw new Error("MemoryStore must be an object");
  }
  const missing = REQUIRED_METHODS3.filter((m) => typeof store[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`MemoryStore is missing required method(s): ${missing.join(", ")}`);
  }
}

// src/memory/analytics.js
function compareAgainstBaseline(candidateRecords, sector) {
  const cycleCounts = /* @__PURE__ */ new Map();
  for (const record of candidateRecords) {
    if (record.sector !== sector) continue;
    cycleCounts.set(record.marketStateId, (cycleCounts.get(record.marketStateId) ?? 0) + 1);
  }
  const sortedCycleIds = [...cycleCounts.keys()].sort();
  if (sortedCycleIds.length === 0) {
    return { sector, current: 0, average: null, deviationPercent: null, sampleCycles: 0, insufficientData: true };
  }
  const currentCycleId = sortedCycleIds[sortedCycleIds.length - 1];
  const current = cycleCounts.get(currentCycleId);
  const priorCycleIds = sortedCycleIds.slice(0, -1);
  if (priorCycleIds.length === 0) {
    return { sector, current, average: null, deviationPercent: null, sampleCycles: 1, insufficientData: true };
  }
  const average = priorCycleIds.reduce((sum, id) => sum + cycleCounts.get(id), 0) / priorCycleIds.length;
  const deviationPercent = average === 0 ? null : Number(((current - average) / average * 100).toFixed(1));
  return {
    sector,
    current,
    average: Number(average.toFixed(2)),
    deviationPercent,
    sampleCycles: sortedCycleIds.length,
    insufficientData: false
  };
}
function findLeadershipRuns(sortedMarketStates, sector) {
  const runs = [];
  let currentRun = null;
  for (const state of sortedMarketStates) {
    const isLeading = (state.sectorLeadership ?? []).some((entry) => entry.sector === sector);
    if (isLeading) {
      if (!currentRun) {
        currentRun = { startTimestamp: state.timestamp, endTimestamp: state.timestamp, cycles: 1 };
      } else {
        currentRun.endTimestamp = state.timestamp;
        currentRun.cycles += 1;
      }
    } else if (currentRun) {
      runs.push({ ...currentRun, ongoing: false });
      currentRun = null;
    }
  }
  if (currentRun) {
    runs.push({ ...currentRun, ongoing: true });
  }
  return runs;
}
function computeTypicalLeadershipDuration(marketStateRecords, sector) {
  const sorted = [...marketStateRecords].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1);
  const runs = findLeadershipRuns(sorted, sector);
  const completedRuns = runs.filter((r) => !r.ongoing);
  const currentlyLeading = runs.some((r) => r.ongoing);
  if (completedRuns.length === 0) {
    return { sector, sampleRuns: 0, averageCycles: null, averageDurationMs: null, currentlyLeading, insufficientData: true };
  }
  const averageCycles = completedRuns.reduce((sum, r) => sum + r.cycles, 0) / completedRuns.length;
  const averageDurationMs = completedRuns.reduce((sum, r) => sum + (new Date(r.endTimestamp).getTime() - new Date(r.startTimestamp).getTime()), 0) / completedRuns.length;
  return {
    sector,
    sampleRuns: completedRuns.length,
    averageCycles: Number(averageCycles.toFixed(2)),
    averageDurationMs,
    currentlyLeading,
    insufficientData: false
  };
}
function computeHistoricalExpectancy(outcomeRecords, filter = {}) {
  const filtered = outcomeRecords.filter(
    (o) => (!filter.sector || o.sector === filter.sector) && (!filter.riskState || o.riskStateAtEntry === filter.riskState)
  );
  if (filtered.length === 0) {
    return { sampleSize: 0, winRate: null, averageRMultiple: null, insufficientData: true };
  }
  const wins = filtered.filter((o) => o.result === "win").length;
  const winRate = wins / filtered.length;
  const averageRMultiple = filtered.reduce((sum, o) => sum + (o.rMultiple ?? 0), 0) / filtered.length;
  return {
    sampleSize: filtered.length,
    winRate: Number(winRate.toFixed(3)),
    averageRMultiple: Number(averageRMultiple.toFixed(3)),
    insufficientData: false
  };
}
function computeFailurePatterns(outcomeRecords, filter = {}) {
  const losses = outcomeRecords.filter((o) => o.result === "loss" && (!filter.sector || o.sector === filter.sector));
  if (losses.length === 0) {
    return { sampleSize: 0, patterns: [], insufficientData: true };
  }
  const counts = /* @__PURE__ */ new Map();
  for (const loss of losses) {
    const trigger = loss.failureTrigger ?? "unspecified";
    counts.set(trigger, (counts.get(trigger) ?? 0) + 1);
  }
  const patterns = [...counts.entries()].map(([trigger, count]) => ({ trigger, count })).sort((a, b) => b.count - a.count);
  return { sampleSize: losses.length, patterns, insufficientData: false };
}

// src/memory/index.js
var COLLECTIONS = Object.freeze({
  MARKET_STATES: "marketStates",
  CANDIDATES: "candidates",
  THEME_UPDATES: "themeUpdates",
  OUTCOMES: "outcomes"
});
var MemoryEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('./store/memoryStorePort.js').MemoryStore} [deps.store] - defaults to a fresh InMemoryStore
   */
  constructor(deps) {
    super({ name: "Memory", eventBus: deps.eventBus, logger: deps.logger });
    this.store = deps.store ?? new InMemoryStore();
    assertValidMemoryStore(this.store);
    this.#unsubscribeOutcomes = null;
  }
  #unsubscribeOutcomes;
  async onStart() {
    this.#unsubscribeOutcomes = this.eventBus.subscribe(
      config.events.TRADE_OUTCOME_RECORDED,
      (envelope) => this.recordOutcome(envelope.payload)
    );
    this.logger.info("Memory started", { storeType: this.store.constructor.name });
  }
  async onStop() {
    this.#unsubscribeOutcomes?.();
    this.#unsubscribeOutcomes = null;
  }
  // ===== Write-side: called directly by engines that inject Memory =====
  async recordMarketState(marketState) {
    await this.store.append(COLLECTIONS.MARKET_STATES, marketState);
  }
  async recordCandidate(candidateContext) {
    await this.store.append(COLLECTIONS.CANDIDATES, candidateContext);
  }
  async recordThemeUpdate(sector, themeMemoryEntry) {
    await this.store.append(COLLECTIONS.THEME_UPDATES, {
      sector,
      ...themeMemoryEntry,
      recordedAt: (/* @__PURE__ */ new Date()).toISOString()
    });
  }
  /**
   * Not yet called by any engine — Judge doesn't exist. Implemented
   * now so getHistoricalExpectancy() and getFailurePatterns() have a
   * real write path ready the moment Judge/outcome-tracking is built,
   * rather than needing a Memory change at that point.
   *
   * @param {{symbol: string, sector: string, marketStateId: string, riskStateAtEntry: string, result: 'win'|'loss'|'breakeven', rMultiple: number, failureTrigger?: string, closedAt: string}} outcome
   */
  async recordOutcome(outcome) {
    await this.store.append(COLLECTIONS.OUTCOMES, outcome);
  }
  // ===== Read-side: the actual public interface =====
  /** Seeds Intel's in-process theme registry on startup. Returns a Map, as Intel expects. */
  async getThemeRegistry() {
    const records = await this.store.queryAll(COLLECTIONS.THEME_UPDATES);
    const latestBySector = /* @__PURE__ */ new Map();
    for (const record of records) {
      const { sector, recordedAt, ...entry } = record;
      const existing = latestBySector.get(sector);
      if (!existing || recordedAt > existing.recordedAt) {
        latestBySector.set(sector, { entry, recordedAt });
      }
    }
    const registry = /* @__PURE__ */ new Map();
    for (const [sector, { entry }] of latestBySector) {
      registry.set(sector, entry);
    }
    return registry;
  }
  /** Seeds Observer's rotation-detection context on startup. */
  async getLastMarketState() {
    const records = await this.store.queryAll(COLLECTIONS.MARKET_STATES);
    if (records.length === 0) return null;
    return [...records].sort((a, b) => a.timestamp < b.timestamp ? -1 : 1).at(-1);
  }
  /**
   * Full chronological history of theme-memory updates for one sector.
   * "Have we seen this before?" — answered directly, not recomputed.
   */
  async getThemeHistory(sector, { limit } = {}) {
    const records = await this.store.queryAll(COLLECTIONS.THEME_UPDATES);
    const forSector = records.filter((r) => r.sector === sector).sort((a, b) => a.recordedAt < b.recordedAt ? -1 : 1);
    return limit ? forSector.slice(-limit) : forSector;
  }
  /** "18 mentions vs a baseline of 6 — that's intelligence, not a count." */
  async compareAgainstBaseline(sector) {
    const candidates = await this.store.queryAll(COLLECTIONS.CANDIDATES);
    return compareAgainstBaseline(candidates, sector);
  }
  /** How long a sector typically stays in market leadership once it gets there. */
  async getTypicalLeadershipDuration(sector) {
    const marketStates = await this.store.queryAll(COLLECTIONS.MARKET_STATES);
    return computeTypicalLeadershipDuration(marketStates, sector);
  }
  /** Win rate / average R-multiple, optionally filtered by sector and/or risk state at entry. */
  async getHistoricalExpectancy(filter = {}) {
    const outcomes = await this.store.queryAll(COLLECTIONS.OUTCOMES);
    return computeHistoricalExpectancy(outcomes, filter);
  }
  /** Ranked failure triggers behind past losing outcomes, optionally filtered by sector. */
  async getFailurePatterns(filter = {}) {
    const outcomes = await this.store.queryAll(COLLECTIONS.OUTCOMES);
    return computeFailurePatterns(outcomes, filter);
  }
};

// src/sniper/technicalDataPort.js
var REQUIRED_METHODS4 = Object.freeze(["getTechnicalSnapshot"]);
function assertValidTechnicalDataPort(port) {
  if (!port || typeof port !== "object") {
    throw new Error("TechnicalDataPort must be an object");
  }
  const missing = REQUIRED_METHODS4.filter((m) => typeof port[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`TechnicalDataPort is missing required method(s): ${missing.join(", ")}`);
  }
}
var REQUIRED_SNAPSHOT_FIELDS = Object.freeze([
  "symbol",
  "assetClass",
  "price",
  "sma20",
  "sma50",
  "sma200",
  "atr14",
  "high20",
  "low20",
  "volumeToday",
  "volumeAvg20",
  "momentumRoc5dPercent",
  "timestamp"
]);
function assertValidTechnicalSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== "object") {
    throw new Error("TechnicalSnapshot must be an object");
  }
  const missing = REQUIRED_SNAPSHOT_FIELDS.filter((field) => snapshot[field] === void 0);
  if (missing.length > 0) {
    throw new Error(`TechnicalSnapshot is missing required field(s): ${missing.join(", ")} (symbol: ${snapshot.symbol ?? "unknown"})`);
  }
}

// src/sniper/policy.js
var TREND_POLICY = Object.freeze({
  // Points awarded for moving-average alignment (price>sma20,
  // sma20>sma50, sma50>sma200) before any magnitude bonus.
  maxAlignmentScore: 70,
  // Remaining points come from how far price sits above sma200, capped here.
  maxMagnitudeBonus: 30
});
var MOMENTUM_POLICY = Object.freeze({
  // momentumRoc5dPercent is linearly mapped onto 0-100 across this
  // symmetric band; anything outside is clamped to 0 or 100.
  rocBandPercent: 10
});
var PARTICIPATION_POLICY = Object.freeze({
  // Reuses config.rvolReference.optimalCenter as the peak of a Gaussian
  // curve — same reference point Radar uses for its own (separate)
  // volume-expansion reasoning, since both ultimately trace back to the
  // same shadow-mode RVOL research. sigma controls how quickly the
  // score falls off on either side of the optimal center.
  sigma: 1
});
var RISK_POLICY = Object.freeze({
  // ATR as a % of price. Below idealMinPercent, there's not enough
  // volatility to work with; above idealMaxPercent, risk becomes hard
  // to size safely. Score is 100 inside the ideal band, tapering
  // linearly to 0 at the outer bounds.
  idealMinPercent: 1.5,
  idealMaxPercent: 4,
  outerMinPercent: 0,
  outerMaxPercent: 10
});

// src/sniper/pillars.js
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
function scoreTrend(snapshot) {
  const alignments = [
    snapshot.price > snapshot.sma20,
    snapshot.sma20 > snapshot.sma50,
    snapshot.sma50 > snapshot.sma200
  ];
  const alignmentCount = alignments.filter(Boolean).length;
  const baseScore = alignmentCount / 3 * TREND_POLICY.maxAlignmentScore;
  const priceAboveSma200Percent = snapshot.sma200 > 0 ? (snapshot.price - snapshot.sma200) / snapshot.sma200 * 100 : 0;
  const magnitudeBonus = clamp(priceAboveSma200Percent, 0, TREND_POLICY.maxMagnitudeBonus);
  const score = Math.round(clamp(baseScore + magnitudeBonus, 0, 100));
  return { score, details: { alignmentCount, priceAboveSma200Percent: Number(priceAboveSma200Percent.toFixed(2)) } };
}
function scoreStructure(snapshot) {
  const range = snapshot.high20 - snapshot.low20;
  if (range <= 0) {
    return { score: 50, details: { positionPercent: null, insufficientRange: true } };
  }
  const positionPercent = (snapshot.price - snapshot.low20) / range * 100;
  const distanceFromHighPercent = snapshot.high20 > 0 ? (snapshot.high20 - snapshot.price) / snapshot.high20 * 100 : null;
  const score = Math.round(clamp(positionPercent, 0, 100));
  return {
    score,
    details: {
      positionPercent: Number(positionPercent.toFixed(2)),
      distanceFromHighPercent: distanceFromHighPercent !== null ? Number(distanceFromHighPercent.toFixed(2)) : null
    }
  };
}
function scoreMomentum(snapshot) {
  const band = MOMENTUM_POLICY.rocBandPercent;
  const roc = snapshot.momentumRoc5dPercent;
  const score = Math.round(clamp((roc + band) / (2 * band) * 100, 0, 100));
  return { score, details: { momentumRoc5dPercent: roc } };
}
function scoreParticipation(snapshot) {
  if (!snapshot.volumeAvg20 || snapshot.volumeAvg20 <= 0) {
    return { score: 0, details: { rvol: null, insufficientVolumeData: true } };
  }
  const rvol = snapshot.volumeToday / snapshot.volumeAvg20;
  const { optimalCenter } = config.rvolReference;
  const { sigma } = PARTICIPATION_POLICY;
  const gaussian = Math.exp(-Math.pow(rvol - optimalCenter, 2) / (2 * Math.pow(sigma, 2)));
  const score = Math.round(clamp(gaussian * 100, 0, 100));
  return { score, details: { rvol: Number(rvol.toFixed(2)), optimalCenter } };
}
function scoreRisk(snapshot) {
  if (!snapshot.price || snapshot.price <= 0) {
    return { score: 0, details: { atrPercent: null, insufficientPriceData: true } };
  }
  const atrPercent = snapshot.atr14 / snapshot.price * 100;
  const { idealMinPercent, idealMaxPercent, outerMinPercent, outerMaxPercent } = RISK_POLICY;
  let score;
  if (atrPercent >= idealMinPercent && atrPercent <= idealMaxPercent) {
    score = 100;
  } else if (atrPercent < idealMinPercent) {
    score = (atrPercent - outerMinPercent) / (idealMinPercent - outerMinPercent) * 100;
  } else {
    score = 100 - (atrPercent - idealMaxPercent) / (outerMaxPercent - idealMaxPercent) * 100;
  }
  return { score: Math.round(clamp(score, 0, 100)), details: { atrPercent: Number(atrPercent.toFixed(2)) } };
}

// src/sniper/swingStructure.js
var DEFAULT_MIN_REVERSAL_PERCENT = 0.03;
function extractSwings(bars, minReversalPercent = DEFAULT_MIN_REVERSAL_PERCENT) {
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error("extractSwings requires a non-empty bars array");
  }
  if (minReversalPercent <= 0) {
    throw new Error("extractSwings requires a positive minReversalPercent");
  }
  if (bars.length < 2) return [];
  const swings = [];
  let highIdx = 0;
  let highPrice = bars[0].high;
  let lowIdx = 0;
  let lowPrice = bars[0].low;
  let direction = null;
  let i = 1;
  for (; i < bars.length && direction === null; i++) {
    const bar = bars[i];
    const dropFromHigh = (highPrice - bar.low) / highPrice;
    const riseFromLow = (bar.high - lowPrice) / lowPrice;
    if (dropFromHigh >= minReversalPercent) {
      swings.push({ type: "high", index: highIdx, price: highPrice });
      direction = "down";
      lowIdx = i;
      lowPrice = bar.low;
    } else if (riseFromLow >= minReversalPercent) {
      swings.push({ type: "low", index: lowIdx, price: lowPrice });
      direction = "up";
      highIdx = i;
      highPrice = bar.high;
    } else {
      if (bar.high > highPrice) {
        highPrice = bar.high;
        highIdx = i;
      }
      if (bar.low < lowPrice) {
        lowPrice = bar.low;
        lowIdx = i;
      }
    }
  }
  if (direction === null) return swings;
  for (; i < bars.length; i++) {
    const bar = bars[i];
    if (direction === "down") {
      const riseFromLow = (bar.high - lowPrice) / lowPrice;
      if (riseFromLow >= minReversalPercent) {
        swings.push({ type: "low", index: lowIdx, price: lowPrice });
        direction = "up";
        highIdx = i;
        highPrice = bar.high;
      } else if (bar.low < lowPrice) {
        lowPrice = bar.low;
        lowIdx = i;
      }
    } else {
      const dropFromHigh = (highPrice - bar.low) / highPrice;
      if (dropFromHigh >= minReversalPercent) {
        swings.push({ type: "high", index: highIdx, price: highPrice });
        direction = "down";
        lowIdx = i;
        lowPrice = bar.low;
      } else if (bar.high > highPrice) {
        highPrice = bar.high;
        highIdx = i;
      }
    }
  }
  return swings;
}
function extractPullbackDepths(swings) {
  const depths = [];
  for (let i = 1; i < swings.length; i++) {
    const prev = swings[i - 1];
    const curr = swings[i];
    if (prev.type === "high" && curr.type === "low") {
      depths.push((prev.price - curr.price) / prev.price);
    }
  }
  return depths;
}
function extractPullbackAvgVolumes(swings, bars) {
  const volumes = [];
  for (let i = 1; i < swings.length; i++) {
    const prev = swings[i - 1];
    const curr = swings[i];
    if (prev.type === "high" && curr.type === "low") {
      const segment = bars.slice(prev.index, curr.index + 1);
      const avg = segment.reduce((sum, b) => sum + b.volume, 0) / segment.length;
      volumes.push(avg);
    }
  }
  return volumes;
}

// src/sniper/baseQuality.js
var DEFAULTS = Object.freeze({
  lookbackDays: 40,
  // how many days back to look for the base itself
  priorLookbackDays: 20,
  // how many days BEFORE the base to compare range-tightness against
  minBaseLength: 15,
  // minimum days of actual data required to even evaluate a base
  minContractions: 2,
  // Minervini/VCP's minimum contraction count
  volumeDryUpRatio: 0.7,
  // last contraction's avg volume must be <= this fraction of the first contraction's
  minReversalPercent: 0.03
  // passed through to extractSwings — filters day-to-day noise
});
function rangePercent(bar) {
  return (bar.high - bar.low) / bar.high;
}
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
function detectBase(bars, endIndex, options = {}) {
  const opts = { ...DEFAULTS, ...options };
  if (!Array.isArray(bars)) {
    throw new Error("detectBase requires bars to be an array");
  }
  if (!Number.isInteger(endIndex) || endIndex < 0 || endIndex > bars.length) {
    throw new Error(`detectBase requires a valid endIndex within bars (got ${endIndex} for ${bars.length} bars)`);
  }
  const windowStart = Math.max(0, endIndex - opts.lookbackDays);
  const windowBars = bars.slice(windowStart, endIndex);
  const failedCriteria = [];
  if (windowBars.length < opts.minBaseLength) {
    failedCriteria.push("insufficient_bars");
    return {
      valid: false,
      failedCriteria,
      baseHigh: null,
      baseLow: null,
      baseLength: windowBars.length,
      baseDepth: null,
      contractions: [],
      contractionVolumes: [],
      progressiveContraction: false,
      volumeDryUp: false,
      rangeTightened: false
    };
  }
  const baseHigh = Math.max(...windowBars.map((b) => b.high));
  const baseLow = Math.min(...windowBars.map((b) => b.low));
  const baseDepth = (baseHigh - baseLow) / baseHigh;
  const swings = extractSwings(windowBars, opts.minReversalPercent);
  const contractions = extractPullbackDepths(swings);
  const contractionVolumes = extractPullbackAvgVolumes(swings, windowBars);
  if (contractions.length < opts.minContractions) {
    failedCriteria.push("insufficient_contractions");
  }
  let progressiveContraction = contractions.length >= 2;
  for (let k = 1; k < contractions.length; k++) {
    if (contractions[k] >= contractions[k - 1]) {
      progressiveContraction = false;
      break;
    }
  }
  if (contractions.length >= 2 && !progressiveContraction) {
    failedCriteria.push("contractions_not_progressive");
  }
  const volumeDryUp = contractionVolumes.length >= 2 && contractionVolumes[contractionVolumes.length - 1] <= contractionVolumes[0] * opts.volumeDryUpRatio;
  if (contractionVolumes.length >= 2 && !volumeDryUp) {
    failedCriteria.push("volume_did_not_dry_up");
  }
  const priorStart = Math.max(0, windowStart - opts.priorLookbackDays);
  const priorBars = bars.slice(priorStart, windowStart);
  let rangeTightened = true;
  if (priorBars.length > 0) {
    const baseMedianRange = median(windowBars.map(rangePercent));
    const priorMedianRange = median(priorBars.map(rangePercent));
    rangeTightened = baseMedianRange <= priorMedianRange;
    if (!rangeTightened) {
      failedCriteria.push("range_not_tightened");
    }
  }
  return {
    valid: failedCriteria.length === 0,
    failedCriteria,
    baseHigh,
    baseLow,
    baseLength: windowBars.length,
    baseDepth,
    contractions,
    contractionVolumes,
    progressiveContraction,
    volumeDryUp,
    rangeTightened
  };
}

// src/sniper/distributionDays.js
var DEFAULT_DISTRIBUTION_THRESHOLD_PERCENT = -2e-3;
var DEFAULT_LOOKBACK_DAYS = 25;
var DEFAULT_RALLY_EXPIRY_MULTIPLIER = 1.05;
function isDistributionDay(bars, i, thresholdPercent = DEFAULT_DISTRIBUTION_THRESHOLD_PERCENT) {
  if (i < 1 || i >= bars.length) return false;
  const ret1d = (bars[i].close - bars[i - 1].close) / bars[i - 1].close;
  return ret1d <= thresholdPercent && bars[i].volume > bars[i - 1].volume;
}
function countDistributionDays(bars, i, options = {}) {
  const lookbackDays = options.lookbackDays ?? DEFAULT_LOOKBACK_DAYS;
  const rallyExpiryMultiplier = options.rallyExpiryMultiplier ?? DEFAULT_RALLY_EXPIRY_MULTIPLIER;
  const thresholdPercent = options.thresholdPercent ?? DEFAULT_DISTRIBUTION_THRESHOLD_PERCENT;
  if (!Array.isArray(bars)) {
    throw new Error("countDistributionDays requires bars to be an array");
  }
  if (!Number.isInteger(i) || i < 0 || i >= bars.length) {
    throw new Error(`countDistributionDays requires a valid index within bars (got ${i} for ${bars.length} bars)`);
  }
  let count = 0;
  const start = Math.max(1, i - lookbackDays + 1);
  for (let j = start; j <= i; j++) {
    if (isDistributionDay(bars, j, thresholdPercent)) {
      const expired = bars[i].close >= bars[j].close * rallyExpiryMultiplier;
      if (!expired) {
        count++;
      }
    }
  }
  return count;
}

// src/sniper/breakoutDetection.js
var DEFAULTS2 = Object.freeze({
  minVolumeRatio: 1.5,
  // standard breakout confirmation
  strongVolumeRatio: 2,
  eliteVolumeRatio: 2.25,
  minClosePosition: 0.6,
  // where in the day's range price closed — 0=low, 1=high
  strongClosePosition: 0.7
});
function closePosition(bar) {
  const range = bar.high - bar.low;
  if (range === 0) return 0.5;
  return (bar.close - bar.low) / range;
}
function classifyBreakoutDay(bar, pivot, avgVolume, options = {}) {
  const opts = { ...DEFAULTS2, ...options };
  if (avgVolume <= 0) {
    throw new Error("classifyBreakoutDay requires a positive avgVolume");
  }
  const volumeRatio = bar.volume / avgVolume;
  const pos = closePosition(bar);
  const clearsPivot = bar.high > pivot && bar.close > pivot;
  if (!clearsPivot || volumeRatio < opts.minVolumeRatio || pos < opts.minClosePosition) {
    return { isBreakout: false, tier: "none", volumeRatio, closePosition: pos };
  }
  if (volumeRatio >= opts.eliteVolumeRatio && pos >= opts.strongClosePosition) {
    return { isBreakout: true, tier: "elite", volumeRatio, closePosition: pos };
  }
  if (volumeRatio >= opts.strongVolumeRatio && pos >= opts.strongClosePosition) {
    return { isBreakout: true, tier: "strong", volumeRatio, closePosition: pos };
  }
  return { isBreakout: true, tier: "standard", volumeRatio, closePosition: pos };
}
function flagFalseBreakout(bars, breakoutIndex, pivot, avgVolume) {
  if (!Array.isArray(bars) || breakoutIndex < 0 || breakoutIndex >= bars.length) {
    throw new Error(`flagFalseBreakout requires a valid breakoutIndex within bars (got ${breakoutIndex} for ${bars.length} bars)`);
  }
  if (avgVolume <= 0) {
    throw new Error("flagFalseBreakout requires a positive avgVolume");
  }
  const reasons = [];
  const breakoutBar = bars[breakoutIndex];
  const volumeRatio = breakoutBar.volume / avgVolume;
  if (closePosition(breakoutBar) < 0.4) {
    reasons.push("weak_close_location");
  }
  const windowEnd = Math.min(breakoutIndex + 3, bars.length - 1);
  const followingBars = bars.slice(breakoutIndex + 1, windowEnd + 1);
  const failedFast = followingBars.some((b) => b.close < pivot);
  if (volumeRatio >= 3 && failedFast) {
    reasons.push("huge_volume_but_failed_fast");
  }
  const anyGenuineFollowThrough = followingBars.some((b, idx) => {
    const prevClose = idx === 0 ? breakoutBar.close : followingBars[idx - 1].close;
    return b.volume / avgVolume >= 1 && b.close > prevClose;
  });
  if (failedFast && !anyGenuineFollowThrough) {
    reasons.push("failed_fast_no_follow_through");
  }
  const distCheckIndex = Math.min(breakoutIndex + 10, bars.length - 1);
  const dd = countDistributionDays(bars, distCheckIndex, { lookbackDays: 25 });
  if (dd >= 5) {
    reasons.push("rising_distribution_count");
  }
  return { isFalseBreakout: reasons.length > 0, reasons };
}

// src/sniper/momentumStructure.js
function scoreMomentumStructure(bars, avgVolume50, options = {}) {
  if (!Array.isArray(bars) || bars.length === 0) {
    return { score: 0, details: { insufficientData: true } };
  }
  if (avgVolume50 <= 0) {
    return { score: 0, details: { insufficientData: true, reason: "invalid_avgVolume50" } };
  }
  const latestIndex = bars.length - 1;
  const base = detectBase(bars, latestIndex, options);
  if (!base.valid) {
    return {
      score: 0,
      details: {
        baseValid: false,
        baseFailedCriteria: base.failedCriteria,
        reason: "no_valid_base"
      }
    };
  }
  const pivot = base.baseHigh;
  const breakout = classifyBreakoutDay(bars[latestIndex], pivot, avgVolume50);
  if (!breakout.isBreakout) {
    return {
      score: 0,
      details: {
        baseValid: true,
        breakoutDetected: false,
        baseHigh: pivot,
        volumeRatio: Number(breakout.volumeRatio.toFixed(2)),
        closePosition: Number(breakout.closePosition.toFixed(2)),
        reason: "no_confirmed_breakout"
      }
    };
  }
  let score = 0;
  if (breakout.volumeRatio >= 2) score += 2;
  else if (breakout.volumeRatio >= 1.5) score += 1;
  if (breakout.closePosition >= 0.7) score += 1;
  if (base.baseLength >= 15) score += 1;
  if (base.baseDepth <= 0.35) score += 1;
  const dd = countDistributionDays(bars, latestIndex, { lookbackDays: 25 });
  if (dd <= 2) score += 2;
  else if (dd <= 4) score += 1;
  const falseBreakoutFlag = flagFalseBreakout(bars, latestIndex, pivot, avgVolume50);
  if (falseBreakoutFlag.isFalseBreakout) {
    score = Math.max(0, score - 4);
  }
  const normalizedScore = Math.round(score / 8 * 100);
  return {
    score: Math.max(0, Math.min(100, normalizedScore)),
    details: {
      baseValid: true,
      breakoutTier: breakout.tier,
      baseHigh: pivot,
      // the base-high/pivot level — added for PortfolioEngine's breakoutPivot use, found missing during real integration work, purely additive
      volumeRatio: Number(breakout.volumeRatio.toFixed(2)),
      closePosition: Number(breakout.closePosition.toFixed(2)),
      baseLength: base.baseLength,
      baseDepth: Number(base.baseDepth.toFixed(3)),
      distributionDays: dd,
      isFalseBreakout: falseBreakoutFlag.isFalseBreakout,
      falseBreakoutReasons: falseBreakoutFlag.reasons,
      rawScore: score
    }
  };
}

// src/sniper/profileBuilder.js
function buildCandidateProfile(candidateContext, technicalSnapshot, historicalContext, pillarWeights, sniperVersion) {
  const pillars = {
    trend: scoreTrend(technicalSnapshot),
    structure: scoreStructure(technicalSnapshot),
    momentum: scoreMomentum(technicalSnapshot),
    participation: scoreParticipation(technicalSnapshot),
    risk: scoreRisk(technicalSnapshot)
  };
  const compositeScore = Math.round(
    pillars.trend.score * pillarWeights.trend + pillars.structure.score * pillarWeights.structure + pillars.momentum.score * pillarWeights.momentum + pillars.participation.score * pillarWeights.participation + pillars.risk.score * pillarWeights.risk
  );
  const momentumStructure = technicalSnapshot.dailyBars && technicalSnapshot.volumeAvg50 ? scoreMomentumStructure(technicalSnapshot.dailyBars, technicalSnapshot.volumeAvg50) : null;
  return {
    candidateId: `${candidateContext.symbol}:${candidateContext.marketStateId}`,
    symbol: candidateContext.symbol,
    assetClass: candidateContext.assetClass,
    sector: candidateContext.sector,
    pillars,
    compositeScore,
    momentumStructure,
    historicalContext: historicalContext ?? null,
    sniperVersion,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/sniper/index.js
var SniperEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('./technicalDataPort.js').TechnicalDataPort} deps.technicalDataPort
   * @param {object} [deps.memory] - optional Memory interface; queried read-only for historical context, never written to by Sniper
   */
  constructor(deps) {
    super({ name: "Sniper", eventBus: deps.eventBus, logger: deps.logger, memory: deps.memory });
    assertValidTechnicalDataPort(deps.technicalDataPort);
    this.technicalDataPort = deps.technicalDataPort;
    this.#unsubscribeCandidates = null;
  }
  #unsubscribeCandidates;
  async onStart() {
    this.#unsubscribeCandidates = this.eventBus.subscribe(
      config.events.CANDIDATE_DISCOVERED,
      (envelope) => this.handleCandidate(envelope.payload)
    );
  }
  async onStop() {
    this.#unsubscribeCandidates?.();
    this.#unsubscribeCandidates = null;
  }
  /**
   * Processes one CandidateContext: fetches technical data, scores all
   * five pillars, optionally enriches with Memory, publishes
   * PROFILE_COMPLETE. Public (not private) so tests can call it
   * directly. Returns the published profile, or undefined if technical
   * data could not be obtained (logged, not thrown).
   */
  async handleCandidate(candidateContext) {
    let technicalSnapshot;
    try {
      technicalSnapshot = await this.technicalDataPort.getTechnicalSnapshot(candidateContext.symbol, candidateContext.assetClass);
      assertValidTechnicalSnapshot(technicalSnapshot);
    } catch (err) {
      this.logger.error("Sniper failed to obtain a valid technical snapshot", {
        symbol: candidateContext.symbol,
        error: err.message
      });
      return;
    }
    const historicalContext = await this.#fetchHistoricalContext(candidateContext);
    const profile = buildCandidateProfile(
      candidateContext,
      technicalSnapshot,
      historicalContext,
      config.pillarWeights,
      config.build.scoringModel
    );
    this.logger.info("Sniper profile complete", {
      symbol: profile.symbol,
      compositeScore: profile.compositeScore
    });
    await this.eventBus.publish(config.events.PROFILE_COMPLETE, {
      candidateId: profile.candidateId,
      profile,
      timestamp: profile.timestamp
    });
    return profile;
  }
  /**
   * Queries Memory (read-only) for whatever historical context is
   * available for this candidate's sector. Never throws — Sniper must
   * function fully without Memory, same graceful-degradation pattern
   * every other engine follows.
   */
  async #fetchHistoricalContext(candidateContext) {
    if (!this.memory?.getHistoricalExpectancy || !this.memory?.getTypicalLeadershipDuration) {
      return null;
    }
    try {
      const [expectancy, leadershipDuration] = await Promise.all([
        this.memory.getHistoricalExpectancy({ sector: candidateContext.sector }),
        this.memory.getTypicalLeadershipDuration(candidateContext.sector)
      ]);
      return { expectancy, leadershipDuration };
    } catch (err) {
      this.logger.warn("Sniper could not fetch historical context from Memory", {
        symbol: candidateContext.symbol,
        error: err.message
      });
      return null;
    }
  }
};

// src/judge/blindAssessment.js
function toBlindAssessment(profile) {
  const { pillars, compositeScore, momentumStructure, historicalContext } = profile;
  return { pillars, compositeScore, momentumStructure, historicalContext };
}

// src/judge/policy.js
var JUDGE_THRESHOLDS = Object.freeze({
  ELITE: 85,
  // composite score >= 85
  GOOD: 70,
  // composite score >= 70 and < 85
  WATCH: 55
  // composite score >= 55 and < 70
  // anything below WATCH is PASS
});
function scoreToDecision(compositeScore) {
  if (typeof compositeScore !== "number" || Number.isNaN(compositeScore)) {
    throw new Error(`scoreToDecision requires a numeric score, got: ${compositeScore}`);
  }
  if (compositeScore >= JUDGE_THRESHOLDS.ELITE) return "ELITE";
  if (compositeScore >= JUDGE_THRESHOLDS.GOOD) return "GOOD";
  if (compositeScore >= JUDGE_THRESHOLDS.WATCH) return "WATCH";
  return "PASS";
}
function decisionToDeliveryTarget(decision, config2) {
  switch (decision) {
    case config2.decisions.ELITE:
    case config2.decisions.GOOD:
      return config2.deliveryTargets.BLUEJAM;
    case config2.decisions.WATCH:
    case config2.decisions.PASS:
      return config2.deliveryTargets.LOG_ONLY;
    default:
      throw new Error(`No delivery target routing defined for decision: ${decision}`);
  }
}
var PILLAR_LABEL_THRESHOLDS = Object.freeze({
  excellent: 85,
  strong: 70,
  acceptable: 55,
  weak: 40
  // below weak is "Poor"
});
function pillarLabel(score) {
  if (score >= PILLAR_LABEL_THRESHOLDS.excellent) return "Excellent";
  if (score >= PILLAR_LABEL_THRESHOLDS.strong) return "Strong";
  if (score >= PILLAR_LABEL_THRESHOLDS.acceptable) return "Acceptable";
  if (score >= PILLAR_LABEL_THRESHOLDS.weak) return "Weak";
  return "Poor";
}
function riskLabel(score) {
  if (score >= PILLAR_LABEL_THRESHOLDS.strong) return "Low";
  if (score >= PILLAR_LABEL_THRESHOLDS.acceptable) return "Moderate";
  return "High";
}
var EXPECTANCY_LABEL_THRESHOLDS = Object.freeze({
  high: 0.6,
  moderate: 0.5
});
function expectancyLabel(expectancy) {
  if (!expectancy || expectancy.insufficientData) return "Insufficient data";
  if (expectancy.winRate >= EXPECTANCY_LABEL_THRESHOLDS.high) return "High";
  if (expectancy.winRate >= EXPECTANCY_LABEL_THRESHOLDS.moderate) return "Moderate";
  return "Low";
}

// src/judge/reasoningBuilder.js
function buildReasoning(assessment, decision) {
  const tags = [`composite_score_${decision.toLowerCase()}_tier`];
  const pillarEntries = Object.entries(assessment.pillars);
  const strongest = pillarEntries.reduce((best, entry) => entry[1].score > best[1].score ? entry : best);
  const weakest = pillarEntries.reduce((worst, entry) => entry[1].score < worst[1].score ? entry : worst);
  tags.push(`primary_strength_${strongest[0]}`);
  tags.push(`primary_weakness_${weakest[0]}`);
  const expectancy = assessment.historicalContext?.expectancy;
  if (expectancy) {
    if (expectancy.insufficientData) {
      tags.push("historical_expectancy_insufficient_data");
    } else if (expectancy.winRate >= 0.5) {
      tags.push("historical_expectancy_supportive");
    } else {
      tags.push("historical_expectancy_unfavorable");
    }
  }
  const leadershipDuration = assessment.historicalContext?.leadershipDuration;
  if (leadershipDuration) {
    if (leadershipDuration.insufficientData) {
      tags.push("historical_leadership_duration_insufficient_data");
    } else if (leadershipDuration.currentlyLeading) {
      tags.push("sector_currently_in_leadership_run");
    }
  }
  return tags;
}

// src/judge/explanationBuilder.js
var PILLAR_DISPLAY_NAMES = Object.freeze({
  trend: "Trend",
  structure: "Structure",
  momentum: "Momentum",
  participation: "Participation",
  risk: "Risk"
});
function buildExplanation(assessment, decision) {
  const lines = [];
  for (const [pillarKey, displayName] of Object.entries(PILLAR_DISPLAY_NAMES)) {
    const score = assessment.pillars[pillarKey].score;
    const label = pillarKey === "risk" ? riskLabel(score) : pillarLabel(score);
    lines.push(`${displayName}: ${label}`);
  }
  const expectancy = assessment.historicalContext?.expectancy;
  if (expectancy) {
    lines.push(`Historical expectancy: ${expectancyLabel(expectancy)}`);
  }
  if (assessment.momentumStructure) {
    lines.push(`Momentum structure (informational): ${assessment.momentumStructure.score}/100`);
  }
  const thresholdForDecision = JUDGE_THRESHOLDS[decision];
  if (decision === "PASS") {
    lines.push(`Policy: composite score ${assessment.compositeScore} did not clear the WATCH threshold (${JUDGE_THRESHOLDS.WATCH})`);
  } else {
    lines.push(`Policy: composite score ${assessment.compositeScore} satisfies the ${decision} threshold (>= ${thresholdForDecision})`);
  }
  return lines;
}

// src/judge/decisionEngine.js
function makeDecision(blindAssessment) {
  const decision = scoreToDecision(blindAssessment.compositeScore);
  const reasoning = buildReasoning(blindAssessment, decision);
  const explanation = buildExplanation(blindAssessment, decision);
  return { decision, reasoning, explanation };
}

// src/judge/index.js
var JudgeEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   */
  constructor(deps) {
    super({ name: "Judge", eventBus: deps.eventBus, logger: deps.logger });
    this.#unsubscribeProfiles = null;
  }
  #unsubscribeProfiles;
  async onStart() {
    this.#unsubscribeProfiles = this.eventBus.subscribe(
      config.events.PROFILE_COMPLETE,
      (envelope) => this.handleProfile(envelope.payload)
    );
  }
  async onStop() {
    this.#unsubscribeProfiles?.();
    this.#unsubscribeProfiles = null;
  }
  /**
   * Processes one PROFILE_COMPLETE payload: strips identity, decides,
   * routes, publishes DECISION_MADE. Public (not private) so tests can
   * call it directly. Returns the published decision payload.
   */
  async handleProfile(payload) {
    const blindAssessment = toBlindAssessment(payload.profile);
    const { decision, reasoning, explanation } = makeDecision(blindAssessment);
    const deliveryTarget = decisionToDeliveryTarget(decision, config);
    const marketStateId = payload.candidateId.includes(":") ? payload.candidateId.split(":").slice(1).join(":") : null;
    const decisionPayload = {
      candidateId: payload.candidateId,
      // opaque to Judge — see header note
      decision,
      reasoning,
      explanation,
      compositeScore: blindAssessment.compositeScore,
      deliveryTarget,
      judgeVersion: config.build.judgePolicy,
      symbol: payload.profile.symbol,
      assetClass: payload.profile.assetClass,
      sector: payload.profile.sector,
      marketStateId,
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
    this.logger.info("Judge decision made", {
      decision,
      compositeScore: decisionPayload.compositeScore,
      deliveryTarget
    });
    await this.eventBus.publish(config.events.DECISION_MADE, decisionPayload);
    return decisionPayload;
  }
};

// src/kernel/eventEnvelope.js
var EVENT_SOURCES = Object.freeze({
  MARKET_STATE_CHANGED: "Observer",
  CANDIDATE_DISCOVERED: "Radar",
  INTEL_UPDATED: "Intel",
  INTEL_REPORT: "Intel",
  PROFILE_COMPLETE: "Sniper",
  DECISION_MADE: "Judge",
  TRADE_OUTCOME_RECORDED: "OutcomeRecorder",
  POSITION_OPENED: "Portfolio",
  POSITION_REVIEWED: "Portfolio",
  POSITION_CLOSED: "Portfolio"
});
var ENVELOPE_VERSION = "1";
function toEventEnvelope(busEnvelope) {
  const source = EVENT_SOURCES[busEnvelope.type];
  if (!source) {
    throw new Error(
      `No known source engine for event type "${busEnvelope.type}" \u2014 add it to EVENT_SOURCES in kernel/eventEnvelope.js`
    );
  }
  return Object.freeze({
    id: busEnvelope.eventId,
    type: busEnvelope.type,
    version: ENVELOPE_VERSION,
    timestamp: busEnvelope.timestamp,
    source,
    payload: busEnvelope.payload
  });
}

// src/database/store/inMemoryEventStore.js
var InMemoryEventStore = class {
  #events = [];
  async appendEvent(envelope) {
    this.#events.push(envelope);
  }
  async queryAll() {
    return [...this.#events];
  }
};

// src/database/store/eventStorePort.js
var REQUIRED_METHODS5 = Object.freeze(["appendEvent", "queryAll"]);
function assertValidEventStore(store) {
  if (!store || typeof store !== "object") {
    throw new Error("EventStore must be an object");
  }
  const missing = REQUIRED_METHODS5.filter((m) => typeof store[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`EventStore is missing required method(s): ${missing.join(", ")}`);
  }
}

// src/database/projections.js
function filterEvents(events, filter = {}) {
  return events.filter(
    (e) => (!filter.type || e.type === filter.type) && (!filter.source || e.source === filter.source) && (!filter.since || e.timestamp >= filter.since)
  );
}
function countEventsByType(events) {
  const counts = /* @__PURE__ */ new Map();
  for (const e of events) {
    counts.set(e.type, (counts.get(e.type) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}
function countEventsBySource(events) {
  const counts = /* @__PURE__ */ new Map();
  for (const e of events) {
    counts.set(e.source, (counts.get(e.source) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

// src/database/index.js
var DatabaseEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('./store/eventStorePort.js').EventStore} [deps.store] - defaults to a fresh InMemoryEventStore
   */
  constructor(deps) {
    super({ name: "Database", eventBus: deps.eventBus, logger: deps.logger });
    this.store = deps.store ?? new InMemoryEventStore();
    assertValidEventStore(this.store);
    this.#unsubscribeAll = null;
  }
  #unsubscribeAll;
  async onStart() {
    this.#unsubscribeAll = this.eventBus.subscribeAll((busEnvelope) => this.recordEvent(busEnvelope));
    this.logger.info("Database started", { storeType: this.store.constructor.name });
  }
  async onStop() {
    this.#unsubscribeAll?.();
    this.#unsubscribeAll = null;
  }
  /**
   * The one recording path for every event, of every type, forever.
   * Public (not private) so tests can call it directly with a raw bus
   * envelope shape.
   */
  async recordEvent(busEnvelope) {
    const envelope = toEventEnvelope(busEnvelope);
    await this.store.appendEvent(envelope);
    return envelope;
  }
  /** Raw retrieval, optionally filtered by type/source/since. No interpretation — that's Memory's job. */
  async getEvents(filter = {}) {
    const all = await this.store.queryAll();
    return filterEvents(all, filter);
  }
  /** Simple projections — counts, not analysis. */
  async getEventCountsByType() {
    return countEventsByType(await this.store.queryAll());
  }
  async getEventCountsBySource() {
    return countEventsBySource(await this.store.queryAll());
  }
};

// src/telegram/telegramTransportPort.js
var REQUIRED_METHODS6 = Object.freeze(["sendMessage"]);
function assertValidTelegramTransport(transport) {
  if (!transport || typeof transport !== "object") {
    throw new Error("TelegramTransport must be an object");
  }
  const missing = REQUIRED_METHODS6.filter((m) => typeof transport[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`TelegramTransport is missing required method(s): ${missing.join(", ")}`);
  }
}

// src/telegram/messageFormatter.js
var DECISION_EMOJI = Object.freeze({
  ELITE: "\u{1F3AF}",
  GOOD: "\u2705",
  WATCH: "\u{1F440}",
  PASS: "\u23ED\uFE0F"
});
function describeScoreStrength(compositeScore) {
  if (compositeScore >= 85) return "Nearly every signal aligned";
  if (compositeScore >= 70) return "Most signals aligned, solid setup";
  if (compositeScore >= 55) return "Mixed signals, some strength showing";
  return "Signals mostly against it";
}
function extractSymbol(candidateId) {
  return candidateId.split(":")[0];
}
function formatDecisionMessage(decisionPayload) {
  const symbol = extractSymbol(decisionPayload.candidateId);
  const emoji = DECISION_EMOJI[decisionPayload.decision] ?? "";
  const lines = [
    `${emoji} ${decisionPayload.decision} \u2014 ${symbol}`,
    "",
    ...decisionPayload.explanation,
    "",
    describeScoreStrength(decisionPayload.compositeScore)
  ];
  return lines.join("\n");
}

// src/telegram/deliveryRouter.js
function resolveChatId(deliveryTarget, telegramConfig, deliveryTargets) {
  switch (deliveryTarget) {
    case deliveryTargets.PUBLIC:
      return telegramConfig.publicChannelId;
    case deliveryTargets.BLUEJAM:
      return telegramConfig.bluejamChannelId;
    case deliveryTargets.LOG_ONLY:
      return null;
    default:
      throw new Error(`No chat ID routing defined for delivery target: ${deliveryTarget}`);
  }
}

// src/portfolio/messageBuilder.js
function pct(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${value.toFixed(1)}%`;
}
function buildPositionOpenedMessage(payload) {
  const emoji = payload.decision === "ELITE" ? "\u{1F3AF}" : "\u2705";
  const lines = [
    `${emoji} <b>OPEN \u2014 ${payload.symbol}</b>`,
    "",
    `Decision: ${payload.decision} \xB7 Entry: ${payload.entryPrice.toFixed(2)} \xB7 Score: ${payload.compositeScore}`
  ];
  if (payload.explanation && payload.explanation.length > 0) {
    lines.push("", payload.explanation.join(" \xB7 "));
  }
  lines.push("", "Plan: hold while structure remains intact, close only on a genuine break.");
  return lines.join("\n");
}
function buildPositionReviewedMessage(payload) {
  const lines = [
    `<b>HOLD \u2014 ${payload.symbol}</b>`,
    "",
    `Price: ${payload.currentPrice.toFixed(2)} (${pct(payload.unrealizedPercent)})`,
    payload.reviewSummary
  ];
  if (payload.activeStructuralLow) {
    lines.push(`Structural low: ${payload.activeStructuralLow.price.toFixed(2)} \u2014 this is the level that matters.`);
  }
  return lines.join("\n");
}
function buildPositionClosedMessage(payload) {
  const gainPercent = (payload.exitPrice - payload.entryPrice) / payload.entryPrice * 100;
  const lines = [
    `\u{1F534} <b>CLOSE \u2014 ${payload.symbol}</b>`,
    "",
    `Exit: ${payload.exitPrice.toFixed(2)} (${pct(gainPercent)})`,
    `Reason: ${payload.reviewSummary}`
  ];
  return lines.join("\n");
}

// src/telegram/index.js
var TelegramEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('./telegramTransportPort.js').TelegramTransport} deps.transport
   */
  constructor(deps) {
    super({ name: "Telegram", eventBus: deps.eventBus, logger: deps.logger });
    assertValidTelegramTransport(deps.transport);
    this.transport = deps.transport;
    this.#unsubscribeDecisions = null;
    this.#unsubscribeIntelReports = null;
    this.#unsubscribePositionOpened = null;
    this.#unsubscribePositionReviewed = null;
    this.#unsubscribePositionClosed = null;
    this.lastSentReviewReasonByPosition = /* @__PURE__ */ new Map();
  }
  #unsubscribeDecisions;
  #unsubscribeIntelReports;
  #unsubscribePositionOpened;
  #unsubscribePositionReviewed;
  #unsubscribePositionClosed;
  async onStart() {
    this.#unsubscribeDecisions = this.eventBus.subscribe(
      config.events.DECISION_MADE,
      (envelope) => this.handleDecision(envelope.payload)
    );
    if (config.env.cadence.narrativeAlertsEnabled) {
      this.#unsubscribeIntelReports = this.eventBus.subscribe(
        config.events.INTEL_REPORT,
        (envelope) => this.handleIntelReport(envelope.payload)
      );
    }
    if (config.env.portfolio.alertsEnabled) {
      this.#unsubscribePositionOpened = this.eventBus.subscribe(
        config.events.POSITION_OPENED,
        (envelope) => this.handlePositionOpened(envelope.payload)
      );
      this.#unsubscribePositionReviewed = this.eventBus.subscribe(
        config.events.POSITION_REVIEWED,
        (envelope) => this.handlePositionReviewed(envelope.payload)
      );
      this.#unsubscribePositionClosed = this.eventBus.subscribe(
        config.events.POSITION_CLOSED,
        (envelope) => this.handlePositionClosed(envelope.payload)
      );
    }
  }
  async onStop() {
    this.#unsubscribeDecisions?.();
    this.#unsubscribeIntelReports?.();
    this.#unsubscribePositionOpened?.();
    this.#unsubscribePositionReviewed?.();
    this.#unsubscribePositionClosed?.();
    this.#unsubscribeDecisions = null;
    this.#unsubscribeIntelReports = null;
    this.#unsubscribePositionOpened = null;
    this.#unsubscribePositionReviewed = null;
    this.#unsubscribePositionClosed = null;
  }
  /**
   * Processes one DECISION_MADE payload: routes, formats, sends.
   * Public (not private) so tests can call it directly. Deliberately
   * NEVER throws — a Telegram failure must never propagate anywhere
   * that could affect the rest of the system, on top of the isolation
   * the event bus already provides.
   */
  async handleDecision(payload) {
    let chatId;
    try {
      chatId = resolveChatId(payload.deliveryTarget, config.env.telegram, config.deliveryTargets);
    } catch (err) {
      this.logger.error("Telegram: could not resolve a chat ID for this delivery target", {
        deliveryTarget: payload.deliveryTarget,
        error: err.message
      });
      return;
    }
    if (chatId === null) {
      this.logger.info("Telegram: decision recorded but not delivered (log-only target)", {
        decision: payload.decision
      });
      return;
    }
    const message = formatDecisionMessage(payload);
    try {
      await this.transport.sendMessage(chatId, message);
      this.logger.info("Telegram: message delivered", {
        decision: payload.decision,
        deliveryTarget: payload.deliveryTarget
      });
    } catch (err) {
      this.logger.error("Telegram: failed to deliver message \u2014 trading and every other engine continue unaffected", {
        decision: payload.decision,
        error: err.message
      });
    }
    return message;
  }
  /**
   * Processes one INTEL_REPORT payload: sends the already-built
   * message text to Bluejam. Intel reports are always Bluejam-only
   * right now, matching DECISION_MADE's current routing — the public
   * channel is unused across this whole system, not just for
   * decisions (see judge/policy.js's decisionToDeliveryTarget for the
   * decision-side version of this same rule). Public (not private) so
   * tests can call it directly. Deliberately NEVER throws, same
   * isolation guarantee as handleDecision.
   *
   * @param {{message: string, reason: string}} payload - `message` is Intel's already-formatted text (narrativeMessageBuilder.js's output); `reason` (e.g. 'new-sector') is logged only, never rendered
   */
  async handleIntelReport(payload) {
    let chatId;
    try {
      chatId = resolveChatId(config.deliveryTargets.BLUEJAM, config.env.telegram, config.deliveryTargets);
    } catch (err) {
      this.logger.error("Telegram: could not resolve Bluejam chat ID for an Intel report", { error: err.message });
      return;
    }
    if (chatId === null) {
      this.logger.info("Telegram: Intel report recorded but not delivered (log-only target)", { reason: payload.reason });
      return;
    }
    try {
      await this.transport.sendMessage(chatId, payload.message);
      this.logger.info("Telegram: Intel report delivered", { reason: payload.reason });
    } catch (err) {
      this.logger.error("Telegram: failed to deliver Intel report \u2014 every other engine continues unaffected", {
        reason: payload.reason,
        error: err.message
      });
    }
    return payload.message;
  }
  /**
   * Processes one POSITION_OPENED payload: sends to Bluejam. Always
   * sent (an open is inherently a real, discrete event — no
   * "only on change" concern here, unlike reviews).
   */
  async handlePositionOpened(payload) {
    let chatId;
    try {
      chatId = resolveChatId(config.deliveryTargets.BLUEJAM, config.env.telegram, config.deliveryTargets);
    } catch (err) {
      this.logger.error("Telegram: could not resolve Bluejam chat ID for a position-opened alert", { error: err.message });
      return;
    }
    if (chatId === null) return;
    const message = buildPositionOpenedMessage(payload);
    try {
      await this.transport.sendMessage(chatId, message);
      this.logger.info("Telegram: position-opened alert delivered", { symbol: payload.symbol });
    } catch (err) {
      this.logger.error("Telegram: failed to deliver position-opened alert \u2014 every other engine continues unaffected", { symbol: payload.symbol, error: err.message });
    }
    return message;
  }
  /**
   * Processes one POSITION_REVIEWED payload. Only sends a HOLD alert
   * when PORTFOLIO_HOLD_ALERTS_ONLY_ON_CHANGE is true (default) AND
   * the reviewReason has genuinely changed since the last alert sent
   * for this position — same lesson learned from narrative alerts
   * firing too often under normal volatility: reviewing every cycle
   * is necessary for the engine's own state, but alerting on every
   * unchanged "still holding, normal pullback" review would be exactly
   * the kind of noise this whole system was built to avoid.
   */
  async handlePositionReviewed(payload) {
    if (config.env.portfolio.holdAlertsOnlyOnChange) {
      const lastReason = this.lastSentReviewReasonByPosition.get(payload.positionId);
      if (lastReason === payload.reviewReason) {
        this.logger.info("Telegram: HOLD review unchanged since last alert, suppressed", { symbol: payload.symbol, reviewReason: payload.reviewReason });
        return void 0;
      }
    }
    let chatId;
    try {
      chatId = resolveChatId(config.deliveryTargets.BLUEJAM, config.env.telegram, config.deliveryTargets);
    } catch (err) {
      this.logger.error("Telegram: could not resolve Bluejam chat ID for a position-reviewed alert", { error: err.message });
      return void 0;
    }
    if (chatId === null) return void 0;
    const message = buildPositionReviewedMessage(payload);
    try {
      await this.transport.sendMessage(chatId, message);
      this.lastSentReviewReasonByPosition.set(payload.positionId, payload.reviewReason);
      this.logger.info("Telegram: position-reviewed alert delivered", { symbol: payload.symbol, reviewReason: payload.reviewReason });
    } catch (err) {
      this.logger.error("Telegram: failed to deliver position-reviewed alert \u2014 every other engine continues unaffected", { symbol: payload.symbol, error: err.message });
    }
    return message;
  }
  /**
   * Processes one POSITION_CLOSED payload: sends to Bluejam. Always
   * sent — a close is inherently a real, discrete event.
   */
  async handlePositionClosed(payload) {
    let chatId;
    try {
      chatId = resolveChatId(config.deliveryTargets.BLUEJAM, config.env.telegram, config.deliveryTargets);
    } catch (err) {
      this.logger.error("Telegram: could not resolve Bluejam chat ID for a position-closed alert", { error: err.message });
      return;
    }
    if (chatId === null) return;
    const message = buildPositionClosedMessage(payload);
    try {
      await this.transport.sendMessage(chatId, message);
      this.lastSentReviewReasonByPosition.delete(payload.positionId);
      this.logger.info("Telegram: position-closed alert delivered", { symbol: payload.symbol, result: payload.result });
    } catch (err) {
      this.logger.error("Telegram: failed to deliver position-closed alert \u2014 every other engine continues unaffected", { symbol: payload.symbol, error: err.message });
    }
    return message;
  }
};

// src/health/index.js
var EMITTING_ENGINES = /* @__PURE__ */ new Set(["Observer", "Radar", "Intel", "Sniper", "Judge", "OutcomeRecorder"]);
var ENGINE_DISPLAY_NAMES = Object.freeze({
  observer: "Observer",
  radar: "Radar",
  intel: "Intel",
  memory: "Memory",
  sniper: "Sniper",
  judge: "Judge",
  database: "Database",
  telegram: "Telegram",
  shadowMode: "ShadowMode",
  outcomeRecorder: "OutcomeRecorder"
});
var ADAPTER_BUDGET_KEYS = Object.freeze(["BINANCE", "ALPACA", "YAHOO", "FMP", "FINNHUB"]);
var HealthService = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {Record<string, object>} deps.engines - the same { observer, radar, ... } map app.js's buildApp() returns
   * @param {{getUsage: (providerKey: string) => object}} [deps.callBudget] - defaults to the real shared singleton
   */
  constructor(deps) {
    super({ name: "Health", eventBus: deps.eventBus, logger: deps.logger });
    this.engines = deps.engines ?? {};
    this.callBudget = deps.callBudget ?? null;
    this.#eventCounts = /* @__PURE__ */ new Map();
    this.#lastHeartbeat = /* @__PURE__ */ new Map();
    this.#unsubscribeAll = null;
  }
  #eventCounts;
  #lastHeartbeat;
  #unsubscribeAll;
  async onStart() {
    this.#unsubscribeAll = this.eventBus.subscribeAll((rawEnvelope) => {
      try {
        const envelope = toEventEnvelope(rawEnvelope);
        this.#eventCounts.set(envelope.source, (this.#eventCounts.get(envelope.source) ?? 0) + 1);
        this.#lastHeartbeat.set(envelope.source, envelope.timestamp);
      } catch {
      }
    });
  }
  async onStop() {
    this.#unsubscribeAll?.();
    this.#unsubscribeAll = null;
  }
  /**
   * Assembles the full health report. Async only because store
   * descriptions could, in principle, be async in a future
   * implementation — this one is entirely synchronous underneath.
   */
  async getHealthReport() {
    const engines = {};
    for (const [key, engine] of Object.entries(this.engines)) {
      const displayName = ENGINE_DISPLAY_NAMES[key] ?? key;
      const emitsEvents = EMITTING_ENGINES.has(displayName);
      engines[key] = {
        status: engine?.isRunning ? "UP" : "DOWN",
        lastHeartbeat: emitsEvents ? this.#lastHeartbeat.get(displayName) ?? null : null,
        eventsProcessed: emitsEvents ? this.#eventCounts.get(displayName) ?? 0 : null
      };
    }
    const persistence = {};
    if (this.engines.database?.store) {
      persistence.eventStore = this.#describeStore(this.engines.database.store);
    }
    if (this.engines.memory?.store) {
      persistence.memoryStore = this.#describeStore(this.engines.memory.store);
    }
    const adapters = {};
    if (this.callBudget) {
      for (const providerKey of ADAPTER_BUDGET_KEYS) {
        try {
          adapters[providerKey] = this.callBudget.getUsage(providerKey);
        } catch {
        }
      }
    }
    return {
      version: config.build,
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      engines,
      persistence,
      adapters
    };
  }
  /**
   * Describes a store's health from passively observable state only —
   * never an active query. Duck-types Supabase-backed stores (which
   * expose getDeadLetterQueue() and a `coordinator`) vs. InMemory
   * stores (which don't), rather than requiring a specific class.
   */
  #describeStore(store) {
    const isDurable = typeof store.getDeadLetterQueue === "function";
    return {
      storeType: store.constructor.name,
      durable: isDurable,
      queueDepth: store.coordinator?.getQueueDepth?.() ?? null,
      deadLetters: isDurable ? store.getDeadLetterQueue().length : null
    };
  }
};

// src/portfolio/store/portfolioStorePort.js
var REQUIRED_METHODS7 = Object.freeze([
  "createPosition",
  "getOpenPositionBySymbol",
  "listOpenPositions",
  "updatePositionReview",
  "closePosition",
  "getPositionById"
]);
function assertValidPortfolioStore(store) {
  if (!store || typeof store !== "object") {
    throw new Error("PortfolioStore must be an object");
  }
  const missing = REQUIRED_METHODS7.filter((m) => typeof store[m] !== "function");
  if (missing.length > 0) {
    throw new Error(`PortfolioStore is missing required method(s): ${missing.join(", ")}`);
  }
}

// src/sniper/meaningfulSwingLow.js
var DEFAULT_MIN_ATR_MULTIPLE = 1.5;
function isMeaningfulSwingLow(lowSwing, precedingHighSwing, atr14, minAtrMultiple = DEFAULT_MIN_ATR_MULTIPLE) {
  if (lowSwing.type !== "low") {
    throw new Error("isMeaningfulSwingLow requires a low-type swing");
  }
  if (!precedingHighSwing) {
    return false;
  }
  if (atr14 <= 0) {
    throw new Error("isMeaningfulSwingLow requires a positive atr14");
  }
  const retracement = precedingHighSwing.price - lowSwing.price;
  return retracement >= atr14 * minAtrMultiple;
}
function getActiveStructuralSwingLow(bars, atr14, options = {}) {
  const minReversalPercent = options.minReversalPercent ?? 0.03;
  const minAtrMultiple = options.minAtrMultiple ?? DEFAULT_MIN_ATR_MULTIPLE;
  if (!Array.isArray(bars) || bars.length === 0) {
    throw new Error("getActiveStructuralSwingLow requires a non-empty bars array");
  }
  if (atr14 <= 0) {
    throw new Error("getActiveStructuralSwingLow requires a positive atr14");
  }
  const swings = extractSwings(bars, minReversalPercent);
  const meaningfulLows = [];
  for (let i = 0; i < swings.length; i++) {
    const swing = swings[i];
    if (swing.type !== "low") continue;
    const precedingHigh = i > 0 && swings[i - 1].type === "high" ? swings[i - 1] : null;
    if (isMeaningfulSwingLow(swing, precedingHigh, atr14, minAtrMultiple)) {
      meaningfulLows.push(swing);
    }
  }
  if (meaningfulLows.length === 0) return null;
  const latest = meaningfulLows[meaningfulLows.length - 1];
  const barsSinceLow = bars.slice(latest.index + 1);
  const alreadyBroken = barsSinceLow.some((b) => b.close < latest.price);
  if (alreadyBroken) return null;
  return { price: latest.price, index: latest.index };
}

// src/portfolio/positionState.js
var DEFAULTS3 = Object.freeze({
  // Drawdown-from-peak thresholds, as a fraction (0.20 = 20%)
  normalPullbackMaxDrawdown: 0.2,
  deeperValidPullbackMaxDrawdown: 0.35,
  tightenDrawdownThreshold: 0.2,
  closeDrawdownAfterBigGainThreshold: 0.5,
  // "gave it all back" — only applies after a genuinely large gain
  bigGainThreshold: 0.5,
  // what counts as a "big gain" for the above rule to even apply
  distributionLookbackDays: 20
});
function rollingMin(bars, fromIndex, toIndex) {
  let min = Infinity;
  for (let i = fromIndex; i <= toIndex; i++) {
    if (bars[i].low < min) min = bars[i].low;
  }
  return min;
}
function sma(bars, endIndex, period) {
  if (endIndex - period + 1 < 0) return null;
  let sum = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i++) {
    sum += bars[i].close;
  }
  return sum / period;
}
function classifyPositionState(bars, todayIndex, position, atr14 = null, options = {}) {
  const opts = { ...DEFAULTS3, ...options };
  if (!Array.isArray(bars) || todayIndex < 0 || todayIndex >= bars.length) {
    throw new Error(`classifyPositionState requires a valid todayIndex within bars (got ${todayIndex} for ${bars.length} bars)`);
  }
  if (position.entryIndex < 0 || position.entryIndex > todayIndex) {
    throw new Error("classifyPositionState requires a valid entryIndex at or before todayIndex");
  }
  const today = bars[todayIndex];
  const highestCloseSinceEntry = Math.max(...bars.slice(position.entryIndex, todayIndex + 1).map((b) => b.close));
  const drawdownFromPeak = (highestCloseSinceEntry - today.close) / highestCloseSinceEntry;
  const gainFromEntry = (today.close - position.entryPrice) / position.entryPrice;
  const distributionDays20 = countDistributionDays(bars, todayIndex, { lookbackDays: opts.distributionLookbackDays });
  const reasons = [];
  if (position.breakoutPivot && todayIndex <= position.entryIndex + 3) {
    const reclaimedPivot = bars.slice(position.entryIndex + 1, todayIndex + 1).some((b) => b.close >= position.breakoutPivot);
    if (today.close < position.breakoutPivot && !reclaimedPivot) {
      reasons.push("breakout_failed_fast");
    }
  }
  let activeStructuralLow = null;
  if (atr14 !== null && atr14 > 0 && todayIndex >= 1) {
    const barsBeforeToday = bars.slice(0, todayIndex);
    if (barsBeforeToday.length > 0) {
      activeStructuralLow = getActiveStructuralSwingLow(barsBeforeToday, atr14, {
        minReversalPercent: opts.minReversalPercent ?? 0.03
      });
      if (activeStructuralLow && today.close < activeStructuralLow.price) {
        reasons.push("closed_below_structural_swing_low");
      }
    }
  } else if (todayIndex >= 20) {
    const olderSupportLow = rollingMin(bars, todayIndex - 20, todayIndex - 10);
    const sma20Fallback = sma(bars, todayIndex, 20);
    if (sma20Fallback !== null && today.close < olderSupportLow && today.close < sma20Fallback) {
      reasons.push("severe_structure_break");
    }
  }
  if (gainFromEntry >= opts.bigGainThreshold && drawdownFromPeak >= opts.closeDrawdownAfterBigGainThreshold) {
    reasons.push("gave_back_majority_of_a_big_gain");
  }
  const previousClose = bars[todayIndex - 1]?.close ?? today.close;
  const todayReturn = (today.close - previousClose) / previousClose;
  if (distributionDays20 >= 4 && todayReturn <= -0.05) {
    reasons.push("heavy_distribution_with_sharp_decline");
  }
  if (reasons.length > 0) {
    return { state: "CLOSE", reasons, drawdownFromPeak, gainFromEntry, distributionDays20, activeStructuralLow };
  }
  const sma20 = sma(bars, todayIndex, 20);
  const normalPullback = drawdownFromPeak <= opts.normalPullbackMaxDrawdown && sma20 !== null && today.close >= sma20 && distributionDays20 <= 1;
  const deeperButValid = drawdownFromPeak <= opts.deeperValidPullbackMaxDrawdown && (!position.breakoutPivot || today.close >= position.breakoutPivot) && distributionDays20 <= 1;
  if (normalPullback || deeperButValid) {
    return {
      state: "HOLD",
      reasons: normalPullback ? ["normal_pullback_within_tolerance"] : ["deeper_but_structurally_valid_pullback"],
      drawdownFromPeak,
      gainFromEntry,
      distributionDays20,
      activeStructuralLow
    };
  }
  const tightenReasons = [];
  if (distributionDays20 >= 2) tightenReasons.push("moderate_distribution_stress");
  if (drawdownFromPeak >= opts.tightenDrawdownThreshold) tightenReasons.push("drawdown_beyond_normal_tolerance");
  if (sma20 !== null && today.close < sma20) tightenReasons.push("lost_20day_average");
  if (tightenReasons.length > 0) {
    return { state: "TIGHTEN", reasons: tightenReasons, drawdownFromPeak, gainFromEntry, distributionDays20, activeStructuralLow };
  }
  return { state: "HOLD", reasons: ["no_material_warning_signs"], drawdownFromPeak, gainFromEntry, distributionDays20, activeStructuralLow };
}

// src/portfolio/reviewDecision.js
function evaluateOpenPosition(position, technicalSnapshot, options = {}) {
  const bars = technicalSnapshot.dailyBars;
  if (!bars || bars.length === 0) {
    throw new Error(`evaluateOpenPosition requires technicalSnapshot.dailyBars for ${position.symbol} \u2014 none available`);
  }
  const todayIndex = bars.length - 1;
  const atr14 = technicalSnapshot.atr14 ?? null;
  const classification = classifyPositionState(bars, todayIndex, position, atr14, options);
  const action = classification.state === "CLOSE" ? "CLOSE" : "HOLD";
  const closeReason = classification.state === "CLOSE" ? classification.reasons[0] : null;
  const unrealizedPercent = classification.gainFromEntry * 100;
  const reviewReason = classification.reasons[0] ?? "no_material_warning_signs";
  const reviewSummary = buildReviewSummary(classification);
  return {
    action,
    internalState: classification.state,
    closeReason,
    reviewReason,
    reviewSummary,
    reasons: classification.reasons,
    activeStructuralLow: classification.activeStructuralLow,
    currentPrice: technicalSnapshot.price,
    unrealizedPercent
  };
}
var REASON_PHRASES = Object.freeze({
  normal_pullback_within_tolerance: "normal pullback, trend intact",
  deeper_but_structurally_valid_pullback: "deeper pullback but structure still holds",
  no_material_warning_signs: "no material warning signs",
  moderate_distribution_stress: "moderate distribution pressure building",
  drawdown_beyond_normal_tolerance: "pullback deeper than normal tolerance",
  lost_20day_average: "lost the 20-day average",
  breakout_failed_fast: "breakout failed to hold, never reclaimed",
  closed_below_structural_swing_low: "closed below the active structural swing low",
  severe_structure_break: "closed below meaningful prior support",
  gave_back_majority_of_a_big_gain: "gave back most of a large gain",
  heavy_distribution_with_sharp_decline: "heavy distribution plus a sharp decline today"
});
function buildReviewSummary(classification) {
  const phrases = classification.reasons.map((r) => REASON_PHRASES[r] ?? r);
  const structuralLowText = classification.activeStructuralLow ? ` Structural low: ${classification.activeStructuralLow.price.toFixed(2)}.` : "";
  return `${phrases.join("; ")}.${structuralLowText}`;
}

// src/portfolio/outcomeMapper.js
var R_MULTIPLE_UNKNOWN_RISK_DEFAULT_PERCENT = 5;
function mapClosedPositionToOutcome(position, closeDecision, closeDetails) {
  const gainPercent = (closeDetails.exitPrice - position.entryPrice) / position.entryPrice * 100;
  const result = gainPercent > 0.5 ? "win" : gainPercent < -0.5 ? "loss" : "breakeven";
  const rMultiple = gainPercent / R_MULTIPLE_UNKNOWN_RISK_DEFAULT_PERCENT;
  return {
    symbol: position.symbol,
    sector: position.sector ?? null,
    marketStateId: position.entryMarketStateId,
    riskStateAtEntry: position.riskStateAtEntry,
    result,
    rMultiple: Number(rMultiple.toFixed(2)),
    rMultipleMethod: "assumed_5pct_initial_risk",
    // see comment above — not yet a real modeled stop distance
    failureTrigger: closeDecision.closeReason ?? null,
    closedAt: closeDetails.closedAt,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}

// src/portfolio/index.js
var REVIEW_TASK_NAME = "portfolio-review-scan";
var QUALIFYING_DECISIONS = Object.freeze(["ELITE", "GOOD"]);
var PortfolioEngine = class extends Engine {
  /**
   * @param {object} deps
   * @param {import('../kernel/eventBus.js').EventBus} deps.eventBus
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} deps.logger
   * @param {import('../kernel/scheduler.js').Scheduler} deps.scheduler
   * @param {import('./store/portfolioStorePort.js').PortfolioStore} deps.portfolioStore
   * @param {import('../sniper/technicalDataPort.js').TechnicalDataPort} deps.technicalDataPort
   * @param {number} [deps.reviewIntervalSeconds] - defaults to config.env.portfolio.reviewIntervalSeconds
   */
  constructor(deps) {
    super({ name: "Portfolio", eventBus: deps.eventBus, logger: deps.logger });
    if (!deps.scheduler) {
      throw new Error("PortfolioEngine requires a scheduler dependency");
    }
    assertValidPortfolioStore(deps.portfolioStore);
    assertValidTechnicalDataPort(deps.technicalDataPort);
    this.scheduler = deps.scheduler;
    this.portfolioStore = deps.portfolioStore;
    this.technicalDataPort = deps.technicalDataPort;
    this.reviewIntervalSeconds = deps.reviewIntervalSeconds ?? config.env.portfolio.reviewIntervalSeconds;
    this.#unsubscribeDecisions = null;
    this.latestRiskState = null;
  }
  #unsubscribeDecisions;
  #unsubscribeMarketState;
  async onStart() {
    this.#unsubscribeMarketState = this.eventBus.subscribe(config.events.MARKET_STATE_CHANGED, (envelope) => {
      this.latestRiskState = envelope.payload.riskState;
    });
    this.#unsubscribeDecisions = this.eventBus.subscribe(
      config.events.DECISION_MADE,
      (envelope) => this.handleDecision(envelope.payload)
    );
    this.scheduler.register(REVIEW_TASK_NAME, this.reviewIntervalSeconds, () => this.runReviewCycle());
    this.scheduler.start(REVIEW_TASK_NAME);
  }
  async onStop() {
    this.#unsubscribeDecisions?.();
    this.#unsubscribeMarketState?.();
    this.#unsubscribeDecisions = null;
    this.#unsubscribeMarketState = null;
    this.scheduler.stop(REVIEW_TASK_NAME);
  }
  /**
   * Processes one DECISION_MADE payload: opens a new position if it
   * qualifies (ELITE/GOOD, Bluejam) and no open position already
   * exists for the symbol. Public so tests can call it directly.
   * Deliberately never throws past this method — a decision-handling
   * failure must not crash the engine or affect any other subsystem.
   *
   * @returns {object|undefined} the created position, or undefined if this decision didn't qualify / was skipped
   */
  async handleDecision(payload) {
    try {
      if (!QUALIFYING_DECISIONS.includes(payload.decision)) {
        return void 0;
      }
      if (payload.deliveryTarget !== config.deliveryTargets.BLUEJAM) {
        return void 0;
      }
      const existing = await this.portfolioStore.getOpenPositionBySymbol(payload.symbol);
      if (existing) {
        this.logger.info("Portfolio: skipped opening \u2014 an open position already exists for this symbol", { symbol: payload.symbol });
        return void 0;
      }
      const snapshot = await this.technicalDataPort.getTechnicalSnapshot(payload.symbol, payload.assetClass);
      const entryIndex = snapshot.dailyBars ? snapshot.dailyBars.length - 1 : 0;
      let breakoutPivot = null;
      if (snapshot.dailyBars && snapshot.volumeAvg50) {
        const momentumResult = scoreMomentumStructure(snapshot.dailyBars, snapshot.volumeAvg50);
        breakoutPivot = momentumResult.details?.baseHigh ?? null;
      }
      const position = {
        positionId: crypto.randomUUID(),
        symbol: payload.symbol,
        assetClass: payload.assetClass,
        sector: payload.sector,
        entryDecision: payload.decision,
        entryPrice: snapshot.price,
        entryIndex,
        breakoutPivot,
        entryCompositeScore: payload.compositeScore,
        entryMarketStateId: payload.marketStateId,
        riskStateAtEntry: this.latestRiskState ?? "UNKNOWN",
        entrySnapshot: { price: snapshot.price, sma20: snapshot.sma20, sma50: snapshot.sma50, atr14: snapshot.atr14 },
        openedAt: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.portfolioStore.createPosition(position);
      const openedPayload = {
        positionId: position.positionId,
        symbol: position.symbol,
        assetClass: position.assetClass,
        sector: position.sector,
        decision: position.entryDecision,
        entryPrice: position.entryPrice,
        openedAt: position.openedAt,
        marketStateId: position.entryMarketStateId,
        riskStateAtEntry: position.riskStateAtEntry,
        compositeScore: position.entryCompositeScore,
        deliveryTarget: payload.deliveryTarget,
        timestamp: (/* @__PURE__ */ new Date()).toISOString()
      };
      await this.eventBus.publish(config.events.POSITION_OPENED, openedPayload);
      this.logger.info("Portfolio: opened new position", { symbol: position.symbol, entryPrice: position.entryPrice, decision: position.entryDecision });
      return position;
    } catch (err) {
      this.logger.error("Portfolio: failed to handle a DECISION_MADE payload", { symbol: payload?.symbol, error: err?.message, stack: err?.stack });
      return void 0;
    }
  }
  /**
   * Reviews every open position: fetches a fresh technical snapshot,
   * evaluates HOLD vs CLOSE, persists the review, publishes
   * POSITION_REVIEWED, and on CLOSE also persists the closure and
   * publishes POSITION_CLOSED + TRADE_OUTCOME_RECORDED. Public so
   * tests and manual triggers can call it directly without waiting on
   * the scheduler. One position's failure must not stop the rest of
   * the cycle from running.
   *
   * @returns {Promise<{reviewed: number, closed: number}>}
   */
  async runReviewCycle() {
    const openPositions = await this.portfolioStore.listOpenPositions();
    let reviewed = 0;
    let closed = 0;
    for (const position of openPositions) {
      try {
        const snapshot = await this.technicalDataPort.getTechnicalSnapshot(position.symbol, position.assetClass);
        const decision = evaluateOpenPosition(position, snapshot);
        await this.portfolioStore.updatePositionReview(position.positionId, {
          lastReviewedAt: (/* @__PURE__ */ new Date()).toISOString(),
          latestSnapshot: { price: snapshot.price, sma20: snapshot.sma20 },
          activeStructuralStopPrice: decision.activeStructuralLow?.price ?? null,
          reviewReason: decision.reviewReason,
          reviewSummary: decision.reviewSummary
        });
        const reviewedPayload = {
          positionId: position.positionId,
          symbol: position.symbol,
          status: decision.action,
          reviewReason: decision.reviewReason,
          reviewSummary: decision.reviewSummary,
          currentPrice: decision.currentPrice,
          unrealizedPercent: decision.unrealizedPercent,
          evaluatedAt: (/* @__PURE__ */ new Date()).toISOString(),
          timestamp: (/* @__PURE__ */ new Date()).toISOString()
        };
        await this.eventBus.publish(config.events.POSITION_REVIEWED, reviewedPayload);
        reviewed++;
        if (decision.action === "CLOSE") {
          const closedAt = (/* @__PURE__ */ new Date()).toISOString();
          const closePayload = {
            exitPrice: decision.currentPrice,
            closedAt,
            closeReason: decision.closeReason,
            failureTrigger: decision.closeReason
          };
          const outcome = mapClosedPositionToOutcome(position, decision, closePayload);
          closePayload.rMultiple = outcome.rMultiple;
          await this.portfolioStore.closePosition(position.positionId, closePayload);
          const closedPayload = {
            positionId: position.positionId,
            symbol: position.symbol,
            assetClass: position.assetClass,
            sector: position.sector,
            entryPrice: position.entryPrice,
            exitPrice: closePayload.exitPrice,
            openedAt: position.openedAt,
            closedAt,
            holdingPeriodDays: Math.max(0, Math.round((new Date(closedAt) - new Date(position.openedAt)) / (1e3 * 60 * 60 * 24))),
            result: outcome.result,
            rMultiple: outcome.rMultiple,
            failureTrigger: closePayload.failureTrigger,
            closeReason: closePayload.closeReason,
            reviewSummary: decision.reviewSummary,
            // human-readable, not just the raw reason code — used directly by Telegram's message builder
            timestamp: (/* @__PURE__ */ new Date()).toISOString()
          };
          await this.eventBus.publish(config.events.POSITION_CLOSED, closedPayload);
          await this.eventBus.publish(config.events.TRADE_OUTCOME_RECORDED, outcome);
          this.logger.info("Portfolio: closed position", { symbol: position.symbol, closeReason: closePayload.closeReason, result: outcome.result });
          closed++;
        }
      } catch (err) {
        this.logger.error("Portfolio: failed to review a position \u2014 continuing with the rest of the cycle", {
          symbol: position.symbol,
          positionId: position.positionId,
          error: err?.message,
          stack: err?.stack
        });
      }
    }
    this.logger.info("Portfolio review cycle complete", { openPositions: openPositions.length, reviewed, closed });
    return { reviewed, closed };
  }
};

// src/utilities/apiBudget.js
var ApiBudgetTracker = class {
  /** @param {Record<string, number>} dailyLimits - providerKey -> max calls per UTC day */
  constructor(dailyLimits) {
    this.dailyLimits = dailyLimits;
    this.usage = /* @__PURE__ */ new Map();
  }
  #today() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  /**
   * Checks whether `providerKey` has budget remaining today, and if so,
   * consumes one call. Throws a clear, catchable error if the daily
   * limit would be exceeded — callers already handle port/provider
   * failures gracefully (log + skip), so this fits the same pattern
   * rather than needing new error handling anywhere.
   */
  consume(providerKey) {
    const limit = this.dailyLimits[providerKey];
    if (limit === void 0) {
      throw new Error(`No daily call limit configured for provider "${providerKey}" \u2014 add one in adapters/callBudgetPolicy.js`);
    }
    const today = this.#today();
    const entry = this.usage.get(providerKey);
    if (!entry || entry.day !== today) {
      this.usage.set(providerKey, { day: today, count: 1 });
      return;
    }
    if (entry.count >= limit) {
      throw new Error(
        `API budget exceeded for "${providerKey}": ${entry.count}/${limit} calls used today (UTC). Resets at 00:00 UTC. Raise the limit in adapters/callBudgetPolicy.js if your plan allows more.`
      );
    }
    entry.count += 1;
  }
  /** Read-only usage snapshot, mainly for logging/dashboards later. */
  getUsage(providerKey) {
    const limit = this.dailyLimits[providerKey];
    const entry = this.usage.get(providerKey);
    const today = this.#today();
    const count = entry && entry.day === today ? entry.count : 0;
    return { providerKey, used: count, limit, remaining: limit !== void 0 ? limit - count : void 0 };
  }
};

// src/adapters/callBudgetPolicy.js
var DAILY_CALL_LIMITS = Object.freeze({
  BINANCE: 5e3,
  ALPACA: 2e3,
  YAHOO: 1e3,
  FMP: 200,
  // Finnhub's real constraint is per-minute (60/min), not a tight daily
  // credit like FMP's — this ceiling is a generous safety net, same
  // rationale as Binance/Alpaca above.
  FINNHUB: 5e3,
  // Polygon's real constraint is per-minute (5/min, enforced by
  // polygonRateLimiter — see providerRateLimiters.js), so this daily
  // ceiling is a coarse safety net, not the binding constraint.
  POLYGON: 2e3,
  // TwelveData's real, binding constraint is per-minute + serial
  // (enforced by twelveDataRateLimiter — see providerRateLimiters.js).
  // This 800 figure is confirmed directly from the live account
  // dashboard (Basic 8 plan, checked 2026-07-13) — the reset period
  // (daily vs monthly) was not unambiguous from the dashboard alone,
  // so this is treated as the conservative (daily) reading pending
  // confirmation. See ADAPTERS.md's TwelveData entry for the full note.
  TWELVE_DATA: 800,
  // CoinGecko's real, binding constraint is the ~55-minute minimum
  // interval enforced by coingeckoRateLimiter — that alone already
  // caps daily calls to roughly 26. This ceiling is mostly redundant
  // given that, kept only for consistency with every other provider
  // having a callBudget entry.
  COINGECKO: 30
});
var UNWIRED_PROVIDER_REFERENCE_LIMITS = Object.freeze({
  ALPHA_VANTAGE: { perDay: 20 }
});

// src/adapters/callBudget.js
var callBudget = new ApiBudgetTracker(DAILY_CALL_LIMITS);

// src/adapters/ttlCache.js
var TtlCache = class {
  /**
   * @param {number} ttlMs - how long an entry stays valid after being set
   */
  constructor(ttlMs) {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error("TtlCache requires a positive ttlMs");
    }
    this.ttlMs = ttlMs;
    this.store = /* @__PURE__ */ new Map();
  }
  /**
   * @param {string} key
   * @returns {*} the cached value, or undefined if missing/expired
   */
  get(key) {
    const entry = this.store.get(key);
    if (!entry) return void 0;
    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return void 0;
    }
    return entry.value;
  }
  /**
   * @param {string} key
   * @param {*} value
   */
  set(key, value) {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
  /**
   * Wraps an async factory function with cache-or-fetch semantics —
   * the pattern every call site actually wants, rather than making
   * every caller manually check get()/set().
   *
   * @param {string} key
   * @param {() => Promise<*>} factory - only called on a cache miss
   * @returns {Promise<*>}
   */
  async getOrFetch(key, factory) {
    const cached = this.get(key);
    if (cached !== void 0) return cached;
    const value = await factory();
    this.set(key, value);
    return value;
  }
  /** Removes every entry. Exposed mainly for tests. */
  clear() {
    this.store.clear();
  }
  /** Current entry count, including possibly-expired-but-not-yet-evicted ones. Exposed mainly for tests/diagnostics. */
  get size() {
    return this.store.size;
  }
};

// src/adapters/providers/fmpProvider.js
var BASE_URL = "https://financialmodelingprep.com/stable";
var activesCache = new TtlCache(3 * 60 * 1e3);
var profileCache = new TtlCache(6 * 60 * 60 * 1e3);
function apiKeyParam() {
  return `apikey=${encodeURIComponent(config.env.adapters.fmp.apiKey ?? "")}`;
}
function firstDefined(...values) {
  return values.find((v) => v !== void 0 && v !== null);
}
function parseProfile(rawProfile, symbol) {
  const entry = rawProfile?.[0];
  if (!entry) {
    throw new Error(`FMP profile response for ${symbol} contained no data`);
  }
  const marketCap = firstDefined(entry.marketCap, entry.mktCap);
  if (marketCap === void 0) {
    throw new Error(`FMP profile response for ${symbol} had neither "marketCap" nor "mktCap" \u2014 actual keys present: ${Object.keys(entry).join(", ")}`);
  }
  return {
    symbol,
    marketCap,
    sector: entry.sector,
    industry: entry.industry,
    exchange: entry.exchange,
    isEtf: Boolean(entry.isEtf)
  };
}
function parseQuote(rawQuote, symbol) {
  const entry = rawQuote?.[0];
  if (!entry) {
    throw new Error(`FMP quote response for ${symbol} contained no data`);
  }
  return {
    symbol,
    price: entry.price,
    dayHigh: entry.dayHigh,
    yearHigh: entry.yearHigh,
    marketCap: entry.marketCap,
    priceAvg50: entry.priceAvg50,
    priceAvg200: entry.priceAvg200,
    volume: entry.volume,
    avgVolume: entry.avgVolume,
    exchange: entry.exchange
  };
}
function parseSectorPerformance(rawSectorPerformance) {
  return rawSectorPerformance.map((entry) => {
    const raw = firstDefined(entry.averageChange, entry.changePercentage, entry.changesPercentage);
    if (raw === void 0) {
      throw new Error(`FMP sector-performance-snapshot entry for "${entry.sector}" had no recognized change field \u2014 actual keys present: ${Object.keys(entry).join(", ")}`);
    }
    const numeric = typeof raw === "string" ? parseFloat(raw.replace("%", "")) / 100 : raw;
    return { sector: entry.sector, relativeStrength: numeric };
  });
}
function parseMoverList(rawMovers) {
  return rawMovers.map((entry) => entry.symbol).filter(Boolean);
}
function parseActives(rawActives) {
  const symbols = [
    ...parseMoverList(rawActives.gainers ?? []),
    ...parseMoverList(rawActives.losers ?? []),
    ...parseMoverList(rawActives.actives ?? [])
  ];
  return [...new Set(symbols)];
}
async function fetchJson(url) {
  callBudget.consume("FMP");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`FMP request failed: ${response.status} ${response.statusText} (${url.split("?")[0]})`);
  }
  return response.json();
}
async function fetchProfile(symbol) {
  return profileCache.getOrFetch(
    symbol,
    () => fetchJson(`${BASE_URL}/profile?symbol=${encodeURIComponent(symbol)}&${apiKeyParam()}`)
  );
}
async function fetchQuote(symbol) {
  return fetchJson(`${BASE_URL}/quote?symbol=${encodeURIComponent(symbol)}&${apiKeyParam()}`);
}
async function fetchSectorPerformance(date) {
  const resolvedDate = date ?? (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  return fetchJson(`${BASE_URL}/sector-performance-snapshot?date=${resolvedDate}&${apiKeyParam()}`);
}
async function fetchActives() {
  return activesCache.getOrFetch("today", fetchActivesUncached);
}
async function fetchActivesUncached() {
  const [gainers, losers, actives] = await Promise.allSettled([
    fetchJson(`${BASE_URL}/biggest-gainers?${apiKeyParam()}`),
    fetchJson(`${BASE_URL}/biggest-losers?${apiKeyParam()}`),
    fetchJson(`${BASE_URL}/most-actives?${apiKeyParam()}`)
  ]);
  const settled = [gainers, losers, actives];
  const failures = settled.filter((r) => r.status === "rejected");
  if (failures.length === settled.length) {
    throw failures[0].reason;
  }
  return {
    gainers: gainers.status === "fulfilled" ? gainers.value : [],
    losers: losers.status === "fulfilled" ? losers.value : [],
    actives: actives.status === "fulfilled" ? actives.value : []
  };
}

// src/adapters/liveMarketDataPort.js
var VIX_SYMBOL = "^VIX";
function buildMarketSnapshot(quotes, sectorPerformance, vixPrice) {
  const validQuotes = quotes.filter((q) => q.priceAvg50 > 0);
  const aboveSma50Count = validQuotes.filter((q) => q.price > q.priceAvg50).length;
  const breadthPercentAboveMA50 = validQuotes.length > 0 ? aboveSma50Count / validQuotes.length * 100 : 0;
  return {
    breadthPercentAboveMA50: Number(breadthPercentAboveMA50.toFixed(2)),
    volatilityIndexValue: vixPrice,
    sectorPerformance,
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
var MAX_SYMBOLS_FOR_BREADTH = 15;
var liveMarketDataPort = Object.freeze({
  /** @returns {Promise<import('../observer/marketDataPort.js').MarketSnapshot>} */
  async getMarketSnapshot() {
    const rawActives = await fetchActives();
    const symbols = parseActives(rawActives).slice(0, MAX_SYMBOLS_FOR_BREADTH);
    const quotes = [];
    for (const symbol of symbols) {
      try {
        const rawQuote = await fetchQuote(symbol);
        quotes.push(parseQuote(rawQuote, symbol));
      } catch {
        continue;
      }
    }
    const [rawSectorPerformance, rawVixQuote] = await Promise.all([
      fetchSectorPerformance(),
      fetchQuote(VIX_SYMBOL)
    ]);
    const sectorPerformance = parseSectorPerformance(rawSectorPerformance);
    const vixQuote = parseQuote(rawVixQuote, VIX_SYMBOL);
    return buildMarketSnapshot(quotes, sectorPerformance, vixQuote.price);
  }
});

// src/adapters/providers/finnhubProvider.js
var BASE_URL2 = "https://finnhub.io/api/v1";
function tokenParam() {
  return `token=${encodeURIComponent(config.env.adapters.finnhub.apiKey ?? "")}`;
}
function parseQuote2(rawQuote, symbol) {
  if (!rawQuote || typeof rawQuote.c !== "number") {
    throw new Error(`Finnhub quote response for ${symbol} was empty or malformed`);
  }
  return {
    symbol,
    price: rawQuote.c,
    dayHigh: rawQuote.h,
    dayLow: rawQuote.l,
    previousClose: rawQuote.pc,
    changePercent: rawQuote.dp
  };
}
function parseNews(rawNews) {
  if (!Array.isArray(rawNews)) {
    throw new Error("Finnhub news response was not an array");
  }
  return rawNews.map((article) => `${article.headline ?? ""} ${article.summary ?? ""}`.toLowerCase());
}
async function fetchJson2(url) {
  callBudget.consume("FINNHUB");
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Finnhub request failed: ${response.status} ${response.statusText} (${url.split("?")[0]})`);
  }
  return response.json();
}
async function fetchQuote2(symbol) {
  return fetchJson2(`${BASE_URL2}/quote?symbol=${encodeURIComponent(symbol)}&${tokenParam()}`);
}
async function fetchNews() {
  return fetchJson2(`${BASE_URL2}/news?category=general&${tokenParam()}`);
}

// src/utilities/rateLimiter.js
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
var RateLimiter = class {
  /**
   * @param {object} [policies]
   * @param {number} [policies.perMinute] - max calls allowed in any rolling 60s window
   * @param {number} [policies.minIntervalMs] - minimum time that must elapse between the start of one call and the next
   * @param {number} [policies.maxConcurrent] - max calls allowed in flight simultaneously
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} [policies.logger]
   */
  constructor({ perMinute = null, minIntervalMs = null, maxConcurrent = null, logger = null } = {}) {
    this.perMinute = perMinute;
    this.minIntervalMs = minIntervalMs;
    this.maxConcurrent = maxConcurrent;
    this.logger = logger;
    this.#callTimestamps = [];
    this.#lastCallTimestamp = null;
    this.#availablePermits = maxConcurrent;
    this.#waitQueue = [];
    this.#admissionChain = Promise.resolve();
  }
  #callTimestamps;
  #lastCallTimestamp;
  #availablePermits;
  #waitQueue;
  #admissionChain;
  /**
   * Waits until every configured policy permits proceeding, then
   * reserves a concurrency slot (if maxConcurrent is set) and records
   * the call for per-minute/min-interval bookkeeping. Returns a
   * release() function — call it exactly once when the operation
   * completes (success or failure) to free its concurrency slot.
   *
   * Never throws due to rate limiting — it waits instead. A provider
   * combining this with ApiBudgetTracker should check the budget
   * (which does throw) either before or after acquire(), depending on
   * whether waiting-then-being-refused or being-refused-immediately is
   * more appropriate for that provider.
   */
  async acquire() {
    const myTurn = this.#admissionChain.then(() => this.#admit());
    this.#admissionChain = myTurn.catch(() => {
    });
    await myTurn;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#releaseConcurrencySlot();
    };
  }
  async #admit() {
    await this.#waitForPerMinute();
    await this.#waitForMinInterval();
    await this.#waitForConcurrencySlot();
    const now = Date.now();
    this.#callTimestamps.push(now);
    this.#lastCallTimestamp = now;
  }
  async #waitForPerMinute() {
    if (this.perMinute == null) return;
    for (; ; ) {
      const now = Date.now();
      this.#callTimestamps = this.#callTimestamps.filter((t) => now - t < 6e4);
      if (this.#callTimestamps.length < this.perMinute) return;
      const oldest = this.#callTimestamps[0];
      const waitMs = 6e4 - (now - oldest) + 5;
      this.logger?.debug(`RateLimiter: per-minute cap reached, waiting ${waitMs}ms`);
      await sleep(Math.max(waitMs, 0));
    }
  }
  async #waitForMinInterval() {
    if (this.minIntervalMs == null || this.#lastCallTimestamp == null) return;
    const elapsed = Date.now() - this.#lastCallTimestamp;
    if (elapsed < this.minIntervalMs) {
      const waitMs = this.minIntervalMs - elapsed;
      this.logger?.debug(`RateLimiter: minimum interval not yet elapsed, waiting ${waitMs}ms`);
      await sleep(waitMs);
    }
  }
  async #waitForConcurrencySlot() {
    if (this.maxConcurrent == null) return;
    if (this.#availablePermits > 0) {
      this.#availablePermits--;
      return;
    }
    await new Promise((resolve) => this.#waitQueue.push(resolve));
  }
  #releaseConcurrencySlot() {
    if (this.maxConcurrent == null) return;
    if (this.#waitQueue.length > 0) {
      const resolve = this.#waitQueue.shift();
      resolve();
    } else {
      this.#availablePermits++;
    }
  }
};

// src/adapters/providerRateLimiters.js
var polygonRateLimiter = new RateLimiter({
  perMinute: 5,
  logger: createLogger("RateLimiter:Polygon")
});
var twelveDataRateLimiter = new RateLimiter({
  perMinute: 8,
  maxConcurrent: 1,
  logger: createLogger("RateLimiter:TwelveData")
});
var coingeckoRateLimiter = new RateLimiter({
  minIntervalMs: 55 * 60 * 1e3,
  // ~1/hour, documented in ADAPTERS.md's CoinGecko entry
  logger: createLogger("RateLimiter:CoinGecko")
});

// src/adapters/providers/coingeckoProvider.js
var BASE_URL3 = "https://api.coingecko.com/api/v3/coins";
function parseCoinData(rawResponse, symbol) {
  if (!rawResponse || !rawResponse.id || !rawResponse.market_data) {
    throw new Error(`CoinGecko coin data response for ${symbol} was empty or malformed`);
  }
  const category = Array.isArray(rawResponse.categories) && rawResponse.categories.length > 0 ? rawResponse.categories[0] : void 0;
  return {
    symbol,
    marketCap: rawResponse.market_data.market_cap?.usd,
    price: rawResponse.market_data.current_price?.usd,
    category
  };
}
function parseTrending(rawResponse) {
  if (!rawResponse || !Array.isArray(rawResponse.coins)) {
    throw new Error("CoinGecko trending response was empty or malformed");
  }
  return rawResponse.coins.map((c) => c.item?.symbol?.toUpperCase()).filter(Boolean);
}
async function fetchTrending() {
  const release = await coingeckoRateLimiter.acquire();
  try {
    callBudget.consume("COINGECKO");
    const url = `https://api.coingecko.com/api/v3/search/trending`;
    const response = await fetch(url, {
      headers: config.env.adapters.coingecko.apiKey ? { "x-cg-demo-api-key": config.env.adapters.coingecko.apiKey } : {}
    });
    if (!response.ok) {
      throw new Error(`CoinGecko trending request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    release();
  }
}
async function fetchCoinData(coinId) {
  const release = await coingeckoRateLimiter.acquire();
  try {
    callBudget.consume("COINGECKO");
    const url = `${BASE_URL3}/${encodeURIComponent(coinId)}?localization=false&tickers=false&market_data=true`;
    const response = await fetch(url, {
      headers: config.env.adapters.coingecko.apiKey ? { "x-cg-demo-api-key": config.env.adapters.coingecko.apiKey } : {}
    });
    if (!response.ok) {
      throw new Error(`CoinGecko coin data request failed: ${response.status} ${response.statusText}`);
    }
    return response.json();
  } finally {
    release();
  }
}
var coingeckoProvider = Object.freeze({
  /**
   * @param {string} coinId - CoinGecko's own coin id (e.g. 'bitcoin'), NOT a ticker symbol — CoinGecko does not key its API by ticker
   * @returns {Promise<{symbol: string, marketCap: number|undefined, price: number|undefined, category: string|undefined}>}
   */
  async getCoinData(coinId) {
    const rawResponse = await fetchCoinData(coinId);
    return parseCoinData(rawResponse, coinId);
  },
  /**
   * @returns {Promise<string[]>} currently-trending ticker symbols (uppercased, e.g. 'BTC'), rate-limited the same way getCoinData is
   */
  async getTrendingSymbols() {
    const rawResponse = await fetchTrending();
    return parseTrending(rawResponse);
  }
});

// src/adapters/marketCalendar.js
var NYSE_HOLIDAYS_2026 = Object.freeze([
  "2026-01-01",
  // New Year's Day
  "2026-01-19",
  // Martin Luther King Jr. Day
  "2026-02-16",
  // Washington's Birthday (Presidents Day)
  "2026-04-03",
  // Good Friday
  "2026-05-25",
  // Memorial Day
  "2026-06-19",
  // Juneteenth
  "2026-07-03",
  // Independence Day (observed — July 4 falls on a Saturday)
  "2026-09-07",
  // Labor Day
  "2026-11-26",
  // Thanksgiving Day
  "2026-12-25"
  // Christmas Day
]);
var LSE_HOLIDAYS_2026 = Object.freeze([
  "2026-01-01",
  // New Year's Day
  "2026-04-03",
  // Good Friday
  "2026-04-06",
  // Easter Monday
  "2026-05-04",
  // Early May Bank Holiday
  "2026-05-25",
  // Spring Bank Holiday
  "2026-08-31",
  // Summer Bank Holiday
  "2026-12-25",
  // Christmas Day
  "2026-12-28"
  // Boxing Day (substitute — Dec 26 falls on a Saturday)
]);
var KNOWN_YEARS = Object.freeze([2026]);
function toDateKey(date) {
  return date.toISOString().slice(0, 10);
}
function assertKnownYear(date) {
  const year = date.getUTCFullYear();
  if (!KNOWN_YEARS.includes(year)) {
    throw new Error(
      `Market holiday calendar has no data for ${year} \u2014 only ${KNOWN_YEARS.join(", ")} ${KNOWN_YEARS.length === 1 ? "is" : "are"} covered. This needs a deliberate update (real, looked-up dates \u2014 not computed/estimated) before it can be trusted for ${year}.`
    );
  }
}
function isWeekendDate(date) {
  const day = date.getUTCDay();
  return day === 0 || day === 6;
}
function isNyseClosed(now = /* @__PURE__ */ new Date()) {
  assertKnownYear(now);
  return isWeekendDate(now) || NYSE_HOLIDAYS_2026.includes(toDateKey(now));
}

// src/adapters/liveDiscoveryPort.js
var STOCK_MOVER_THRESHOLD_PERCENT = 3;
var CRYPTO_MOVER_THRESHOLD_PERCENT = 5;
var BINANCE_24HR_URL = "https://data-api.binance.vision/api/v3/ticker/24hr";
function buildStockUniverse() {
  const symbols = /* @__PURE__ */ new Set();
  for (const members of Object.values(SECTOR_SYMBOLS)) {
    for (const symbol of members) {
      if (!symbol.includes("USDT") && !symbol.includes(".")) {
        symbols.add(symbol);
      }
    }
  }
  return [...symbols];
}
function buildCryptoUniverse() {
  const symbols = /* @__PURE__ */ new Set();
  for (const members of Object.values(SECTOR_SYMBOLS)) {
    for (const symbol of members) {
      if (symbol.includes("USDT")) {
        symbols.add(symbol);
      }
    }
  }
  return [...symbols];
}
async function fetchStockMovers() {
  const universe = buildStockUniverse();
  const movers = [];
  await Promise.all(
    universe.map(async (symbol) => {
      try {
        const raw = await fetchQuote2(symbol);
        const parsed = parseQuote2(raw, symbol);
        if (Math.abs(parsed.changePercent) >= STOCK_MOVER_THRESHOLD_PERCENT) {
          movers.push({ symbol, changePercent: parsed.changePercent });
        }
      } catch {
      }
    })
  );
  return movers;
}
async function fetchCryptoMovers() {
  const universe = new Set(buildCryptoUniverse());
  const response = await fetch(BINANCE_24HR_URL);
  if (!response.ok) {
    throw new Error(`Binance 24hr ticker request failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("Binance 24hr ticker response was not an array");
  }
  return data.filter((t) => universe.has(t.symbol) && Math.abs(Number(t.priceChangePercent)) >= CRYPTO_MOVER_THRESHOLD_PERCENT).map((t) => ({ symbol: t.symbol, changePercent: Number(t.priceChangePercent) }));
}
var liveDiscoveryPort = Object.freeze({
  /**
   * @param {Date} [now] - injectable for tests; defaults to the real current date
   * @returns {Promise<import('../intel/discoveryPort.js').DiscoverySnapshot>}
   */
  async getDiscoverySnapshot(now = /* @__PURE__ */ new Date()) {
    const marketClosed = isNyseClosed(now);
    const [newsResult, stockMoversResult, cryptoMoversResult, trendingResult] = await Promise.allSettled([
      marketClosed ? Promise.resolve([]) : fetchNews().then(parseNews),
      marketClosed ? Promise.resolve([]) : fetchStockMovers(),
      fetchCryptoMovers(),
      coingeckoProvider.getTrendingSymbols()
    ]);
    return {
      newsTexts: newsResult.status === "fulfilled" ? newsResult.value : [],
      stockMovers: stockMoversResult.status === "fulfilled" ? stockMoversResult.value : [],
      cryptoMovers: cryptoMoversResult.status === "fulfilled" ? cryptoMoversResult.value : [],
      trendingSymbols: trendingResult.status === "fulfilled" ? trendingResult.value : [],
      timestamp: (/* @__PURE__ */ new Date()).toISOString()
    };
  }
});

// src/adapters/liveAssetClassAdapter.js
function buildRawCandidate(fundamentals, quote) {
  return {
    symbol: fundamentals.symbol,
    assetClass: config.assetClasses.US_STOCK,
    price: quote.price,
    avgDollarVolume: quote.avgVolume * quote.price,
    marketCap: fundamentals.marketCap ?? quote.marketCap,
    sector: fundamentals.sector ?? "unclassified",
    relativeVolume: quote.avgVolume > 0 ? quote.volume / quote.avgVolume : void 0,
    distanceFromHighPercent: quote.yearHigh > 0 ? (quote.yearHigh - quote.price) / quote.yearHigh * 100 : void 0,
    isOtc: typeof fundamentals.exchange === "string" && fundamentals.exchange.toUpperCase().includes("OTC"),
    timestamp: (/* @__PURE__ */ new Date()).toISOString()
  };
}
var MAX_SYMBOLS_PER_CYCLE = 15;
var liveUsStockAssetClassAdapter = Object.freeze({
  assetClass: config.assetClasses.US_STOCK,
  /** @returns {Promise<import('../radar/marketAdapterPort.js').RawCandidate[]>} */
  async getCandidates() {
    const rawActives = await fetchActives();
    const symbols = parseActives(rawActives).slice(0, MAX_SYMBOLS_PER_CYCLE);
    const candidates = [];
    for (const symbol of symbols) {
      try {
        const [rawProfile, rawQuote] = await Promise.all([fetchProfile(symbol), fetchQuote(symbol)]);
        const fundamentals = parseProfile(rawProfile, symbol);
        const quote = parseQuote(rawQuote, symbol);
        candidates.push(buildRawCandidate(fundamentals, quote));
      } catch {
        continue;
      }
    }
    return candidates;
  }
});

// src/adapters/normalizedMarketData.js
var REQUIRED_TOP_LEVEL_FIELDS = Object.freeze(["symbol", "exchange", "timeframe", "ohlcv"]);
var REQUIRED_CANDLE_FIELDS = Object.freeze(["openTime", "open", "high", "low", "close", "volume", "closeTime"]);
function assertValidNormalizedMarketData(data) {
  if (!data || typeof data !== "object") {
    throw new Error("NormalizedMarketData must be an object");
  }
  const missing = REQUIRED_TOP_LEVEL_FIELDS.filter((field) => data[field] === void 0);
  if (missing.length > 0) {
    throw new Error(`NormalizedMarketData is missing required field(s): ${missing.join(", ")}`);
  }
  if (!Array.isArray(data.ohlcv) || data.ohlcv.length === 0) {
    throw new Error("NormalizedMarketData.ohlcv must be a non-empty array");
  }
  for (const [i, candle] of data.ohlcv.entries()) {
    const missingCandleFields = REQUIRED_CANDLE_FIELDS.filter((f) => candle[f] === void 0);
    if (missingCandleFields.length > 0) {
      throw new Error(`NormalizedMarketData.ohlcv[${i}] is missing field(s): ${missingCandleFields.join(", ")}`);
    }
  }
}

// src/adapters/providers/binanceProvider.js
var BASE_URL4 = "https://data-api.binance.vision/api/v3/klines";
function parseKlinesToNormalizedMarketData(rawKlines, symbol, timeframe) {
  const ohlcv = rawKlines.map((k) => ({
    openTime: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    closeTime: k[6]
  }));
  const normalized = { symbol, exchange: "BINANCE", timeframe, ohlcv };
  assertValidNormalizedMarketData(normalized);
  return normalized;
}
async function fetchKlines(symbol, timeframe, limit) {
  callBudget.consume("BINANCE");
  const url = `${BASE_URL4}?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${limit}`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Binance klines request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
var binanceProvider = Object.freeze({
  exchange: "BINANCE",
  /**
   * @param {string} symbol - e.g. 'BTCUSDT'
   * @param {{timeframe?: string, limit?: number}} [options]
   * @returns {Promise<import('../normalizedMarketData.js').NormalizedMarketData>}
   */
  async getNormalizedMarketData(symbol, { timeframe = "1d", limit = 210 } = {}) {
    const rawKlines = await fetchKlines(symbol, timeframe, limit);
    return parseKlinesToNormalizedMarketData(rawKlines, symbol, timeframe);
  }
});

// src/adapters/providers/alpacaProvider.js
var BASE_URL5 = "https://data.alpaca.markets/v2/stocks";
function parseBarsToNormalizedMarketData(rawResponse, symbol, timeframe) {
  const ohlcv = rawResponse.bars.map((bar) => {
    const time = new Date(bar.t).getTime();
    return {
      openTime: time,
      open: bar.o,
      high: bar.h,
      low: bar.l,
      close: bar.c,
      volume: bar.v,
      closeTime: time
    };
  });
  const normalized = { symbol, exchange: "NASDAQ", timeframe, ohlcv };
  assertValidNormalizedMarketData(normalized);
  return normalized;
}
async function fetchBars(symbol, timeframe, limit) {
  callBudget.consume("ALPACA");
  const url = `${BASE_URL5}/${encodeURIComponent(symbol)}/bars?timeframe=${encodeURIComponent(timeframe)}&limit=${limit}`;
  const response = await fetch(url, {
    headers: {
      "APCA-API-KEY-ID": config.env.adapters.alpaca.apiKey ?? "",
      "APCA-API-SECRET-KEY": config.env.adapters.alpaca.apiSecret ?? ""
      // sourced from ALPACA_SECRET_KEY
    }
  });
  if (!response.ok) {
    throw new Error(`Alpaca bars request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
var alpacaProvider = Object.freeze({
  exchange: "NASDAQ",
  /**
   * @param {string} symbol - e.g. 'AMD'
   * @param {{timeframe?: string, limit?: number}} [options] - Alpaca timeframe format, e.g. '1Day'
   * @returns {Promise<import('../normalizedMarketData.js').NormalizedMarketData>}
   */
  async getNormalizedMarketData(symbol, { timeframe = "1Day", limit = 210 } = {}) {
    const rawResponse = await fetchBars(symbol, timeframe, limit);
    return parseBarsToNormalizedMarketData(rawResponse, symbol, timeframe);
  }
});

// src/adapters/providers/yahooProvider.js
var BASE_URL6 = "https://query1.finance.yahoo.com/v8/finance/chart";
function parseChartToNormalizedMarketData(rawResponse, symbol, timeframe) {
  const result = rawResponse.chart?.result?.[0];
  if (!result) {
    throw new Error(`Yahoo chart response for ${symbol} contained no result data`);
  }
  const timestamps = result.timestamp ?? [];
  const quote = result.indicators?.quote?.[0] ?? {};
  const ohlcv = [];
  for (let i = 0; i < timestamps.length; i++) {
    if (quote.open?.[i] == null || quote.close?.[i] == null) continue;
    const timeMs = timestamps[i] * 1e3;
    ohlcv.push({
      openTime: timeMs,
      open: quote.open[i],
      high: quote.high[i],
      low: quote.low[i],
      close: quote.close[i],
      volume: quote.volume[i] ?? 0,
      closeTime: timeMs
    });
  }
  const normalized = { symbol, exchange: "LSE", timeframe, ohlcv };
  assertValidNormalizedMarketData(normalized);
  return normalized;
}
async function fetchChart(symbol, timeframe, range) {
  callBudget.consume("YAHOO");
  const url = `${BASE_URL6}/${encodeURIComponent(symbol)}?interval=${encodeURIComponent(timeframe)}&range=${encodeURIComponent(range)}`;
  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; SNIPER-X1/0.1.0)" }
  });
  if (!response.ok) {
    throw new Error(`Yahoo chart request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}
var yahooProvider = Object.freeze({
  exchange: "LSE",
  /**
   * @param {string} symbol - e.g. 'VOD.L'
   * @param {{timeframe?: string, range?: string}} [options]
   * @returns {Promise<import('../normalizedMarketData.js').NormalizedMarketData>}
   */
  async getNormalizedMarketData(symbol, { timeframe = "1d", range = "1y" } = {}) {
    const rawResponse = await fetchChart(symbol, timeframe, range);
    return parseChartToNormalizedMarketData(rawResponse, symbol, timeframe);
  }
});

// src/adapters/registry.js
var PROVIDERS_BY_ASSET_CLASS = Object.freeze({
  [config.assetClasses.CRYPTO]: binanceProvider,
  [config.assetClasses.US_STOCK]: alpacaProvider,
  [config.assetClasses.LSE]: yahooProvider
});
function getProviderForAssetClass(assetClass) {
  const provider = PROVIDERS_BY_ASSET_CLASS[assetClass];
  if (!provider) {
    throw new Error(`No provider registered for asset class "${assetClass}" \u2014 add one in adapters/registry.js`);
  }
  return provider;
}

// src/utilities/indicators.js
function calculateSMA(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    throw new Error(`calculateSMA requires at least ${period} values, got ${values?.length ?? 0}`);
  }
  const window = values.slice(values.length - period);
  return window.reduce((sum, v) => sum + v, 0) / period;
}
function calculateATR(bars, period) {
  if (!Array.isArray(bars) || bars.length < period + 1) {
    throw new Error(`calculateATR requires at least ${period + 1} bars, got ${bars?.length ?? 0}`);
  }
  const trueRanges = [];
  for (let i = bars.length - period; i < bars.length; i++) {
    const current = bars[i];
    const prevClose = bars[i - 1].close;
    const trueRange = Math.max(
      current.high - current.low,
      Math.abs(current.high - prevClose),
      Math.abs(current.low - prevClose)
    );
    trueRanges.push(trueRange);
  }
  return trueRanges.reduce((sum, tr) => sum + tr, 0) / period;
}
function calculateROC(values, periodsAgo) {
  if (!Array.isArray(values) || values.length < periodsAgo + 1) {
    throw new Error(`calculateROC requires at least ${periodsAgo + 1} values, got ${values?.length ?? 0}`);
  }
  const latest = values.at(-1);
  const past = values[values.length - 1 - periodsAgo];
  if (past === 0) {
    throw new Error("calculateROC cannot divide by a zero baseline value");
  }
  return (latest - past) / past * 100;
}
function calculateRollingHigh(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    throw new Error(`calculateRollingHigh requires at least ${period} values, got ${values?.length ?? 0}`);
  }
  return Math.max(...values.slice(values.length - period));
}
function calculateRollingLow(values, period) {
  if (!Array.isArray(values) || values.length < period) {
    throw new Error(`calculateRollingLow requires at least ${period} values, got ${values?.length ?? 0}`);
  }
  return Math.min(...values.slice(values.length - period));
}

// src/adapters/liveTechnicalDataPort.js
var DEFAULT_TIMEFRAME = "1d";
var DEFAULT_CANDLE_LIMIT = 210;
function buildTechnicalSnapshot(normalized, symbol, assetClass) {
  const closes = normalized.ohlcv.map((c) => c.close);
  const highs = normalized.ohlcv.map((c) => c.high);
  const lows = normalized.ohlcv.map((c) => c.low);
  const volumes = normalized.ohlcv.map((c) => c.volume);
  return {
    symbol,
    assetClass,
    price: closes.at(-1),
    sma20: calculateSMA(closes, 20),
    sma50: calculateSMA(closes, 50),
    sma200: calculateSMA(closes, 200),
    atr14: calculateATR(normalized.ohlcv, 14),
    high20: calculateRollingHigh(highs, 20),
    low20: calculateRollingLow(lows, 20),
    volumeToday: volumes.at(-1),
    volumeAvg20: calculateSMA(volumes, 20),
    momentumRoc5dPercent: calculateROC(closes, 5),
    timestamp: (/* @__PURE__ */ new Date()).toISOString(),
    // Optional fields for the informational momentum-structure signal
    // only — see technicalDataPort.js's docs for why these are kept
    // separate from everything the five weighted pillars use.
    volumeAvg50: volumes.length >= 50 ? calculateSMA(volumes, 50) : void 0,
    dailyBars: normalized.ohlcv.map((c) => ({ high: c.high, low: c.low, close: c.close, volume: c.volume }))
  };
}
var liveTechnicalDataPort = Object.freeze({
  /**
   * @param {string} symbol
   * @param {string} assetClass
   * @returns {Promise<import('../sniper/technicalDataPort.js').TechnicalSnapshot>}
   */
  async getTechnicalSnapshot(symbol, assetClass) {
    const provider = getProviderForAssetClass(assetClass);
    const normalized = await provider.getNormalizedMarketData(symbol, {
      timeframe: DEFAULT_TIMEFRAME,
      limit: DEFAULT_CANDLE_LIMIT
    });
    return buildTechnicalSnapshot(normalized, symbol, assetClass);
  }
});

// src/telegram/liveTelegramTransport.js
var BASE_URL7 = "https://api.telegram.org";
var DEFAULT_MAX_RETRIES = 3;
var DEFAULT_BASE_BACKOFF_MS = 500;
async function sendOnce(botToken, chatId, text) {
  const url = `${BASE_URL7}/bot${botToken}/sendMessage`;
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.ok === false) {
    throw new Error(`Telegram sendMessage failed: ${body.description ?? response.statusText}`);
  }
}
var liveTelegramTransport = Object.freeze({
  /**
   * @param {string} chatId
   * @param {string} text
   */
  async sendMessage(chatId, text) {
    const botToken = config.env.telegram.botToken;
    let lastError;
    for (let attempt = 1; attempt <= DEFAULT_MAX_RETRIES + 1; attempt++) {
      try {
        await sendOnce(botToken, chatId, text);
        return;
      } catch (err) {
        lastError = err;
        if (attempt <= DEFAULT_MAX_RETRIES) {
          const backoffMs = DEFAULT_BASE_BACKOFF_MS * Math.pow(2, attempt - 1);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
      }
    }
    throw lastError;
  }
});

// src/database/supabaseClient.js
import { createClient } from "@supabase/supabase-js";
import ws from "ws";
function createSupabaseClient() {
  const { url, serviceKey } = config.env.supabase;
  if (!url || !serviceKey) {
    throw new Error("createSupabaseClient requires SUPABASE_URL and SUPABASE_SERVICE_KEY to be set");
  }
  return createClient(url, serviceKey, {
    realtime: { transport: ws }
  });
}

// src/persistence/persistenceCoordinator.js
var PersistenceCoordinator = class {
  /**
   * @param {object} options
   * @param {(batch: object[]) => Promise<void>} options.flush - performs the real write for one batch; should throw on failure
   * @param {number} [options.batchSize] - flush automatically once this many items are queued
   * @param {number} [options.flushIntervalMs] - also flush on this timer, regardless of batch size
   * @param {number} [options.maxRetries] - retry attempts per batch before giving up
   * @param {number} [options.baseBackoffMs] - base delay for exponential backoff (doubles each retry)
   * @param {ReturnType<typeof import('../kernel/logger.js').createLogger>} [options.logger]
   */
  constructor({ flush, batchSize = 20, flushIntervalMs = 2e3, maxRetries = 5, baseBackoffMs = 500, logger } = {}) {
    if (typeof flush !== "function") {
      throw new Error("PersistenceCoordinator requires a flush function");
    }
    this.flush = flush;
    this.batchSize = batchSize;
    this.flushIntervalMs = flushIntervalMs;
    this.maxRetries = maxRetries;
    this.baseBackoffMs = baseBackoffMs;
    this.logger = logger ?? null;
    this.queue = [];
    this.deadLetterQueue = [];
    this.timer = null;
    this.isFlushing = false;
  }
  /**
   * Queues an item for later batch writing. Resolves immediately —
   * never awaits the real write. May trigger a background flush if the
   * batch size threshold is reached, but that flush is fire-and-forget
   * from this call's perspective.
   */
  async enqueue(item) {
    this.queue.push(item);
    if (this.queue.length >= this.batchSize && !this.isFlushing) {
      this.flushNow().catch((err) => {
        this.logger?.error("PersistenceCoordinator: background flush failed unexpectedly", { error: err.message });
      });
    }
  }
  /** Starts the periodic flush timer. Safe to call multiple times. */
  start() {
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flushNow().catch((err) => {
        this.logger?.error("PersistenceCoordinator: periodic flush failed unexpectedly", { error: err.message });
      });
    }, this.flushIntervalMs);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
  /**
   * Flushes one batch (up to batchSize items) from the front of the
   * queue, with retry/backoff. No-ops if already flushing or the queue
   * is empty, so concurrent triggers (timer + threshold) don't race.
   *
   * After releasing the lock, if enough items accumulated WHILE this
   * flush was in progress to warrant another batch, this recurses
   * (fire-and-forget) rather than leaving them stranded until the next
   * periodic timer tick. Without this, a second enqueue() arriving
   * mid-flush would see isFlushing=true, skip triggering a flush, and
   * — with a large flushIntervalMs — that item could sit unflushed
   * far longer than intended, or in a test with the timer effectively
   * disabled, indefinitely.
   */
  async flushNow() {
    if (this.isFlushing || this.queue.length === 0) return;
    this.isFlushing = true;
    const batch = this.queue.splice(0, this.batchSize);
    try {
      await this.#writeWithRetry(batch);
    } finally {
      this.isFlushing = false;
    }
    if (this.queue.length >= this.batchSize) {
      this.flushNow().catch((err) => {
        this.logger?.error("PersistenceCoordinator: follow-up flush failed unexpectedly", { error: err.message });
      });
    }
  }
  async #writeWithRetry(batch) {
    for (let attempt = 1; attempt <= this.maxRetries + 1; attempt++) {
      try {
        await this.flush(batch);
        return;
      } catch (err) {
        const isLastAttempt = attempt === this.maxRetries + 1;
        if (isLastAttempt) {
          const failedAt = (/* @__PURE__ */ new Date()).toISOString();
          this.deadLetterQueue.push(...batch.map((item) => ({ item, error: err.message, failedAt })));
          this.logger?.error("PersistenceCoordinator: batch moved to dead-letter queue after exhausting retries", {
            count: batch.length,
            attempts: attempt,
            error: err.message
          });
          return;
        }
        this.logger?.warn(`PersistenceCoordinator: flush attempt ${attempt} failed, retrying`, { error: err.message });
        const backoffMs = this.baseBackoffMs * Math.pow(2, attempt - 1);
        await new Promise((resolve) => setTimeout(resolve, backoffMs));
      }
    }
  }
  /**
   * Drains the entire queue, flushing repeatedly until empty. Intended
   * for graceful shutdown — awaited before the process exits, so
   * nothing queued is silently lost.
   */
  async shutdownFlush() {
    this.stop();
    while (this.queue.length > 0) {
      await this.flushNow();
    }
  }
  /** Copy of failed items, for diagnostics/alerting — never silently dropped. */
  getDeadLetterQueue() {
    return [...this.deadLetterQueue];
  }
  getQueueDepth() {
    return this.queue.length;
  }
};

// src/database/store/supabaseEventStore.js
var DEFAULT_TABLE = "x1_events";
var SupabaseEventStore = class {
  /**
   * @param {object} deps
   * @param {import('@supabase/supabase-js').SupabaseClient} deps.supabaseClient - injected, never constructed internally
   * @param {ReturnType<typeof import('../../kernel/logger.js').createLogger>} [deps.logger]
   * @param {string} [deps.tableName]
   * @param {object} [deps.coordinatorOptions] - passed through to PersistenceCoordinator (batchSize, flushIntervalMs, maxRetries, baseBackoffMs)
   */
  constructor({ supabaseClient, logger, tableName = DEFAULT_TABLE, coordinatorOptions = {} }) {
    if (!supabaseClient) {
      throw new Error("SupabaseEventStore requires an injected supabaseClient");
    }
    this.client = supabaseClient;
    this.tableName = tableName;
    this.logger = logger ?? null;
    this.coordinator = new PersistenceCoordinator({
      flush: (batch) => this.#writeBatch(batch),
      logger: this.logger,
      ...coordinatorOptions
    });
    this.coordinator.start();
  }
  /**
   * Satisfies the EventStore port. Enqueues for batched writing —
   * never blocks on the real Supabase call.
   */
  async appendEvent(envelope) {
    await this.coordinator.enqueue(this.#toRow(envelope));
  }
  /**
   * Satisfies the EventStore port. This IS a direct, awaited Supabase
   * read — reads aren't batched, since there's nothing to batch when
   * retrieving.
   */
  async queryAll() {
    const { data, error } = await this.client.from(this.tableName).select("id, type, version, source, timestamp, payload").order("timestamp", { ascending: true });
    if (error) {
      throw new Error(`SupabaseEventStore.queryAll failed: ${error.message}`);
    }
    return data.map((row) => this.#fromRow(row));
  }
  /**
   * Not part of the EventStore port — an additional capability for
   * whoever wires this store up (app.js) to call during graceful
   * shutdown, so nothing queued is lost when the process exits.
   */
  async shutdown() {
    await this.coordinator.shutdownFlush();
  }
  /** Diagnostics — items that permanently failed to write after all retries. */
  getDeadLetterQueue() {
    return this.coordinator.getDeadLetterQueue();
  }
  #toRow(envelope) {
    return {
      id: envelope.id,
      type: envelope.type,
      version: envelope.version,
      source: envelope.source,
      timestamp: envelope.timestamp,
      payload: envelope.payload
    };
  }
  #fromRow(row) {
    return {
      id: row.id,
      type: row.type,
      version: row.version,
      source: row.source,
      timestamp: row.timestamp,
      payload: row.payload
    };
  }
  async #writeBatch(rows) {
    const { error } = await this.client.from(this.tableName).insert(rows);
    if (error) {
      throw new Error(`SupabaseEventStore batch insert failed: ${error.message}`);
    }
  }
};

// src/memory/store/supabaseMemoryStore.js
var DEFAULT_TABLE2 = "x1_memory_records";
var SupabaseMemoryStore = class {
  /**
   * @param {object} deps
   * @param {import('@supabase/supabase-js').SupabaseClient} deps.supabaseClient - injected, never constructed internally
   * @param {ReturnType<typeof import('../../kernel/logger.js').createLogger>} [deps.logger]
   * @param {string} [deps.tableName]
   * @param {object} [deps.coordinatorOptions] - passed through to PersistenceCoordinator, unmodified
   */
  constructor({ supabaseClient, logger, tableName = DEFAULT_TABLE2, coordinatorOptions = {} }) {
    if (!supabaseClient) {
      throw new Error("SupabaseMemoryStore requires an injected supabaseClient");
    }
    this.client = supabaseClient;
    this.tableName = tableName;
    this.logger = logger ?? null;
    this.coordinator = new PersistenceCoordinator({
      flush: (batch) => this.#writeBatch(batch),
      logger: this.logger,
      ...coordinatorOptions
    });
    this.coordinator.start();
  }
  /**
   * Satisfies the MemoryStore port. Enqueues for batched writing —
   * never blocks on the real Supabase call. `record` is stored exactly
   * as given, opaque JSON — this file never inspects its shape.
   */
  async append(collection, record) {
    await this.coordinator.enqueue({ collection, record });
  }
  /**
   * Satisfies the MemoryStore port. A direct, awaited Supabase read —
   * reads aren't batched. Returns records in the order they were
   * recorded; Memory's own analytics.js is responsible for whatever
   * re-sorting or filtering it needs beyond that.
   */
  async queryAll(collection) {
    const { data, error } = await this.client.from(this.tableName).select("record").eq("collection", collection).order("recorded_at", { ascending: true });
    if (error) {
      throw new Error(`SupabaseMemoryStore.queryAll failed for collection "${collection}": ${error.message}`);
    }
    return data.map((row) => row.record);
  }
  /** Not part of the MemoryStore port — for graceful shutdown, same as SupabaseEventStore. */
  async shutdown() {
    await this.coordinator.shutdownFlush();
  }
  /** Diagnostics — records that permanently failed to write after all retries. */
  getDeadLetterQueue() {
    return this.coordinator.getDeadLetterQueue();
  }
  async #writeBatch(items) {
    const rows = items.map(({ collection, record }) => ({ collection, record }));
    const { error } = await this.client.from(this.tableName).insert(rows);
    if (error) {
      throw new Error(`SupabaseMemoryStore batch insert failed: ${error.message}`);
    }
  }
};

// src/portfolio/store/supabasePortfolioStore.js
var DEFAULT_TABLE3 = "x1_positions";
function toRow(position) {
  return {
    position_id: position.positionId,
    symbol: position.symbol,
    asset_class: position.assetClass,
    sector: position.sector ?? null,
    status: position.status ?? "open",
    entry_decision: position.entryDecision,
    entry_price: position.entryPrice,
    entry_index: position.entryIndex,
    breakout_pivot: position.breakoutPivot ?? null,
    entry_composite_score: position.entryCompositeScore,
    entry_market_state_id: position.entryMarketStateId,
    risk_state_at_entry: position.riskStateAtEntry,
    entry_snapshot: position.entrySnapshot ?? {},
    opened_at: position.openedAt
  };
}
function fromRow(row) {
  if (!row) return null;
  return {
    positionId: row.position_id,
    symbol: row.symbol,
    assetClass: row.asset_class,
    sector: row.sector,
    status: row.status,
    entryDecision: row.entry_decision,
    entryPrice: Number(row.entry_price),
    entryIndex: row.entry_index,
    breakoutPivot: row.breakout_pivot !== null ? Number(row.breakout_pivot) : null,
    entryCompositeScore: Number(row.entry_composite_score),
    entryMarketStateId: row.entry_market_state_id,
    riskStateAtEntry: row.risk_state_at_entry,
    entrySnapshot: row.entry_snapshot,
    latestSnapshot: row.latest_snapshot,
    activeStructuralStopPrice: row.active_structural_stop_price !== null ? Number(row.active_structural_stop_price) : null,
    openedAt: row.opened_at,
    lastReviewedAt: row.last_reviewed_at,
    reviewReason: row.review_reason,
    reviewSummary: row.review_summary,
    closeReason: row.close_reason,
    failureTrigger: row.failure_trigger,
    exitPrice: row.exit_price !== null ? Number(row.exit_price) : null,
    closedAt: row.closed_at,
    rMultiple: row.r_multiple !== null ? Number(row.r_multiple) : null,
    notes: row.notes
  };
}
var SupabasePortfolioStore = class {
  /**
   * @param {object} deps
   * @param {import('@supabase/supabase-js').SupabaseClient} deps.supabaseClient - injected, never constructed internally
   * @param {ReturnType<typeof import('../../kernel/logger.js').createLogger>} [deps.logger]
   * @param {string} [deps.tableName]
   */
  constructor({ supabaseClient, logger, tableName = DEFAULT_TABLE3 }) {
    if (!supabaseClient) {
      throw new Error("SupabasePortfolioStore requires an injected supabaseClient");
    }
    this.client = supabaseClient;
    this.tableName = tableName;
    this.logger = logger ?? null;
  }
  async createPosition(position) {
    const existing = await this.getOpenPositionBySymbol(position.symbol);
    if (existing) {
      throw new Error(`SupabasePortfolioStore: an open position already exists for symbol "${position.symbol}" (positionId ${existing.positionId})`);
    }
    const { error } = await this.client.from(this.tableName).insert(toRow(position));
    if (error) {
      throw new Error(`SupabasePortfolioStore.createPosition failed for ${position.symbol}: ${error.message}`);
    }
  }
  async getOpenPositionBySymbol(symbol) {
    const { data, error } = await this.client.from(this.tableName).select("*").eq("symbol", symbol).eq("status", "open").limit(1);
    if (error) {
      throw new Error(`SupabasePortfolioStore.getOpenPositionBySymbol failed for ${symbol}: ${error.message}`);
    }
    return data && data.length > 0 ? fromRow(data[0]) : null;
  }
  async listOpenPositions(assetClass = null) {
    let query = this.client.from(this.tableName).select("*").eq("status", "open");
    if (assetClass) {
      query = query.eq("asset_class", assetClass);
    }
    const { data, error } = await query;
    if (error) {
      throw new Error(`SupabasePortfolioStore.listOpenPositions failed: ${error.message}`);
    }
    return (data ?? []).map(fromRow);
  }
  async updatePositionReview(positionId, review) {
    const patch = {
      last_reviewed_at: review.lastReviewedAt,
      latest_snapshot: review.latestSnapshot ?? null,
      active_structural_stop_price: review.activeStructuralStopPrice ?? null,
      review_reason: review.reviewReason ?? null,
      review_summary: review.reviewSummary ?? null
    };
    const { error } = await this.client.from(this.tableName).update(patch).eq("position_id", positionId);
    if (error) {
      throw new Error(`SupabasePortfolioStore.updatePositionReview failed for ${positionId}: ${error.message}`);
    }
  }
  async closePosition(positionId, closePayload) {
    const patch = {
      status: "closed",
      exit_price: closePayload.exitPrice,
      closed_at: closePayload.closedAt,
      close_reason: closePayload.closeReason ?? null,
      failure_trigger: closePayload.failureTrigger ?? null,
      r_multiple: closePayload.rMultiple ?? null
    };
    const { error } = await this.client.from(this.tableName).update(patch).eq("position_id", positionId);
    if (error) {
      throw new Error(`SupabasePortfolioStore.closePosition failed for ${positionId}: ${error.message}`);
    }
  }
  async getPositionById(positionId) {
    const { data, error } = await this.client.from(this.tableName).select("*").eq("position_id", positionId).limit(1);
    if (error) {
      throw new Error(`SupabasePortfolioStore.getPositionById failed for ${positionId}: ${error.message}`);
    }
    return data && data.length > 0 ? fromRow(data[0]) : null;
  }
};

// src/health/httpServer.js
import http from "node:http";
function createHealthHttpServer(healthService, { logger } = {}) {
  return http.createServer(async (req, res) => {
    if (req.method !== "GET" || req.url !== "/health") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }
    try {
      const report = await healthService.getHealthReport();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(report, null, 2));
    } catch (err) {
      logger?.error("Health endpoint failed to generate a report", { error: err.message });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Failed to generate health report" }));
    }
  });
}

// src/app.js
var appLogger = createLogger("App");
var DEFAULT_PORT = 3e3;
function buildApp() {
  const eventBus = new EventBus({ logger: createLogger("EventBus") });
  const supabaseClient = createSupabaseClient();
  const eventStore = new SupabaseEventStore({ supabaseClient, logger: createLogger("EventStore") });
  const memoryStore = new SupabaseMemoryStore({ supabaseClient, logger: createLogger("MemoryStore") });
  const portfolioStore = new SupabasePortfolioStore({ supabaseClient, logger: createLogger("PortfolioStore") });
  const memory = new MemoryEngine({
    eventBus,
    logger: createLogger("Memory"),
    store: memoryStore
  });
  const observer = new ObserverEngine({
    eventBus,
    logger: createLogger("Observer"),
    scheduler: new Scheduler({ logger: createLogger("Observer:Scheduler") }),
    marketDataPort: liveMarketDataPort,
    observerThresholds: config.observerThresholds,
    scanIntervalSeconds: config.env.cadence.observerScanIntervalSeconds,
    memory
  });
  const radar = new RadarEngine({
    eventBus,
    logger: createLogger("Radar"),
    scheduler: new Scheduler({ logger: createLogger("Radar:Scheduler") }),
    assetClassAdapters: [liveUsStockAssetClassAdapter],
    scanIntervalSeconds: config.env.cadence.radarScanIntervalSeconds,
    memory
  });
  const intel = new IntelEngine({
    eventBus,
    logger: createLogger("Intel"),
    memory,
    scheduler: new Scheduler({ logger: createLogger("Intel:Scheduler") }),
    discoveryPort: liveDiscoveryPort,
    discoveryIntervalSeconds: config.env.cadence.intelDiscoveryIntervalSeconds
  });
  const sniper = new SniperEngine({
    eventBus,
    logger: createLogger("Sniper"),
    technicalDataPort: liveTechnicalDataPort,
    memory
  });
  const judge = new JudgeEngine({
    eventBus,
    logger: createLogger("Judge")
  });
  const portfolio = new PortfolioEngine({
    eventBus,
    logger: createLogger("Portfolio"),
    scheduler: new Scheduler({ logger: createLogger("Portfolio:Scheduler") }),
    portfolioStore,
    technicalDataPort: liveTechnicalDataPort,
    reviewIntervalSeconds: config.env.portfolio.reviewIntervalSeconds
  });
  const database = new DatabaseEngine({
    eventBus,
    logger: createLogger("Database"),
    store: eventStore
  });
  const telegram = new TelegramEngine({
    eventBus,
    logger: createLogger("Telegram"),
    transport: liveTelegramTransport
  });
  const engines = { memory, observer, radar, intel, sniper, judge, portfolio, database, telegram };
  const health = new HealthService({
    eventBus,
    logger: createLogger("Health"),
    engines,
    callBudget
  });
  const healthHttpServer = createHealthHttpServer(health, { logger: createLogger("HealthHTTP") });
  return {
    eventBus,
    engines: { ...engines, health },
    stores: { eventStore, memoryStore, portfolioStore },
    healthHttpServer
  };
}
async function startApp(app) {
  for (const [name, engine] of Object.entries(app.engines)) {
    await engine.start();
    appLogger.info(`${name} engine online`);
  }
}
async function stopApp(app) {
  const entries = Object.entries(app.engines).reverse();
  for (const [name, engine] of entries) {
    await engine.stop();
    appLogger.info(`${name} engine offline`);
  }
}
if (import.meta.url === `file://${process.argv[1]}`) {
  let app;
  const shutdown = async (signal) => {
    appLogger.info(`Received ${signal} \u2014 shutting down gracefully`);
    try {
      if (app) {
        await stopApp(app);
        await Promise.all([
          app.stores.eventStore.shutdown(),
          app.stores.memoryStore.shutdown()
        ]);
        await new Promise((resolve) => app.healthHttpServer.close(resolve));
      }
      process.exit(0);
    } catch (err) {
      appLogger.error("Error during shutdown", { error: err.message });
      process.exit(1);
    }
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("uncaughtException", (err) => {
    appLogger.error("Uncaught exception \u2014 exiting", { error: err.message, stack: err.stack });
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    appLogger.error("Unhandled promise rejection \u2014 exiting", { reason: reason instanceof Error ? reason.message : String(reason) });
    process.exit(1);
  });
  try {
    app = buildApp();
    await startApp(app);
    const port = parseInt(process.env.PORT, 10) || DEFAULT_PORT;
    await new Promise((resolve) => app.healthHttpServer.listen(port, "0.0.0.0", resolve));
    appLogger.info(`Health endpoint listening on port ${port}`);
    appLogger.info("SNIPER X1 fully online", { build: config.build });
  } catch (err) {
    console.error("=== SNIPER X1 STARTUP FAILURE ===");
    console.error("Error message:", err && err.message);
    console.error("Error name:", err && err.name);
    console.error("Full stack:");
    console.error(err && err.stack);
    console.error("=== END STARTUP FAILURE ===");
    appLogger.error("Failed to start SNIPER X1", { error: err?.message, stack: err?.stack });
    process.exit(1);
  }
}
export {
  buildApp,
  startApp,
  stopApp
};
