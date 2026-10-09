/**
 * EasyCron REST client — the only place that knows the vendor's wire format.
 *
 * EasyCron is a timer and nothing else: it stores "call this URL on this cron"
 * and forgets the response. Everything about what a run *means* — the ranger,
 * the query, the outcome — lives in our own
 * `rangerschedules` collection, keyed by an id we generate. The job id returned
 * here is stored only so a schedule can later be edited, paused or deleted.
 *
 * The API key never leaves the server, so callers are our own route handlers.
 */

const BASE = "https://www.easycron.com/rest";

const apiKey = () => {
  const key = process.env.EASYCRON_API_KEY;
  if (!key) throw new Error("EASYCRON_API_KEY is not set");
  return key;
};

/**
 * Credentials go in the POST body rather than the query string so the key does
 * not end up in proxy logs. Errors are surfaced as EasyCron reports them —
 * quota and expression complaints are the ones users actually hit.
 */
async function call(action, params = {}) {
  const body = new URLSearchParams({ token: apiKey() });
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }

  let response;
  try {
    response = await fetch(`${BASE}/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (error) {
    throw new Error(`EasyCron unreachable: ${error?.message || error}`);
  }

  const raw = await response.text().catch(() => "");
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`EasyCron returned a non-JSON response (${response.status})`);
  }

  if (data?.status !== "success") {
    const message = data?.error?.message || data?.error || `EasyCron ${action} failed`;
    throw new Error(String(message));
  }
  return data;
}

/**
 * Create a job. `url` must already carry the schedule id and its run token —
 * EasyCron has nowhere to put a payload, so the URL is the whole instruction.
 * Returns the job id to store on the schedule row.
 */
export async function addCronJob({ url, cronExpression, timezone, name, description, groupId }) {
  const data = await call("add", {
    url,
    cron_expression: cronExpression,
    timezone,
    cron_job_name: name,
    description,
    http_method: "GET",
    // Our run endpoint acknowledges in milliseconds and does the work after, so
    // a long agent run is never reported as a failed job.
    timeout: 30,
    // EasyCron's own retry would double-run the ranger; failures are visible in
    // `last_run` on the row instead.
    number_of_tries: 1,
    // Puts the job under an EasyCron dashboard group (e.g. easycron.com/cron-jobs/index?group_id=95890),
    // separate from our own `group_id` metadata on the schedule row.
    group_id: groupId,
  });
  const id = data?.cron_job_id;
  if (!id) throw new Error("EasyCron did not return a cron_job_id");
  return String(id);
}

export async function editCronJob(cronJobId, { url, cronExpression, timezone, name, groupId } = {}) {
  await call("edit", {
    id: cronJobId,
    url,
    cron_expression: cronExpression,
    timezone,
    cron_job_name: name,
    group_id: groupId,
  });
}

export async function deleteCronJob(cronJobId) {
  await call("delete", { id: cronJobId });
}

export async function setCronJobEnabled(cronJobId, enabled) {
  await call(enabled ? "enable" : "disable", { id: cronJobId });
}

/** Every job on the account — used by /api/scheduler/reconcile to find strays. */
export async function listCronJobs() {
  const data = await call("list");
  return Array.isArray(data?.cron_jobs) ? data.cron_jobs : [];
}
