import React, { useEffect, useState, useMemo, useRef } from "react";
import appwriteClient from "./appwriteClient";
import "./App.css";

const DB_ID = import.meta.env.VITE_APPWRITE_DATABASE_ID;
const COLLECTION_ID = import.meta.env.VITE_APPWRITE_COLLECTION_ID;

// helper to read potential variant field names from document data
function getField(doc, ...names) {
  if (!doc) return undefined;
  const data = doc.data || doc;
  for (const n of names) {
    if (n in data) return data[n];
  }
  return undefined;
}

function formatDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString();
}

function App() {
  const [docs, setDocs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [globalError, setGlobalError] = useState(null);

  // form state matching DB schema
  const emptyForm = { CARD_HOLDER_NAME: "", LAST_FOUR_NO: "", LAST_DEPOSIT_DATE: "", MONTHS_NAME: "", COUNT_LEFT: "" };
  const [form, setForm] = useState(emptyForm);
  const [fieldErrors, setFieldErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [recentAddedId, setRecentAddedId] = useState(null);

  // edit state
  const [editingId, setEditingId] = useState(null);
  // flip card state for preview <-> form
  const [flipped, setFlipped] = useState(false);
  const touchStartX = useRef(null);
  const touchDelta = 50; // px to detect swipe

  // search/filter — use a debounced input to avoid filtering on every keystroke
  const [q, setQ] = useState(""); // debounced query used for filtering
  const [qInput, setQInput] = useState(""); // bound directly to input
  const [filterMonth, setFilterMonth] = useState("");
  // when true, show the full add/edit form on the page (not only the flip-card back)
  const [showFullForm, setShowFullForm] = useState(false);
  // ref to the first input for autofocus
  const firstInputRef = useRef(null);
  // ref to keep the original document when editing so we can detect date changes
  const originalDocRef = useRef(null);

  useEffect(() => {
    fetchDocs();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function fetchDocs() {
    try {
      setLoading(true);
      setGlobalError(null);
      const res = await appwriteClient.get(
        `/databases/${DB_ID}/collections/${COLLECTION_ID}/documents`
      );
      setDocs(res.data.documents || []);
    } catch (err) {
      console.error(err);
      setGlobalError(err.response?.data?.message ?? err.response?.data ?? String(err));
    } finally {
      setLoading(false);
    }
  }

  function validate(formData) {
    const e = {};
    if (!formData.CARD_HOLDER_NAME || !formData.CARD_HOLDER_NAME.trim()) e.CARD_HOLDER_NAME = "Card holder name is required";
    if (!/^[0-9]{4}$/.test(String(formData.LAST_FOUR_NO))) e.LAST_FOUR_NO = "Last four digits must be exactly 4 numbers";
    if (!formData.LAST_DEPOSIT_DATE || isNaN(Date.parse(formData.LAST_DEPOSIT_DATE))) e.LAST_DEPOSIT_DATE = "Valid date is required (YYYY-MM-DD)";
    if (!formData.MONTHS_NAME || !formData.MONTHS_NAME.trim()) e.MONTHS_NAME = "Month name is required";
    if (formData.COUNT_LEFT === "" || isNaN(Number(formData.COUNT_LEFT)) || Number(formData.COUNT_LEFT) < 0) e.COUNT_LEFT = "Count left must be a non-negative number";
    return e;
  }

  // Convert/sanitize form values to the proper types expected by Appwrite
  function sanitizeData(formData) {
    const out = {};
    // string fields
    out.CARD_HOLDER_NAME = String(formData.CARD_HOLDER_NAME || "").trim();
    out.LAST_FOUR_NO = String(formData.LAST_FOUR_NO || "").trim();
    // date — keep as yyyy-mm-dd if provided
    if (formData.LAST_DEPOSIT_DATE) out.LAST_DEPOSIT_DATE = String(formData.LAST_DEPOSIT_DATE);
    if (formData.MONTHS_NAME) out.MONTHS_NAME = String(formData.MONTHS_NAME).trim();
    // numeric field — ensure integer when sending to Appwrite
    if (formData.COUNT_LEFT !== "" && formData.COUNT_LEFT != null) {
      const n = Number(formData.COUNT_LEFT);
      // if it's not a finite number, leave it out and let server validate
      if (Number.isFinite(n)) out.COUNT_LEFT = Math.trunc(n);
    }
    return out;
  }

  async function createDocument(data) {
    const payload = { documentId: "unique()", data };
    const res = await appwriteClient.post(
      `/databases/${DB_ID}/collections/${COLLECTION_ID}/documents`,
      payload
    );
    return res.data;
  }

  async function updateDocument(id, data) {
    const res = await appwriteClient.patch(
      `/databases/${DB_ID}/collections/${COLLECTION_ID}/documents/${id}`,
      { data }
    );
    return res.data;
  }

  async function deleteDocument(id) {
    await appwriteClient.delete(
      `/databases/${DB_ID}/collections/${COLLECTION_ID}/documents/${id}`
    );
  }

  async function handleSubmit(e) {
    e.preventDefault();
    setFieldErrors({});
    const errs = validate(form);
    if (Object.keys(errs).length) {
      setFieldErrors(errs);
      return;
    }
    setSubmitting(true);
    setGlobalError(null);
    try {
      const payload = sanitizeData(form);
      // compute COUNT_LEFT automatically based on existing docs and business rules
      const cardHolder = String(payload.CARD_HOLDER_NAME || '').trim();
      const lastFour = String(payload.LAST_FOUR_NO || '').trim();
      const monthKey = getMonthKey(payload.LAST_DEPOSIT_DATE);

      if (editingId) {
        // when editing, compare with original doc to decide how to update COUNT_LEFT
        const original = originalDocRef.current;
        const originalDate = getField(original, 'LAST_DEPOSIT_DATE', 'last_deposit_date');
        const originalMonthKey = getMonthKey(originalDate);
        const originalCount = Number(getField(original, 'COUNT_LEFT', 'count_left') ?? 5);

        if (!originalDate) {
          // fallback: recompute based on existing docs
          const existingCount = countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey, editingId);
          payload.COUNT_LEFT = Math.max(0, 5 - (existingCount + 1));
        } else if (monthKey === originalMonthKey) {
          // same month: if date changed, treat as a new deposit and decrement count
          if (originalDate !== payload.LAST_DEPOSIT_DATE) {
            payload.COUNT_LEFT = Math.max(0, originalCount - 1);
          } else {
            // date same -> keep previous count
            payload.COUNT_LEFT = originalCount;
          }
        } else {
          // month changed -> reset quota for the new month
          payload.COUNT_LEFT = 5;
        }

        const updated = await updateDocument(editingId, payload);
        setDocs((s) => s.map((d) => (d.$id === editingId ? updated : d)));
  setEditingId(null);
  originalDocRef.current = null;
        // highlight updated
        setRecentAddedId(updated.$id);
        setTimeout(() => setRecentAddedId(null), 2000);
      } else {
        // creating new document: count existing deposits for this card & month
        const existingCount = countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey);
        payload.COUNT_LEFT = Math.max(0, 5 - (existingCount + 1));

        const created = await createDocument(payload);
        setDocs((s) => [created, ...s]);
        // animate new card
        setRecentAddedId(created.$id);
        setTimeout(() => setRecentAddedId(null), 2000);
      }
      setForm(emptyForm);
      // close full form after successful submit to show the list on smaller screens
      setShowFullForm(false);
    } catch (err) {
      console.error(err);
      // Try to extract Appwrite validation errors if present
      const server = err.response?.data;
      if (server) {
        // server may include message and details
        const msg = server.message || server;
        // if details/errors is an object with field keys, show those
        if (server?.errors && typeof server.errors === 'object') {
          const fieldErrs = {};
          for (const key of Object.keys(server.errors)) {
            fieldErrs[key] = server.errors[key]?.message || JSON.stringify(server.errors[key]);
          }
          setFieldErrors((prev) => ({ ...prev, ...fieldErrs }));
        }
        setGlobalError(msg);
      } else {
        setGlobalError(String(err));
      }
    } finally {
      setSubmitting(false);
    }
  }

  function startEdit(doc) {
    // populate form from doc (accept variants in key names)
    const d = doc.data || doc;
    setEditingId(doc.$id);
    setForm({
      CARD_HOLDER_NAME: getField(doc, "CARD_HOLDER_NAME", "card_holder", "card_holder_name") || "",
      LAST_FOUR_NO: getField(doc, "LAST_FOUR_NO", "last_four_no") || "",
      LAST_DEPOSIT_DATE: getField(doc, "LAST_DEPOSIT_DATE", "last_deposit_date", "expiry_date") || "",
      MONTHS_NAME: getField(doc, "MONTHS_NAME", "months_name") || "",
      COUNT_LEFT: getField(doc, "COUNT_LEFT", "count_left") ?? "",
    });
    window.scrollTo({ top: 0, behavior: "smooth" });
    // when editing, flip to back (form) and show the full form for easier editing
    setFlipped(true);
    setShowFullForm(true);
    // remember the original doc for comparison during update
    originalDocRef.current = doc;
  }

  async function handleDelete(id) {
    if (!confirm("Delete this deposit? This action cannot be undone.")) return;
    try {
      await deleteDocument(id);
      setDocs((s) => s.filter((d) => d.$id !== id));
    } catch (err) {
      console.error(err);
      setGlobalError(err.response?.data?.message ?? String(err));
    }
  }

  // touch handlers to flip the mini card on swipe
  function onTouchStart(e) {
    if (showFullForm) return; // disable card swipe when full form overlay is open
    touchStartX.current = e.touches?.[0]?.clientX ?? null;
  }
  function onTouchEnd(e) {
    if (showFullForm) return;
    if (touchStartX.current == null) return;
    const endX = e.changedTouches?.[0]?.clientX ?? null;
    if (endX == null) return;
    const diff = endX - touchStartX.current;
    if (diff < -touchDelta) {
      // swipe left -> show form
      setFlipped(true);
    } else if (diff > touchDelta) {
      // swipe right -> show preview
      setFlipped(false);
    }
    touchStartX.current = null;
  }

  // page-level flip (Add <-> Deposits)
  const [pageFlipped, setPageFlipped] = useState(false); // false = Add Deposit (front), true = Deposits (back)
  const pageTouchStart = useRef(null);
  const pageTouchDelta = 60;
  function onPageTouchStart(e) {
    if (showFullForm) return; // don't flip pages while full form overlay is open
    pageTouchStart.current = e.touches?.[0]?.clientX ?? null;
  }
  function onPageTouchEnd(e) {
    if (showFullForm) return;
    if (pageTouchStart.current == null) return;
    const endX = e.changedTouches?.[0]?.clientX ?? null;
    if (endX == null) return;
    const diff = endX - pageTouchStart.current;
    if (diff < -pageTouchDelta) {
      setPageFlipped(true); // swipe left -> show deposits
    } else if (diff > pageTouchDelta) {
      setPageFlipped(false); // swipe right -> show add form
    }
    pageTouchStart.current = null;
  } 

  const months = useMemo(() => {
    const set = new Set();
    docs.forEach((d) => {
      const m = getField(d, "MONTHS_NAME", "months_name");
      if (m) set.add(m);
    });
    return Array.from(set).sort();
  }, [docs]);

  const filtered = useMemo(() => {
    const ql = String(q).trim().toLowerCase();
    return docs.filter((d) => {
      const name = String(getField(d, "CARD_HOLDER_NAME", "card_holder", "card_holder_name") || "").toLowerCase();
      const last = String(getField(d, "LAST_FOUR_NO", "last_four_no") || "");
      const month = String(getField(d, "MONTHS_NAME", "months_name") || "");
      if (filterMonth && month !== filterMonth) return false;
      if (!ql) return true;
      return name.includes(ql) || last.includes(ql) || month.includes(ql);
    });
  }, [docs, q, filterMonth]);

  // debounce the input -> q (220ms)
  useEffect(() => {
    const t = setTimeout(() => setQ(qInput), 220);
    return () => clearTimeout(t);
  }, [qInput]);

  // Helpers for COUNT_LEFT logic
  function getMonthKey(isoDate) {
    if (!isoDate) return null;
    const d = new Date(isoDate);
    if (isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey, excludeId) {
    if (!monthKey) return 0;
    return docs.reduce((acc, d) => {
      try {
        const dd = d.data || d;
        const m = getField(d, 'LAST_DEPOSIT_DATE', 'last_deposit_date');
        const mk = getMonthKey(m);
        const sameMonth = mk === monthKey;
        const sameHolder = String(getField(d, 'CARD_HOLDER_NAME', 'card_holder', 'card_holder_name') || '').trim() === String(cardHolder || '').trim();
        const sameFour = String(getField(d, 'LAST_FOUR_NO', 'last_four_no') || '') === String(lastFour || '');
        if (sameMonth && sameHolder && sameFour && d.$id !== excludeId) return acc + 1;
      } catch (e) { /* ignore */ }
      return acc;
    }, 0);
  }

  // autofocus the first input when the form becomes visible (either flip or full form)
  useEffect(() => {
    if ((showFullForm || flipped) && firstInputRef.current) {
      try { firstInputRef.current.focus(); } catch (e) { /* ignore */ }
    }
  }, [showFullForm, flipped]);

  // when the full form overlay is open, lock body scrolling and add Escape handler to close
  useEffect(() => {
    const prev = document.body.style.overflow;
    if (showFullForm) document.body.style.overflow = 'hidden';
    function onKey(e) {
      if (e.key === 'Escape' && showFullForm) {
        setShowFullForm(false);
        setFlipped(false);
  setEditingId(null);
  originalDocRef.current = null;
      }
    }
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = prev;
    };
  }, [showFullForm]);

  function renderSkeleton() {
    return (
      <div className="cards">
        <div className="skeleton-card"><div className="skeleton" style={{ height: 56 }} /></div>
        <div className="skeleton-card"><div className="skeleton" style={{ height: 56 }} /></div>
        <div className="skeleton-card"><div className="skeleton" style={{ height: 56 }} /></div>
      </div>
    );
  }

  // Reusable form renderer so it can be shown inside the flip-card or as a full form
  function renderForm() {
    return (
      <div>
        <form onSubmit={handleSubmit} className="deposit-form" noValidate>
          <label>
            Card holder name
            <input
              ref={firstInputRef}
              value={form.CARD_HOLDER_NAME}
              onChange={(e) => setForm((s) => ({ ...s, CARD_HOLDER_NAME: e.target.value }))}
              aria-invalid={!!fieldErrors.CARD_HOLDER_NAME}
            />
            {fieldErrors.CARD_HOLDER_NAME && <div className="error" role="alert">{fieldErrors.CARD_HOLDER_NAME}</div>}
          </label>

          <label>
            Last four digits
            <input
              value={form.LAST_FOUR_NO}
              onChange={(e) => setForm((s) => ({ ...s, LAST_FOUR_NO: e.target.value.replace(/[^0-9]/g, "") }))}
              maxLength={4}
              inputMode="numeric"
              aria-invalid={!!fieldErrors.LAST_FOUR_NO}
            />
            {fieldErrors.LAST_FOUR_NO && <div className="error" role="alert">{fieldErrors.LAST_FOUR_NO}</div>}
          </label>

          <label>
            Last deposit date
            <input
              type="date"
              value={form.LAST_DEPOSIT_DATE}
              onChange={(e) => setForm((s) => ({ ...s, LAST_DEPOSIT_DATE: e.target.value }))}
              aria-invalid={!!fieldErrors.LAST_DEPOSIT_DATE}
            />
            {fieldErrors.LAST_DEPOSIT_DATE && <div className="error" role="alert">{fieldErrors.LAST_DEPOSIT_DATE}</div>}
          </label>

          <label>
            Month name
            <input
              value={form.MONTHS_NAME}
              onChange={(e) => setForm((s) => ({ ...s, MONTHS_NAME: e.target.value }))}
              aria-invalid={!!fieldErrors.MONTHS_NAME}
            />
            {fieldErrors.MONTHS_NAME && <div className="error" role="alert">{fieldErrors.MONTHS_NAME}</div>}
          </label>

          <label>
            Count left
            {/* COUNT_LEFT is computed automatically. Show read-only value so user cannot edit it. */}
            <input
              value={(() => {
                // compute a preview value for COUNT_LEFT to show in the form
                try {
                  const cardHolder = String(form.CARD_HOLDER_NAME || '').trim();
                  const lastFour = String(form.LAST_FOUR_NO || '').trim();
                  const monthKey = getMonthKey(form.LAST_DEPOSIT_DATE);
                  if (editingId && originalDocRef.current) {
                    const original = originalDocRef.current;
                    const originalDate = getField(original, 'LAST_DEPOSIT_DATE', 'last_deposit_date');
                    const originalCount = Number(getField(original, 'COUNT_LEFT', 'count_left') ?? 5);
                    const originalMonthKey = getMonthKey(originalDate);
                    if (!originalDate) {
                      const existingCount = countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey, editingId);
                      return String(Math.max(0, 5 - (existingCount + 1)));
                    }
                    if (monthKey === originalMonthKey) {
                      if (originalDate !== form.LAST_DEPOSIT_DATE) return String(Math.max(0, originalCount - 1));
                      return String(originalCount);
                    }
                    return String(5);
                  }
                  // creating new
                  const existingCount = countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey);
                  return String(Math.max(0, 5 - (existingCount + 1)));
                } catch (e) { return String(form.COUNT_LEFT ?? '') }
              })()}
              readOnly
              aria-readonly
              inputMode="numeric"
              aria-invalid={!!fieldErrors.COUNT_LEFT}
            />
            {fieldErrors.COUNT_LEFT && <div className="error" role="alert">{fieldErrors.COUNT_LEFT}</div>}
          </label>

          <div className="form-actions">
            <button type="submit" className="primary" disabled={submitting} aria-busy={submitting}>
              {submitting && <span className="spinner" aria-hidden />}
              {submitting ? (editingId ? "Updating…" : "Saving…") : (editingId ? "Update" : "Create")}
            </button>
            <button type="button" className="outline small" onClick={() => { setForm(emptyForm); setEditingId(null); setFieldErrors({}); }}>
              Clear
            </button>
            <button type="button" className="outline small" onClick={() => fetchDocs()}>
              Refresh
            </button>
          </div>
        </form>
        {/* show a compact inline error only when not using the full-page overlay */}
        {globalError && !showFullForm && <div style={{ marginTop: 10 }} className="error" role="status">{String(globalError)}</div>}
      </div>
    );
  }

  // Small live preview that mirrors current form values
  function renderPreviewMirror() {
    // compute COUNT_LEFT preview using same logic as the form
    let previewCount = '';
    try {
      const cardHolder = String(form.CARD_HOLDER_NAME || '').trim();
      const lastFour = String(form.LAST_FOUR_NO || '').trim();
      const monthKey = getMonthKey(form.LAST_DEPOSIT_DATE);
      if (editingId && originalDocRef.current) {
        const original = originalDocRef.current;
        const originalDate = getField(original, 'LAST_DEPOSIT_DATE', 'last_deposit_date');
        const originalCount = Number(getField(original, 'COUNT_LEFT', 'count_left') ?? 5);
        const originalMonthKey = getMonthKey(originalDate);
        if (!originalDate) {
          const existingCount = countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey, editingId);
          previewCount = Math.max(0, 5 - (existingCount + 1));
        } else if (monthKey === originalMonthKey) {
          previewCount = originalDate !== form.LAST_DEPOSIT_DATE ? Math.max(0, originalCount - 1) : originalCount;
        } else {
          previewCount = 5;
        }
      } else {
        const existingCount = countExistingDepositsForCardInMonth(cardHolder, lastFour, monthKey);
        previewCount = Math.max(0, 5 - (existingCount + 1));
      }
    } catch (e) {
      previewCount = '';
    }

    return (
      <div className="preview-mini" role="region" aria-label="Card preview">
        <div className="card-preview" style={{ minHeight: 110, padding: 12 }}>
          <div className="top">
            <div className="brand">Deposit</div>
            <div className="meta"><span className="small">{form.MONTHS_NAME || months[0] || ''}</span></div>
          </div>
          <div className="number">•••• {form.LAST_FOUR_NO || '----'}</div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 12 }}>{form.CARD_HOLDER_NAME || 'Card holder'}</div>
            <div style={{ fontSize: 12 }}>{previewCount !== '' ? `Left ${previewCount}` : ''}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-root">
      <div className="container">
        <header>
          <h1>Deposit Management</h1>
          <p className="subtitle">Add, view and manage deposit records</p>
        </header>

        <div className="tabs" role="tablist" aria-label="Pages">
        <button
          className={`tab ${!pageFlipped ? 'active' : ''}`}
          onClick={() => { setPageFlipped(false); setShowFullForm(true); setFlipped(true); }}
          role="tab" aria-selected={!pageFlipped}
        >Add Deposit</button>
        <button
          className={`tab ${pageFlipped ? 'active' : ''}`}
          onClick={() => { setPageFlipped(true); setShowFullForm(false); }}
          role="tab" aria-selected={pageFlipped}
        >Deposits</button>
        </div>

        <main>
        <div className={`page-wrap ${pageFlipped ? 'is-flipped' : ''}`} onTouchStart={onPageTouchStart} onTouchEnd={onPageTouchEnd}>
          <div className="page-inner">
            <div className="page-front page-frame">
              <section className="form-section" aria-labelledby="form-title">
                <h2 id="form-title">{editingId ? "Edit Deposit" : "Add Deposit"}</h2>
                <div className="flip-wrap" onTouchStart={onTouchStart} onTouchEnd={onTouchEnd}>
                  <div className={`flip-card ${flipped ? 'is-flipped' : ''}`}>
                    <div className="flip-card-inner">
                      <div className="flip-card-front">
                        <div className="card-preview" onClick={() => setFlipped(true)} role="button" tabIndex={0} aria-label="Open form">
                          <div className="top">
                            <div className="brand">Deposit</div>
                            <div className="meta"><span className="small">{months[0] ?? ''}</span></div>
                          </div>
                          <div className="number">•••• {form.LAST_FOUR_NO || '----'}</div>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <div style={{ fontSize: 12 }}>{form.CARD_HOLDER_NAME || 'Card holder'}</div>
                            <div style={{ fontSize: 12 }}>{form.COUNT_LEFT ? ` ${form.COUNT_LEFT}` : ''}</div>
                          </div>
                        </div>
                      </div>
                      <div className="flip-card-back">
                        {renderForm()}
                      </div>
                    </div>
                  </div>
                </div>

                {/* full form variant shown when user clicks '+ Add Card' on the Deposits page */}
                {showFullForm && (
                  <div
                    className="overlay-backdrop"
                    onClick={() => { setShowFullForm(false); setFlipped(false); setEditingId(null); originalDocRef.current = null; }}
                  >
                    <div
                      className="full-form panel centered-panel"
                      onClick={(e) => e.stopPropagation()}
                      role="dialog"
                      aria-modal="true"
                    >
                      <div className="panel-header">
                        <h3 className="panel-title">{editingId ? 'Edit Deposit' : 'Add Deposit'}</h3>
                        <div>
                          <button className="close-btn outline small" onClick={() => { setShowFullForm(false); setFlipped(false); setEditingId(null); originalDocRef.current = null; }}>Close</button>
                        </div>
                      </div>
                      {/* layout: preview + form on wide, stacked on narrow */}
                      <div className="full-form-layout">
                        <div className="full-form-preview">
                          {renderPreviewMirror()}
                        </div>
                        <div className="full-form-body">
                          {renderForm()}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </section>
            </div>

            <div className="page-back page-frame">
              <section className="list-section">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 8 }}>
                  <h2 style={{ margin: 0 }}>Deposits</h2>
                  <div>
                    <button className="primary small" onClick={() => { setEditingId(null); setForm(emptyForm); setPageFlipped(false); setFlipped(true); setShowFullForm(true); window.scrollTo({ top: 0, behavior: 'smooth' }); }}>+ Add Card</button>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginBottom: 8, alignItems: 'center' }}>
                  <input className="filter-input" placeholder="Search name, last four or month" value={qInput} onChange={(e) => setQInput(e.target.value)} style={{ flex: 1, padding: '0.6rem', borderRadius: 8, border: '1px solid var(--border)' }} />
                  <div className="filter-wrap" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <select className="filter-select" value={filterMonth} onChange={(e) => setFilterMonth(e.target.value)} style={{ padding: '0.6rem', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent' }}>
                      <option value="">All months</option>
                      {months.map((m) => <option key={m} value={m}>{m}</option>)}
                    </select>
                    {/* colorful pill to show selected month (options styling is limited cross-browser) */}
                    <div className="selected-pill" style={(() => {
                      if (!filterMonth) return { background: 'linear-gradient(90deg, rgba(255,255,255,0.03), rgba(255,255,255,0.02))', color: 'var(--muted)' };
                      // derive a hue from the month string for a repeatable color
                      const s = filterMonth || '';
                      let h = 0;
                      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
                      const c1 = `hsl(${h} 80% 60%)`;
                      const c2 = `hsl(${(h + 40) % 360} 70% 50%)`;
                      return { background: `linear-gradient(90deg, ${c1}, ${c2})`, color: '#fff' };
                    })()}>
                      {filterMonth || 'All months'}
                    </div>
                  </div>
                </div>

                {loading ? renderSkeleton() : (
                  <div className="cards">
                    {filtered.length === 0 && <p>No documents match your query.</p>}
                    {filtered.map((doc) => {
                      const name = getField(doc, "CARD_HOLDER_NAME", "card_holder", "card_holder_name") || "(no name)";
                      const month = getField(doc, "MONTHS_NAME", "months_name") || '—';
                      const lastFour = getField(doc, "LAST_FOUR_NO", "last_four_no") ?? '----';
                      const raw = getField(doc, "COUNT_LEFT", "count_left");
                      const n = (raw == null || raw === '') ? NaN : Number(raw);
                      let cls = 'count-badge';
                      if (!Number.isFinite(n)) cls = 'count-badge';
                      else if (n >= 5) cls = 'count-badge count-bad';
                      else if (n === 4) cls = 'count-badge count-warn';
                      else if (n >= 3) cls = 'count-badge count-good';
                      else cls = 'count-badge';

                      return (
                        <article className={`card modern-card ${recentAddedId === doc.$id ? 'enter' : ''}`} key={doc.$id}>
                          {/* Decorative gradient overlay is handled in CSS ::before/::after */}
                          <div className="card-content">
                            <div className="card-header">
                              <div className="month-pill" aria-hidden>{month}</div>
                              <div className="count-wrap">
                                <span className={cls} aria-label={`Count left ${Number.isFinite(n) ? n : 'unknown'}`}>Left {Number.isFinite(n) ? n : '—'}</span>
                              </div>
                            </div>

                            <div className="card-body">
                              <div className="card-name">{name}</div>
                              <div className="card-number muted">•••• {lastFour}</div>
                            </div>

                            <div className="card-footer">
                              <div className="card-notes muted">{getField(doc, 'notes') || ''}</div>
                              <div className="card-actions">
                                <button className="outline small" onClick={() => { startEdit(doc); setPageFlipped(false); }}>Edit</button>
                                <button className="outline small" onClick={() => handleDelete(doc.$id)}>Delete</button>
                              </div>
                            </div>

                            <div className="card-meta-row muted"><small>Created: {formatDate(doc.$createdAt)} · Updated: {formatDate(doc.$updatedAt)}</small></div>
                          </div>
                        </article>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

          </div>
        </div>
        </main>

        <footer>
          {/* <small>Tip: use the filter and search to locate records. Ensure your Appwrite env vars are set.</small> */}
        </footer>
      </div>
    </div>
  );
}

export default App;

