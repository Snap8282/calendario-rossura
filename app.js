// Calendario Casa di Famiglia - logica dell'app.
// Parla direttamente con Supabase (vedi config.js + supabase/schema.sql). Nessun build step.

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// 16 colori volutamente diversi per distinguere meglio le prenotazioni.
// L'admin usa sempre il grigio.
const ADMIN_COLOR = "#6b7280";
const BOOKING_OVERLAP_MESSAGE = "Queste date si sovrappongono a una prenotazione esistente. Scegli un altro intervallo.";
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
let sessionVersion = 0;
let bookingLoadVersion = 0;
let bookingLoadController = null;
let bookingsReady = false;
let visibleRange = null;
let refreshTimer = null;
let modalVersion = 0;
const busyActions = new Map();
const ACTION_CONTROLS = {
  login: ['gate-name', 'gate-password', 'gate-new-password-input', 'gate-new-password-confirm', 'gate-submit', 'gate-set-password-submit'],
  booking: ['booking-start', 'booking-end', 'booking-note', 'booking-member', 'booking-submit', 'booking-cancel'],
  event: ['event-edit-start', 'event-edit-end', 'event-edit-note', 'event-edit-btn', 'event-save-btn', 'event-delete-btn', 'event-close-btn'],
};

const el = (id) => document.getElementById(id);
const dialogFocus = new Map();

async function requestRpc(name, args) {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await sb.rpc(name, args).abortSignal(controller.signal);
    if (controller.signal.aborted) throw new Error('Richiesta interrotta. Verifica le prenotazioni con Aggiorna prima di riprovare.');
    return response;
  } finally { clearTimeout(deadline); }
}

function showDialog(id, focusId) {
  dialogFocus.set(id, document.activeElement);
  el(id).classList.remove('hidden');
  el(focusId).focus();
}

function hideDialog(id) {
  const wasOpen = !el(id).classList.contains('hidden');
  el(id).classList.add('hidden');
  const previous = dialogFocus.get(id);
  dialogFocus.delete(id);
  if (wasOpen && previous && previous.isConnected) previous.focus();
}

async function runAction(group, errorId, action) {
  if (busyActions.has(group)) return;
  const token = {};
  const session = sessionVersion;
  const dialog = modalVersion;
  const isCurrent = () => session === sessionVersion && (group === 'login' || dialog === modalVersion);
  busyActions.set(group, token);
  ACTION_CONTROLS[group].forEach(id => { el(id).disabled = true; });
  hideModalError(errorId);
  try {
    await action(isCurrent);
  } catch (error) {
    if (isCurrent()) showModalError(errorId, error.message || 'Impossibile connettersi. Riprova.');
  } finally {
    if (busyActions.get(group) === token) {
      busyActions.delete(group);
      ACTION_CONTROLS[group].forEach(id => { el(id).disabled = false; });
      if (group === 'booking' && !el('booking-modal').classList.contains('hidden')) updateBookingValidation(false);
    }
  }
}

function setBookingStatus(message, ready = false) {
  bookingsReady = ready;
  el('booking-status').textContent = message;
  el('calendar-controls').classList.toggle('hidden', !identity);
}

function refreshBookings() {
  if (!identity || !calendar || bookingLoadController || document.visibilityState === 'hidden' || busyActions.has('booking') || busyActions.has('event') ||
      !el('booking-modal').classList.contains('hidden') || !el('event-modal').classList.contains('hidden')) return;
  return loadBookings();
}

el('refresh-bookings').addEventListener('click', () => loadBookings());
window.addEventListener('focus', refreshBookings);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshBookings();
});

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

function formatSwissDate(value) {
  const [year, month, day] = value.split("-");
  return `${day}.${month}.${year}`;
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
  gatePassword.value = '';
  gateNewPasswordInput.value = '';
  gateNewPasswordConfirm.value = '';
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

  await runAction('login', 'gate-error', async isCurrent => {
    const { data: ok, error } = await requestRpc("verify_pin", {
      p_member_name: member.name,
      p_pin: pin,
    });
    if (!isCurrent()) return;
    if (error) return showModalError("gate-error", error.message);
    if (!ok) return showModalError("gate-error", "Password errata.");

    identity = { name: member.name, pin };
    enterApp();
  });
});

el("gate-set-password-submit").addEventListener("click", async () => {
  const member = membersById[gateName.value];
  const pin = gateNewPasswordInput.value.trim();
  const confirmation = gateNewPasswordConfirm.value.trim();
  if (!member) return showModalError("gate-set-password-error", "Scegli prima il tuo nome.");
  if (pin.length < 4) return showModalError("gate-set-password-error", "La password deve avere almeno 4 caratteri.");
  if (pin !== confirmation) return showModalError("gate-set-password-error", "Le password non coincidono.");

  await runAction('login', 'gate-set-password-error', async isCurrent => {
    const { error } = await requestRpc("set_pin", {
      p_member_name: member.name,
      p_pin: pin,
    });
    if (!isCurrent()) return;
    if (error) return showModalError("gate-set-password-error", error.message);

    member.has_pin = true;
    identity = { name: member.name, pin };
    enterApp();
  });
});

// ---------------------------------------------------------------------------
// Gate di accesso / logout
// ---------------------------------------------------------------------------
function enterApp() {
  sessionVersion++;
  bookingLoadVersion++;
  bookingsCache = [];
  bookingsReady = false;
  gatePassword.value = '';
  gateNewPasswordInput.value = '';
  gateNewPasswordConfirm.value = '';
  el("login-gate").classList.add("hidden");
  el("calendar-hero").classList.remove("hidden");
  el("calendar").classList.remove("hidden");
  renderIdentityBar();
  if (calendar) calendar.destroy();
  initCalendar();
  clearInterval(refreshTimer);
  refreshTimer = setInterval(refreshBookings, 60000);
}

function logout() {
  sessionVersion++;
  bookingLoadVersion++;
  if (bookingLoadController) bookingLoadController.abort();
  bookingLoadController = null;
  identity = null;
  bookingsCache = [];
  bookingsReady = false;
  visibleRange = null;
  clearInterval(refreshTimer);
  refreshTimer = null;
  closeBookingModal();
  closeBookingDetails();
  for (const group of busyActions.keys()) ACTION_CONTROLS[group].forEach(id => { el(id).disabled = false; });
  busyActions.clear();
  el('calendar-controls').classList.add('hidden');
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
  // Keep the server's alphabetical order, with admin accounts after family members.
  members = [...data].sort((a, b) => Number(a.is_admin) - Number(b.is_admin));
  membersById = Object.fromEntries(members.map((m) => [m.id, m]));
  return true;
}

// ---------------------------------------------------------------------------
// Calendario
// ---------------------------------------------------------------------------

async function loadBookings() {
  if (!identity || !calendar || !visibleRange) return false;
  const session = sessionVersion;
  const request = ++bookingLoadVersion;
  if (bookingLoadController) bookingLoadController.abort();
  const controller = new AbortController();
  bookingLoadController = controller;
  const deadline = setTimeout(() => controller.abort(), 20000);
  const range = {...visibleRange};
  const current = () => session === sessionVersion && request === bookingLoadVersion;
  setBookingStatus('Aggiornamento prenotazioni…');
  el('refresh-bookings').disabled = true;
  try {
    const rows = [];
    // Always read until an empty page, even if the server's row cap is below 500.
    // Offset advances by actual returned rows rather than the requested page size.
    let offset = 0;
    while (true) {
      const {data, error} = await sb.from('bookings')
        .select('id, member_id, start_date, end_date, note')
        .lte('start_date', range.end).gte('end_date', range.start)
        .order('id').abortSignal(controller.signal).range(offset, offset + 499);
      if (!current()) return false;
      if (error) throw error;
      if (!Array.isArray(data)) throw new Error('Risposta non valida.');
      if (!data.length) break;
      rows.push(...data);
      offset += data.length;
    }
    // Publish a complete result only; failed pagination never replaces the cache.
    bookingsCache = [...new Map(rows.map(row => [row.id, row])).values()];
    renderBookingFragments();
    setBookingStatus('Prenotazioni aggiornate alle ' + new Date().toLocaleTimeString('it-CH', {hour: '2-digit', minute: '2-digit'}), true);
    return true;
  } catch (error) {
    if (current()) {
      clearClickSelection();
      setBookingStatus('Impossibile aggiornare le prenotazioni. I dati possono essere incompleti o non aggiornati. Premi Aggiorna per riprovare.');
    }
    return false;
  } finally {
    clearTimeout(deadline);
    if (current()) {
      bookingLoadController = null;
      el('refresh-bookings').disabled = false;
    }
  }
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

document.addEventListener("keydown", (event) => {
  const bookingOpen = !el('booking-modal').classList.contains('hidden');
  const eventOpen = !el('event-modal').classList.contains('hidden');
  if (event.key === 'Escape') {
    if (bookingOpen && !busyActions.has('booking')) closeBookingModal();
    else if (eventOpen && !busyActions.has('event')) closeBookingDetails();
    else if (!bookingOpen && !eventOpen) clearClickSelection();
  }
  if (event.key === 'Tab' && (bookingOpen || eventOpen)) {
    const dialog = el(bookingOpen ? 'booking-modal' : 'event-modal');
    const focusable = [...dialog.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled)')].filter(node => node.offsetParent !== null);
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || !dialog.contains(document.activeElement))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (document.activeElement === last || !dialog.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
  }
  if (event.key === 'Enter' && event.target.tagName === 'INPUT') {
    event.preventDefault();
    if (!identity) el(gateNewPassword.classList.contains('hidden') ? 'gate-submit' : 'gate-set-password-submit').click();
    else if (bookingOpen) el('booking-submit').click();
    else if (eventOpen && !el('event-edit-fields').classList.contains('hidden')) el('event-save-btn').click();
  }
});

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
  if (!identity || !bookingsReady) {
    showError('Attendi un aggiornamento riuscito delle prenotazioni prima di scegliere le date.');
    return;
  }
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
    datesSet: info => {
      clearClickSelection();
      // Calendar date strings preserve the user's local calendar dates (no UTC conversion).
      visibleRange = {start: info.startStr.slice(0, 10), end: info.endStr.slice(0, 10)};
      loadBookings();
    },
  });
  calendar.render();
}

// ---------------------------------------------------------------------------
// Modale nuova prenotazione
// ---------------------------------------------------------------------------

function bookingErrorMessage(error) {
  return error.code === '23P01' || /Those dates overlap with an existing booking/i.test(error.message || '')
    ? BOOKING_OVERLAP_MESSAGE : error.message;
}

function updateBookingValidation(clearError = true) {
  const start = el('booking-start').value;
  const end = el('booking-end').value;
  let message = '';
  if (!start || !end) message = 'Scegli le date di inizio e fine.';
  else if (end <= start) message = 'La data di check-out deve essere successiva a quella di check-in.';
  else if (hasBookingOverlap(start, end)) message = BOOKING_OVERLAP_MESSAGE;
  el('booking-submit').disabled = Boolean(message) || !bookingsReady || busyActions.has('booking');
  if (message) showModalError('booking-error', message);
  else if (clearError) hideModalError('booking-error');
  return !message && bookingsReady;
}

['booking-start', 'booking-end'].forEach(id => {
  el(id).addEventListener('input', () => updateBookingValidation());
  el(id).addEventListener('change', () => updateBookingValidation());
});

function openBookingModal(startStr, endStr) {
  if (!identity || !bookingsReady) return;
  modalVersion++;
  const me = currentMember();
  hideModalError("booking-error");
  el("booking-note").value = "";
  el("booking-start").value = startStr.slice(0, 10);
  el("booking-end").value = endStr.slice(0, 10);
  el("booking-member-label").classList.toggle("hidden", !(me && me.is_admin));
  if (me && me.is_admin) populateMemberSelect(el("booking-member"), me.id);
  updateBookingValidation();
  showDialog('booking-modal', 'booking-start');
}

function closeBookingModal() {
  modalVersion++;
  hideDialog('booking-modal');
  clearClickSelection();
}

el("booking-cancel").addEventListener("click", closeBookingModal);

el("booking-submit").addEventListener("click", async () => {
  if (!identity || !bookingsReady) return;
  const start = el("booking-start").value;
  const end = el("booking-end").value;
  const note = el("booking-note").value.trim();
  const me = currentMember();
  const targetMember = me && me.is_admin ? membersById[el("booking-member").value] : me;

  if (!updateBookingValidation()) return;
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

  await runAction('booking', 'booking-error', async isCurrent => {
    const { error } = await requestRpc(rpcName, rpcArgs);
    if (!isCurrent()) return;

    if (error) return showModalError("booking-error", bookingErrorMessage(error));

    closeBookingModal();
    await loadBookings();
  });
});

// ---------------------------------------------------------------------------
// Modale visualizza / modifica / elimina prenotazione
// ---------------------------------------------------------------------------

let openEventId = null;

function openBookingDetails(booking) {
  if (!identity) return;
  modalVersion++;
  clearClickSelection();
  openEventId = booking.id;
  hideModalError("event-error");

  const member = membersById[booking.member_id];
  const start = booking.start_date;
  const end = booking.end_date;

  el("event-title").textContent = member ? member.name : "Sconosciuto";
  el("event-dates").textContent = `Check-in: ${formatSwissDate(start)}\nCheck-out: ${formatSwissDate(end)}`;
  const note = (booking.note || "").trim();
  el("event-note").textContent = note;
  el("event-note").classList.toggle("hidden", !note);

  el("event-edit-fields").classList.add("hidden");
  el("event-edit-start").value = start;
  el("event-edit-end").value = end;
  el("event-edit-note").value = booking.note || "";

  const me = currentMember();
  const canManage = me && (me.id === booking.member_id || me.is_admin);
  el("event-edit-btn").classList.toggle("hidden", !canManage);
  el("event-delete-btn").classList.toggle("hidden", !canManage);
  el("event-save-btn").classList.add("hidden");

  showDialog('event-modal', 'event-close-btn');
}

function closeBookingDetails() {
  modalVersion++;
  hideDialog('event-modal');
  openEventId = null;
}
el("event-close-btn").addEventListener("click", closeBookingDetails);

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
  await runAction('event', 'event-error', async isCurrent => {
    const { error } = await requestRpc("update_booking", {
      p_booking_id: openEventId,
      p_member_name: identity.name,
      p_pin: identity.pin,
      p_start: start,
      p_end: end,
      p_note: el("event-edit-note").value.trim() || null,
    });
    if (!isCurrent()) return;
    if (error) return showModalError("event-error", bookingErrorMessage(error));

    closeBookingDetails();
    await loadBookings();
  });
});

el("event-delete-btn").addEventListener("click", async () => {
  if (!openEventId || !identity) return;
  if (!confirm("Eliminare questa prenotazione?")) return;

  await runAction('event', 'event-error', async isCurrent => {
    const { error } = await requestRpc("delete_booking", {
      p_booking_id: openEventId,
      p_member_name: identity.name,
      p_pin: identity.pin,
    });
    if (!isCurrent()) return;
    if (error) return showModalError("event-error", error.message);

    closeBookingDetails();
    await loadBookings();
  });
});

// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

(async function init() {
  if (!(await loadMembers())) return;
  renderIdentityBar();
  resetLogin();
})();
