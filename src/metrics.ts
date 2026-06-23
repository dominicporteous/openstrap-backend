import { Context } from "hono";

export async function getMetrics(c: any) {
  const db: D1Database = c.env.DB;

  // 1. Get all users to use as a baseline for labels
  const users = await db
    .prepare("SELECT id, email, name FROM users")
    .all<any>();

  let output = "";

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
