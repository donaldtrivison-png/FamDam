/**
 * FamDam app: state, rendering, scoring, and event wiring.
 * Persists to localStorage always; also syncs to Google Drive/Calendar
 * when the user has connected their Google account (see google.js).
 */
(function () {
  const LS_STATE = "famdam.state.v1";
  const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const DAY_LETTERS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const TREND_DAYS = 14;
  const RANGE_DAYS = { week: 7, month: 30, all: null };

  // Material-style five-point star, reused for pips, stat tiles and score rows.
  const STAR_PATH = "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z";

  const COLORS = ["#1fa39a", "#ff6b57", "#f5a623", "#6a8caf", "#9b6bd6", "#3fae6a"];
  let colorCycle = 0;

  /** @type {{familyMembers: Array, chores: Array, completions: Object}} */
  let state = normalizeState(loadLocalState() || { familyMembers: [], chores: [], completions: {} });
  let weekStart = startOfWeek(new Date());
  let saveTimer = null;
  let reportRange = "week";
  let activePicker = null;

  // ---------- persistence ----------

  function loadLocalState() {
    try {
      const raw = localStorage.getItem(LS_STATE);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  }

  /** Fills in defaults and migrates older data shapes so the rest of the app
   *  can assume every chore has a createdAt and every completion records who
   *  did it and when. */
  function normalizeState(s) {
    s.familyMembers = s.familyMembers || [];
    s.chores = s.chores || [];
    s.completions = s.completions || {};

    const today = isoDate(new Date());
    s.chores.forEach((c) => {
      if (!c.createdAt) c.createdAt = today;
      if (!Array.isArray(c.assigneeIds)) c.assigneeIds = [];
      if (!c.googleEventIds) c.googleEventIds = [];
    });

    const choreById = Object.fromEntries(s.chores.map((c) => [c.id, c]));
    Object.keys(s.completions).forEach((key) => {
      const entry = s.completions[key];
      if (entry === true) {
        // Legacy shape: boolean-only completion, no attribution recorded.
        const [choreId, dateIso] = key.split("::");
        const chore = choreById[choreId];
        const fallbackAssignee = chore && chore.assigneeIds[0];
        s.completions[key] = {
          done: true,
          completedAt: `${dateIso}T00:00:00`,
          completedBy: fallbackAssignee || null,
        };
      } else if (entry && typeof entry === "object" && entry.completedBy === undefined) {
        entry.completedBy = null;
      }
    });

    return s;
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

  // ---------- icons ----------

  function starIcon(filled) {
    if (filled) return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="currentColor"/></svg>`;
    return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${STAR_PATH}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  }

  function starRow(count, max = 5) {
    let out = "";
    for (let i = 0; i < max; i++) out += `<span>${starIcon(i < count)}</span>`;
    return out;
  }

  function starsForPct(pct) {
    if (pct === null) return 0;
    return Math.min(5, Math.max(0, Math.round(pct / 20)));
  }

  function statusColor(pct) {
    if (pct === null) return "var(--status-none)";
    if (pct >= 80) return "var(--good)";
    if (pct >= 50) return "var(--warning)";
    return "var(--critical)";
  }

  function statusLabel(pct) {
    if (pct === null) return "No data yet";
    if (pct >= 80) return "On track";
    if (pct >= 50) return "Needs attention";
    return "Falling behind";
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
      createdAt: isoDate(new Date()),
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

  // ---------- completions (who did it, and when) ----------

  function setCompletion(choreId, dateIso, slot, memberId) {
    const key = `${choreId}::${dateIso}::${slot}`;
    state.completions[key] = { done: true, completedAt: new Date().toISOString(), completedBy: memberId || null };
    persist();
  }

  function clearCompletion(choreId, dateIso, slot) {
    const key = `${choreId}::${dateIso}::${slot}`;
    delete state.completions[key];
    persist();
  }

  function closeCompletionPicker() {
    if (!activePicker) return;
    activePicker.menu.remove();
    document.removeEventListener("click", activePicker.onOutside, true);
    document.removeEventListener("keydown", activePicker.onKey, true);
    activePicker = null;
  }

  /** Opens a small "who did it?" menu anchored to the clicked pip. */
  function openCompletionPicker(pipEl, chore, dateIso, slot, assignees) {
    closeCompletionPicker();
    const menu = document.createElement("div");
    menu.className = "completion-picker";
    menu.innerHTML =
      `<div class="completion-picker-title">Who did it?</div>` +
      assignees
        .map(
          (a) =>
            `<button type="button" class="completion-picker-option" data-id="${a.id}">` +
            `<span class="swatch" style="background:${a.color}"></span>${escapeHtml(a.name)}</button>`
        )
        .join("");
    document.body.appendChild(menu);

    const rect = pipEl.getBoundingClientRect();
    const top = window.scrollY + rect.bottom + 6;
    let left = window.scrollX + rect.left;
    const maxLeft = window.scrollX + document.documentElement.clientWidth - menu.offsetWidth - 8;
    left = Math.min(left, Math.max(8, maxLeft));
    menu.style.top = `${top}px`;
    menu.style.left = `${left}px`;

    menu.querySelectorAll(".completion-picker-option").forEach((btn) => {
      btn.addEventListener("click", () => {
        setCompletion(chore.id, dateIso, slot, btn.dataset.id);
        closeCompletionPicker();
      });
    });

    const onOutside = (e) => {
      if (!menu.contains(e.target)) closeCompletionPicker();
    };
    const onKey = (e) => {
      if (e.key === "Escape") closeCompletionPicker();
    };
    setTimeout(() => {
      document.addEventListener("click", onOutside, true);
      document.addEventListener("keydown", onKey, true);
    }, 0);
    activePicker = { menu, onOutside, onKey };
  }

  function handlePipClick(pipEl, chore, dateIso, slot) {
    const key = `${chore.id}::${dateIso}::${slot}`;
    const entry = state.completions[key];
    if (entry && entry.done) {
      clearCompletion(chore.id, dateIso, slot);
      return;
    }
    const assignees = state.familyMembers.filter((m) => chore.assigneeIds.includes(m.id));
    if (assignees.length > 1) {
      openCompletionPicker(pipEl, chore, dateIso, slot, assignees);
    } else {
      setCompletion(chore.id, dateIso, slot, assignees[0] ? assignees[0].id : null);
    }
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

  // ---------- scoring: turn schedules + completions into a report ----------

  /**
   * Walks every chore's schedule from its creation date through today and
   * classifies each due occurrence as onTime / late / missed / pending.
   * `rangeDays` limits how far back to look (null = since each chore began).
   */
  function occurrencesInRange(rangeDays) {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayIso = isoDate(today);
    const rangeStart = rangeDays ? addDays(today, -(rangeDays - 1)) : null;
    const results = [];

    state.chores.forEach((chore) => {
      const createdAt = new Date(`${chore.createdAt}T00:00:00`);
      let cursor = rangeStart && rangeStart > createdAt ? new Date(rangeStart) : createdAt;
      cursor.setHours(0, 0, 0, 0);

      while (cursor <= today) {
        const dateIso = isoDate(cursor);
        if (choreRunsOn(chore, cursor.getDay())) {
          const times = Math.max(1, chore.schedule.timesPerDay || 1);
          for (let slot = 0; slot < times; slot++) {
            const key = `${chore.id}::${dateIso}::${slot}`;
            const entry = state.completions[key];
            let status;
            let completedBy = null;
            if (entry && entry.done) {
              completedBy = entry.completedBy || null;
              status = (entry.completedAt || "").slice(0, 10) > dateIso ? "late" : "onTime";
            } else {
              status = dateIso < todayIso ? "missed" : "pending";
            }
            results.push({ choreId: chore.id, assigneeIds: chore.assigneeIds, date: dateIso, status, completedBy });
          }
        }
        cursor = addDays(cursor, 1);
      }
    });

    return results;
  }

  function summarize(occurrences) {
    const c = { onTime: 0, late: 0, missed: 0, pending: 0 };
    occurrences.forEach((o) => c[o.status]++);
    const scored = c.onTime + c.late + c.missed;
    const pct = scored ? Math.round((c.onTime / scored) * 100) : null;
    return { ...c, scored, pct };
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
    const todayIso = isoDate(today);

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
    const pipHandlers = [];

    state.chores.forEach((chore) => {
      const tr = document.createElement("tr");
      let cells = `<td class="chore-name-cell">${escapeHtml(chore.title)}</td>`;
      const assignees = state.familyMembers.filter((m) => chore.assigneeIds.includes(m.id));

      weekDates.forEach((d) => {
        const dayIndex = d.getDay();
        if (!choreRunsOn(chore, dayIndex) || isoDate(d) < chore.createdAt) {
          cells += `<td class="${isSameDay(d, today) ? "today-col" : ""} day-cell-empty">—</td>`;
          return;
        }
        const dateIso = isoDate(d);
        const times = Math.max(1, chore.schedule.timesPerDay || 1);
        const pips = Array.from({ length: times }, (_, slot) => {
          const key = `${chore.id}::${dateIso}::${slot}`;
          const entry = state.completions[key];
          const done = !!(entry && entry.done);
          let cls = "pip";
          let style = "";
          let title;
          if (done) {
            cls += " pip-done";
            const doer = state.familyMembers.find((m) => m.id === entry.completedBy);
            const late = (entry.completedAt || "").slice(0, 10) > dateIso;
            style = doer ? ` style="--pip-color:${doer.color}"` : "";
            title = doer ? `Done by ${doer.name}${late ? " (logged late)" : ""}` : `Done${late ? " (logged late)" : ""}`;
          } else if (dateIso < todayIso) {
            cls += " pip-missed";
            title = "Missed — tap to log it late";
          } else {
            title = times > 1 ? `Mark ${slot + 1}/${times} done` : "Mark done";
          }
          pipHandlers.push({ choreId: chore.id, dateIso, slot });
          return `<button type="button" class="${cls}"${style} data-chore="${chore.id}" data-date="${dateIso}" data-slot="${slot}" title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${starIcon(done)}</button>`;
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
        const chore = state.chores.find((c) => c.id === btn.dataset.chore);
        if (chore) handlePipClick(btn, chore, btn.dataset.date, Number(btn.dataset.slot));
      });
    });
  }

  function renderScoreTile(el, label, summary) {
    if (summary.pct === null) {
      el.innerHTML = `
        <span class="score-label">${escapeHtml(label)}</span>
        <span class="score-empty">No tasks due yet in this range.</span>
      `;
      return;
    }
    const color = statusColor(summary.pct);
    el.innerHTML = `
      <span class="score-label">${escapeHtml(label)}</span>
      <span class="score-value">${summary.pct}<span class="score-unit">%</span></span>
      <span class="score-stars">${starRow(starsForPct(summary.pct))}</span>
      <span class="status-chip"><i class="status-dot" style="background:${color}"></i>${statusLabel(summary.pct)}</span>
      <span class="score-detail">${summary.onTime} on time · ${summary.late} late · ${summary.missed} missed</span>
    `;
  }

  function renderMemberScoreRow(member, summary) {
    const li = document.createElement("li");
    if (summary.pct === null) {
      li.className = "member-score-row no-data";
      li.innerHTML = `
        <span class="swatch" style="background:${member.color}"></span>
        <span class="member-score-name">${escapeHtml(member.name)}</span>
        <span class="chore-meta">No tasks due yet</span>
      `;
      return li;
    }
    const color = statusColor(summary.pct);
    li.className = "member-score-row";
    li.title = statusLabel(summary.pct);
    li.innerHTML = `
      <span class="swatch" style="background:${member.color}"></span>
      <span class="member-score-name">${escapeHtml(member.name)}</span>
      <span class="member-score-bar-track"><span class="member-score-bar-fill" style="width:${summary.pct}%;background:${color}"></span></span>
      <span class="member-score-pct">${summary.pct}%</span>
      <span class="member-score-stars">${starRow(starsForPct(summary.pct))}</span>
    `;
    return li;
  }

  function renderTrend() {
    const occ = occurrencesInRange(TREND_DAYS);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const days = Array.from({ length: TREND_DAYS }, (_, i) => addDays(today, -(TREND_DAYS - 1) + i));

    const chart = document.getElementById("trendChart");
    chart.innerHTML = "";

    days.forEach((d, i) => {
      const dateIso = isoDate(d);
      const dayOcc = occ.filter((o) => o.date === dateIso);
      const s = summarize(dayOcc);
      const isToday = i === days.length - 1;

      const wrap = document.createElement("div");
      wrap.className = "trend-bar-wrap";

      const valueEl = document.createElement("div");
      valueEl.className = "trend-bar-value";
      valueEl.style.visibility = isToday ? "visible" : "hidden";
      valueEl.textContent = s.pct === null ? "–" : `${s.pct}%`;

      const bar = document.createElement("div");
      bar.className = "trend-bar";
      let color;
      let heightPx;
      if (s.pct === null) {
        color = "var(--status-none)";
        heightPx = 8;
      } else {
        color = statusColor(s.pct);
        heightPx = Math.max(8, Math.round((s.pct / 100) * 80) + 8);
      }
      bar.style.background = color;
      bar.style.height = `${heightPx}px`;
      const dayLabel = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
      bar.title =
        s.pct === null
          ? `${dayLabel}: nothing due`
          : `${dayLabel}: ${s.onTime}/${s.scored} on time (${s.pct}%)${s.late ? `, ${s.late} late` : ""}${s.missed ? `, ${s.missed} missed` : ""}`;

      const dayLetter = document.createElement("div");
      dayLetter.className = "trend-day-label";
      dayLetter.textContent = DAY_LETTERS[d.getDay()];

      wrap.appendChild(valueEl);
      wrap.appendChild(bar);
      wrap.appendChild(dayLetter);
      chart.appendChild(wrap);
    });
  }

  function renderReport() {
    const occ = occurrencesInRange(RANGE_DAYS[reportRange]);
    const overall = summarize(occ);
    renderScoreTile(document.getElementById("familyScoreTile"), "Whole family", overall);

    const memberList = document.getElementById("memberScoreList");
    memberList.innerHTML = "";
    if (!state.familyMembers.length) {
      memberList.innerHTML = '<li class="chore-meta">Add family members to see individual scores.</li>';
    }
    state.familyMembers.forEach((m) => {
      const mine = occ.filter(
        (o) => (o.assigneeIds.includes(m.id) && o.status === "missed") || o.completedBy === m.id
      );
      const s = summarize(mine);
      memberList.appendChild(renderMemberScoreRow(m, s));
    });

    renderTrend();
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
    renderReport();
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
      document.querySelector(".add-chore-details").open = false;
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

  function wireReportTabs() {
    const tabs = document.querySelectorAll("#rangeTabs .range-tab");
    tabs.forEach((tab) => {
      tab.addEventListener("click", () => {
        reportRange = tab.dataset.range;
        tabs.forEach((t) => {
          t.classList.toggle("is-active", t === tab);
          t.setAttribute("aria-selected", String(t === tab));
        });
        renderReport();
      });
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
        state = normalizeState(remote);
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
    wireReportTabs();
    wireGoogle();
    document.getElementById("memberColor").value = COLORS[0];
    colorCycle = 1;
    render();
  });
})();
