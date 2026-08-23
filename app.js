// Calendario Casa di Famiglia - logica dell'app.
// Parla direttamente con Supabase (vedi config.js + supabase/schema.sql). Nessun build step.

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const IDENTITY_KEY = "familyCalendar.identity";

// 8 tinte validate per accessibilita (color-blind safe), ciascuna in due
// tonalita (chiara/scura) per ottenere 16 colori distinguibili - a >16
// persone i colori si ripetono, ma il nome e sempre scritto sull'evento,
// quindi l'identita non dipende mai dal solo colore.
const COLOR_PALETTE = [
  "#2a78d6", "#eb6834", "#1baf7a", "#eda100",
  "#e87ba4", "#008300", "#4a3aa7", "#e34948",
  "#3987e5", "#d95926", "#199e70", "#c98500",
  "#d55181", "#008300", "#9085e9", "#e66767",
];

let members = [];      // [{id, name, is_admin, has_pin}]
let membersById = {};  // id -> member
let identity = loadIdentity(); // {name, pin/password} | null
let calendar = null;
let bookingsCache = []; // ultime prenotazioni caricate, per il controllo di sovrapposizione lato client
let pendingCheckinDate = null;
let resizeTimer = null;
let calendarResizeObserver = null;

const el = (id) => document.getElementById(id);

function loadIdentity() {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function saveIdentity(name, pin, remember) {
  identity = { name, pin };
  if (remember) {
    localStorage.setItem(IDENTITY_KEY, JSON.stringify(identity));
  } else {
    localStorage.removeItem(IDENTITY_KEY);
  }
}

function currentMember() {
  if (!identity) return null;
  return members.find((m) => m.name === identity.name) || null;
}

function colorForMember(memberId) {
  const idx = members.findIndex((m) => m.id === memberId);
  return COLOR_PALETTE[Math.max(idx, 0) % COLOR_PALETTE.length];
}

function shiftDate(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function compareDates(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

function rangesOverlap(startA, endA, startB, endB) {
  return startA < endB && startB < endA;
}

function daysBetween(startStr, endStr) {
  const start = new Date(startStr + "T00:00:00Z");
  const end = new Date(endStr + "T00:00:00Z");
  return Math.max(1, Math.round((end - start) / 86400000));
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
  for (const m of members.filter((member) => !member.is_admin)) {
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

function setupIdentifyUI(ids) {
  const nameSelect = el(ids.name);
  const existingBlock = el(ids.existingBlock);
  const newBlock = el(ids.newBlock);
  const pinInput = el(ids.pin);
  const rememberCheckbox = el(ids.remember);
  const errorEl = ids.error;
  const newPinInput = el(ids.newPin);
  const newPinConfirmInput = el(ids.newPinConfirm);
  const setPinErrorEl = ids.setPinError;
  const submitBtn = el(ids.submit);
  const setPinBtn = el(ids.setPinSubmit);

  nameSelect.addEventListener("change", () => {
    const member = membersById[nameSelect.value];
    hideModalError(errorEl);
    hideModalError(setPinErrorEl);
    if (!member) return;
    existingBlock.classList.toggle("hidden", !member.has_pin);
    newBlock.classList.toggle("hidden", member.has_pin);
  });

  submitBtn.addEventListener("click", async () => {
    const member = membersById[nameSelect.value];
    const pin = pinInput.value.trim();
    if (!member) return showModalError(errorEl, "Scegli prima il tuo nome.");
    if (!pin) return showModalError(errorEl, "Inserisci la password.");

    const { data: ok, error } = await sb.rpc("verify_pin", { p_member_name: member.name, p_pin: pin });
    if (error) return showModalError(errorEl, error.message);
    if (!ok) return showModalError(errorEl, "Password errata.");

    saveIdentity(member.name, pin, rememberCheckbox.checked);
    ids.onSuccess();
  });

  setPinBtn.addEventListener("click", async () => {
    const member = membersById[nameSelect.value];
    const pin = newPinInput.value.trim();
    const confirmPin = newPinConfirmInput.value.trim();
    if (!member) return showModalError(setPinErrorEl, "Scegli prima il tuo nome.");
    if (pin.length < 6) return showModalError(setPinErrorEl, "La password deve avere almeno 6 caratteri.");
    if (pin !== confirmPin) return showModalError(setPinErrorEl, "Le password non coincidono.");

    const { error } = await sb.rpc("set_pin", { p_member_name: member.name, p_pin: pin });
    if (error) return showModalError(setPinErrorEl, error.message);

    member.has_pin = true;
    saveIdentity(member.name, pin, rememberCheckbox.checked);
    ids.onSuccess();
  });

  return {
    reset() {
      hideModalError(errorEl);
      hideModalError(setPinErrorEl);
      pinInput.value = "";
      newPinInput.value = "";
      newPinConfirmInput.value = "";
      populateNameSelect(nameSelect);
      existingBlock.classList.remove("hidden");
      newBlock.classList.add("hidden");
    },
  };
}

const gateUI = setupIdentifyUI({
  name: "gate-name",
  existingBlock: "gate-existing-password",
  newBlock: "gate-new-password",
  pin: "gate-password",
  remember: "gate-remember",
  error: "gate-error",
  newPin: "gate-new-password-input",
  newPinConfirm: "gate-new-password-confirm",
  setPinError: "gate-set-password-error",
  submit: "gate-submit",
  setPinSubmit: "gate-set-password-submit",
  onSuccess: enterApp,
});


// ---------------------------------------------------------------------------
// Gate di accesso / logout - il calendario e visibile solo dopo l'identificazione.
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
  localStorage.removeItem(IDENTITY_KEY);
  if (calendar) {
    calendar.destroy();
    calendar = null;
  }
  el("calendar").classList.add("hidden");
  el("calendar-hero").classList.add("hidden");
  el("login-gate").classList.remove("hidden");
  gateUI.reset();
  renderIdentityBar();
}

function renderIdentityBar() {
  const bar = el("identity-bar");
  bar.innerHTML = "";
  if (!identity || !currentMember()) return;

  const who = currentMember();
  const label = document.createElement("span");
  label.textContent = `Accesso come ${who.name}${who.is_admin ? " (admin)" : ""}`;


  const logoutBtn = document.createElement("button");
  logoutBtn.textContent = "Esci";
  logoutBtn.className = "link-btn";
  logoutBtn.onclick = () => logout();

  bar.append(label, logoutBtn);
}

async function loadMembers() {
  const { data, error } = await sb.from("members_public").select("*").order("name");
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

async function fetchEvents(fetchInfo, successCallback, failureCallback) {
  const { data, error } = await sb.from("bookings").select("*");
  if (error) {
    showError("Impossibile caricare le prenotazioni: " + error.message);
    failureCallback(error);
    return;
  }

  bookingsCache = data;

  const events = [];
  for (const b of data) {
    const member = membersById[b.member_id];
    const color = colorForMember(b.member_id);

    events.push({
      id: b.id,
      title: (member ? member.name : "Sconosciuto") + (b.note ? `: ${b.note}` : ""),
      start: b.start_date,
      end: b.end_date,
      display: "none",
      backgroundColor: color,
      borderColor: color,
      extendedProps: { memberId: b.member_id, note: b.note || "", realStart: b.start_date, realEnd: b.end_date },
    });
  }
  successCallback(events);
  requestAnimationFrame(renderCalendarOverlays);
}

function bookingsForDay(dateStr) {
  return bookingsCache
    .filter((b) => compareDates(b.start_date, dateStr) <= 0 && compareDates(dateStr, b.end_date) <= 0)
    .sort((a, b) => compareDates(a.start_date, b.start_date) || compareDates(a.end_date, b.end_date));
}

function renderBookingBars() {
  if (!calendar) return;
  const calendarEl = el("calendar");
  const calendarRect = calendarEl.getBoundingClientRect();
  document.querySelectorAll(".booking-strip").forEach((node) => node.remove());
  document.querySelectorAll(".fc-daygrid-day-frame").forEach((frame) => frame.classList.remove("has-booking-strips"));

  for (const booking of bookingsCache) {
    const member = membersById[booking.member_id];
    const title = member ? member.name : "Sconosciuto";
    const cells = Array.from(document.querySelectorAll(".fc-daygrid-day[data-date]"))
      .map((cell) => ({ cell, date: cell.getAttribute("data-date") }))
      .filter((item) => booking.start_date <= item.date && item.date <= booking.end_date)
      .sort((a, b) => compareDates(a.date, b.date));

    cells.forEach(({ cell }) => {
      const frame = cell.querySelector(".fc-daygrid-day-frame");
      if (frame) frame.classList.add("has-booking-strips");
    });

    let segment = [];
    let segmentRow = null;
    const segments = [];
    for (const item of cells) {
      const row = Math.round(item.cell.getBoundingClientRect().top);
      if (segment.length && row !== segmentRow) {
        segments.push(segment);
        segment = [];
      }
      segment.push(item);
      segmentRow = row;
    }
    if (segment.length) segments.push(segment);

    segments.forEach((items, index) => {
      const first = items[0];
      const last = items[items.length - 1];
      const firstRect = first.cell.getBoundingClientRect();
      const lastRect = last.cell.getBoundingClientRect();
      const startsHere = first.date === booking.start_date;
      const endsHere = last.date === booking.end_date;
      const leftEdge = startsHere ? firstRect.left + firstRect.width / 2 : firstRect.left;
      const rightEdge = endsHere ? lastRect.left + lastRect.width / 2 : lastRect.right;

      const strip = document.createElement("button");
      strip.type = "button";
      strip.className = "booking-strip";
      strip.style.setProperty("--strip-color", colorForMember(booking.member_id));
      strip.style.left = `${leftEdge - calendarRect.left}px`;
      strip.style.top = `${firstRect.top - calendarRect.top + 32}px`;
      strip.style.width = `${Math.max(24, rightEdge - leftEdge)}px`;
      strip.classList.toggle("starts-here", startsHere);
      strip.classList.toggle("ends-here", endsHere);

      const label = document.createElement("span");
      label.className = "booking-strip-label";
      label.textContent = index === 0 ? title : "";
      strip.appendChild(label);

      strip.title = `${title}: ${booking.start_date} -> ${booking.end_date}`;
      strip.addEventListener("click", (event) => {
        event.stopPropagation();
        openBookingDetails(booking);
      });
      calendarEl.appendChild(strip);
    });
  }
}

function renderClickSelection(checkoutDate = null) {
  document.querySelectorAll(".fc-daygrid-day").forEach((cell) => {
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

function renderCalendarOverlays() {
  renderBookingBars();
  renderClickSelection();
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
    events: fetchEvents,
    dateClick: onDateClick,
    eventClick: onEventClick,
    datesSet: () => scheduleCalendarOverlayRender(),
  });
  calendar.render();
  if (calendarResizeObserver) calendarResizeObserver.disconnect();
  if ("ResizeObserver" in window) {
    calendarResizeObserver = new ResizeObserver(() => scheduleCalendarOverlayRender());
    calendarResizeObserver.observe(el("calendar"));
  }
  scheduleCalendarOverlayRender();
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

  if (!start || !end) return showModalError("booking-error", "Scegli le date di inizio e fine.");
  if (end <= start) return showModalError("booking-error", "La data di check-out deve essere successiva a quella di check-in.");
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
  calendar.refetchEvents();
});

// ---------------------------------------------------------------------------
// Modale visualizza / modifica / elimina prenotazione
// ---------------------------------------------------------------------------

let openEventId = null;

function onEventClick(info) {
  const booking = bookingsCache.find((b) => b.id === info.event.id);
  if (booking) openBookingDetails(booking);
}

function openBookingDetails(booking) {
  openEventId = booking.id;
  hideModalError("event-error");

  const member = membersById[booking.member_id];
  const start = booking.start_date;
  const end = booking.end_date;

  el("event-title").textContent = member ? member.name : "Sconosciuto";
  el("event-dates").textContent = `${start} -> ${end} (giorno di check-out)`;
  el("event-note").textContent = booking.note || "";

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
  const { error } = await sb.rpc("update_booking", {
    p_booking_id: openEventId,
    p_member_name: identity.name,
    p_pin: identity.pin,
    p_start: el("event-edit-start").value,
    p_end: el("event-edit-end").value,
    p_note: el("event-edit-note").value.trim() || null,
  });
  if (error) return showModalError("event-error", error.message);

  el("event-modal").classList.add("hidden");
  openEventId = null;
  calendar.refetchEvents();
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
  calendar.refetchEvents();
});

function scheduleCalendarOverlayRender() {
  if (!calendar) return;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (!calendar) return;
    calendar.updateSize();
    requestAnimationFrame(() => requestAnimationFrame(renderCalendarOverlays));
  }, 120);
}


window.addEventListener("resize", scheduleCalendarOverlayRender);
// ---------------------------------------------------------------------------
// Avvio
// ---------------------------------------------------------------------------

(async function init() {
  const ok = await loadMembers();
  if (!ok) return;

  renderIdentityBar();
  gateUI.reset();

  // Se c'e un'identita ricordata, verifichiamo che la password sia ancora valida
  // (potrebbe essere stato azzerato da un admin) prima di aprire il calendario.
  if (identity && currentMember()) {
    const { data: valid } = await sb.rpc("verify_pin", {
      p_member_name: identity.name,
      p_pin: identity.pin,
    });
    if (valid) {
      enterApp();
      return;
    }
    identity = null;
    localStorage.removeItem(IDENTITY_KEY);
  }
})();

