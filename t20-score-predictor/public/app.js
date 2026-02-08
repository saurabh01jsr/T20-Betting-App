const state = {
  data: null,
  playerId: localStorage.getItem("t20_playerId") || "",
  adminPin: localStorage.getItem("t20_adminPin") || "",
  showSetup: false,
  scheduleNotice: null,
  view: localStorage.getItem("t20_view") || "focus"
};

const elements = {
  roomName: document.getElementById("room-name"),
  playerSelect: document.getElementById("player-select"),
  adminPin: document.getElementById("admin-pin"),
  setupSection: document.getElementById("setup"),
  setupForm: document.getElementById("setup-form"),
  scoreboard: document.getElementById("scoreboard"),
  matches: document.getElementById("matches"),
  scheduleMeta: document.getElementById("schedule-meta"),
  scheduleSync: document.getElementById("sync-schedule"),
  tossSync: document.getElementById("sync-toss"),
  toggleSetup: document.getElementById("toggle-setup"),
  statTotal: document.getElementById("stat-total"),
  statUpcoming: document.getElementById("stat-upcoming"),
  statLocked: document.getElementById("stat-locked"),
  statScored: document.getElementById("stat-scored"),
  tabs: Array.from(document.querySelectorAll(".view-tabs .tab"))
};

elements.adminPin.value = state.adminPin;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: "Request failed" }));
    throw new Error(error.error || "Request failed");
  }
  return res.json();
}

function formatDate(value) {
  if (!value) return "TBD";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "TBD";
  return date.toLocaleString();
}

function getBattingTeams(match) {
  if (!match.toss || !match.toss.winner || !match.toss.decision) return null;
  const winner = match.toss.winner;
  const decision = match.toss.decision;
  const other = winner === match.teamA ? match.teamB : match.teamA;
  if (decision === "bat") {
    return { innings1: winner, innings2: other };
  }
  if (decision === "field") {
    return { innings1: other, innings2: winner };
  }
  return null;
}

function renderScheduleMeta() {
  const settings = state.data.settings;
  const source = settings.scheduleSource || "Manual";
  const lastSync = settings.lastScheduleSync ? formatDate(settings.lastScheduleSync) : "Never";
  const tossSource = settings.tossAutoSource || "Goalserve";
  const lastTossSync = settings.lastTossSync ? formatDate(settings.lastTossSync) : "Never";
  const tossAuto = settings.tossAutoEnabled ? "Enabled" : "Disabled";
  const notice = state.scheduleNotice;
  elements.scheduleMeta.innerHTML = `
    <div><strong>Schedule source:</strong> ${source}</div>
    <div><strong>Last sync:</strong> ${lastSync}</div>
    <div><strong>Toss auto:</strong> ${tossAuto} (${tossSource})</div>
    <div><strong>Last toss sync:</strong> ${lastTossSync}</div>
    ${notice ? `<div class="${notice.type === "error" ? "error" : "notice"}">${notice.text}</div>` : ""}
  `;
}

function renderStats() {
  const matches = state.data.matches;
  const total = matches.length;
  const upcoming = matches.filter((match) => match.innings1?.status === "open").length;
  const locked = matches.filter(
    (match) => match.innings1?.status === "locked" || match.innings2?.status === "locked"
  ).length;
  const scored = matches.filter((match) => match.innings2?.status === "scored").length;

  elements.statTotal.textContent = total;
  elements.statUpcoming.textContent = upcoming;
  elements.statLocked.textContent = locked;
  elements.statScored.textContent = scored;
}

function renderScoreboard() {
  const rows = state.data.scoreboard || [];
  if (!rows.length) {
    elements.scoreboard.innerHTML = "<p class=\"notice\">No scored innings yet.</p>";
    return;
  }
  const html = `
    <table class="table">
      <thead>
        <tr>
          <th>Player</th>
          <th>Points</th>
          <th>Wins</th>
          <th>Exact</th>
          <th>Avg Diff</th>
        </tr>
      </thead>
      <tbody>
        ${rows
          .map(
            (row) => `
          <tr>
            <td>${row.name}</td>
            <td>${row.points}</td>
            <td>${row.wins}</td>
            <td>${row.exactHits}</td>
            <td>${row.avgDiff === null ? "-" : row.avgDiff}</td>
          </tr>`
          )
          .join("")}
      </tbody>
    </table>`;
  elements.scoreboard.innerHTML = html;
}

function renderPredictionList(match, inningsKey, showAll) {
  return state.data.players
    .map((player) => {
      const prediction = match.predictions?.[inningsKey]?.[player.id];
      if (!showAll && player.id !== state.playerId) {
        return `<li><strong>${player.name}:</strong> <span class="notice">hidden</span></li>`;
      }
      return `<li><strong>${player.name}:</strong> ${prediction == null ? "-" : prediction}</li>`;
    })
    .join("");
}

function renderResultLine(match, inningsKey) {
  const result = match.result?.[inningsKey];
  if (!result) return "";
  const winners = result.winners || [];
  const names = winners
    .map((id) => state.data.players.find((p) => p.id === id)?.name)
    .filter(Boolean);
  const label = `Winner${names.length === 1 ? "" : "s"}: ${names.length ? names.join(", ") : "None"}`;
  return label;
}

function buildMatchCard(match, options = {}) {
  const { collapsed = false, showToggle = true, variant = "default" } = options;
  const player = state.data.players.find((p) => p.id === state.playerId);
  const innings1 = match.innings1 || { status: "open", lockTime: match.lockTime || null, score: null };
  const innings2 = match.innings2 || { status: "pending", lockTime: null, score: null };
  const battingTeams = getBattingTeams(match);
  const tossText = match.toss
    ? `${match.toss.winner} chose to ${match.toss.decision}`
    : "Set toss to enable predictions.";
  const tossWinner = match.toss?.winner || match.teamA;
  const tossDecision = match.toss?.decision || "bat";
  const matchId = match.matchNumber ? `Match #${match.matchNumber}` : "Custom match";
  const detailLine = [match.stage || "Match", match.group ? `Group ${match.group}` : null]
    .filter(Boolean)
    .join(" | ");
  const cardClass = variant === "compact" ? "match-card match-compact" : "match-card";

  const innings1Disabled = !player || innings1.status !== "open" || !battingTeams;
  const innings2Disabled =
    !player || innings2.status !== "open" || !battingTeams || innings2.status === "pending";

  return `
    <div class="${cardClass}">
      <div class="match-summary">
        <div>
          <div class="match-title">${match.teamA} vs ${match.teamB}</div>
          <div class="match-sub">${detailLine}</div>
        </div>
        <div class="status-pill ${innings1.status}">${innings1.status}</div>
        ${showToggle ? `<button class="ghost" data-action="toggle-details" data-id="${match.id}">${collapsed ? "Open" : "Close"}</button>` : ""}
      </div>
      <div class="match-details ${collapsed ? "hidden" : ""}" data-details="${match.id}">
        <div class="match-meta">
          <span>${matchId}</span>
          <span>Venue: ${match.venue || "TBD"}</span>
          <span>Starts: ${formatDate(match.matchDate)}</span>
          <span>Toss: ${tossText}</span>
        </div>

        <div class="innings-block">
          <div class="innings-head">
            <div class="innings-title">Innings 1 - ${battingTeams ? battingTeams.innings1 : "TBD"}</div>
            <div class="status-pill ${innings1.status}">${innings1.status}</div>
          </div>
          <div class="notice">Lock: ${formatDate(innings1.lockTime)}</div>
          <div>
            <strong>Predictions</strong>
            <ul>
              ${renderPredictionList(match, "innings1", innings1.status !== "open")}
            </ul>
          </div>
          ${innings1.status === "scored" ? `<div><strong>Actual:</strong> ${innings1.score} | ${renderResultLine(match, "innings1")}</div>` : ""}
          <form data-action="predict" data-id="${match.id}" data-innings="1">
            <label>
              ${player ? `Your pick (${player.name})` : "Select your name"}
              <input name="score" type="number" min="${state.data.settings.minScore}" max="${state.data.settings.maxScore}" ${innings1Disabled ? "disabled" : ""} />
            </label>
            <button type="submit" class="primary" ${innings1Disabled ? "disabled" : ""}>Save Prediction</button>
          </form>
          <div class="match-actions">
            <button data-action="lock" data-id="${match.id}" data-innings="1" class="ghost">Lock Innings 1</button>
          </div>
          <form data-action="score" data-id="${match.id}" data-innings="1">
            <input name="actualScore" type="number" placeholder="Innings 1 score" min="${state.data.settings.minScore}" max="${state.data.settings.maxScore}" ${innings1.status === "scored" ? "disabled" : ""} />
            <input name="innings2StartTime" type="datetime-local" placeholder="Second innings start" />
            <button type="submit" class="primary" ${innings1.status === "scored" ? "disabled" : ""}>Finalize Innings 1</button>
          </form>
        </div>

        <div class="innings-block">
          <div class="innings-head">
            <div class="innings-title">Innings 2 - ${battingTeams ? battingTeams.innings2 : "TBD"}</div>
            <div class="status-pill ${innings2.status}">${innings2.status}</div>
          </div>
          <div class="notice">Lock: ${formatDate(innings2.lockTime)}</div>
          <div>
            <strong>Predictions</strong>
            <ul>
              ${renderPredictionList(match, "innings2", innings2.status !== "open")}
            </ul>
          </div>
          ${innings2.status === "scored" ? `<div><strong>Actual:</strong> ${innings2.score} | ${renderResultLine(match, "innings2")}</div>` : ""}
          <form data-action="predict" data-id="${match.id}" data-innings="2">
            <label>
              ${player ? `Your pick (${player.name})` : "Select your name"}
              <input name="score" type="number" min="${state.data.settings.minScore}" max="${state.data.settings.maxScore}" ${innings2Disabled ? "disabled" : ""} />
            </label>
            <button type="submit" class="primary" ${innings2Disabled ? "disabled" : ""}>Save Prediction</button>
          </form>
          <div class="match-actions">
            <button data-action="lock" data-id="${match.id}" data-innings="2" class="ghost">Lock Innings 2</button>
          </div>
          <form data-action="score" data-id="${match.id}" data-innings="2">
            <input name="actualScore" type="number" placeholder="Innings 2 score" min="${state.data.settings.minScore}" max="${state.data.settings.maxScore}" ${innings2.status === "scored" ? "disabled" : ""} />
            <button type="submit" class="primary" ${innings2.status === "scored" ? "disabled" : ""}>Finalize Innings 2</button>
          </form>
        </div>

        <form data-action="toss" data-id="${match.id}">
          <label>
            Toss winner
            <select name="winner">
              <option value="${match.teamA}" ${tossWinner === match.teamA ? "selected" : ""}>${match.teamA}</option>
              <option value="${match.teamB}" ${tossWinner === match.teamB ? "selected" : ""}>${match.teamB}</option>
            </select>
          </label>
          <label>
            Decision
            <select name="decision">
              <option value="bat" ${tossDecision === "bat" ? "selected" : ""}>Bat</option>
              <option value="field" ${tossDecision === "field" ? "selected" : ""}>Field</option>
            </select>
          </label>
          <button type="submit" class="primary">Set Toss</button>
        </form>

        <div class="match-actions">
          <button data-action="reopen" data-id="${match.id}" class="ghost">Reopen Match</button>
        </div>
      </div>
    </div>
  `;
}

function pickNextMatch(matches) {
  const now = Date.now();
  const future = matches.filter((match) => match.matchDate);
  const sorted = [...future].sort(
    (a, b) => new Date(a.matchDate).getTime() - new Date(b.matchDate).getTime()
  );
  const upcoming = sorted.find((match) => new Date(match.matchDate).getTime() >= now);
  if (upcoming) return upcoming;
  return sorted[0] || matches[0] || null;
}

function renderMatches() {
  const allMatches = state.data.matches.slice();
  allMatches.sort((a, b) => {
    const aTime = a.matchDate ? new Date(a.matchDate).getTime() : Number.MAX_SAFE_INTEGER;
    const bTime = b.matchDate ? new Date(b.matchDate).getTime() : Number.MAX_SAFE_INTEGER;
    return aTime - bTime;
  });

  const completed = allMatches.filter((match) => match.innings2?.status === "scored");
  const upcoming = allMatches.filter((match) => match.innings2?.status !== "scored");

  elements.tabs.forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.view === state.view);
  });

  if (state.view === "focus") {
    const featured = pickNextMatch(upcoming);
    if (!featured) {
      elements.matches.innerHTML = "<p class=\"notice\">No upcoming matches.</p>";
      return;
    }
    const nextUp = upcoming.filter((match) => match.id !== featured.id).slice(0, 3);
    elements.matches.innerHTML = `
      <div class="section-head">
        <h4>Next Match</h4>
        <span class="section-hint">Everything you need, right now.</span>
      </div>
      ${buildMatchCard(featured, { collapsed: false, showToggle: false })}
      ${nextUp.length
        ? `
        <div class="section-head">
          <h4>Up Next</h4>
          <span class="section-hint">Quick view. Open to edit.</span>
        </div>
        <div class="stack">
          ${nextUp.map((match) => buildMatchCard(match, { collapsed: true, variant: "compact" })).join("")}
        </div>`
        : ""}`;
    return;
  }

  if (state.view === "upcoming") {
    if (!upcoming.length) {
      elements.matches.innerHTML = "<p class=\"notice\">No upcoming matches.</p>";
      return;
    }
    elements.matches.innerHTML = upcoming
      .map((match) => buildMatchCard(match, { collapsed: true }))
      .join("");
    return;
  }

  if (state.view === "completed") {
    if (!completed.length) {
      elements.matches.innerHTML = "<p class=\"notice\">No completed matches yet.</p>";
      return;
    }
    elements.matches.innerHTML = completed
      .map((match) => buildMatchCard(match, { collapsed: true, variant: "compact" }))
      .join("");
  }
}

function render() {
  elements.roomName.textContent = state.data.settings.roomName;
  if (!state.data.players.length) {
    state.showSetup = true;
  }
  elements.setupSection.classList.toggle("hidden", !state.showSetup);
  elements.toggleSetup.textContent = state.showSetup ? "Hide setup" : "Edit room";

  elements.playerSelect.innerHTML = state.data.players
    .map((player) => `<option value="${player.id}">${player.name}</option>`)
    .join("");

  if (!state.data.players.find((p) => p.id === state.playerId)) {
    state.playerId = state.data.players[0]?.id || "";
    localStorage.setItem("t20_playerId", state.playerId);
  }
  elements.playerSelect.value = state.playerId;

  renderScheduleMeta();
  renderStats();
  renderScoreboard();
  renderMatches();
}

async function refresh() {
  state.data = await api("/api/state");
  render();
}

elements.playerSelect.addEventListener("change", (event) => {
  state.playerId = event.target.value;
  localStorage.setItem("t20_playerId", state.playerId);
  render();
});

elements.adminPin.addEventListener("input", (event) => {
  state.adminPin = event.target.value;
  localStorage.setItem("t20_adminPin", state.adminPin);
});

elements.toggleSetup.addEventListener("click", () => {
  state.showSetup = !state.showSetup;
  render();
});

elements.scheduleSync.addEventListener("click", async () => {
  elements.scheduleSync.disabled = true;
  elements.scheduleSync.textContent = "Syncing...";
  try {
    const result = await api("/api/schedule/import", {
      method: "POST",
      body: { adminPin: state.adminPin }
    });
    state.scheduleNotice = {
      type: "success",
      text: `Synced ${result.result.created} new, updated ${result.result.updated} (${result.result.total} total).`
    };
    await refresh();
  } catch (err) {
    state.scheduleNotice = { type: "error", text: err.message };
    renderScheduleMeta();
  } finally {
    elements.scheduleSync.disabled = false;
    elements.scheduleSync.textContent = "Sync Official Schedule";
  }
});

elements.tossSync.addEventListener("click", async () => {
  elements.tossSync.disabled = true;
  elements.tossSync.textContent = "Syncing...";
  try {
    const result = await api("/api/toss/sync", {
      method: "POST",
      body: { adminPin: state.adminPin }
    });
    if (result.result?.skipped) {
      state.scheduleNotice = { type: "notice", text: result.result.reason || "No toss updates." };
    } else {
      state.scheduleNotice = {
        type: "success",
        text: `Toss sync updated ${result.result.updated || 0} matches.`
      };
    }
    await refresh();
  } catch (err) {
    state.scheduleNotice = { type: "error", text: err.message };
    renderScheduleMeta();
  } finally {
    elements.tossSync.disabled = false;
    elements.tossSync.textContent = "Sync Toss Now";
  }
});

elements.setupForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const body = {
    roomName: form.roomName.value,
    players: [form.player1.value, form.player2.value, form.player3.value, form.player4.value],
    usePin: form.usePin.checked,
    adminPin: form.adminPin.value,
    bonusExact: form.bonusExact.value,
    minScore: form.minScore.value,
    maxScore: form.maxScore.value,
    lockMinutesBeforeStart: form.lockMinutesBeforeStart.value,
    importSchedule: form.importSchedule.checked
  };

  try {
    const response = await api("/api/setup", { method: "POST", body });
    if (response.scheduleError) {
      state.scheduleNotice = { type: "error", text: response.scheduleError };
    } else if (response.scheduleResult) {
      state.scheduleNotice = {
        type: "success",
        text: `Synced ${response.scheduleResult.created} new, updated ${response.scheduleResult.updated}.`
      };
    }
    state.showSetup = false;
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

elements.matches.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const action = form.dataset.action;
  const id = form.dataset.id;

  if (action === "predict") {
    const score = form.score.value;
    const innings = Number(form.dataset.innings || 1);
    try {
      await api(`/api/matches/${id}/predict`, {
        method: "POST",
        body: { playerId: state.playerId, score, innings }
      });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  if (action === "score") {
    const actualScore = form.actualScore.value;
    const innings = Number(form.dataset.innings || 1);
    const body = { actualScore, adminPin: state.adminPin, innings };
    if (innings === 1 && form.innings2StartTime?.value) {
      body.innings2StartTime = new Date(form.innings2StartTime.value).toISOString();
    }
    try {
      await api(`/api/matches/${id}/score`, { method: "POST", body });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }

  if (action === "toss") {
    const winner = form.winner.value;
    const decision = form.decision.value;
    try {
      await api(`/api/matches/${id}/toss`, {
        method: "POST",
        body: { winner, decision, adminPin: state.adminPin }
      });
      await refresh();
    } catch (err) {
      alert(err.message);
    }
  }
});

elements.matches.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  const action = target.dataset.action;
  const id = target.dataset.id;

  if (action === "toggle-details") {
    const details = elements.matches.querySelector(`[data-details="${id}"]`);
    if (details) {
      const isHidden = details.classList.toggle("hidden");
      target.textContent = isHidden ? "Open" : "Close";
    }
    return;
  }

  if (!action || !id) return;

  try {
    if (action === "lock") {
      await api(`/api/matches/${id}/lock`, {
        method: "POST",
        body: { adminPin: state.adminPin, innings: target.dataset.innings }
      });
    }
    if (action === "reopen") {
      await api(`/api/matches/${id}/reopen`, {
        method: "POST",
        body: { adminPin: state.adminPin }
      });
    }
    await refresh();
  } catch (err) {
    alert(err.message);
  }
});

elements.tabs.forEach((tab) => {
  tab.addEventListener("click", () => {
    state.view = tab.dataset.view;
    localStorage.setItem("t20_view", state.view);
    renderMatches();
  });
});

refresh();
