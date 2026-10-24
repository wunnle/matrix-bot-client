/**
 * Linear details for the room sidebar's Issues & PRs section.
 * POST /api/linear { issues: ["BEN-123", …], projects: ["8915c40f6ab7", …] }
 *   → { issues: { "BEN-123": {…} | null }, projects: { "8915c40f6ab7": {…} | null } }
 *
 * Projects are keyed by the 12-hex slugId a project URL ends with. The
 * projects of the requested issues come back too, unasked: the same query
 * already has them. null means Linear has no such issue or project.
 *
 * One GraphQL query per call, whatever the count, and only for what this warm
 * instance hasn't looked up in the last two minutes. Only the fields the
 * sidebar shows leave this file; the key never does.
 *
 * Env: LINEAR_API_KEY (a personal key; read-only is enough).
 * Auth: x-intent-secret header. See _auth.js.
 */
import { authorized } from "./_auth.js";
import { cors } from "./_cors.js";

const KEY = process.env.LINEAR_API_KEY;
const TTL_MS = 2 * 60 * 1000;
const MAX = 50;
const ISSUE_KEY = /^([A-Z][A-Z0-9]{0,9})-(\d{1,6})$/;
const PROJECT_SLUG = /^[0-9a-f]{12}$/;

const PROJECT_FIELDS = "slugId name url progress targetDate state status { name color type } lead { name displayName }";
const ISSUE_FIELDS = `identifier title priority priorityLabel updatedAt
  state { name color type } assignee { name displayName } project { ${PROJECT_FIELDS} }`;

const cache = new Map(); // "issue:BEN-1" | "project:slug" -> { value, expires }

function cached(key) {
  const hit = cache.get(key);
  if (!hit) return undefined;
  if (hit.expires > Date.now()) return hit;
  cache.delete(key);
  return undefined;
}

function remember(key, value) {
  cache.set(key, { value, expires: Date.now() + TTL_MS });
}

// displayName is the lowercase handle ("sinan"); the full name reads better.
const firstName = (u) => (u ? (u.name || u.displayName)?.split(/[\s@]/)[0] : undefined);

function trimProject(p) {
  const status = p.status ?? { name: p.state, color: undefined, type: p.state };
  return {
    name: p.name,
    url: p.url,
    status: { name: status.name, color: status.color, type: status.type },
    progress: typeof p.progress === "number" ? Math.round(p.progress * 100) : undefined,
    targetDate: p.targetDate ?? undefined,
    lead: firstName(p.lead),
  };
}

function trimIssue(i) {
  return {
    title: i.title,
    state: { name: i.state.name, color: i.state.color, type: i.state.type },
    priority: i.priority || undefined,
    priorityLabel: i.priority ? i.priorityLabel : undefined,
    assignee: firstName(i.assignee),
    project: i.project?.slugId,
    updatedAt: i.updatedAt,
  };
}

async function query(issueKeys, projectSlugs) {
  // Issues by team and number, so one unknown key doesn't fail the query the
  // way an issue(id:) lookup would.
  const byTeam = new Map();
  for (const k of issueKeys) {
    const [, team, num] = ISSUE_KEY.exec(k);
    byTeam.set(team, [...(byTeam.get(team) ?? []), Number(num)]);
  }
  // Inside `or`, sibling fields are not ANDed (Linear drops the number
  // filter and returns the newest 50), so each team's pair is an explicit `and`.
  const issueFilter = {
    or: [...byTeam].map(([team, numbers]) => ({ and: [{ team: { key: { eq: team } } }, { number: { in: numbers } }] })),
  };
  const parts = [];
  const decls = [];
  const variables = {};
  if (issueKeys.length) {
    parts.push(`issues(first: ${MAX}, filter: $issues) { nodes { ${ISSUE_FIELDS} } }`);
    decls.push("$issues: IssueFilter");
    variables.issues = issueFilter;
  }
  if (projectSlugs.length) {
    parts.push(`projects(first: ${MAX}, filter: $projects) { nodes { ${PROJECT_FIELDS} } }`);
    decls.push("$projects: ProjectFilter");
    variables.projects = { slugId: { in: projectSlugs } };
  }
  const r = await fetch("https://api.linear.app/graphql", {
    method: "POST",
    headers: { Authorization: KEY, "Content-Type": "application/json" },
    body: JSON.stringify({ query: `query(${decls.join(", ")}) { ${parts.join(" ")} }`, variables }),
  });
  if (!r.ok) throw new Error(`linear ${r.status}`);
  const body = await r.json();
  if (!body.data) throw new Error(body.errors?.[0]?.message ?? "linear: no data");
  return { issues: body.data.issues?.nodes ?? [], projects: body.data.projects?.nodes ?? [] };
}

function wanted(list, pattern) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((s) => typeof s === "string" && pattern.test(s)))].slice(0, MAX);
}

export default async function handler(req, res) {
  if (cors(req, res)) return;
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  if (!(await authorized(req))) return res.status(403).json({ error: "forbidden" });
  if (!KEY) return res.status(503).json({ error: "linear not configured" });

  let body = req.body ?? {};
  if (typeof body === "string") {
    try { body = JSON.parse(body || "{}"); } catch { return res.status(400).json({ error: "bad json" }); }
  }
  const issueKeys = wanted(body.issues, ISSUE_KEY);
  const projectSlugs = wanted(body.projects, PROJECT_SLUG);

  const issues = {};
  const projects = {};
  const issueMisses = [];
  const projectMisses = [];
  for (const k of issueKeys) {
    const hit = cached(`issue:${k}`);
    if (hit) issues[k] = hit.value;
    else issueMisses.push(k);
  }
  for (const s of projectSlugs) {
    const hit = cached(`project:${s}`);
    if (hit) projects[s] = hit.value;
    else projectMisses.push(s);
  }

  if (issueMisses.length || projectMisses.length) {
    let found;
    try {
      found = await query(issueMisses, projectMisses);
    } catch (err) {
      console.warn("[linear]", err.message);
      return res.status(502).json({ error: "linear unavailable" });
    }
    for (const k of issueMisses) issues[k] = null;
    for (const s of projectMisses) projects[s] = null;
    const asked = new Set(issueMisses);
    for (const i of found.issues) {
      if (!asked.has(i.identifier)) continue;
      const issue = trimIssue(i);
      issues[i.identifier] = issue;
      remember(`issue:${i.identifier}`, issue);
      if (i.project) {
        const project = trimProject(i.project);
        projects[i.project.slugId] = project;
        remember(`project:${i.project.slugId}`, project);
      }
    }
    for (const p of found.projects) {
      const project = trimProject(p);
      projects[p.slugId] = project;
      remember(`project:${p.slugId}`, project);
    }
    for (const k of issueMisses) if (issues[k] === null) remember(`issue:${k}`, null);
    for (const s of projectMisses) if (projects[s] === null) remember(`project:${s}`, null);
  }

  // Projects of issues answered from the cache.
  for (const issue of Object.values(issues)) {
    if (!issue?.project || issue.project in projects) continue;
    const hit = cached(`project:${issue.project}`);
    if (hit) projects[issue.project] = hit.value;
  }

  res.setHeader("Cache-Control", "private, no-store");
  return res.status(200).json({ issues, projects });
}
