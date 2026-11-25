// Publishes due reels from schedule.json to Instagram (Instagram API with Instagram Login).
// Env: IG_TOKEN (secret), BASE_URL (public base of this repo's files), DRY_RUN=1 to only check.
import fs from "node:fs";

const API = "https://graph.instagram.com/v23.0";
const TOKEN = process.env.IG_TOKEN;
const BASE = (process.env.BASE_URL || "").replace(/\/$/, "");
const DRY = process.env.DRY_RUN === "1";
const MAX_PER_RUN = 1;
const MAX_LATE_HOURS = 12; // never post something scheduled more than this long ago

const schedule = JSON.parse(fs.readFileSync("schedule.json", "utf8"));
const stateFile = "state/published.json";
fs.mkdirSync("state", { recursive: true });
const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, "utf8")) : {};
const save = () => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(method, path, params = {}) {
  const url = new URL(API + path);
  const body = new URLSearchParams({ ...params, access_token: TOKEN });
  const res = method === "GET"
    ? await fetch(url + "?" + body)
    : await fetch(url, { method, body });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`${method} ${path} -> ${res.status} ${JSON.stringify(json.error || json)}`);
  return json;
}

async function check(item) {
  for (const f of [item.video, item.cover]) {
    const r = await fetch(`${BASE}/${f}`, { method: "HEAD" });
    console.log(`  ${f}: HTTP ${r.status} ${r.headers.get("content-type")} ${r.headers.get("content-length")}`);
    if (!r.ok) throw new Error(`not reachable: ${BASE}/${f}`);
  }
}

async function publish(item) {
  const c = await call("POST", "/me/media", {
    media_type: "REELS",
    video_url: `${BASE}/${item.video}`,
    cover_url: `${BASE}/${item.cover}`,
    caption: item.caption,
    share_to_feed: "true",
  });
  for (let i = 0; i < 40; i++) {
    const s = await call("GET", `/${c.id}`, { fields: "status_code,status" });
    console.log(`  container ${c.id}: ${s.status_code}`);
    if (s.status_code === "FINISHED") break;
    if (s.status_code === "ERROR" || s.status_code === "EXPIRED") throw new Error(`container ${s.status_code}: ${s.status}`);
    await sleep(15000);
  }
  const p = await call("POST", "/me/media_publish", { creation_id: c.id });
  return p.id;
}

const now = Date.now();
const due = schedule
  .filter((i) => !state[i.part] && Date.parse(i.at) <= now)
  .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));

console.log(`now=${new Date(now).toISOString()} due=${due.map((i) => "P" + i.part).join(",") || "none"} dry=${DRY}`);

if (DRY) {
  for (const i of schedule) { console.log(`Part ${i.part} @ ${i.at}`); await check(i); }
  if (TOKEN) console.log("token check:", JSON.stringify(await call("GET", "/me", { fields: "user_id,username,account_type" })));
  process.exit(0);
}

let done = 0;
for (const item of due) {
  if (done >= MAX_PER_RUN) break;
  if (now - Date.parse(item.at) > MAX_LATE_HOURS * 3600e3) {
    console.log(`Part ${item.part} is over ${MAX_LATE_HOURS}h late; skipping (edit schedule.json to reschedule).`);
    continue;
  }
  console.log(`Publishing Part ${item.part}`);
  const id = await publish(item);
  state[item.part] = { media_id: id, published_at: new Date().toISOString() };
  save();
  console.log(`Published Part ${item.part}: media ${id}`);
  done++;
}
