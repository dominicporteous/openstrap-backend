// biometrics.ts — HRV + relative skin-temp + relative SpO₂, re-decoded from the
// raw V24 records already in R2. These fields ride in every 1 Hz historical record
// (rr intervals @18/19, raw red ADC @64, raw temp ADC @68) — validated on 127,971
// of our own records (RR 99.7% physiological; |g|≈1.012). No new capture needed.
//
// HRV is the real one: RMSSD over artifact-filtered beat-to-beat intervals during
// the resting/sleep window — the same substrate WHOOP builds recovery on. SpO₂ and
// skin temp are RAW ADCs (the band never sends a finished %/°C), so we only ever
// express them as a deviation from the user's own baseline — relative, never absolute.

import { parse_r24 } from 'openstrap-protocol/ts/records'

const DAY = 86400

interface BioEnv { DB: D1Database; RAW_BUCKET: R2Bucket }

const hexToBytes = (hex: string): Uint8Array => {
  const clean = hex.trim()
  const m = clean.match(/.{1,2}/g)
  if (!m) return new Uint8Array(0)
  return new Uint8Array(m.map((b) => parseInt(b, 16)))
}

const median = (a: number[]): number => {
  if (!a.length) return 0
  const s = [...a].sort((x, y) => x - y)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}

// One decoded V24 record's biometrics, or null if it isn't a usable V24.
interface BioSample { ts: number; hr: number; rr: number[]; temp: number; spo2: number }
function decodeV24(hex: string): BioSample | null {
  const b = hexToBytes(hex)
  if (b.length < 89 || b[0] !== 0x2f || b[1] !== 24) return null
  const r = parse_r24(b)
  if (!r || !(r.ts_epoch > 0)) return null
  return {
    ts: r.ts_epoch,
    hr: r.hr,
    rr: r.rr_intervals_ms.filter((x) => x >= 300 && x <= 2000), // physiological
    temp: r.skin_temp_raw,
    spo2: r.spo2_red_raw,
  }
}

/**
 * RMSSD (ms) over a time-ordered RR stream, with successive-difference artifact
 * rejection (drop jumps > 200 ms — ectopics / missed beats). The standard
 * short-term HRV index; what nocturnal recovery is built on.
 */
export function rmssd(samples: BioSample[]): { rmssd: number | null; nBeats: number } {
  const seq: number[] = []
  for (const s of [...samples].sort((a, b) => a.ts - b.ts)) for (const x of s.rr) seq.push(x)
  if (seq.length < 30) return { rmssd: null, nBeats: seq.length }
  let sumSq = 0, n = 0
  for (let i = 1; i < seq.length; i++) {
    const d = seq[i] - seq[i - 1]
    if (Math.abs(d) <= 200) { sumSq += d * d; n++ }
  }
  if (n < 20) return { rmssd: null, nBeats: seq.length }
  return { rmssd: Math.round(Math.sqrt(sumSq / n) * 10) / 10, nBeats: seq.length }
}

async function rawKeysInWindow(bucket: R2Bucket, userId: string, from: number, to: number): Promise<string[]> {
  const out: string[] = []
  let cursor: string | undefined
  do {
    const listing = await bucket.list({ prefix: `raw/${userId}/`, cursor, limit: 1000 })
    for (const o of listing.objects) {
      const m = o.key.match(/-(\d+)-(\d+)\.txt$/)
      if (!m) { out.push(o.key); continue }
      const minTs = parseInt(m[1]), maxTs = parseInt(m[2])
      if (maxTs >= from && minTs <= to) out.push(o.key)
    }
    cursor = listing.truncated ? listing.cursor : undefined
  } while (cursor)
  return out
}

// Read + decode resting V24 records in [from,to]. "Resting" = HR in a calm band
// so HRV reflects parasympathetic tone, not exercise. Bounded to `maxObjects`
// most-recent objects — a Worker request has a tight CPU/subrequest budget, and
// each object holds ~50–90 records, so ~20 objects ≈ a few hundred beats, which
// is more than enough for a stable RMSSD.
async function restingSamples(env: BioEnv, userId: string, from: number, to: number, maxObjects: number): Promise<BioSample[]> {
  const keys = await rawKeysInWindow(env.RAW_BUCKET, userId, from, to)
  // Newest first by the maxTs embedded in the key (…-<minTs>-<maxTs>.txt).
  const keyTs = (k: string) => { const m = k.match(/-(\d+)\.txt$/); return m ? parseInt(m[1]) : 0 }
  keys.sort((a, b) => keyTs(b) - keyTs(a))
  const out: BioSample[] = []
  for (const key of keys.slice(0, maxObjects)) {
    const obj = await env.RAW_BUCKET.get(key)
    if (!obj) continue
    const text = await obj.text()
    for (const line of text.split('\n')) {
      const s = decodeV24(line)
      if (s && s.ts >= from && s.ts <= to && s.hr > 0 && s.hr <= 70) out.push(s)
    }
  }
  return out
}

interface NightBio { date: string; rmssd: number | null; nBeats: number; temp: number | null; spo2: number | null }

async function computeDay(env: BioEnv, userId: string, date: string, from: number, to: number, maxObjects: number): Promise<NightBio> {
  const samples = await restingSamples(env, userId, from, to, maxObjects)
  const { rmssd: hrv, nBeats } = rmssd(samples)
  const temps = samples.map((s) => s.temp).filter((t) => t > 0)
  const spo2s = samples.map((s) => s.spo2).filter((s) => s > 0)
  return {
    date,
    rmssd: hrv,
    nBeats,
    temp: temps.length ? median(temps) : null,
    spo2: spo2s.length ? median(spo2s) : null,
  }
}

/**
 * runBiometrics — for the last `days` days, re-decode resting V24 from R2 and
 * compute nightly HRV (RMSSD), plus median raw skin-temp / red-ADC. Writes
 * daily.hrv_rmssd/hrv_conf and the relative indices (night value − personal
 * baseline). Refreshes the HRV/temp/spo2 baselines (rolling medians). Heavy (R2
 * reads) → nightly cron / admin only, never inline ingest.
 */
export async function runBiometrics(env: BioEnv, userId: string, days = 3): Promise<{ days: number; computed: number }> {
  const now = Math.floor(Date.now() / 1000)
  const today = new Date(now * 1000).toISOString().slice(0, 10)

  // Prefer real sleep windows; fall back to the calendar day so we still produce
  // a number on nights sleep detection missed.
  const since = new Date((now - days * DAY) * 1000).toISOString().slice(0, 10)
  const { results: sleeps } = await env.DB.prepare(
    'SELECT date, onset_ts, wake_ts FROM sleep WHERE user_id = ? AND date >= ? AND onset_ts IS NOT NULL AND wake_ts IS NOT NULL',
  ).bind(userId, since).all<{ date: string; onset_ts: number; wake_ts: number }>()
  const sleepByDate = new Map((sleeps ?? []).map((s) => [s.date, s]))

  // Per-request work budget: each R2 object holds ~50–90 records, so a small
  // number of recent objects per day is plenty for RMSSD while staying inside the
  // Worker CPU/subrequest limit. Newest day first; older days skip once spent.
  const PER_DAY = 12
  const TOTAL_OBJECTS = 24
  let spent = 0
  const out: NightBio[] = []
  for (let d = 0; d < days; d++) {
    const dayStart = Math.floor((now - d * DAY) / DAY) * DAY
    const date = new Date(dayStart * 1000).toISOString().slice(0, 10)
    const budget = Math.min(PER_DAY, TOTAL_OBJECTS - spent)
    if (budget <= 0) { out.push({ date, rmssd: null, nBeats: 0, temp: null, spo2: null }); continue }
    const sl = sleepByDate.get(date)
    const from = sl ? sl.onset_ts : dayStart
    const to = sl ? sl.wake_ts + 60 : dayStart + DAY
    out.push(await computeDay(env, userId, date, from, to, budget))
    spent += budget
  }

  // Baselines: rolling medians over what we just computed + whatever's stored.
  const hrvs = out.map((o) => o.rmssd).filter((x): x is number => x != null)
  const temps = out.map((o) => o.temp).filter((x): x is number => x != null)
  const spo2s = out.map((o) => o.spo2).filter((x): x is number => x != null)
  const blHrv = hrvs.length ? median(hrvs) : null
  const blTemp = temps.length ? median(temps) : null
  const blSpo2 = spo2s.length ? median(spo2s) : null
  if (blHrv != null || blTemp != null || blSpo2 != null) {
    await env.DB.prepare(
      'UPDATE baselines SET hrv_rmssd = COALESCE(?, hrv_rmssd), skin_temp_raw = COALESCE(?, skin_temp_raw), spo2_raw = COALESCE(?, spo2_raw) WHERE user_id = ?',
    ).bind(blHrv, blTemp, blSpo2, userId).run()
  }

  let computed = 0
  for (const o of out) {
    // confidence from beat count: ~500 beats (a few hours of resting RR) → full.
    const conf = o.rmssd == null ? 0 : Math.round(Math.min(1, o.nBeats / 500) * 1000) / 1000
    const tempIdx = (o.temp != null && blTemp != null) ? Math.round((o.temp - blTemp) * 10) / 10 : null
    const spo2Idx = (o.spo2 != null && blSpo2 != null) ? Math.round((o.spo2 - blSpo2) * 10) / 10 : null
    // Ensure a daily row exists, then patch the biometric columns.
    await env.DB.prepare('INSERT OR IGNORE INTO daily(user_id, date) VALUES(?, ?)').bind(userId, o.date).run()
    await env.DB.prepare(
      'UPDATE daily SET hrv_rmssd = ?, hrv_conf = ?, skin_temp_idx = ?, spo2_idx = ?, updated_at = ? WHERE user_id = ? AND date = ?',
    ).bind(o.rmssd, conf, tempIdx, spo2Idx, now, userId, o.date).run()
    if (o.rmssd != null) computed++
  }
  return { days, computed }
}
