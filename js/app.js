/**
 * FamDam app: state, rendering, and event wiring.
 * Persists to localStorage always; also syncs to Google Drive/Calendar
 * when the user has connected their Google account (see google.js).
 */
(function () {
  const LS_STATE = "famdam.state.v1";
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  const COLORS = ["#4f8cff", "#e0553f", "#2a9d5c", "#f2a90b", "#9b5de5", "#00b8a9"];
  let colorCycle = 0;

  /** @type {{familyMembers: Array, chores: Array, completions: Object}} */
  let state = loadLocalState() || { familyMembers: [], chores: [], completions: {} };
  let weekStart = startOfWeek(new Date());
  let saveTimer = null;

  // ---------- persistence ----------

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  function saveLocalState() {
    localStorage.setItem(LS_STATE, JSON.stringify(state));
  }

  function scheduleRemoteSave() {
    if (!window.FamDamGoogle.isSignedIn()) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      try {
        setSyncStatus("syncing", "Syncing…");
        await window.FamDamGoogle.saveRemoteState(state);
        setSyncStatus("connected", "Synced");
      } catch (err) {
        console.error(err);
        setSyncStatus("error", "Sync failed");
      }
    }, 800);
  }

  function persist() {
    saveLocalState();
    render();
    scheduleRemoteSave();
  }

  // ---------- date helpers ----------

  function startOfWeek(d) {
    const copy = new Date(d);
    copy.setHours(0, 0, 0, 0);
    copy.setDate(copy.getDate() - copy.getDay());
    return copy;
  }

  function addDays(d, n) {
    const copy = new Date(d);
    copy.setDate(copy.getDate() + n);
    return copy;
  }

  function isoDate(d) {
    const pad = (n) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  }

  function isSameDay(a, b) {
    return isoDate(a) === isoDate(b);
  }

  function choreRunsOn(chore, dayIndex) {
    if (chore.schedule.type === "daily") return true;
    return (chore.schedule.days || []).includes(dayIndex);
  }

  // ---------- CRUD: members ----------

  function addMember(name, color) {
    state.familyMembers.push({ id: crypto.randomUUID(), name: name.trim(), color });
    persist();
  }

  function deleteMember(id) {
    if (!confirm("Remove this family member? Chores assigned only to them will become unassigned.")) return;
    state.familyMembers = state.familyMembers.filter((m) => m.id !== id);
    state.chores.forEach((c) => {
      c.assigneeIds = c.assigneeIds.filter((aid) => aid !== id);
    });
    persist();
    resyncAllChores();
  }

  // ---------- CRUD: chores ----------

  function addChore({ title, assigneeIds, scheduleType, days, timesPerDay }) {
    const chore = {
      id: crypto.randomUUID(),
      title: title.trim(),
      assigneeIds,
      schedule: { type: scheduleType, days: scheduleType === "weekly" ? days : [], timesPerDay },
      googleEventIds: [],
    };
    state.chores.push(chore);
    persist();
    syncOneChore(chore);
  }

  function deleteChore(id) {
    if (!confirm("Delete this chore?")) return;
    const chore = state.chores.find((c) => c.id === id);
    state.chores = state.chores.filter((c) => c.id !== id);
    Object.keys(state.completions).forEach((key) => {
      if (key.startsWith(id + "::")) delete state.completions[key];
    });
    persist();
    if (chore && window.FamDamGoogle.isSignedIn()) {
      window.FamDamGoogle.clearChoreEvents(chore).catch((err) => console.error(err));
    }
  }

  function toggleCompletion(choreId, dateIso, slot) {
    const key = `${choreId}::${dateIso}::${slot}`;
    if (state.completions[key]) delete state.completions[key];
    else state.completions[key] = true;
    persist();
  }

  async function syncOneChore(chore) {
    if (!window.FamDamGoogle.isSignedIn()) return;
    try {
      setSyncStatus("syncing", "Syncing…");
      await window.FamDamGoogle.syncChore(chore, state.familyMembers);
      saveLocalState();
      setSyncStatus("connected", "Synced");
    } catch (err) {
      console.error(err);
      setSyncStatus("error", "Calendar sync failed");
    }
  }

  async function resyncAllChores() {
    if (!window.FamDamGoogle.isSignedIn()) return;
    for (const chore of state.chores) {
      await syncOneChore(chore);
    }
  }

  // ---------- rendering ----------

  function setSyncStatus(cls, text) {
    const el = document.getElementById("syncStatus");
    el.className = `sync-status ${cls}`;
    el.textContent = text;
  }

  function renderMembers() {
    const list = document.getElementById("memberList");
    list.innerHTML = "";
    state.familyMembers.forEach((m) => {
      const li = document.createElement("li");
      li.className = "member-row";
      li.innerHTML = `
        <span class="swatch" style="background:${m.color}"></span>
        <span class="member-name">${escapeHtml(m.name)}</span>
        <button class="btn-icon" title="Remove" data-id="${m.id}">✕</button>
      `;
      li.querySelector("button").addEventListener("click", () => deleteMember(m.id));
      list.appendChild(li);
    });

    renderAssigneeChips();
  }

  function renderAssigneeChips() {
    const wrap = document.getElementById("choreAssignees");
    wrap.innerHTML = "";
    if (!state.familyMembers.length) {
      wrap.innerHTML = '<span class="chore-meta">Add a family member first.</span>';
      return;
    }
    state.familyMembers.forEach((m) => {
      const label = document.createElement("label");
      label.className = "chip";
      label.innerHTML = `<input type="checkbox" value="${m.id}" /> <span class="swatch" style="background:${m.color}"></span> ${escapeHtml(m.name)}`;
      const input = label.querySelector("input");
      input.addEventListener("change", () => label.classList.toggle("checked", input.checked));
      wrap.appendChild(label);
    });
  }

  function scheduleSummary(chore) {
    if (chore.schedule.type === "daily") {
      return chore.schedule.timesPerDay > 1 ? `Every day · ${chore.schedule.timesPerDay}×` : "Every day";
    }
    const days = chore.schedule.days.map((d) => DAY_NAMES[d]).join(", ") || "No days set";
    return chore.schedule.timesPerDay > 1 ? `${days} · ${chore.schedule.timesPerDay}×` : days;
  }

  function renderChores() {
    const list = document.getElementById("choreList");
    list.innerHTML = "";
    if (!state.chores.length) {
      list.innerHTML = '<li class="chore-meta">No chores yet — add one below.</li>';
    }
    state.chores.forEach((c) => {
      const names = state.familyMembers
        .filter((m) => c.assigneeIds.includes(m.id))
        .map((m) => m.name)
        .join(", ") || "Unassigned";
      const li = document.createElement("li");
      li.className = "chore-row";
      li.innerHTML = `
        <div style="flex:1">
          <div class="chore-title">${escapeHtml(c.title)}</div>
          <div class="chore-meta">${escapeHtml(names)} · ${escapeHtml(scheduleSummary(c))}</div>
        </div>
        <button class="btn-icon" title="Delete" data-id="${c.id}">✕</button>
      `;
      li.querySelector("button").addEventListener("click", () => deleteChore(c.id));
      list.appendChild(li);
    });
  }

  function renderChart() {
    const thead = document.querySelector("#chartTable thead");
    const tbody = document.querySelector("#chartTable tbody");
    const emptyState = document.getElementById("emptyState");
    const table = document.getElementById("chartTable");
    const today = new Date();

    const weekDates = Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
    document.getElementById("weekLabel").textContent =
      `${weekDates[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ` +
      `${weekDates[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;

    if (!state.familyMembers.length || !state.chores.length) {
      table.hidden = true;
      emptyState.hidden = false;
      return;
    }
    table.hidden = false;
    emptyState.hidden = true;

    thead.innerHTML =
      "<tr><th>Chore</th>" +
      weekDates
        .map((d) => `<th class="${isSameDay(d, today) ? "today-col" : ""}">${DAY_NAMES[d.getDay()]}<br><small>${d.getMonth() + 1}/${d.getDate()}</small></th>`)
        .join("") +
      "</tr>";

    tbody.innerHTML = "";
    state.chores.forEach((chore) => {
      const tr = document.createElement("tr");
      let cells = `<td class="chore-name-cell">${escapeHtml(chore.title)}</td>`;
      weekDates.forEach((d) => {
        const dayIndex = d.getDay();
        if (!choreRunsOn(chore, dayIndex)) {
          cells += `<td class="${isSameDay(d, today) ? "today-col" : ""} day-cell-empty">—</td>`;
          return;
        }
        const assignees = state.familyMembers.filter((m) => chore.assigneeIds.includes(m.id));
        const dateIso = isoDate(d);
        const times = Math.max(1, chore.schedule.timesPerDay || 1);
        const pips = Array.from({ length: times }, (_, slot) => {
          const done = !!state.completions[`${chore.id}::${dateIso}::${slot}`];
          return `<button class="pip ${done ? "done" : ""}" data-chore="${chore.id}" data-date="${dateIso}" data-slot="${slot}" title="Mark ${slot + 1}/${times}">${done ? "✓" : ""}</button>`;
        }).join("");
        const assigneeLine = assignees.length
          ? `<span class="assignee-line">${assignees
              .map((a) => `<span class="avatar-dot" style="background:${a.color}" title="${escapeHtml(a.name)}"></span>`)
              .join("")}</span>`
          : `<span class="chore-meta">Unassigned</span>`;
        cells += `<td class="${isSameDay(d, today) ? "today-col" : ""}">${assigneeLine}<div class="slot-pips">${pips}</div></td>`;
      });
      tr.innerHTML = cells;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll(".pip").forEach((btn) => {
      btn.addEventListener("click", () => {
        toggleCompletion(btn.dataset.chore, btn.dataset.date, Number(btn.dataset.slot));
      });
    });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function render() {
    renderMembers();
    renderChores();
    renderChart();
  }

  // ---------- event wiring ----------

  function wireMemberForm() {
    document.getElementById("memberForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const nameInput = document.getElementById("memberName");
      const colorInput = document.getElementById("memberColor");
      const name = nameInput.value.trim();
      if (!name) return;
      addMember(name, colorInput.value);
      nameInput.value = "";
      colorInput.value = COLORS[colorCycle % COLORS.length];
      colorCycle++;
    });
  }

  function wireChoreForm() {
    const dayPicker = document.getElementById("dayPicker");
    document.querySelectorAll('input[name="scheduleType"]').forEach((radio) => {
      radio.addEventListener("change", () => {
        dayPicker.hidden = document.querySelector('input[name="scheduleType"]:checked').value !== "weekly";
      });
    });

    document.getElementById("choreForm").addEventListener("submit", (e) => {
      e.preventDefault();
      const title = document.getElementById("choreTitle").value.trim();
      if (!title) return;
      const assigneeIds = Array.from(
        document.querySelectorAll("#choreAssignees input:checked")
      ).map((el) => el.value);
      const scheduleType = document.querySelector('input[name="scheduleType"]:checked').value;
      const days = Array.from(dayPicker.querySelectorAll("input:checked")).map((el) => Number(el.value));
      const timesPerDay = Math.max(1, Math.min(10, Number(document.getElementById("choreTimes").value) || 1));

      if (scheduleType === "weekly" && !days.length) {
        alert("Pick at least one day, or choose “Every day”.");
        return;
      }

      addChore({ title, assigneeIds, scheduleType, days, timesPerDay });
      e.target.reset();
      dayPicker.hidden = true;
      document.getElementById("choreTimes").value = 1;
      renderAssigneeChips();
    });
  }

  function wireWeekNav() {
    document.getElementById("prevWeek").addEventListener("click", () => {
      weekStart = addDays(weekStart, -7);
      renderChart();
    });
    document.getElementById("nextWeek").addEventListener("click", () => {
      weekStart = addDays(weekStart, 7);
      renderChart();
    });
    document.getElementById("todayBtn").addEventListener("click", () => {
      weekStart = startOfWeek(new Date());
      renderChart();
    });
  }

  function wireGoogle() {
    const btn = document.getElementById("googleBtn");
    const settingsBtn = document.getElementById("settingsBtn");
    const dialog = document.getElementById("settingsDialog");
    const clientIdInput = document.getElementById("clientIdInput");

    function refreshButton() {
      const signedIn = window.FamDamGoogle.isSignedIn();
      btn.textContent = signedIn ? "Connected ✓" : "Connect Google";
      setSyncStatus(signedIn ? "connected" : "", signedIn ? "Synced" : "Not connected");
    }

    btn.addEventListener("click", async () => {
      if (!window.FamDamGoogle.getClientId()) {
        clientIdInput.value = "";
        dialog.showModal();
        return;
      }
      try {
        setSyncStatus("syncing", "Connecting…");
        await window.FamDamGoogle.connect();
        await mergeRemoteState();
        refreshButton();
      } catch (err) {
        console.error(err);
        setSyncStatus("error", "Connect failed");
      }
    });

    settingsBtn.addEventListener("click", () => {
      clientIdInput.value = window.FamDamGoogle.getClientId();
      dialog.showModal();
    });

    document.getElementById("settingsForm").addEventListener("submit", (e) => {
      e.preventDefault();
      window.FamDamGoogle.setClientId(clientIdInput.value);
      dialog.close();
    });

    document.getElementById("disconnectBtn").addEventListener("click", () => {
      window.FamDamGoogle.disconnect();
      dialog.close();
      refreshButton();
    });

    refreshButton();

    // Try a silent reconnect on load if we were connected before.
    if (window.FamDamGoogle.getClientId() && window.FamDamGoogle.isMarkedConnected()) {
      window.FamDamGoogle
        .trySilentReconnect()
        .then(async () => {
          await mergeRemoteState();
          refreshButton();
        })
        .catch(() => {
          /* user will need to click Connect again */
        });
    }
  }

  async function mergeRemoteState() {
    try {
      const remote = await window.FamDamGoogle.loadRemoteState();
      if (remote) {
        state = remote;
      } else {
        await window.FamDamGoogle.saveRemoteState(state);
      }
      saveLocalState();
      render();
    } catch (err) {
      console.error(err);
      setSyncStatus("error", "Could not load synced data");
    }
  }

  // ---------- init ----------

  document.addEventListener("DOMContentLoaded", () => {
    wireMemberForm();
    wireChoreForm();
    wireWeekNav();
    wireGoogle();
    document.getElementById("memberColor").value = COLORS[0];
    colorCycle = 1;
    render();
  });
})();
