import { Context } from "hono";

export async function getMetrics(c: any) {
  const db: D1Database = c.env.DB;
  const now = Math.floor(Date.now() / 1000);

  // 1. Get all users to use as a baseline for labels
  const users = await db
    .prepare("SELECT id, email, name FROM users")
    .all<any>();

  let output = "";

  // Global metrics
  output += `openstrap_system_ts ${now}\n`;

  for (const user of users.results) {
    const labels = `user_id="${user.id}",email="${user.email}",name="${user.name || ""}"`;

    // --- Daily Metrics ---
    const latestDaily = (await db
      .prepare(
        "SELECT * FROM daily WHERE user_id = ? ORDER BY date DESC LIMIT 1",
      )
      .bind(user.id)
      .first()) as any;

    if (latestDaily) {
      const dateLabel = `date="${latestDaily.date}"`;
      const dailyLabels = `${labels},${dateLabel}`;
      output += exportObjectMetrics(
        "openstrap_daily",
        latestDaily,
        dailyLabels,
      );
    }

    // --- Sleep Metrics ---
    const latestSleep = (await db
      .prepare(
        "SELECT * FROM sleep WHERE user_id = ? ORDER BY date DESC LIMIT 1",
      )
      .bind(user.id)
      .first()) as any;

    if (latestSleep) {
      const dateLabel = `date="${latestSleep.date}"`;
      const sleepLabels = `${labels},${dateLabel}`;
      output += exportObjectMetrics(
        "openstrap_sleep",
        latestSleep,
        sleepLabels,
      );
    }

    // --- Session Metrics (latest) ---
    const latestSession = (await db
      .prepare(
        "SELECT * FROM sessions WHERE user_id = ? ORDER BY start_ts DESC LIMIT 1",
      )
      .bind(user.id)
      .first()) as any;

    if (latestSession) {
      const sessionLabels = `${labels},session_id="${latestSession.id}",type="${latestSession.type || "unknown"}"`;
      output += exportObjectMetrics(
        "openstrap_session",
        latestSession,
        sessionLabels,
      );
    }

    // --- Baseline Metrics ---
    const baseline = (await db
      .prepare("SELECT * FROM baselines WHERE user_id = ?")
      .bind(user.id)
      .first()) as any;

    if (baseline) {
      output += exportObjectMetrics("openstrap_baseline", baseline, labels);
    }

    // --- User Profile Metrics ---
    const profile = (await db
      .prepare(
        "SELECT age, height_cm, weight_kg, step_goal, track_cycle FROM users WHERE id = ?",
      )
      .bind(user.id)
      .first()) as any;

    if (profile) {
      output += exportObjectMetrics("openstrap_user", profile, labels);
    }

    // --- Healthspan Metrics ---
    const latestHealthspan = (await db
      .prepare(
        "SELECT * FROM healthspan WHERE user_id = ? ORDER BY date DESC LIMIT 1",
      )
      .bind(user.id)
      .first()) as any;

    if (latestHealthspan) {
      const dateLabel = `date="${latestHealthspan.date}"`;
      const healthLabels = `${labels},${dateLabel}`;
      output += exportObjectMetrics(
        "openstrap_healthspan",
        latestHealthspan,
        healthLabels,
      );
    }

    // --- Diagnostic Metrics ---
    const cursor = (await db
      .prepare("SELECT * FROM analytics_cursor WHERE user_id = ?")
      .bind(user.id)
      .first()) as any;

    if (cursor) {
      if (cursor.last_run) {
        output += `openstrap_last_analytics_run_ts{${labels}} ${cursor.last_run}\n`;
      }
      if (cursor.last_min_ts) {
        output += `openstrap_last_ingest_ts{${labels}} ${cursor.last_min_ts}\n`;
      }
      if (cursor.battery_pct !== null && cursor.battery_pct !== undefined) {
        output += `openstrap_battery_pct{${labels}} ${cursor.battery_pct}\n`;
      }
      if (cursor.is_charging !== null && cursor.is_charging !== undefined) {
        output += `openstrap_is_charging{${labels}} ${cursor.is_charging}\n`;
      }
      if (cursor.phase_since) {
        output += `openstrap_phase_since_ts{${labels}} ${cursor.phase_since}\n`;
      }
      if (cursor.dirty !== null && cursor.dirty !== undefined) {
        output += `openstrap_dirty{${labels}} ${cursor.dirty}\n`;
      }
      if (cursor.sleep_phase) {
        const phaseVal =
          cursor.sleep_phase === "awake" ? 1 : cursor.sleep_phase === "asleep" ? 2 : 0;
        output += `openstrap_sleep_phase{${labels},phase="${cursor.sleep_phase}"} ${phaseVal}\n`;
      }
    }

    const eventStats = (await db
      .prepare(
        "SELECT MAX(ts) as max_device_ts, MAX(ingested_at) as max_ingested_ts FROM events WHERE user_id = ?",
      )
      .bind(user.id)
      .first()) as any;

    if (eventStats) {
      if (eventStats.max_ingested_ts) {
        output += `openstrap_last_event_ts{${labels}} ${eventStats.max_ingested_ts}\n`;
      }
      if (eventStats.max_device_ts) {
        output += `openstrap_last_event_device_ts{${labels}} ${eventStats.max_device_ts}\n`;
      }
    }

    const events30s = (await db
      .prepare(
        "SELECT COUNT(*) as count FROM events WHERE user_id = ? AND ingested_at > ?",
      )
      .bind(user.id, now - 30)
      .first()) as any;

    if (events30s) {
      output += `openstrap_events_ingested_30s{${labels}} ${events30s.count}\n`;
    }

    const events60s = (await db
      .prepare(
        "SELECT COUNT(*) as count FROM events WHERE user_id = ? AND ingested_at > ?",
      )
      .bind(user.id, now - 60)
      .first()) as any;

    if (events60s) {
      output += `openstrap_events_ingested_60s{${labels}} ${events60s.count}\n`;
    }
  }

  return c.text(output, 200, { "Content-Type": "text/plain; version=0.0.4" });
}

/**
 * Iterates through an object's keys, flattening JSON and exporting numeric values as Prometheus gauges.
 */
function exportObjectMetrics(
  prefix: string,
  obj: Record<string, any>,
  labels: string,
): string {
  let lines = "";

  for (const [key, value] of Object.entries(obj)) {
    // Skip internal fields and large arrays
    if (
      [
        "user_id",
        "id",
        "date",
        "ts",
        "start_ts",
        "end_ts",
        "onset_ts",
        "wake_ts",
        "token_hash",
        "code_hash",
        "hex",
        "email",
        "name",
        "tags",
        "note",
        "drivers",
        "strain_curve",
        "segments",
        "flags",
      ].includes(key)
    ) {
      continue;
    }

    if (typeof value === "number") {
      lines += `${prefix}_${key}{${labels}} ${value}\n`;
    } else if (typeof value === "string" && value.startsWith("{")) {
      // Try to parse as JSON
      try {
        const parsed = JSON.parse(value);
        lines += flattenToMetrics(`${prefix}_${key}`, parsed, labels);
      } catch (e) {
        // Not JSON or failed to parse, skip
      }
    }
  }

  return lines;
}

function flattenToMetrics(prefix: string, obj: any, labels: string): string {
  let lines = "";
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";

  for (const [key, value] of Object.entries(obj)) {
    const currentPath = `${prefix}_${key}`;
    if (typeof value === "number") {
      lines += `${currentPath}{${labels}} ${value}\n`;
    } else if (
      typeof value === "object" &&
      value !== null &&
      !Array.isArray(value)
    ) {
      lines += flattenToMetrics(currentPath, value, labels);
    }
  }
  return lines;
}
