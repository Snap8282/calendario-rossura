// Calendario Casa di Famiglia - logica dell'app.
// Parla direttamente con Supabase (vedi config.js + supabase/schema.sql). Nessun build step.

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 16 colori volutamente diversi per distinguere meglio le prenotazioni.
// L'admin usa sempre il grigio.
const ADMIN_COLOR = "#6b7280";
const COLOR_PALETTE = [
  "#2563eb", "#dc2626", "#16a34a", "#ca8a04",
  "#9333ea", "#0891b2", "#ea580c", "#be185d",
  "#4f46e5", "#65a30d", "#c026d3", "#0f766e",
  "#b45309", "#e11d48", "#0284c7", "#7c2d12",
];

let members = [];      // [{id, name, is_admin, has_pin}]
let membersById = {};  // id -> member
let identity = null; // {name, pin} while this page is open
let calendar = null;
let bookingsCache = []; // ultime prenotazioni caricate, per il controllo di sovrapposizione lato client
let pendingCheckinDate = null;

const el = (id) => document.getElementById(id);

function currentMember() {
  if (!identity) return null;
  return members.find((m) => m.name === identity.name) || null;
}

function colorForMember(memberId) {
  const member = membersById[memberId];
  if (member && member.is_admin) return ADMIN_COLOR;
  const nonAdminMembers = members.filter((m) => !m.is_admin);
  const idx = nonAdminMembers.findIndex((m) => m.id === memberId);
  return COLOR_PALETTE[Math.max(idx, 0) % COLOR_PALETTE.length];
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function capitalizeFirst(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

function showError(message) {
  const banner = el("error-banner");
  banner.textContent = message;
  banner.classList.remove("hidden");
  clearTimeout(showError._t);
  showError._t = setTimeout(() => banner.classList.add("hidden"), 5000);
}

function showModalError(id, message) {
  const node = el(id);
  node.textContent = message;
  node.classList.remove("hidden");
}

function hideModalError(id) {
  el(id).classList.add("hidden");
}

function populateNameSelect(selectEl) {
  selectEl.innerHTML = '<option value="" disabled selected>Seleziona il tuo nome</option>';
  for (const m of members) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    selectEl.appendChild(opt);
  }
}

function populateMemberSelect(selectEl, selectedId) {
  selectEl.innerHTML = "";
  for (const m of members) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.name;
    opt.selected = m.id === selectedId;
    selectEl.appendChild(opt);
  }
}

// ---------------------------------------------------------------------------
// Modulo identificazione - verifica o imposta la password prima di entrare nel calendario.
// ---------------------------------------------------------------------------

const gateName = el("gate-name");
const gateExistingPassword = el("gate-existing-password");
const gateNewPassword = el("gate-new-password");
const gatePassword = el("gate-password");
const gateNewPasswordInput = el("gate-new-password-input");
const gateNewPasswordConfirm = el("gate-new-password-confirm");

function resetLogin() {
  hideModalError("gate-error");
  hideModalError("gate-set-password-error");
  gatePassword.value = "";
  gateNewPasswordInput.value = "";
  gateNewPasswordConfirm.value = "";
  populateNameSelect(gateName);
  gateExistingPassword.classList.remove("hidden");
  gateNewPassword.classList.add("hidden");
}

gateName.addEventListener("change", () => {
  const member = membersById[gateName.value];
  hideModalError("gate-error");
  hideModalError("gate-set-password-error");
  if (!member) return;
  gateExistingPassword.classList.toggle("hidden", !member.has_pin);
  gateNewPassword.classList.toggle("hidden", member.has_pin);
});

el("gate-submit").addEventListener("click", async () => {
  const member = membersById[gateName.value];
  const pin = gatePassword.value.trim();
  if (!member) return showModalError("gate-error", "Scegli prima il tuo nome.");
  if (!pin) return showModalError("gate-error", "Inserisci la password.");

  const { data: ok, error } = await sb.rpc("verify_pin", {
    p_member_name: member.name,
    p_pin: pin,
  });
  if (error) return showModalError("gate-error", error.message);
  if (!ok) return showModalError("gate-error", "Password errata.");

  identity = { name: member.name, pin };
  enterApp();
});

el("gate-set-password-submit").addEventListener("click", async () => {
  const member = membersById[gateName.value];
  const pin = gateNewPasswordInput.value.trim();
  const confirmation = gateNewPasswordConfirm.value.trim();
  if (!member) return showModalError("gate-set-password-error", "Scegli prima il tuo nome.");
  if (pin.length < 4) return showModalError("gate-set-password-error", "La password deve avere almeno 4 caratteri.");
  if (pin !== confirmation) return showModalError("gate-set-password-error", "Le password non coincidono.");

  const { error } = await sb.rpc("set_pin", {
    p_member_name: member.name,
    p_pin: pin,
  });
  if (error) return showModalError("gate-set-password-error", error.message);

  member.has_pin = true;
  identity = { name: member.name, pin };
  enterApp();
});

// ---------------------------------------------------------------------------
// Gate di accesso / logout
// ---------------------------------------------------------------------------
function enterApp() {
  el("login-gate").classList.add("hidden");
  el("calendar-hero").classList.remove("hidden");
  el("calendar").classList.remove("hidden");
  renderIdentityBar();
  if (calendar) calendar.destroy();
  initCalendar();
}

function logout() {
  identity = null;
  pendingCheckinDate = null;
  if (calendar) {
    calendar.destroy();
    calendar = null;
  }
  el("calendar").classList.add("hidden");
  el("calendar-hero").classList.add("hidden");
  el("login-gate").classList.remove("hidden");
  resetLogin();
  renderIdentityBar();
}

function renderIdentityBar() {
  const bar = el("identity-bar");
  bar.innerHTML = "";
  const who = currentMember();
  if (!who) return;
  const label = document.createElement("span");
  label.textContent = `Accesso come ${who.name}${who.is_admin ? " (admin)" : ""}`;

  const logoutBtn = document.createElement("button");
  logoutBtn.textContent = "Esci";
  logoutBtn.className = "link-btn";
  logoutBtn.onclick = logout;

  bar.append(label, logoutBtn);
}

async function loadMembers() {
  const { data, error } = await sb.from("members_public").select("id, name, is_admin, has_pin").order("name");
  if (error) {
    showError("Impossibile caricare i familiari: " + error.message);
    el("login-gate").innerHTML = '<p class="hint">Impossibile connettersi - controlla config.js</p>';
    return false;
  }
  members = data;
  membersById = Object.fromEntries(members.map((m) => [m.id, m]));
  return true;
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

async function loadBookings() {
  const { data, error } = await sb.from("bookings").select("id, member_id, start_date, end_date, note");
  if (error) {
    showError("Impossibile caricare le prenotazioni: " + error.message);
    return;
  }

  bookingsCache = data;
  renderBookingFragments();
}

function bookingsForDate(dateStr) {
  return bookingsCache
    .filter((booking) => booking.start_date <= dateStr && dateStr <= booking.end_date)
    .sort((a, b) => a.start_date.localeCompare(b.start_date));
}

function renderBookingFragmentsForCell(cell, dateStr) {
  const frame = cell.querySelector(".fc-daygrid-day-frame");
  if (!frame) return;

  frame.querySelectorAll(".booking-strip").forEach((node) => node.remove());
  if (cell.classList.contains("fc-day-other")) return;

  const dayBookings = bookingsForDate(dateStr);
  if (!dayBookings.length) return;

  for (const booking of dayBookings) {
    const member = membersById[booking.member_id];
    const title = member ? member.name : "Sconosciuto";
    const startsHere = booking.start_date === dateStr;
    const endsHere = booking.end_date === dateStr;

    const strip = document.createElement("button");
    strip.type = "button";
    strip.className = "booking-strip";
    strip.style.setProperty("--strip-color", colorForMember(booking.member_id));
    strip.classList.toggle("starts-here", startsHere);
    strip.classList.toggle("ends-here", endsHere);

    const label = document.createElement("span");
    label.className = "booking-strip-label";
    label.textContent = startsHere ? title : "";
    strip.appendChild(label);

    strip.title = `${title}: ${booking.start_date} -> ${booking.end_date}`;
    strip.addEventListener("click", (event) => {
      event.stopPropagation();
      openBookingDetails(booking);
    });
    frame.appendChild(strip);
  }
}

function renderBookingFragments() {
  if (!calendar) return;
  el("calendar").querySelectorAll(".fc-daygrid-day[data-date]").forEach((cell) => {
    const dateStr = cell.getAttribute("data-date");
    if (dateStr) renderBookingFragmentsForCell(cell, dateStr);
  });
}

function mountBookingCell(info) {
  if (info.isOther) return;
  const dateStr = info.el.getAttribute("data-date");
  if (dateStr) renderBookingFragmentsForCell(info.el, dateStr);
}

function renderClickSelection(checkoutDate = null) {
  if (!calendar) return;
  el("calendar").querySelectorAll(".fc-daygrid-day:not(.fc-day-other)").forEach((cell) => {
    const dateStr = cell.getAttribute("data-date");
    cell.classList.remove("pending-checkin", "pending-checkout", "pending-between");
    if (!pendingCheckinDate || !dateStr) return;

    if (dateStr === pendingCheckinDate) {
      cell.classList.add("pending-checkin");
    } else if (checkoutDate && dateStr === checkoutDate) {
      cell.classList.add("pending-checkout");
    } else if (checkoutDate && pendingCheckinDate < dateStr && dateStr < checkoutDate) {
      cell.classList.add("pending-between");
    }
  });
}

function clearClickSelection() {
  pendingCheckinDate = null;
  renderClickSelection();
}

function isSelectableCheckin(dateStr) {
  return !bookingsCache.some((b) => b.start_date <= dateStr && dateStr < b.end_date);
}

function hasBookingOverlap(start, end) {
  return bookingsCache.some((b) => rangesOverlap(start, end, b.start_date, b.end_date));
}

function validateBookingDates(start, end, errorId) {
  if (!start || !end) {
    showModalError(errorId, "Scegli le date di inizio e fine.");
    return false;
  }
  if (end <= start) {
    showModalError(errorId, "La data di check-out deve essere successiva a quella di check-in.");
    return false;
  }
  return true;
}

function onDateClick(info) {
  const clickedDate = info.dateStr.slice(0, 10);

  if (!pendingCheckinDate) {
    if (!isSelectableCheckin(clickedDate)) {
      showError("Questo giorno e gia occupato: scegli un giorno libero per il check-in.");
      return;
    }
    pendingCheckinDate = clickedDate;
    renderClickSelection();
    return;
  }

  if (clickedDate <= pendingCheckinDate) {
    if (!isSelectableCheckin(clickedDate)) {
      showError("Questo giorno e gia occupato: scegli un giorno libero per il check-in.");
      return;
    }
    pendingCheckinDate = clickedDate;
    renderClickSelection();
    return;
  }

  if (hasBookingOverlap(pendingCheckinDate, clickedDate)) {
    showError("Queste date si sovrappongono a una prenotazione esistente.");
    renderClickSelection(clickedDate);
    return;
  }

  renderClickSelection(clickedDate);
  openBookingModal(pendingCheckinDate, clickedDate);
}

function initCalendar() {
  calendar = new FullCalendar.Calendar(el("calendar"), {
    initialView: "multiMonthYear",
    locale: "it",
    buttonText: { today: "Oggi" },
    titleFormat: (date) => capitalizeFirst(date.date.marker.toLocaleDateString("it-CH", { month: "long", year: "numeric" })),
    dayHeaderContent: (info) => capitalizeFirst(info.text),
    height: "auto",
    selectable: false,
    dateIncrement: { months: 1 },
    headerToolbar: { left: "prev,next today", center: "title", right: "" },
    views: {
      multiMonthYear: {
        type: "multiMonth",
        duration: { months: 12 },
        multiMonthMaxColumns: 1,
        multiMonthTitleFormat: (date) => capitalizeFirst(date.date.marker.toLocaleDateString("it-CH", { month: "long", year: "numeric" })),
      },
    },
    dateClick: onDateClick,
    dayCellDidMount: mountBookingCell,
    datesSet: clearClickSelection,
  });
  calendar.render();
  loadBookings();
}

// ---------------------------------------------------------------------------
// Modale nuova prenotazione
// ---------------------------------------------------------------------------

function openBookingModal(startStr, endStr) {
  const me = currentMember();
  hideModalError("booking-error");
  el("booking-note").value = "";
  el("booking-start").value = startStr.slice(0, 10);
  el("booking-end").value = endStr.slice(0, 10);
  el("booking-member-label").classList.toggle("hidden", !(me && me.is_admin));
  if (me && me.is_admin) populateMemberSelect(el("booking-member"), me.id);
  el("booking-modal").classList.remove("hidden");
}

function closeBookingModal() {
  el("booking-modal").classList.add("hidden");
  clearClickSelection();
}

el("booking-cancel").addEventListener("click", closeBookingModal);

el("booking-submit").addEventListener("click", async () => {
  if (!identity) return;
  const start = el("booking-start").value;
  const end = el("booking-end").value;
  const note = el("booking-note").value.trim();
  const me = currentMember();
  const targetMember = me && me.is_admin ? membersById[el("booking-member").value] : me;

  if (!validateBookingDates(start, end, "booking-error")) return;
  if (!targetMember) return showModalError("booking-error", "Scegli per chi creare la prenotazione.");

  const rpcName = me && me.is_admin && targetMember.id !== me.id ? "add_booking_for_member" : "add_booking";
  const rpcArgs = rpcName === "add_booking_for_member"
    ? {
        p_actor_member_name: identity.name,
        p_pin: identity.pin,
        p_target_member_name: targetMember.name,
        p_start: start,
        p_end: end,
        p_note: note || null,
      }
    : {
        p_member_name: identity.name,
        p_pin: identity.pin,
        p_start: start,
        p_end: end,
        p_note: note || null,
      };

  const { error } = await sb.rpc(rpcName, rpcArgs);

  if (error) return showModalError("booking-error", error.message);

  closeBookingModal();
  await loadBookings();
});

// ---------------------------------------------------------------------------
// Modale visualizza / modifica / elimina prenotazione
// ---------------------------------------------------------------------------

let openEventId = null;

function openBookingDetails(booking) {
  clearClickSelection();
  openEventId = booking.id;
  hideModalError("event-error");

  const member = membersById[booking.member_id];
  const start = booking.start_date;
  const end = booking.end_date;

  el("event-title").textContent = member ? member.name : "Sconosciuto";
  el("event-dates").textContent = `${start} -> ${end} (giorno di check-out)`;
  el("event-note").textContent = booking.note ? `Nota: ${booking.note}` : "Nessuna nota.";

  el("event-edit-fields").classList.add("hidden");
  el("event-edit-start").value = start;
  el("event-edit-end").value = end;
  el("event-edit-note").value = booking.note || "";

  const me = currentMember();
  const canManage = me && (me.id === booking.member_id || me.is_admin);
  el("event-edit-btn").classList.toggle("hidden", !canManage);
  el("event-delete-btn").classList.toggle("hidden", !canManage);
  el("event-save-btn").classList.add("hidden");

  el("event-modal").classList.remove("hidden");
}

el("event-close-btn").addEventListener("click", () => {
  el("event-modal").classList.add("hidden");
  openEventId = null;
});

el("event-edit-btn").addEventListener("click", () => {
  el("event-edit-fields").classList.remove("hidden");
  el("event-edit-btn").classList.add("hidden");
  el("event-save-btn").classList.remove("hidden");
});

el("event-save-btn").addEventListener("click", async () => {
  if (!openEventId || !identity) return;
  const start = el("event-edit-start").value;
  const end = el("event-edit-end").value;
  if (!validateBookingDates(start, end, "event-error")) return;
  const { error } = await sb.rpc("update_booking", {
    p_booking_id: openEventId,
    p_member_name: identity.name,
    p_pin: identity.pin,
    p_start: start,
    p_end: end,
    p_note: el("event-edit-note").value.trim() || null,
  });
  if (error) return showModalError("event-error", error.message);

  el("event-modal").classList.add("hidden");
  openEventId = null;
  await loadBookings();
});

el("event-delete-btn").addEventListener("click", async () => {
  if (!openEventId || !identity) return;
  if (!confirm("Eliminare questa prenotazione?")) return;

  const { error } = await sb.rpc("delete_booking", {
    p_booking_id: openEventId,
    p_member_name: identity.name,
    p_pin: identity.pin,
  });
  if (error) return showModalError("event-error", error.message);

  el("event-modal").classList.add("hidden");
  openEventId = null;
  await loadBookings();
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

(async function init() {
  if (!(await loadMembers())) return;
  renderIdentityBar();
  resetLogin();
})();
