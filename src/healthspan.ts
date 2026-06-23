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
    .prepare("SELECT id, age, sex, created_at FROM users")
    .all<{ id: string; age: number | null; sex: string | null; created_at: number }>();

  for (const user of users) {
    try {
      await updateHealthspanForUser(db, user, dateStr, now);
    } catch (e) {
      console.error(`Healthspan update failed for user ${user.id}`, e);
    }
  }
}

// ACSM VO2 Max Percentiles (Median values for each age group)
const VO2_PERCENTILES: any = {
  m: [
    { age: 25, vo2: 44.5 },
    { age: 35, vo2: 42.5 },
    { age: 45, vo2: 41.0 },
    { age: 55, vo2: 38.0 },
    { age: 65, vo2: 34.5 },
    { age: 75, vo2: 31.0 },
  ],
  f: [
    { age: 25, vo2: 37.5 },
    { age: 35, vo2: 35.5 },
    { age: 45, vo2: 33.5 },
    { age: 55, vo2: 30.5 },
    { age: 65, vo2: 27.5 },
    { age: 75, vo2: 24.5 },
  ],
};

export async function updateHealthspanForUser(
  db: D1Database,
  user: { id: string; age: number | null; sex: string | null; created_at: number },
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
      "SELECT date, strain, resting_hr, steps, vo2max, wear_min, hr_zones, nocturnal_dip_pct FROM daily WHERE user_id = ? AND date >= ? ORDER BY date DESC"
    )
    .bind(userId, sixMonthsAgo)
    .all<any>();

  const sleepData = await db
    .prepare(
      "SELECT date, duration_min, regularity FROM sleep WHERE user_id = ? AND date >= ? ORDER BY date DESC"
    )
    .bind(userId, sixMonthsAgo)
    .all<any>();

  // 3. Multi-Pillar Scientific Weighted Model
  const avgRhr = average(dailyData.results.map((d: any) => d.resting_hr).filter(Boolean));
  const avgSteps = average(dailyData.results.map((d: any) => d.steps).filter(Boolean));
  const avgVo2 = average(dailyData.results.map((d: any) => d.vo2max).filter(Boolean));
  const avgDip = average(dailyData.results.map((d: any) => d.nocturnal_dip_pct).filter(Boolean));
  const avgSleep = average(sleepData.results.map((s: any) => s.duration_min).filter(Boolean));
  const avgConsistency = average(sleepData.results.map((s: any) => s.regularity).filter(Boolean));

  // Time in Zones 1-3 (Weekly avg)
  const weeklyModerateActivity = dailyData.results
    .slice(0, 7)
    .reduce((sum: number, d: any) => {
      try {
        const zones = JSON.parse(d.hr_zones || "{}");
        return sum + (zones.zone1_min || 0) + (zones.zone2_min || 0) + (zones.zone3_min || 0);
      } catch { return sum; }
    }, 0);

  // Pillar 1: Aerobic Power (40% Weight) - VO2 Max Percentile Mapping
  let aerobicAge = age;
  if (avgVo2) {
    const table = VO2_PERCENTILES[user.sex === 'f' ? 'f' : 'm'];
    // Find where the user's VO2 sits in the chronological mapping
    let bestFitIdx = 0;
    while (bestFitIdx < table.length && avgVo2 < table[bestFitIdx].vo2) {
      bestFitIdx++;
    }
    if (bestFitIdx === 0) {
      aerobicAge = 20; // Exceptionally high VO2
    } else if (bestFitIdx >= table.length) {
      aerobicAge = 80; // Very low VO2
    } else {
      // Linear interpolation between brackets
      const top = table[bestFitIdx - 1];
      const bot = table[bestFitIdx];
      const ratio = (avgVo2 - bot.vo2) / (top.vo2 - bot.vo2);
      aerobicAge = bot.age - ratio * (bot.age - top.age);
    }
  }

  // Pillar 2: Autonomic Health (20% Weight) - RHR and Dip
  let autonomicAgeDelta = 0;
  if (avgRhr) autonomicAgeDelta += (avgRhr - 55) / 5; // Reward < 55, penalty > 55
  if (avgDip) autonomicAgeDelta += (0.15 - avgDip) * 20; // 15% dip is healthy benchmark

  // Pillar 3: Metabolic & Activity (20% Weight)
  let metabolicAgeDelta = 0;
  if (avgSteps) {
    // S-curve: Massive benefit up to 8k, diminishing after 12k
    const stepDiff = Math.min(12000, avgSteps) - 8000;
    metabolicAgeDelta -= (stepDiff / 4000) * 3;
  }
  if (weeklyModerateActivity > 150) {
    metabolicAgeDelta -= 1; // 150 min Zone 1-3 weekly goal bonus
  }

  // Pillar 4: Circadian Health (20% Weight)
  let circadianAgeDelta = 0;
  if (avgConsistency) {
    circadianAgeDelta += (80 - avgConsistency) / 10; // Benchmark consistency at 80
  }
  if (avgSleep < 420) circadianAgeDelta += 1; // Penalty for < 7h avg

  // Final Weighted sum
  const fitnessAge = (aerobicAge * 0.4) + ((age + autonomicAgeDelta) * 0.2) + ((age + metabolicAgeDelta) * 0.2) + ((age + circadianAgeDelta) * 0.2);

  const contributors: any = {
    aerobic_power: { score: Math.round(avgVo2 || 0), age_impact: aerobicAge - age },
    autonomic: { score: Math.round(avgRhr || 0), age_impact: autonomicAgeDelta },
    metabolic: { score: Math.round(avgSteps || 0), age_impact: metabolicAgeDelta },
    circadian: { score: Math.round(avgConsistency || 0), age_impact: circadianAgeDelta },
  };

  // 4. Pace of Aging (Short-term acceleration)
  // Compare 30-day fitness age trend
  const thirtyDaysAgo = new Date(nowTs * 1000 - 30 * DAY * 1000)
    .toISOString()
    .slice(0, 10);
  const prevHealth = await db
    .prepare(
      "SELECT fitness_age FROM healthspan WHERE user_id = ? AND date <= ? ORDER BY date DESC LIMIT 1"
    )
    .bind(userId, thirtyDaysAgo)
    .first<{ fitness_age: number | null }>();

  let paceOfAging = 1.0; 
  if (prevHealth?.fitness_age) {
    const ageDiff = fitnessAge - prevHealth.fitness_age;
    // Normalized to months: 0.1 year shift in 1 month is substantial
    paceOfAging = 1.0 + (ageDiff * 12); 
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