/**
 * FamDam Google integration.
 *
 * Uses Google Identity Services (token client) for auth — no backend, no
 * client secret. Reads/writes:
 *  - Drive "appDataFolder": a single famdam-state.json file so the same
 *    family/chore config follows the signed-in user across devices.
 *  - Calendar: a dedicated "Family Chores" calendar, with one recurring
 *    event per chore (or per daily "slot" when a chore happens more than
 *    once a day).
 *
 * Everything here is a thin wrapper around plain REST calls
 * (www.googleapis.com) so it works from a static site with no server.
 */
(function (global) {
  const DRIVE_FILE_NAME = "famdam-state.json";
  const CALENDAR_NAME = "Family Chores";
  const SCOPES = [
    "https://www.googleapis.com/auth/drive.appdata",
    "https://www.googleapis.com/auth/calendar",
  ].join(" ");

  const LS_CLIENT_ID = "famdam.googleClientId";
  const LS_CONNECTED = "famdam.googleConnected";

  let tokenClient = null;
  let accessToken = null;
  let tokenExpiresAt = 0;
  let calendarIdCache = null;

  function getClientId() {
    return localStorage.getItem(LS_CLIENT_ID) || "";
  }

  function setClientId(id) {
    localStorage.setItem(LS_CLIENT_ID, id.trim());
  }

  function isMarkedConnected() {
    return localStorage.getItem(LS_CONNECTED) === "1";
  }

  function markConnected(v) {
    if (v) localStorage.setItem(LS_CONNECTED, "1");
    else localStorage.removeItem(LS_CONNECTED);
  }

  function hasValidToken() {
    return !!accessToken && Date.now() < tokenExpiresAt - 5000;
  }

  function ensureTokenClient() {
    if (tokenClient) return tokenClient;
    const clientId = getClientId();
    if (!clientId) throw new Error("No Google Client ID configured yet.");
    if (!global.google || !global.google.accounts || !global.google.accounts.oauth2) {
      throw new Error("Google Identity Services script has not loaded yet.");
    }
    tokenClient = global.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPES,
      callback: () => {}, // overridden per-call below
    });
    return tokenClient;
  }

  /** Resolves with an access token, prompting the user if needed. */
  function requestToken(interactive) {
    return new Promise((resolve, reject) => {
      let client;
      try {
        client = ensureTokenClient();
      } catch (err) {
        reject(err);
        return;
      }
      client.callback = (resp) => {
        if (resp.error) {
          reject(new Error(resp.error));
          return;
        }
        accessToken = resp.access_token;
        tokenExpiresAt = Date.now() + (resp.expires_in || 3600) * 1000;
        markConnected(true);
        resolve(accessToken);
      };
      try {
        client.requestAccessToken({ prompt: interactive ? "consent" : "" });
      } catch (err) {
        reject(err);
      }
    });
  }

  async function ensureToken() {
    if (hasValidToken()) return accessToken;
    return requestToken(false);
  }

  async function apiFetch(url, options) {
    const token = await ensureToken();
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options && options.headers),
      },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Google API ${res.status}: ${body.slice(0, 300)}`);
    }
    if (res.status === 204) return null;
    const ct = res.headers.get("content-type") || "";
    return ct.includes("application/json") ? res.json() : res.text();
  }

  // ---------- Drive appData (cross-device state) ----------

  async function findStateFile() {
    const data = await apiFetch(
      "https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&fields=files(id,name)&q=" +
        encodeURIComponent(`name='${DRIVE_FILE_NAME}'`)
    );
    return (data.files && data.files[0]) || null;
  }

  async function loadRemoteState() {
    const file = await findStateFile();
    if (!file) return null;
    const content = await apiFetch(
      `https://www.googleapis.com/drive/v3/files/${file.id}?alt=media`
    );
    if (!content) return null;
    return typeof content === "string" ? JSON.parse(content) : content;
  }

  async function saveRemoteState(state) {
    const json = JSON.stringify(state);
    const file = await findStateFile();
    if (file) {
      await apiFetch(
        `https://www.googleapis.com/upload/drive/v3/files/${file.id}?uploadType=media`,
        { method: "PATCH", headers: { "Content-Type": "application/json" }, body: json }
      );
      return file.id;
    }
    const boundary = "famdam-boundary";
    const metadata = { name: DRIVE_FILE_NAME, parents: ["appDataFolder"] };
    const body =
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n` +
      `${JSON.stringify(metadata)}\r\n` +
      `--${boundary}\r\nContent-Type: application/json\r\n\r\n` +
      `${json}\r\n--${boundary}--`;
    const created = await apiFetch(
      "https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id",
      {
        method: "POST",
        headers: { "Content-Type": `multipart/related; boundary=${boundary}` },
        body,
      }
    );
    return created.id;
  }

  // ---------- Calendar ----------

  async function ensureCalendar() {
    if (calendarIdCache) return calendarIdCache;
    const list = await apiFetch(
      "https://www.googleapis.com/calendar/v3/users/me/calendarList?minAccessRole=owner"
    );
    const existing = (list.items || []).find((c) => c.summary === CALENDAR_NAME);
    if (existing) {
      calendarIdCache = existing.id;
      return calendarIdCache;
    }
    const created = await apiFetch("https://www.googleapis.com/calendar/v3/calendars", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ summary: CALENDAR_NAME }),
    });
    calendarIdCache = created.id;
    return calendarIdCache;
  }

  const DAY_CODES = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];

  function buildRRule(chore) {
    if (chore.schedule.type === "daily") return "RRULE:FREQ=DAILY";
    const days = (chore.schedule.days || []).map((d) => DAY_CODES[d]);
    if (!days.length) return "RRULE:FREQ=DAILY";
    return `RRULE:FREQ=WEEKLY;BYDAY=${days.join(",")}`;
  }

  function slotTime(baseDate, slotIndex, totalSlots) {
    const hours = [8, 12, 16, 19, 9, 13, 17, 20, 10, 14];
    const hour = hours[slotIndex] ?? 8 + slotIndex;
    const d = new Date(baseDate);
    d.setHours(hour, 0, 0, 0);
    return d;
  }

  function toRFC3339(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return (
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T` +
      `${pad(d.getHours())}:${pad(d.getMinutes())}:00`
    );
  }

  async function deleteEvent(calendarId, eventId) {
    try {
      await apiFetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`,
        { method: "DELETE" }
      );
    } catch (err) {
      // Already gone / not found is fine to ignore.
      if (!/404/.test(String(err.message))) throw err;
    }
  }

  /** Deletes any previously-synced events for a chore. */
  async function clearChoreEvents(chore) {
    if (!chore.googleEventIds || !chore.googleEventIds.length) return;
    const calendarId = await ensureCalendar();
    await Promise.all(chore.googleEventIds.map((id) => deleteEvent(calendarId, id)));
    chore.googleEventIds = [];
  }

  /** Creates/recreates the recurring calendar event(s) for a chore. */
  async function syncChore(chore, members) {
    const calendarId = await ensureCalendar();
    await clearChoreEvents(chore);

    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const assignees = members.filter((m) => chore.assigneeIds.includes(m.id));
    const names = assignees.map((m) => m.name).join(", ") || "Family";
    const times = Math.max(1, chore.schedule.timesPerDay || 1);
    const today = new Date();
    const eventIds = [];

    for (let slot = 0; slot < times; slot++) {
      const start = slotTime(today, slot, times);
      const end = new Date(start.getTime() + 30 * 60000);
      const summary = times > 1 ? `${chore.title} (${slot + 1}/${times}) — ${names}` : `${chore.title} — ${names}`;
      const body = {
        summary,
        description: `Synced from FamDam. Assigned to: ${names}.`,
        start: { dateTime: toRFC3339(start), timeZone },
        end: { dateTime: toRFC3339(end), timeZone },
        recurrence: [buildRRule(chore)],
        extendedProperties: { private: { famdamChoreId: chore.id, famdamSlot: String(slot) } },
      };
      const created = await apiFetch(
        `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
      );
      eventIds.push(created.id);
    }
    chore.googleEventIds = eventIds;
    return chore;
  }

  function disconnect() {
    if (accessToken && global.google?.accounts?.oauth2?.revoke) {
      global.google.accounts.oauth2.revoke(accessToken, () => {});
    }
    accessToken = null;
    tokenExpiresAt = 0;
    tokenClient = null;
    calendarIdCache = null;
    markConnected(false);
  }

  global.FamDamGoogle = {
    getClientId,
    setClientId,
    isMarkedConnected,
    isSignedIn: () => hasValidToken(),
    connect: () => requestToken(true),
    trySilentReconnect: () => requestToken(false),
    disconnect,
    loadRemoteState,
    saveRemoteState,
    syncChore,
    clearChoreEvents,
  };
})(window);
