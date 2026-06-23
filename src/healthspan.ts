import { Context } from "hono";

const DAY = 86400;

export async function getHealthspan(c: Context) {
  const db: D1Database = c.env.DB;
  const userId = c.get("userId");

  const latest = await db
    .prepare(
      "SELECT * FROM healthspan WHERE user_id = ? ORDER BY date DESC LIMIT 1"
    )
    .bind(userId)
    .first<any>();

  if (!latest) {
    // Check if user exists and why it might be locked
    const user = await db
      .prepare("SELECT age FROM users WHERE id = ?")
      .bind(userId)
      .first<{ age: number | null }>();

    return c.json({
      locked: true,
      reason: user?.age && user.age < 18 ? "under_18" : "still_calibrating",
      fitness_age: null,
      pace_of_aging: null,
    });
  }

  // Parse contributors JSON
  if (latest.contributors) {
    latest.contributors = JSON.parse(latest.contributors);
  }

  return c.json(latest);
}

export async function getHealthspanTrend(c: Context) {
  const db: D1Database = c.env.DB;
  const userId = c.get("userId");
  const { results } = await db
    .prepare(
      "SELECT date, fitness_age, pace_of_aging FROM healthspan WHERE user_id = ? ORDER BY date ASC LIMIT 90"
    )
    .bind(userId)
    .all<any>();

  return c.json(results);
}

export async function runHealthspanUpdate(env: { DB: D1Database }) {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);
  const dateStr = new Date(now * 1000).toISOString().slice(0, 10);

  // Get all users
  const { results: users } = await db
    .prepare("SELECT id, age, created_at FROM users")
    .all<{ id: string; age: number | null; created_at: number }>();

  for (const user of users) {
    try {
      await updateHealthspanForUser(db, user, dateStr, now);
    } catch (e) {
      console.error(`Healthspan update failed for user ${user.id}`, e);
    }
  }
}

async function updateHealthspanForUser(
  db: D1Database,
  user: { id: string; age: number | null; created_at: number },
  date: string,
  nowTs: number
) {
  const userId = user.id;

  // 1. Eligibility Check
  const age = user.age ?? 0;
  if (age < 18) {
    return; // Feature locked for under 18
  }

  // Count recoveries in last 7 days (Requirement: 5/7)
  const weekAgo = new Date(nowTs * 1000 - 7 * DAY * 1000)
    .toISOString()
    .slice(0, 10);
  const { count: recoveryCount } = (await db
    .prepare(
      "SELECT COUNT(*) as count FROM daily WHERE user_id = ? AND date >= ? AND recovery IS NOT NULL"
    )
    .bind(userId, weekAgo)
    .first<{ count: number }>()) ?? { count: 0 };

  const locked = recoveryCount < 5 ? 1 : 0;
  if (locked) {
    // Optional: write a 'locked' record if not exists or update
    await db
      .prepare(
        "INSERT INTO healthspan (user_id, date, locked, updated_at) VALUES (?,?,?,?) " +
          "ON CONFLICT(user_id, date) DO UPDATE SET locked=excluded.locked, updated_at=excluded.updated_at"
      )
      .bind(userId, date, 1, nowTs)
      .run();
    return;
  }

  // 2. Gather Contributors (Last 6 Months)
  const sixMonthsAgo = new Date(nowTs * 1000 - 180 * DAY * 1000)
    .toISOString()
    .slice(0, 10);
  const dailyData = await db
    .prepare(
      "SELECT date, strain, resting_hr, steps, vo2max, wear_min FROM daily WHERE user_id = ? AND date >= ? ORDER BY date DESC"
    )
    .bind(userId, sixMonthsAgo)
    .all<any>();

  const sleepData = await db
    .prepare(
      "SELECT date, duration_min, regularity FROM sleep WHERE user_id = ? AND date >= ? ORDER BY date DESC"
    )
    .bind(userId, sixMonthsAgo)
    .all<any>();

  // 3. Simple fitness Age Modeling (Simplified heuristics for demo)
  // In a real scenario, this would use a complex regression model from openstrap-analytics
  // Here we'll implement a reasonable proxy based on the brief.
  
  const avgRhr = average(dailyData.results.map((d: any) => d.resting_hr).filter(Boolean));
  const avgSteps = average(dailyData.results.map((d: any) => d.steps).filter(Boolean));
  const avgVo2 = average(dailyData.results.map((d: any) => d.vo2max).filter(Boolean));
  const avgSleep = average(sleepData.results.map((s: any) => s.duration_min).filter(Boolean));
  const avgConsistency = average(sleepData.results.map((s: any) => s.regularity).filter(Boolean));

  // Base fitness age starts at chronological age
  let fitnessAge = age;

  const contributors: any = {
    sleep: { score: avgSleep, impact: 0 },
    strain: { score: avgSteps, impact: 0 },
    fitness: { score: avgVo2, impact: 0 },
  };

  // Adjustments (Heuristics)
  // RHR: -1 year for every 5 bpm below 60
  if (avgRhr) {
    const rhrDiff = (60 - avgRhr) / 5;
    fitnessAge -= rhrDiff;
    contributors.fitness.impact += rhrDiff > 0 ? 1 : -1;
  }

  // VO2Max: -1 year for every 5 points above 40
  if (avgVo2) {
    const vo2Diff = (avgVo2 - 40) / 5;
    fitnessAge -= vo2Diff;
    contributors.fitness.impact += vo2Diff > 0 ? 1 : -1;
  }

  // Steps: -1 year for every 2000 steps above 8000
  if (avgSteps) {
    const stepDiff = (avgSteps - 8000) / 2000;
    fitnessAge -= stepDiff;
    contributors.strain.impact += stepDiff > 0 ? 1 : -1;
  }

  // Sleep: -1 year for every hour above 7 (capped at 9)
  if (avgSleep) {
    const sleepHourDiff = (avgSleep / 60 - 7);
    const clampedSleepDiff = Math.max(-1, Math.min(2, sleepHourDiff));
    fitnessAge -= clampedSleepDiff;
    contributors.sleep.impact += clampedSleepDiff > 0 ? 1 : -1;
  }

  // 4. Pace of Aging (30-day Trend)
  // Compare fitness age now vs 30 days ago
  const thirtyDaysAgo = new Date(nowTs * 1000 - 30 * DAY * 1000)
    .toISOString()
    .slice(0, 10);
  const prevHealth = await db
    .prepare(
      "SELECT fitness_age FROM healthspan WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1"
    )
    .bind(userId, thirtyDaysAgo)
    .first<{ fitness_age: number | null }>();

  let paceOfAging = 1.0; // Default: aging at the rate of time
  if (prevHealth?.fitness_age) {
    const ageDiff = fitnessAge - prevHealth.fitness_age;
    // If fitness age increased by 0.1 years over 30 days (0.08 years of time), pace is > 1
    // Simplification:
    paceOfAging = 1.0 + (ageDiff * 10); // Heuristic: 0.1 age increase in a month -> 2.0x pace
  }
  
  paceOfAging = Math.max(-2.0, Math.min(4.0, paceOfAging)); // Clamp

  const isCalibrating = (nowTs - user.created_at) < (90 * DAY) ? 1 : 0;

  await db
    .prepare(
      "INSERT INTO healthspan (user_id, date, fitness_age, chronological_age, pace_of_aging, contributors, is_calibrating, locked, updated_at) " +
        "VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id, date) DO UPDATE SET " +
        "fitness_age=excluded.fitness_age, pace_of_aging=excluded.pace_of_aging, contributors=excluded.contributors, " +
        "is_calibrating=excluded.is_calibrating, locked=excluded.locked, updated_at=excluded.updated_at"
    )
    .bind(
      userId,
      date,
      fitnessAge,
      age,
      paceOfAging,
      JSON.stringify(contributors),
      isCalibrating,
      0,
      nowTs
    )
    .run();
}

function average(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}