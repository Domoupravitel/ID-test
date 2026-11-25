// ==============================================
// CONFIGURATION & GLOBAL STATE
// ==============================================

// Тук трябва да се постави линка от Google Apps Script, след като се разгърне (Deploy -> Web App)
const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbyWw9LmIQx7K-nhcZSC4wRmc2_89xWjXPO3lPXVhVUGZPuCnxD1fPEZFDIXku-w44YpXg/exec";

let currentRouteKey = "";
let apartmentList = [];
let _currentIdealParts = {};
let financialNavigationRevision_ = 0;
const issuedFinancialOperationContexts_ = new WeakSet();

// ==============================================
// INITIALIZATION
// ==============================================

document.addEventListener('DOMContentLoaded', async () => {
    // Възстановяване на запазени данни, ако има такива
    const savedEmail = localStorage.getItem("savedAdminEmail");
    const savedId = localStorage.getItem("savedAccessId");

    if (savedEmail) {
        document.getElementById("adminEmailInput").value = savedEmail;
    }
    // We only set savedId if NO id is provided in the URL to avoid overwriting clean IDs with old/partial ones
    const urlParams = new URLSearchParams(window.location.search);
    if (savedId && !urlParams.get('id') && !window.location.hash) {
        document.getElementById("access-id").value = savedId;
    }

    // Apartment Event Listener for the main view
    document.getElementById('apartmentSelect').addEventListener('change', (e) => {
        if (e.target.value) {
            loadApartmentData(e.target.value);
        } else {
            resetApartmentData();
            // Clear apartment from hash but keep entrance ID
            if (currentRouteKey) {
                window.location.hash = encodeURIComponent(currentRouteKey);
            } else {
                window.location.hash = "";
            }
        }
    });

    // Handle Enter key for admin login
    document.getElementById("pinInput").addEventListener('keydown', (e) => {
        if (e.key === 'Enter') verifyPin();
    });

    // --- Автоматично влизане (Parsing ID and Apartment from Hash or Query) ---
    // (use the already declared urlParams)
    let idValue = urlParams.get('id');
    let aptValue = urlParams.get('apt');

    // Hash priority - Handle both encoded and raw hashes
    if (window.location.hash) {
        try {
            const rawHash = window.location.hash.replace('#', '');
            if (rawHash) {
                // Split first to preserve encoded slashes inside parts if any (though rare in IDs)
                const parts = rawHash.split('/');
                if (parts[0]) idValue = decodeURIComponent(parts[0]);
                if (parts[1]) aptValue = decodeURIComponent(parts[1]);
            }
        } catch(e) { console.error("Hash parsing failed", e); }
    }

    // Stage 2C.2: Parallel 1-RTT bootstrap prefetch (publicPlatformConfigV1 + entranceSummaryV1 + financialManifestV1)
    // eliminates serial waterfall and Firebase SDK WebChannel cold-start delay!
    window._stage2c2NavStartMs_ = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (idValue) {
        const cleanId = idValue.trim();
        await prefetchEntranceBootstrapV2_(cleanId);
        await loadPublicSettings();
        document.getElementById('access-id').value = cleanId;
        
        // Trigger entrance
        const success = await enterEntrance();

        if (success && aptValue) {
            const select = document.getElementById("apartmentSelect");
            const targetApt = decodeURIComponent(aptValue);
            if (apartmentList && apartmentList.length > 0) {
                const found = apartmentList.find(a => normalizeAptName(a) === normalizeAptName(targetApt)) || 
                              apartmentList.find(a => a === targetApt);
                if (found) {
                    select.value = found;
                    loadApartmentData(found);
                }
            }
        }
    } else {
        await loadPublicSettings();
    }

    // Ако сме се върнали от ръководството, отваряме админ панела автоматично
    if (sessionStorage.getItem('shouldOpenAdmin') === 'true') {
        sessionStorage.removeItem('shouldOpenAdmin');
        const deferredAdminRoute = currentRouteKey;
        const deferredAdminContext = captureRouteRequestContext();
        // Даваме малко време на enterEntrance да приключи ако е в ход
        setTimeout(() => {
            if (currentRouteKey !== deferredAdminRoute || (deferredAdminContext && !isCurrentRouteRequestContext(deferredAdminContext))) return;
            if (currentRouteKey) openAdmin();
        }, 800);
    }
});

// ==============================================
// STAGE 2A.2 / 2C.2: PRECOMPUTED READ MODELS, ACCESS GATE & FRESHNESS CLIENT
// ==============================================
window._projFlags = {
    PUBLIC_PLATFORM_CONFIG: 'OFF',
    ENTRANCE_SUMMARY: 'OFF',
    ADMIN_ENTRANCE_CONFIG: 'OFF',
    FIN_DASHBOARD: 'OFF',
    FIN_MAINTENANCE_BALANCE: 'OFF',
    FIN_EXTERNAL_UNITS: 'OFF',
    FIN_MONTHLY_REPORT_V3: 'OFF'
};
window._adminConfigCache = null;
window._finMatCache_ = null;
window._finMatMonthlyCache_ = Object.create(null);
window._finMatParityLog_ = [];
window._entranceSubUnsub_ = null;
window._stage2c2BootstrapCache_ = window._stage2c2BootstrapCache_ || Object.create(null);

const FIRESTORE_REST_BASE_V2_ = 'https://firestore.googleapis.com/v1/projects/domoupravitel-test/databases/(default)/documents';

function fsRestDecodeVal_(v) {
    if (!v || typeof v !== 'object') return null;
    if ('nullValue' in v) return null;
    if ('booleanValue' in v) return Boolean(v.booleanValue);
    if ('integerValue' in v) return Number(v.integerValue);
    if ('doubleValue' in v) return Number(v.doubleValue);
    if ('stringValue' in v) return String(v.stringValue);
    if ('timestampValue' in v) return String(v.timestampValue);
    if ('arrayValue' in v) return ((v.arrayValue && v.arrayValue.values) || []).map(fsRestDecodeVal_);
    if ('mapValue' in v) return fsRestDecodeFields_((v.mapValue && v.mapValue.fields) || {});
    return null;
}

function fsRestDecodeFields_(fields) {
    const out = {};
    const keys = Object.keys(fields || {});
    for (let i = 0; i < keys.length; i++) out[keys[i]] = fsRestDecodeVal_(fields[keys[i]]);
    return out;
}

async function fastGetPublicDoc_(collectionName, docId, routeKey) {
    const cacheKey = collectionName + '/' + docId;
    if (collectionName === 'buildingDashboardSummaryV1' && window._stage2c2EarlyDashPromise_) {
        try { await window._stage2c2EarlyDashPromise_; } catch (e) {}
        window._stage2c2EarlyDashPromise_ = null;
    }
    const pre = window._stage2c2BootstrapCache_[cacheKey];
    if (pre && (Date.now() - pre.ts) < 10000) {
        return pre.snap;
    }
    // Use direct no-store REST GET on live browser origins (enforces 100% identical firestore.rules with zero SDK WebChannel cold start!)
    const canUseRest = typeof fetch === 'function' && typeof window !== 'undefined' && window.location && /^https?:$/.test(window.location.protocol);
    if (canUseRest) {
        try {
            const url = FIRESTORE_REST_BASE_V2_ + '/' + encodeURIComponent(collectionName) + '/' + encodeURIComponent(docId);
            const r = await fetch(url, { method: 'GET', cache: 'no-store' });
            if (r.status === 404) return { exists: () => false, data: () => null };
            if (r.status === 403) {
                const err = new Error('PERMISSION_DENIED');
                err.code = 'permission-denied';
                throw err;
            }
            if (r.ok) {
                const parsed = await r.json();
                const decoded = fsRestDecodeFields_(parsed.fields || {});
                return { exists: () => true, data: () => decoded };
            }
        } catch (restErr) {
            if (restErr && restErr.code === 'permission-denied') throw restErr;
            // Fall through to Firebase SDK getDoc
        }
    }
    if (!window.fb || !window.fb.getDoc || !window.db) return null;
    const ref = (routeKey && typeof window.fb.routeDoc === 'function')
        ? window.fb.routeDoc(window.db, collectionName, docId, routeKey)
        : window.fb.doc(window.db, collectionName, docId);
    return window.fb.getDoc(ref);
}

async function prefetchEntranceBootstrapV2_(routeKey) {
    if (!routeKey) return;
    try {
        if (window._stage2c2EarlyPrefetchPromise_ && window._stage2c2EarlyPrefetchRoute_ === routeKey) {
            await window._stage2c2EarlyPrefetchPromise_;
            window._stage2c2EarlyPrefetchPromise_ = null;
            return;
        }
        const [pubSnap, sumSnap, manSnap] = await Promise.all([
            fastGetPublicDoc_('publicPlatformConfigV1', 'global', null).catch(() => null),
            fastGetPublicDoc_('entranceSummaryV1', routeKey, routeKey).catch(() => null),
            fastGetPublicDoc_('financialManifestV1', routeKey, routeKey).catch(() => null)
        ]);
        const ts = Date.now();
        if (pubSnap) window._stage2c2BootstrapCache_['publicPlatformConfigV1/global'] = { ts, snap: pubSnap };
        if (sumSnap) window._stage2c2BootstrapCache_['entranceSummaryV1/' + routeKey] = { ts, snap: sumSnap };
        if (manSnap) {
            window._stage2c2BootstrapCache_['financialManifestV1/' + routeKey] = { ts, snap: manSnap };
            // Speculatively prefetch buildingDashboardSummaryV1 in parallel right away if manifest is ready!
            const md = manSnap.exists && manSnap.exists() ? manSnap.data() : null;
            if (md && md.parts && md.parts.buildingDashboard) {
                const dId = md.parts.buildingDashboard;
                window._stage2c2EarlyDashPromise_ = fastGetPublicDoc_('buildingDashboardSummaryV1', dId, routeKey)
                    .then(s => { if (s) window._stage2c2BootstrapCache_['buildingDashboardSummaryV1/' + dId] = { ts: Date.now(), snap: s }; return s; })
                    .catch(() => null);
            }
        }
    } catch (e) { /* best-effort bootstrap prefetch */ }
}

function purgeAdminConfigCache_() {
    window._adminConfigCache = null;
}

function purgeFinancialMaterializedCache_(preserveBootstrap) {
    window._finMatCache_ = null;
    window._finMatMonthlyCache_ = Object.create(null);
    if (!preserveBootstrap) window._stage2c2BootstrapCache_ = Object.create(null);
    window._publicExtUnitStatements_ = [];
    window._cachedExternalUnits = [];
    window._cachedExternalUnitStatements = [];
    window._cachedExternalReconciliation = [];
    window._cachedExternalPendingPayments = [];
    window._cachedExternalUnitActions = [];
}

function isEntranceAdminLoggedIn_(routeKey) {
    if (!routeKey) return false;
    return Boolean(sessionStorage.getItem('adminAuth_' + routeKey) || sessionStorage.getItem('adminPin_' + routeKey));
}

function clearProtectedFinancialDomOnBlock_(routeKey, isHardBlocked) {
    purgeFinancialMaterializedCache_();
    const label = isHardBlocked ? 'Достъпът е спрян' : 'Скрит (неплатен абонамент)';
    const setText = (id, txt) => { const el = document.getElementById(id); if (el) el.textContent = txt; };
    setText('dash-debts', '—');
    setText('dash-balance', '—');
    setText('dash-maintenance-balance', '—');
    setText('dash-credit-balance', '—');
    setText('dash-debts-trend', label);
    setText('dash-balance-trend', label);
    setText('maintenanceSourceSummary', label);
    setText('dash-credit-trend', label);
    const breakdownEl = document.getElementById('dash-debts-breakdown');
    if (breakdownEl) { breakdownEl.innerHTML = ''; breakdownEl.style.display = 'none'; }
    setText('saldo', isHardBlocked ? 'Спрян достъп' : 'Скрит');
    const tBody = document.getElementById('tableBody');
    if (tBody) {
        tBody.innerHTML = `<tr><td colspan="14" style="text-align:center; color:#e74c3c;">⚠️ ${isHardBlocked ? 'Достъпът е напълно спрян поради неплатен абонамент.' : 'Информацията е скрита поради неплатен абонамент.'}</td></tr>`;
    }
    const repEl = document.getElementById('report-content');
    if (repEl) repEl.innerHTML = '';
    const extSect = document.getElementById('publicExternalUnitsSection');
    if (extSect) extSect.style.display = 'none';
    const extBox = document.getElementById('publicExtUnitDetails');
    if (extBox) extBox.innerHTML = '';
    const extNote = document.getElementById('individualAptExtUnitsNote');
    if (extNote) extNote.style.display = 'none';
    if (isHardBlocked) {
        purgeAdminConfigCache_();
        sessionStorage.removeItem('adminAuth_' + routeKey);
        sessionStorage.removeItem('adminPin_' + routeKey);
        const adminOverlay = document.getElementById('adminOverlay');
        if (adminOverlay) adminOverlay.classList.remove('active');
        const homeView = document.getElementById('view-entrance-home');
        if (homeView) { homeView.classList.remove('active'); homeView.classList.add('hidden'); }
        const reportView = document.getElementById('view-monthly-report');
        if (reportView) { reportView.classList.remove('active'); reportView.classList.add('hidden'); }
        const hardBlockView = document.getElementById('view-hard-blocked');
        if (hardBlockView) {
            hardBlockView.classList.remove('hidden');
            hardBlockView.classList.add('active');
            const hbId = hardBlockView.querySelector('#hard-block-id');
            if (hbId) hbId.textContent = routeKey;
        }
    }
}

function attachEntranceSubscriptionWatcher_(routeKey) {
    if (typeof window._entranceSubUnsub_ === 'function') {
        try { window._entranceSubUnsub_(); } catch (e) {}
        window._entranceSubUnsub_ = null;
    }
    if (!routeKey) return;
    // Defer real-time Listen channel by 250ms so it never contends with initial paint,
    // and ensure lazy Firebase SDK is loaded before attaching onSnapshot.
    setTimeout(async () => {
        if (routeKey !== currentRouteKey) return;
        try {
            if ((!window.fb || !window.db) && typeof window.ensureFirebaseSdk_ === 'function') {
                await window.ensureFirebaseSdk_();
            }
            if (routeKey !== currentRouteKey || !window.fb || typeof window.fb.onSnapshot !== 'function' || !window.db) return;
            const ref = window.fb.routeDoc(window.db, 'entranceSummaryV1', routeKey, routeKey);
            window._entranceSubUnsub_ = window.fb.onSnapshot(ref, (snap) => {
                if (!snap || !snap.exists() || routeKey !== currentRouteKey) return;
                const d = snap.data() || {};
                if (!d.payload || !d.payload.subscriptionGate) return;
                const gateEval = evaluateSubscriptionGateClient_(d.payload.subscriptionGate);
                if (gateEval.stale) return;
                sessionStorage.setItem('isSoftBlocked_' + routeKey, gateEval.isSoftBlocked ? 'true' : 'false');
                sessionStorage.setItem('isHardBlocked_' + routeKey, gateEval.isHardBlocked ? 'true' : 'false');
                sessionStorage.setItem('subscriptionStatus_' + routeKey, gateEval.status || '');
                if (gateEval.isHardBlocked || (gateEval.isSoftBlocked && !isEntranceAdminLoggedIn_(routeKey))) {
                    clearProtectedFinancialDomOnBlock_(routeKey, gateEval.isHardBlocked);
                }
            }, () => { /* ignore transient listener error */ });
        } catch (e) { /* best-effort live watcher */ }
    }, 250);
}

function reconstructExternalUnitsClient_(summaryPayload, yearRowPayloadsByYear) {
    if (!summaryPayload) return null;
    const years = Array.isArray(summaryPayload.years) ? summaryPayload.years : Object.keys(yearRowPayloadsByYear || {}).sort();
    const unitSummaries = Array.isArray(summaryPayload.unitSummaries) ? summaryPayload.unitSummaries : [];
    const unitStatements = unitSummaries.map(us => {
        let allPeriods = [];
        for (let i = 0; i < years.length; i++) {
            const yDoc = yearRowPayloadsByYear && yearRowPayloadsByYear[years[i]];
            const uRows = yDoc && yDoc.unitPeriodsByUnit && yDoc.unitPeriodsByUnit[us.unitId];
            if (Array.isArray(uRows)) allPeriods = allPeriods.concat(uRows);
        }
        return Object.assign({}, us, { periods: allPeriods });
    });
    let reconciliationByPeriod = [];
    for (let j = 0; j < years.length; j++) {
        const yDoc2 = yearRowPayloadsByYear && yearRowPayloadsByYear[years[j]];
        if (yDoc2 && Array.isArray(yDoc2.reconciliationByPeriod)) {
            reconciliationByPeriod = reconciliationByPeriod.concat(yDoc2.reconciliationByPeriod);
        }
    }
    return {
        success: true,
        units: Array.isArray(summaryPayload.units) ? summaryPayload.units : [],
        unitStatements: unitStatements,
        reconciliationByPeriod: reconciliationByPeriod,
        pendingPayments: Array.isArray(summaryPayload.pendingPayments) ? summaryPayload.pendingPayments : [],
        actions: Array.isArray(summaryPayload.actions) ? summaryPayload.actions : [],
        financialSummary: summaryPayload.financialSummary || null,
        years: years
    };
}

async function fetchAdminFinancialBundleV1_(routeKey) {
    const pin = sessionStorage.getItem('adminAuth_' + routeKey) || sessionStorage.getItem('adminPin_' + routeKey) || '';
    if (!pin || !routeKey) return null;
    try {
        const res = await fetch(SCRIPT_URL, {
            method: 'POST',
            body: new URLSearchParams({ action: 'getAdminFinancialBundleV1', routeKey: routeKey, pin: pin })
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !data.success) {
            if (data && data.isHardBlocked) clearProtectedFinancialDomOnBlock_(routeKey, true);
            return null;
        }
        return data;
    } catch (e) {
        return null;
    }
}

async function readFinancialManifestBundleV2_(routeKey, opts) {
    const options = opts || {};
    const needDashboard = options.dashboard !== false;
    const needExternalSummary = Boolean(options.externalSummary || options.externalRows);
    const needExternalRows = Boolean(options.externalRows);
    const forceRefresh = Boolean(options.forceRefresh);
    if (!routeKey) return null;

    const isHard = sessionStorage.getItem('isHardBlocked_' + routeKey) === 'true';
    const isSoft = sessionStorage.getItem('isSoftBlocked_' + routeKey) === 'true';
    const isAdmin = isEntranceAdminLoggedIn_(routeKey);
    if (isHard) return null;

    const now = Date.now();
    const cached = window._finMatCache_;
    if (!forceRefresh && cached && cached.routeKey === routeKey && (now - cached.fetchedAt) < 15000) {
        const hasDash = !needDashboard || Boolean(cached.dashboard);
        const hasExtSum = !needExternalSummary || Boolean(cached.externalUnitsSummary);
        const hasExtRows = !needExternalRows || Boolean(cached.externalUnitsReconstructed);
        if (hasDash && hasExtSum && hasExtRows) return cached;
    }

    const inFlightKey = `${routeKey}|${needDashboard ? 1 : 0}|${needExternalSummary ? 1 : 0}|${needExternalRows ? 1 : 0}`;
    if (!forceRefresh && window._finMatInFlight_ && window._finMatInFlight_.key === inFlightKey) {
        return window._finMatInFlight_.promise;
    }

    const execPromise = (async () => {
    // Admin grace-period fallback: during SOFT_BLOCKED, Firestore denies direct reads, so Admin reads via POST PIN-gated GAS (0 recalculation!)
    if (isSoft && isAdmin) {
        const adminBundle = await fetchAdminFinancialBundleV1_(routeKey);
        if (!adminBundle || !adminBundle.success) return null;
        if (adminBundle.manifest && adminBundle.manifest.freshnessStatus && adminBundle.manifest.freshnessStatus !== 'CURRENT') {
            showProjectionFreshnessBanner_(adminBundle.manifest.freshnessStatus, 'Финансови данни');
        }
        const entry = {
            routeKey: routeKey,
            fetchedAt: now,
            fromAdminGrace: true,
            manifest: adminBundle.manifest,
            dashboard: adminBundle.dashboard || null,
            maintenanceBalance: adminBundle.maintenanceBalance || (adminBundle.dashboard && adminBundle.dashboard.maintenanceBalance) || null,
            externalUnitsSummary: adminBundle.externalUnitsSummary || null,
            externalUnitsPeriodRows: adminBundle.externalUnitsPeriodRows || null,
            externalUnitsReconstructed: adminBundle.externalUnitsReconstructed || null
        };
        window._finMatCache_ = entry;
        return entry;
    }

    if (isSoft && !isAdmin) return null;

    try {
        const mSnap = await fastGetPublicDoc_('financialManifestV1', routeKey, routeKey);
        if (!mSnap || !mSnap.exists()) return null;
        const m = mSnap.data() || {};
        if (m.contractVersion !== 1 || m.routeKey !== routeKey || !m.parts) return null;

        const freshness = m.freshnessStatus || 'UNVERIFIED';
        if (freshness !== 'CURRENT') {
            showProjectionFreshnessBanner_(freshness === 'DIRTY_IN_FLIGHT' || freshness === 'RECOMPUTING' ? 'PENDING' : freshness, 'Финансови данни');
        } else {
            showProjectionFreshnessBanner_('CURRENT');
        }

        const pubGen = Number(m.publishedMutationGeneration);
        const pubEpoch = Number(m.publishedFinancialEpoch);
        const parts = m.parts || {};

        const reqs = [];
        const keys = [];
        if (needDashboard && parts.buildingDashboard) {
            keys.push({ kind: 'dashboard', id: parts.buildingDashboard });
            reqs.push(fastGetPublicDoc_('buildingDashboardSummaryV1', parts.buildingDashboard, routeKey));
        }
        if (needExternalSummary && parts.externalUnitsSummary) {
            keys.push({ kind: 'extSum', id: parts.externalUnitsSummary });
            reqs.push(fastGetPublicDoc_('externalUnitsSummaryV1', parts.externalUnitsSummary, routeKey));
        }
        if (needExternalRows && parts.externalUnitsPeriodRows && typeof parts.externalUnitsPeriodRows === 'object') {
            const years = Object.keys(parts.externalUnitsPeriodRows).sort();
            for (let i = 0; i < years.length; i++) {
                const yr = years[i];
                const docId = parts.externalUnitsPeriodRows[yr];
                if (!docId) continue;
                keys.push({ kind: 'extYear', year: yr, id: docId });
                reqs.push(fastGetPublicDoc_('externalUnitsPeriodRowsV1', docId, routeKey));
            }
        }
        if (!reqs.length) return null;

        const snaps = await Promise.all(reqs);
        let dashPayload = (cached && cached.routeKey === routeKey && cached.publishedEpoch === pubEpoch) ? cached.dashboard : null;
        let extSumPayload = (cached && cached.routeKey === routeKey && cached.publishedEpoch === pubEpoch) ? cached.externalUnitsSummary : null;
        let extRowsByYear = (cached && cached.routeKey === routeKey && cached.publishedEpoch === pubEpoch && cached.externalUnitsPeriodRows)
            ? Object.assign({}, cached.externalUnitsPeriodRows) : {};

        for (let i = 0; i < snaps.length; i++) {
            const s = snaps[i];
            const meta = keys[i];
            if (!s || !s.exists()) return null;
            const pd = s.data() || {};
            // ZERO VERSION MIXING INVARIANT: every immutable part must match the exact manifest (G, E)!
            if (pd.routeKey !== routeKey ||
                Number(pd.mutationGeneration) !== pubGen ||
                Number(pd.targetFinancialEpoch) !== pubEpoch ||
                !pd.payload) {
                return null;
            }
            if (meta.kind === 'dashboard') dashPayload = pd.payload;
            else if (meta.kind === 'extSum') extSumPayload = pd.payload;
            else if (meta.kind === 'extYear') extRowsByYear[meta.year] = pd.payload;
        }

        const extRec = (needExternalRows && extSumPayload)
            ? reconstructExternalUnitsClient_(extSumPayload, extRowsByYear)
            : ((cached && cached.routeKey === routeKey && cached.publishedEpoch === pubEpoch) ? cached.externalUnitsReconstructed : null);

        const entry = {
            routeKey: routeKey,
            fetchedAt: now,
            publishedGeneration: pubGen,
            publishedEpoch: pubEpoch,
            manifest: m,
            dashboard: dashPayload,
            maintenanceBalance: dashPayload && dashPayload.maintenanceBalance ? dashPayload.maintenanceBalance : null,
            externalUnitsSummary: extSumPayload,
            externalUnitsPeriodRows: extRowsByYear,
            externalUnitsReconstructed: extRec
        };
        window._finMatCache_ = entry;
        return entry;
    } catch (e) {
        if (e && (e.code === 'permission-denied' || String(e.message || '').indexOf('PERMISSION_DENIED') !== -1)) {
            clearProtectedFinancialDomOnBlock_(routeKey, false);
        }
        return null;
    }
    })();
    window._finMatInFlight_ = { key: inFlightKey, promise: execPromise };
    try {
        return await execPromise;
    } finally {
        if (window._finMatInFlight_ && window._finMatInFlight_.promise === execPromise) {
            window._finMatInFlight_ = null;
        }
    }
}
window.readFinancialManifestBundleV2_ = readFinancialManifestBundleV2_;
window.purgeFinancialMaterializedCache_ = purgeFinancialMaterializedCache_;
window.clearProtectedFinancialDomOnBlock_ = clearProtectedFinancialDomOnBlock_;

// STAGE 2C.3: Materialized Monthly Financial Reports Client (0 GAS calls on public read!)
async function fetchAdminMonthlyReportV3_(routeKey, period) {
    const pin = sessionStorage.getItem('adminAuth_' + routeKey) || sessionStorage.getItem('adminPin_' + routeKey) || '';
    if (!pin || !routeKey || !period) return null;
    try {
        const res = await fetch(SCRIPT_URL, {
            method: 'POST',
            body: new URLSearchParams({ action: 'getAdminMonthlyReportV3', routeKey: routeKey, period: period, pin: pin })
        });
        if (!res.ok) return null;
        const data = await res.json();
        if (!data || !data.success) {
            if (data && data.isHardBlocked) clearProtectedFinancialDomOnBlock_(routeKey, true);
            return null;
        }
        return data;
    } catch (e) {
        return null;
    }
}

function buildMonthlyReportViewDataFromMaterialized_(payload, reportDetails, meta) {
    if (!payload || !payload.success || !payload.reconciliation) return null;
    const g = payload.grossByCategoryCents || {};
    const invoicedCounts = {
        elevator: Number(g.elevator || 0) / 100,
        subscription: Number(g.subscription || 0) / 100,
        light: Number(g.light || 0) / 100,
        security: Number(g.security || 0) / 100,
        cleaning: Number(g.cleaning || 0) / 100,
        podrajka: Number(g.maintenance || 0) / 100,
        remont: Number(g.repairFund || 0) / 100,
        water: Number(g.water || 0) / 100,
        platformSubscription: Number(g.platformSubscription || 0) / 100,
        total: Number(payload.reconciliation.grossExpenseCents || 0) / 100
    };
    const det = reportDetails && typeof reportDetails === 'object' ? reportDetails : {};
    const apts = Array.isArray(det.apartments) ? det.apartments.map(a => ({
        apt: a.apt || '?',
        occupants: a.occupants !== undefined ? a.occupants : 0,
        chips: a.chips !== undefined ? a.chips : 0,
        participation: a.participation !== undefined ? a.participation : 'Да',
        idealParts: a.idealParts !== undefined ? a.idealParts : 0,
        art51Multiplier: a.art51Multiplier || null,
        art51Info: a.art51Info || null,
        due: a.dueCents !== undefined ? Number(a.dueCents) / 100 : Number(a.due || 0)
    })) : [];
    const collectedVal = det.apartmentCollectedCents !== undefined
        ? Number(det.apartmentCollectedCents) / 100
        : Number(det.collected || 0);
    return {
        success: true,
        _fromMaterializedV3: true,
        _freshnessStatus: (meta && meta.freshnessStatus) || 'CURRENT',
        _partDocId: (meta && meta.partDocId) || null,
        data: {
            invoiced: invoicedCounts,
            apartmentTotalDueCents: det.apartmentTotalDueCents !== undefined
                ? Number(det.apartmentTotalDueCents)
                : Number(payload.reconciliation.apartmentExactSumCents || 0),
            collected: collectedVal,
            logic: det.logic || 'Равно',
            incomesV2: Array.isArray(det.incomesV2) ? det.incomesV2 : [],
            distributionsV2: Array.isArray(det.distributionsV2) ? det.distributionsV2 : [],
            v3Summary: payload,
            apartments: apts,
            hasIncompleteHistoricalData: Boolean(det.hasIncompleteHistoricalData),
            availablePeriods: (meta && meta.availablePeriods) || [],
            availableYears: (meta && meta.availableYears) || []
        }
    };
}

async function readMaterializedMonthlyReportV3_(routeKey, period, opts) {
    const options = opts || {};
    if (!routeKey || !period) return null;
    const isHard = sessionStorage.getItem('isHardBlocked_' + routeKey) === 'true';
    const isSoft = sessionStorage.getItem('isSoftBlocked_' + routeKey) === 'true';
    const isAdmin = isEntranceAdminLoggedIn_(routeKey);
    if (isHard) return { success: false, permissionDenied: true, isHardBlocked: true };

    const cacheKey = routeKey + '|' + period;
    const now = Date.now();
    const cached = window._finMatMonthlyCache_ && window._finMatMonthlyCache_[cacheKey];
    if (!options.forceRefresh && cached && (now - cached.fetchedAt) < 15000) {
        return cached.result;
    }

    // Admin grace-period fallback during SOFT_BLOCKED (POST PIN-gated, zero recalculation!)
    if (isSoft && isAdmin) {
        const adminRes = await fetchAdminMonthlyReportV3_(routeKey, period);
        if (!adminRes || !adminRes.success || !adminRes.data) return null;
        const fresh = (adminRes.manifest && adminRes.manifest.freshnessStatus) || 'CURRENT';
        if (fresh !== 'CURRENT') showProjectionFreshnessBanner_(fresh, 'Месечен отчет');
        else showProjectionFreshnessBanner_('CURRENT');
        const viewData = buildMonthlyReportViewDataFromMaterialized_(adminRes.data, adminRes.reportDetails, {
            freshnessStatus: fresh,
            partDocId: adminRes.partDocId,
            availablePeriods: adminRes.availablePeriods,
            availableYears: adminRes.availableYears
        });
        if (!viewData) return null;
        const wrapped = { success: true, fromAdminGrace: true, viewData: viewData, manifest: adminRes.manifest };
        window._finMatMonthlyCache_[cacheKey] = { fetchedAt: now, result: wrapped };
        return wrapped;
    }

    if (isSoft && !isAdmin) return { success: false, permissionDenied: true, isSoftBlocked: true };

    try {
        // Reuse cached manifest from Stage 2C.2 bootstrap/bundle if fresh, else 1 REST GET
        let m = (window._finMatCache_ && window._finMatCache_.routeKey === routeKey && window._finMatCache_.manifest && (now - window._finMatCache_.fetchedAt) < 15000)
            ? window._finMatCache_.manifest
            : null;
        if (!m || !m.parts || !m.parts.monthlyReports || !m.parts.monthlyReports[period]) {
            const mSnap = await fastGetPublicDoc_('financialManifestV1', routeKey, routeKey);
            if (!mSnap || !mSnap.exists()) return null;
            m = mSnap.data() || {};
        }
        if (m.contractVersion !== 1 || m.routeKey !== routeKey || !m.parts || !m.parts.monthlyReports) return null;

        const partDocId = m.parts.monthlyReports[period];
        if (!partDocId) return null;

        const pSnap = await fastGetPublicDoc_('monthlyReportSummaryV3', partDocId, routeKey);
        if (!pSnap || !pSnap.exists()) return null;
        const pd = pSnap.data() || {};

        // Strict identity & zero-version-mixing guard
        if (pd.routeKey !== routeKey || pd.period !== period || pd.partType !== 'MONTHLY_REPORT_SUMMARY_V3' || !pd.payload) {
            return null;
        }
        const pv = m.partVersions && m.partVersions.monthlyReports && m.partVersions.monthlyReports[period];
        const expectedG = pv ? Number(pv.g) : Number(m.publishedMutationGeneration);
        const expectedE = pv ? Number(pv.e) : Number(m.publishedFinancialEpoch);
        if (Number(pd.mutationGeneration) !== expectedG ||
            Number(pd.targetFinancialEpoch) !== expectedE ||
            expectedE > Number(m.publishedFinancialEpoch)) {
            return null;
        }

        const freshness = m.freshnessStatus || 'UNVERIFIED';
        if (freshness !== 'CURRENT') {
            showProjectionFreshnessBanner_(freshness === 'DIRTY_IN_FLIGHT' || freshness === 'RECOMPUTING' ? 'PENDING' : freshness, 'Месечен отчет');
        } else {
            showProjectionFreshnessBanner_('CURRENT');
        }

        // Require reportDetails for complete 0-GAS UI rendering (Stage 2C.3 parts always carry it)
        if (!pd.reportDetails || typeof pd.reportDetails !== 'object') return null;

        const viewData = buildMonthlyReportViewDataFromMaterialized_(pd.payload, pd.reportDetails, {
            freshnessStatus: freshness,
            partDocId: partDocId,
            availablePeriods: m.availablePeriods || Object.keys(m.parts.monthlyReports),
            availableYears: m.availableYears || []
        });
        if (!viewData) return null;
        const wrapped = { success: true, viewData: viewData, partDoc: pd, manifest: m };
        window._finMatMonthlyCache_[cacheKey] = { fetchedAt: now, result: wrapped };
        return wrapped;
    } catch (e) {
        if (e && (e.code === 'permission-denied' || String(e.message || '').indexOf('PERMISSION_DENIED') !== -1)) {
            clearProtectedFinancialDomOnBlock_(routeKey, false);
            return { success: false, permissionDenied: true };
        }
        return null;
    }
}
window.readMaterializedMonthlyReportV3_ = readMaterializedMonthlyReportV3_;
window.buildMonthlyReportViewDataFromMaterialized_ = buildMonthlyReportViewDataFromMaterialized_;

function showProjectionFreshnessBanner_(status, contextLabel) {
    let el = document.getElementById('projectionFreshnessBanner');
    if (!status || status === 'CURRENT') {
        if (el) el.style.display = 'none';
        return;
    }
    if (!el) {
        el = document.createElement('div');
        el.id = 'projectionFreshnessBanner';
        el.style.cssText = 'position:fixed;bottom:14px;right:14px;z-index:9999;max-width:360px;padding:10px 14px;border-radius:10px;font-size:13px;font-weight:600;box-shadow:0 4px 16px rgba(0,0,0,.22);display:none;';
        document.body.appendChild(el);
    }
    const map = {
        PENDING: { bg: '#eff6ff', fg: '#1d4ed8', border: '#93c5fd', msg: 'Записано успешно. Справките се обновяват.' },
        STALE: { bg: '#fffbeb', fg: '#b45309', border: '#fcd34d', msg: 'Данните в справката може да не са напълно актуални.' },
        FAILED: { bg: '#fef2f2', fg: '#b91c1c', border: '#fca5a5', msg: 'Обновяването на справката е неуспешно. Данните са неактуални.' },
        UNVERIFIED: { bg: '#fffbeb', fg: '#92400e', border: '#fde68a', msg: 'Справката все още се подготвя или не е верифицирана.' }
    };
    const cfg = map[status] || map.UNVERIFIED;
    el.style.background = cfg.bg;
    el.style.color = cfg.fg;
    el.style.border = '1px solid ' + cfg.border;
    el.textContent = (contextLabel ? contextLabel + ': ' : '') + cfg.msg;
    el.style.display = 'block';
}

function evaluateSubscriptionGateClient_(gate, nowDate) {
    if (!gate || typeof gate !== 'object') return { stale: true, isSoftBlocked: false, isHardBlocked: false, status: 'UNVERIFIED' };
    const nowMs = nowDate ? nowDate.getTime() : Date.now();
    const evalMs = Date.parse(gate.gateEvaluatedAtUtc || '');
    const ttlHours = Number(gate.gateTtlHours) || 24;
    if (!Number.isFinite(evalMs) || (nowMs - evalMs) > ttlHours * 3600000) {
        return { stale: true, isSoftBlocked: false, isHardBlocked: false, status: 'STALE_TTL' };
    }
    if (gate.policyStatus === 'MANUAL_BLOCKED') return { stale: false, isSoftBlocked: true, isHardBlocked: true, status: 'HARD_BLOCKED' };
    if (gate.policyStatus === 'LIFETIME') return { stale: false, isSoftBlocked: false, isHardBlocked: false, status: 'LIFETIME' };
    let todayYmd = '';
    try {
        todayYmd = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(nowMs));
    } catch (e) {
        todayYmd = new Date(nowMs).toISOString().slice(0, 10);
    }
    if (gate.hardBlockFromSofiaYmd && todayYmd >= gate.hardBlockFromSofiaYmd) {
        return { stale: false, isSoftBlocked: true, isHardBlocked: true, status: 'HARD_BLOCKED' };
    }
    if (gate.activeThroughSofiaYmd && todayYmd > gate.activeThroughSofiaYmd) {
        return { stale: false, isSoftBlocked: true, isHardBlocked: false, status: gate.policyStatus === 'TRIAL' ? 'TRIAL_ADMIN_GRACE' : 'PAID_GRACE_7D' };
    }
    return { stale: false, isSoftBlocked: false, isHardBlocked: false, status: gate.policyStatus === 'TRIAL' ? 'TRIAL_FULL' : 'PAID_ACTIVE' };
}

async function readPrecomputedPublicPlatformConfig_() {
    try {
        if (window._stage2c2EarlyPubPromise_) {
            try { await window._stage2c2EarlyPubPromise_; } catch (e) {}
            window._stage2c2EarlyPubPromise_ = null;
        }
        const snap = await fastGetPublicDoc_('publicPlatformConfigV1', 'global', null);
        if (!snap || !snap.exists()) return null;
        const d = snap.data() || {};
        if (d.payload && d.payload.projFlags && typeof d.payload.projFlags === 'object') {
            window._projFlags = Object.assign({}, window._projFlags, d.payload.projFlags);
            window._projFlagsLoaded_ = true;
        }
        if (d.contractVersion !== 1 || d.projectionStatus !== 'CURRENT' || !d.payload) {
            if (d.projectionStatus && d.projectionStatus !== 'CURRENT') showProjectionFreshnessBanner_(d.projectionStatus);
            return null;
        }
        if (window._projFlags.PUBLIC_PLATFORM_CONFIG !== 'ON') return null;
        return { success: true, showRegForm: d.payload.showRegForm, regFormText: d.payload.regFormText, globalMessage: d.payload.globalMessage, _fromPrecomputed: true };
    } catch (e) {
        return null;
    }
}

async function ensureProjFlagsLoaded_() {
    if (window._projFlagsLoaded_) return window._projFlags;
    if (window._projFlagsInFlight_) return window._projFlagsInFlight_;
    window._projFlagsInFlight_ = (async () => {
        try {
            await readPrecomputedPublicPlatformConfig_();
        } catch (e) { /* keep defaults */ }
        return window._projFlags;
    })();
    try {
        return await window._projFlagsInFlight_;
    } finally {
        window._projFlagsInFlight_ = null;
    }
}

async function readPrecomputedEntranceSummary_(routeKey) {
    if (window._projFlags.ENTRANCE_SUMMARY !== 'ON') return null;
    try {
        const snap = await fastGetPublicDoc_('entranceSummaryV1', routeKey, routeKey);
        if (!snap || !snap.exists()) return null;
        const d = snap.data() || {};
        if (d.contractVersion !== 1 || d.routeKey !== routeKey || !d.payload) return null;
        if (d.projectionStatus !== 'CURRENT') {
            showProjectionFreshnessBanner_(d.projectionStatus, 'Обобщение на входа');
            return null;
        }
        const gateEval = evaluateSubscriptionGateClient_(d.payload.subscriptionGate);
        if (gateEval.stale) {
            showProjectionFreshnessBanner_('STALE', 'Абонаментен статус');
            return null;
        }
        const p = d.payload;
        return {
            apartments: Array.isArray(p.apartments) ? p.apartments : null,
            configResult: {
                success: true,
                _fromPrecomputed: true,
                info: {
                    entranceName: p.entranceName || '',
                    currency: p.currency || 'EUR',
                    currentActivePeriod: p.currentActivePeriod || '',
                    isSoftBlocked: gateEval.isSoftBlocked,
                    isHardBlocked: gateEval.isHardBlocked,
                    subscriptionStatus: gateEval.status,
                    paymentInfo: p.paymentInfo || '',
                    entranceNotice: p.publicNotice || '',
                    globalMessage: p.globalMessage || ''
                }
            }
        };
    } catch (e) {
        return null;
    }
}

async function fetchAdminConfigSnapshotV1_(routeKey, forceRefresh) {
    if (window._projFlags.ADMIN_ENTRANCE_CONFIG !== 'ON') return null;
    const pin = (typeof getStoredPin === 'function') ? getStoredPin() : (sessionStorage.getItem('adminPin_' + routeKey) || '');
    if (!pin || !routeKey) { purgeAdminConfigCache_(); return null; }
    const now = Date.now();
    if (!forceRefresh && window._adminConfigCache &&
        window._adminConfigCache.routeKey === routeKey &&
        window._adminConfigCache.pin === pin &&
        (now - window._adminConfigCache.fetchedAt) < 60000) {
        return window._adminConfigCache.snapshot;
    }
    try {
        const res = await fetch(SCRIPT_URL, {
            method: 'POST',
            body: new URLSearchParams({ action: 'getAdminConfigSnapshotV1', routeKey: routeKey, pin: pin })
        });
        if (!res.ok) return null;
        const jsonRes = await res.json();
        if (!jsonRes || jsonRes.success === false) {
            if (jsonRes && (String(jsonRes.error || '').indexOf('Unauthorized') !== -1 || jsonRes.isHardBlocked)) {
                purgeAdminConfigCache_();
                sessionStorage.removeItem('adminPin_' + routeKey);
            }
            return null;
        }
        if (jsonRes.projectionStatus !== 'CURRENT' || !jsonRes.data) {
            showProjectionFreshnessBanner_(jsonRes.projectionStatus || 'UNVERIFIED', 'Админ настройки');
            return null;
        }
        window._adminConfigCache = { routeKey: routeKey, pin: pin, fetchedAt: now, snapshot: jsonRes };
        return jsonRes;
    } catch (e) {
        return null;
    }
}

async function loadPublicSettings() {
    try {
        let res = await readPrecomputedPublicPlatformConfig_();
        if (!res) {
            res = await apiCall('getPublicSettings');
            if (res && res.projFlags && typeof res.projFlags === 'object') {
                window._projFlags = Object.assign({}, window._projFlags, res.projFlags);
            }
        }
        const regLink = document.getElementById("regButtonLink");
        const customText = document.getElementById("regCustomText");
        
        if (res && res.success && regLink) {
            if (res.showRegForm) {
                regLink.style.display = "flex";
                if (customText) customText.style.display = "none";
            } else {
                regLink.style.display = "none";
                if (customText) {
                    if (res.regFormText && res.regFormText.trim() !== "") {
                        customText.style.display = "flex";
                        customText.textContent = res.regFormText;
                    } else {
                        customText.style.display = "none";
                    }
                }
            }
        } else if (regLink) {
            // Default fallback if API fails
            regLink.style.display = "flex";
            if (customText) customText.style.display = "none";
        }
    } catch (e) {
        console.error("Error loading public settings:", e);
    }
}

// ==============================================
// CORE API CALLER
// ==============================================


// Форматира timestamp (ms epoch) като дд.мм.гг — ползва се САМО за
// визуално показване в регистрите (Приходи/Разходи/Разпределение), не
// засяга периодите (мм.гг), с които работят таблиците/изчисленията.
// Превръща обикновен текст в HTML, при което URL адреси (http/https/www.)
// стават кликаеми линкове. Първо escape-ва HTML за безопасност (текстът
// идва от Супер Админ настройки, но пак не се доверяваме сляпо).
function linkifyText(text) {
    if (!text) return "";
    const escaped = text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
    const urlRegex = /((https?:\/\/[^\s<]+)|(www\.[^\s<]+\.[^\s<]+))/gi;
    return escaped.replace(urlRegex, (match) => {
        const href = /^https?:\/\//i.test(match) ? match : "https://" + match;
        return `<a href="${href}" target="_blank" rel="noopener noreferrer" style="color:#007aff; text-decoration:underline;">${match}</a>`;
    });
}

function formatRegisterDate(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    if (isNaN(d.getTime())) return "";
    const dd = String(d.getDate()).padStart(2, '0');
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
}

function formatVisibleCategory(cat) {
    if (!cat) return "";
    let s = String(cat).trim();
    if (s === "Плащане за СО" || s === "EXT_PAYMENT") return "Плащане за самостоятелен обект";
    if (s === "РУП — надбавка чл. 51, ал. 5") return "Управление и поддръжка — надбавка по чл. 51, ал. 5";
    if (s === "РУП (основа)" || s === "РУП основа") return "Управление и поддръжка (основа)";
    if (s === "РУП (надбавка)" || s === "РУП надбавка") return "Управление и поддръжка (надбавка)";
    if (s === "РУП") return "Управление и поддръжка";
    if (s === "Наем на общи части") return "Наем";
    s = s.replace(/Плащане за СО/g, "Плащане за самостоятелен обект");
    s = s.replace(/РУП — надбавка чл\. 51, ал\. 5/g, "Управление и поддръжка — надбавка по чл. 51, ал. 5");
    s = s.replace(/РУП \(основа\)/g, "Управление и поддръжка (основа)");
    s = s.replace(/РУП \(надбавка\)/g, "Управление и поддръжка (надбавка)");
    s = s.replace(/РУП основа/g, "Управление и поддръжка (основа)");
    s = s.replace(/РУП надбавка/g, "Управление и поддръжка (надбавка)");
    s = s.replace(/РУП осн\./g, "Упр. и поддръжка (основа)");
    return s;
}

function formatVisibleSummaryText(text) {
    if (!text) return "";
    let s = String(text);
    s = s.replace(/Плащане за СО/g, "Плащане за самостоятелен обект");
    s = s.replace(/РУП — надбавка чл\. 51, ал\. 5/g, "Управление и поддръжка — надбавка по чл. 51, ал. 5");
    s = s.replace(/РУП \(основа\)/g, "Управление и поддръжка (основа)");
    s = s.replace(/РУП \(надбавка\)/g, "Управление и поддръжка (надбавка)");
    s = s.replace(/РУП основа/g, "Управление и поддръжка (основа)");
    s = s.replace(/РУП надбавка/g, "Управление и поддръжка (надбавка)");
    s = s.replace(/РУП осн\./g, "Упр. и поддръжка (основа)");
    s = s.replace(/\bСО\b/g, "Самостоятелен обект");
    return s;
}

// Превръща период "ММ.ГГГГ" в сравнимо число ГГГГММ — огледално на
// periodToSortable_ в Code.gs. НЕ сравнявай периоди като текст директно
// (грешно около всяка годишна граница).
function periodToSortableClient(period) {
    if (!period) return 0;
    const parts = period.toString().trim().split(".");
    if (parts.length !== 2) return 0;
    const mm = parseInt(parts[0], 10) || 0;
    const yyyy = parseInt(parts[1], 10) || 0;
    return yyyy * 100 + mm;
}

function apiRequestParams(action, params = {}) {
    return { ...params, action, routeKey: params.routeKey || currentRouteKey };
}

// Compatibility hooks preserve the former normal-entrance behavior: shared
// visitor generations no longer exist, so no public session owner is captured.
function captureRouteRequestContext() { return null; }
function isCurrentRouteRequestContext(owner) { return !owner; }
function throwIfStaleRouteRequestContext(owner) {
    if (!isCurrentRouteRequestContext(owner)) throw new Error('Stale route response');
}
function isStaleRouteRequestError(error) { return !!(error && error.staleRouteResponse); }
function reconcileRouteRequestContext(owner, cause) {
    if (!isCurrentRouteRequestContext(owner)) {
        const error = new Error('Stale route response');
        error.staleRouteResponse = true;
        if (cause) error.cause = cause;
        throw error;
    }
}

// A user-triggered financial workflow is bound to the entrance where it began.
// This is intentionally narrower than a browser/session generation framework.
function captureFinancialOperationContext(apartment, documentId) {
    const routeKey = currentRouteKey;
    if (typeof routeKey !== "string" || !routeKey.trim()) {
        throw new Error("Financial operation requires an active entrance");
    }
    const context = { routeKey: routeKey, navigationRevision: financialNavigationRevision_ };
    if (apartment !== undefined && apartment !== null) context.apartment = String(apartment);
    if (documentId !== undefined && documentId !== null && documentId !== "") context.documentId = String(documentId);
    const frozenContext = Object.freeze(context);
    issuedFinancialOperationContexts_.add(frozenContext);
    return frozenContext;
}

function deriveFinancialApartmentContext(operationContext, apartment) {
    if (!operationContext || !issuedFinancialOperationContexts_.has(operationContext) ||
        typeof operationContext.routeKey !== "string") {
        throw new TypeError("A valid financial operation context is required");
    }
    const childContext = Object.freeze({
        routeKey: operationContext.routeKey,
        navigationRevision: operationContext.navigationRevision,
        apartment: String(apartment)
    });
    issuedFinancialOperationContexts_.add(childContext);
    return childContext;
}

function isFinancialOperationContextCurrent(operationContext) {
    return !!operationContext && issuedFinancialOperationContexts_.has(operationContext) &&
        currentRouteKey === operationContext.routeKey &&
        financialNavigationRevision_ === operationContext.navigationRevision;
}

function assertFinancialOperationContextCurrent(operationContext, cause) {
    if (!isFinancialOperationContextCurrent(operationContext)) {
        const error = new Error("Stale financial operation");
        error.staleRouteResponse = true;
        if (cause) error.cause = cause;
        throw error;
    }
    return operationContext;
}

function initializeFinancialFormState_() {
    const controls = [
        ["v2SubmitDistBtn", "🧮 Разпредели сумата"],
        ["v2SubmitBtn", "➕ Добави приход"],
        ["v2SavePayerBtn", "💾 Запиши"]
    ];
    controls.forEach(([id, text]) => {
        const button = document.getElementById(id);
        if (!button) return;
        button.disabled = false;
        button.textContent = text;
    });
    const editId = document.getElementById("v2IncomeEditId");
    if (editId) editId.value = "";
    const cancelEdit = document.getElementById("v2CancelEditBtn");
    if (cancelEdit) cancelEdit.style.display = "none";
    if (typeof resetManualExpenseView_ === 'function') resetManualExpenseView_();
    if (typeof resetRecurringExpenseView_ === 'function') resetRecurringExpenseView_(); // SLICE5_RECURRING_UI
}

function setFinancialEntranceRoute_(nextRouteKey) {
    financialNavigationRevision_ += 1;
    currentRouteKey = nextRouteKey;
    initializeFinancialFormState_();
}

function assertSuccessfulApiResult(result, operationName) {
    if (result && result.success === true) return result;
    let detail = "липсва валиден success резултат";
    if (result && typeof result.error === "string" && result.error) detail = result.error;
    const error = new Error((operationName || "Финансовата операция") + " е неуспешна: " + detail);
    error.financialBusinessFailure = true;
    error.apiResult = result;
    throw error;
}

function createFinancialPartialCompletionError_(message, stage, evidence, cause) {
    const error = new Error(message);
    error.financialPartialCompletion = true;
    error.financialPartialStage = stage;
    if (evidence && Array.isArray(evidence.completedPayments)) {
        error.completedPayments = Object.freeze(evidence.completedPayments.map(item =>
            Object.freeze({ apartment: String(item.apartment), amount: Number(item.amount) })));
    }
    if (evidence && Array.isArray(evidence.committedStages)) {
        error.committedStages = Object.freeze(evidence.committedStages.map(String));
    }
    if (evidence && evidence.distributionPersisted !== undefined) {
        error.distributionPersisted = evidence.distributionPersisted === true;
    }
    if (cause) error.cause = cause;
    return error;
}

function normalizeFinancialApartmentId_(value) {
    if (typeof value !== "string") throw new TypeError("Идентификаторът на апартамента е невалиден");
    const canonicalId = value.trim().replace(/А/g, "A");
    if (!/^A[1-9]\d*$/.test(canonicalId)) {
        throw new TypeError("Невалиден идентификатор на апартамент: " + value);
    }
    return canonicalId;
}

function snapshotFinancialApartmentList_(source) {
    if (!Array.isArray(source) || Object.getPrototypeOf(source) !== Array.prototype) return Object.freeze([]);
    const snapshot = new Array(source.length);
    for (let index = 0; index < source.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(source, index);
        if (descriptor && Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            snapshot[index] = descriptor.value;
        }
    }
    return Object.freeze(snapshot);
}

function buildValidatedFinancialApartmentSet_(requiredApartments) {
    if (!Array.isArray(requiredApartments) || Object.getPrototypeOf(requiredApartments) !== Array.prototype ||
        requiredApartments.length === 0) {
        throw new TypeError("Липсва списъкът със задължителни апартаменти");
    }
    const seenApartments = new Set();
    const apartmentSet = [];
    for (let index = 0; index < requiredApartments.length; index++) {
        const descriptor = Object.getOwnPropertyDescriptor(requiredApartments, index);
        if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, "value")) {
            throw new TypeError("Списъкът с апартаменти не трябва да съдържа празни позиции");
        }
        const canonicalId = normalizeFinancialApartmentId_(descriptor.value);
        const targetId = descriptor.value.trim();
        if (seenApartments.has(canonicalId)) {
            throw new TypeError("Дублиран идентификатор на апартамент: " + canonicalId);
        }
        seenApartments.add(canonicalId);
        apartmentSet.push(Object.freeze({ canonicalId: canonicalId, targetId: targetId }));
    }
    return Object.freeze(apartmentSet);
}

function buildValidatedFinancialAllocationPlan_(requiredApartments, parts, financialAmount) {
    const apartmentSet = buildValidatedFinancialApartmentSet_(requiredApartments);
    if (!parts || typeof parts !== "object" || Array.isArray(parts)) {
        throw new TypeError("Данните за идеалните части са невалидни");
    }
    if (typeof financialAmount !== "number" || !Number.isFinite(financialAmount) || financialAmount === 0) {
        throw new TypeError("Сумата за разпределение е невалидна");
    }

    const partKeysByCanonicalId = new Map();
    Object.keys(parts).forEach(partKey => {
        let canonicalId;
        try {
            canonicalId = normalizeFinancialApartmentId_(partKey);
        } catch (error) {
            return;
        }
        if (!partKeysByCanonicalId.has(canonicalId)) partKeysByCanonicalId.set(canonicalId, []);
        partKeysByCanonicalId.get(canonicalId).push(partKey);
    });

    const validatedParts = apartmentSet.map(apartment => {
        const matchingKeys = partKeysByCanonicalId.get(apartment.canonicalId) || [];
        if (matchingKeys.length !== 1 || !Object.prototype.hasOwnProperty.call(parts, matchingKeys[0])) {
            throw new TypeError(matchingKeys.length > 1
                ? "Дублирани идеални части за " + apartment.canonicalId
                : "Липсват идеални части за " + apartment.targetId);
        }
        const value = parts[matchingKeys[0]];
        if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
            throw new TypeError("Невалидни идеални части за " + apartment.targetId);
        }
        return Object.freeze({
            canonicalId: apartment.canonicalId,
            apartment: apartment.targetId,
            idealPart: value
        });
    });

    const totalIdealParts = validatedParts.reduce((sum, item) => sum + item.idealPart, 0);
    if (!Number.isFinite(totalIdealParts) || totalIdealParts <= 0) {
        throw new TypeError("Общият сбор на идеалните части е невалиден");
    }
    const allocations = validatedParts.map(item => {
        const allocation = financialAmount * item.idealPart / totalIdealParts;
        if (!Number.isFinite(allocation)) throw new TypeError("Невалидно разпределение за " + item.apartment);
        return Object.freeze({ canonicalId: item.canonicalId, apartment: item.apartment, amount: allocation });
    });
    const allocationTotal = allocations.reduce((sum, item) => sum + item.amount, 0);
    const allowedDrift = Math.max(1, Math.abs(financialAmount)) * Number.EPSILON * Math.max(8, allocations.length * 4);
    if (!Number.isFinite(allocationTotal) || Math.abs(allocationTotal - financialAmount) > allowedDrift) {
        throw new TypeError("Разпределението не съответства на финансовата сума");
    }
    return Object.freeze({
        totalIdealParts: totalIdealParts,
        allocations: Object.freeze(allocations)
    });
}

function buildValidatedCreditAllocationPlan_(requiredApartments, parts, creditAmount) {
    return buildValidatedFinancialAllocationPlan_(requiredApartments, parts, creditAmount);
}

function readLocalFinancialRecords_(storageKey) {
    const raw = localStorage.getItem(storageKey);
    let records;
    try {
        records = JSON.parse(raw === null ? "[]" : raw);
    } catch (error) {
        throw new TypeError("Локалните финансови данни са повредени");
    }
    if (!Array.isArray(records) || records.some(record => !record || typeof record !== "object" || Array.isArray(record))) {
        throw new TypeError("Локалните финансови данни са в невалиден формат");
    }
    return records;
}

// Local persistence is an explicit compatibility path only for a canonical
// Firestore permission denial. Ambiguous network/programming/security errors
// fail closed and must never be converted into an apparent successful save.
function isFirestorePermissionFallbackError(error) {
    try {
        if (!(error instanceof Error) || error instanceof TypeError || error instanceof ReferenceError ||
            error.staleRouteResponse === true || error.financialBusinessFailure === true) return false;
        const code = error.code;
        const message = error.message;
        if (/Facade-issued|Retired TEST target|Contradictory mutation owner|trusted Firestore binding|mutation authority|unsupported/i.test(message)) {
            return false;
        }
        if (code !== undefined && code !== null && code !== "") {
            return code === "permission-denied";
        }
        return message === "Missing or insufficient permissions." ||
            message === "Missing or insufficient permissions";
    } catch (readError) {
        return false;
    }
}

async function bgApiCall(action, params = {}) {
    if (!SCRIPT_URL.startsWith("https://script.google.com/macros")) return { error: 'No Script URL configured' };
    const owner = captureRouteRequestContext();
    params = apiRequestParams(action, params);
    const queryParams = new URLSearchParams(params).toString();
    try {
        const response = await fetch(`${SCRIPT_URL}?${queryParams}`);
        const result = await response.json();
        throwIfStaleRouteRequestContext(owner);
        return result;
    } catch (error) {
        reconcileRouteRequestContext(owner, error);
        if (isStaleRouteRequestError(error)) throw error;
        return { error: error.toString() };
    }
}

// BEGIN ART51 CLIENT
function art51CurrentCalendarPeriod_() {
    const now = new Date();
    return String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear();
}

function art51PeriodNumber_(p) {
    if (!p || typeof p !== 'string' || !/^(0[1-9]|1[0-2])\.(20[0-4][0-9]|2050)$/.test(p)) return 0;
    return Number(p.slice(3)) * 12 + Number(p.slice(0, 2));
}

function art51CurrentAdminEmail_() {
    return sessionStorage.getItem("adminEmail_" + currentRouteKey) ||
           localStorage.getItem("savedAdminEmail") ||
           (typeof entranceData !== 'undefined' && entranceData && entranceData.adminEmail) || '';
}

function art51FormatDateTime_(iso) {
    if (!iso) return '-';
    try {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return iso;
        return d.toLocaleString('bg-BG', { timeZone: 'Europe/Sofia' });
    } catch(e) {
        return iso;
    }
}

function art51EscapeHtml_(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderArt51ActionsTable_(actions) {
    const tbody = document.getElementById('art51ActionsBody');
    if (!tbody) return;
    if (!Array.isArray(actions) || actions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="9" style="text-align: center; color: #64748b; padding: 14px;">Няма записани действия.</td></tr>';
        return;
    }
    const sorted = actions.slice().sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
    let html = '';
    sorted.forEach(a => {
        const dt = art51FormatDateTime_(a.timestamp);
        const apt = a.apartment || '-';
        const prevState = a.previousState === 'ДА' ? '<span class="art51-status-da">ДА</span>' : '<span class="art51-status-ne">НЕ</span>';
        const newState = a.newState === 'ДА' ? '<span class="art51-status-da">ДА</span>' : '<span class="art51-status-ne">НЕ</span>';
        
        let multStr = '-';
        if (a.previousMultiplier && a.newMultiplier) multStr = `${a.previousMultiplier} → ${a.newMultiplier}`;
        else if (a.newMultiplier) multStr = `- → ${a.newMultiplier}`;
        else if (a.previousMultiplier) multStr = `${a.previousMultiplier} → -`;
        
        const period = a.effectiveFromPeriod || '-';
        const decDate = a.decisionDate || '-';
        const decRef = a.decisionReference ? art51EscapeHtml_(a.decisionReference) : '-';
        const admin = a.adminEmail ? art51EscapeHtml_(a.adminEmail) : '-';
        
        html += `<tr>
            <td style="white-space: nowrap;">${dt}</td>
            <td style="font-weight: 600;">${apt}</td>
            <td>${prevState}</td>
            <td>${newState}</td>
            <td style="font-weight: 600;">${multStr}</td>
            <td>${period}</td>
            <td>${decDate}</td>
            <td>${decRef}</td>
            <td>${admin}</td>
        </tr>`;
    });
    tbody.innerHTML = html;
}

window.loadArt51Actions = async function() {
    const owner = captureRouteRequestContext();
    try {
        const result = await apiCall('getArt51ActionsV1', { pin: getStoredPin() });
        throwIfStaleRouteRequestContext(owner);
        if (result && result.success && Array.isArray(result.actions)) {
            renderArt51ActionsTable_(result.actions);
        }
    } catch(e) {}
};

window.openArt51Settings = function() {
    const target = document.getElementById('art51Apartment');
    const source = document.getElementById('masterInfoApt');
    if (target && !target.options.length) {
        if (source && source.options && source.options.length) {
            Array.from(source.options).forEach(opt => {
                if (opt.value) {
                    const o = document.createElement('option');
                    o.value = opt.value;
                    o.textContent = opt.textContent;
                    target.appendChild(o);
                }
            });
        } else if (typeof entranceData !== 'undefined' && entranceData && entranceData.apartmentsCount) {
            const count = Number(entranceData.apartmentsCount) || 30;
            for (let i = 1; i <= count; i++) {
                const o = document.createElement('option');
                o.value = 'A' + i;
                o.textContent = 'A' + i;
                target.appendChild(o);
            }
        }
    }
    const periodInput = document.getElementById('art51Period');
    if (periodInput && !periodInput.value) {
        periodInput.value = art51CurrentCalendarPeriod_();
    }
    window.art51ApartmentChanged();
    window.loadArt51Actions();
};

let art51RequestSeq = 0;
let art51CurrentLoadedApt = null;
window.art51Cache = (window.art51Cache instanceof Map) ? window.art51Cache : new Map();

function art51EscapeHtml_(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function clearArt51Fields_() {
    const activeSel = document.getElementById('art51Active');
    if (activeSel) activeSel.value = 'false';
    const multInput = document.getElementById('art51Multiplier');
    if (multInput) multInput.value = '';
    const dateInput = document.getElementById('art51DecisionDate');
    if (dateInput) dateInput.value = '';
    const refInput = document.getElementById('art51Reference');
    if (refInput) refInput.value = '';
    window.art51ActiveChanged();
}

function applyArt51Data_(apt, v) {
    const badge = document.getElementById('art51CurrentBadge');
    const isDa = !!(v && v.active);
    if (badge) {
        if (isDa) {
            badge.innerHTML = `${art51EscapeHtml_(apt)} (общ. достъп -&nbsp;<span class="art51-status-da">ДА</span>)`;
            badge.className = 'art51-badge art51-badge-da';
        } else {
            badge.innerHTML = `${art51EscapeHtml_(apt)} (общ. достъп -&nbsp;<span class="art51-status-ne">НЕ</span>)`;
            badge.className = 'art51-badge art51-badge-ne';
        }
    }
    const activeSel = document.getElementById('art51Active');
    if (activeSel) activeSel.value = isDa ? 'true' : 'false';
    
    const multInput = document.getElementById('art51Multiplier');
    const dateInput = document.getElementById('art51DecisionDate');
    const refInput = document.getElementById('art51Reference');
    
    if (isDa) {
        if (multInput) multInput.value = v.multiplier || 3;
        if (dateInput) dateInput.value = v.decisionDate || '';
        if (refInput) refInput.value = v.decisionReference || '';
    } else {
        if (multInput) multInput.value = '';
        if (dateInput) dateInput.value = '';
        if (refInput) refInput.value = '';
    }
    window.art51ActiveChanged();
}

function handleArt51LoadError_(apt, err) {
    art51CurrentLoadedApt = null;
    const badge = document.getElementById('art51CurrentBadge');
    const saveBtn = document.getElementById('art51SaveBtn');
    const statusMsg = document.getElementById('art51Status');
    if (badge) {
        badge.innerHTML = `${art51EscapeHtml_(apt)} (Състоянието не е заредено)`;
        badge.className = 'art51-badge art51-badge-error';
    }
    if (statusMsg) {
        statusMsg.textContent = 'Състоянието не е заредено';
    }
    if (saveBtn) {
        saveBtn.disabled = true;
    }
    clearArt51Fields_();
}

window.art51ApartmentChanged = async function() {
    const aptSelect = document.getElementById('art51Apartment');
    if (!aptSelect) return;
    const apt = aptSelect.value;
    const badge = document.getElementById('art51CurrentBadge');
    const saveBtn = document.getElementById('art51SaveBtn');
    const statusMsg = document.getElementById('art51Status');
    if (statusMsg) statusMsg.textContent = '';
    
    if (!apt) {
        art51CurrentLoadedApt = null;
        if (badge) { badge.innerHTML = ''; badge.className = 'art51-badge'; }
        if (saveBtn) saveBtn.disabled = true;
        clearArt51Fields_();
        return;
    }
    const currentPeriod = art51CurrentCalendarPeriod_();
    const periodInput = document.getElementById('art51Period');
    if (periodInput && !periodInput.value) periodInput.value = currentPeriod;
    
    // Check cache first for immediate zero-latency feedback
    if (window.art51Cache && window.art51Cache.has(apt)) {
        const cached = window.art51Cache.get(apt);
        if (cached && cached.success) {
            art51RequestSeq++; // invalidate any previous pending fetch
            art51CurrentLoadedApt = apt;
            applyArt51Data_(apt, cached.version);
            if (saveBtn) saveBtn.disabled = false;
            if (Array.isArray(cached.actions)) {
                renderArt51ActionsTable_(cached.actions);
            }
            return;
        }
    }
    
    // 1. Immediately hide old status
    // 2. Show small animated indicator and "Проверява се състоянието…"
    const requestSeq = ++art51RequestSeq;
    const requestedApt = apt;
    art51CurrentLoadedApt = null;
    if (saveBtn) saveBtn.disabled = true;
    clearArt51Fields_();
    
    if (badge) {
        badge.innerHTML = `<span class="art51-spinner"></span> ${art51EscapeHtml_(apt)} (Проверява се състоянието…)`;
        badge.className = 'art51-badge art51-badge-checking';
    }
    
    const owner = captureRouteRequestContext();
    try {
        const result = await apiCall('getArt51V1', { pin: getStoredPin(), request: JSON.stringify({ apartment: apt, period: currentPeriod }) });
        throwIfStaleRouteRequestContext(owner);
        
        // 4. Stale check: discard if newer request was started or dropdown changed
        if (requestSeq !== art51RequestSeq || document.getElementById('art51Apartment')?.value !== requestedApt) {
            return;
        }
        
        if (result && result.success) {
            // 5. Cache result
            if (window.art51Cache) {
                window.art51Cache.set(apt, result);
            }
            art51CurrentLoadedApt = apt;
            // 3. Show actual status
            applyArt51Data_(apt, result.version);
            if (saveBtn) saveBtn.disabled = false;
            if (Array.isArray(result.actions)) {
                renderArt51ActionsTable_(result.actions);
            }
        } else {
            // 6. On error, show "Състоянието не е заредено"
            handleArt51LoadError_(apt, result ? result.error : 'Неуспешно зареждане');
        }
    } catch(e) {
        if (requestSeq !== art51RequestSeq || document.getElementById('art51Apartment')?.value !== requestedApt) {
            return;
        }
        handleArt51LoadError_(apt, e.message || e);
    }
};

window.art51ActiveChanged = function() {
    const active = document.getElementById('art51Active').value === 'true';
    const multGroup = document.getElementById('art51MultiplierGroup');
    const dateGroup = document.getElementById('art51DecisionDateGroup');
    const refGroup = document.getElementById('art51ReferenceGroup');
    const multInput = document.getElementById('art51Multiplier');
    
    if (active) {
        if (multInput && !multInput.value) multInput.value = '3';
        if (multGroup) multGroup.style.opacity = '1';
        if (dateGroup) dateGroup.style.opacity = '1';
        if (refGroup) refGroup.style.opacity = '1';
    } else {
        if (multGroup) multGroup.style.opacity = '0.6';
        if (dateGroup) dateGroup.style.opacity = '0.6';
        if (refGroup) refGroup.style.opacity = '0.6';
    }
};

window.saveArt51Settings = async function() {
    const statusMsg = document.getElementById('art51Status');
    const saveBtn = document.getElementById('art51SaveBtn');
    const apt = (document.getElementById('art51Apartment')?.value || '').trim();
    const active = document.getElementById('art51Active').value === 'true';
    const period = (document.getElementById('art51Period').value || '').trim();
    const multVal = document.getElementById('art51Multiplier').value;
    const dateVal = (document.getElementById('art51DecisionDate').value || '').trim();
    const refVal = (document.getElementById('art51Reference').value || '').trim();
    
    // 7. Guard: prevent saving if data for chosen apartment is not ready
    if (!apt || art51CurrentLoadedApt !== apt) {
        showToast('Данните за избрания апартамент не са готови. Моля, изчакайте зареждането.', 'error');
        if (statusMsg) statusMsg.textContent = 'Данните за избрания апартамент не са готови.';
        return;
    }
    if (!/^(0[1-9]|1[0-2])\.(20[0-4][0-9]|2050)$/.test(period)) {
        showToast('Невалиден период. Форматът трябва да е MM.YYYY.', 'error');
        if (statusMsg) statusMsg.textContent = 'Невалиден период. Форматът трябва да е MM.YYYY.';
        return;
    }
    const currentPeriod = art51CurrentCalendarPeriod_();
    if (art51PeriodNumber_(period) < art51PeriodNumber_(currentPeriod)) {
        showToast('Периодът не може да бъде в миналото. Изберете текущ или бъдещ месец.', 'error');
        if (statusMsg) statusMsg.textContent = 'Периодът не може да бъде в миналото. Изберете текущ или бъдещ месец.';
        return;
    }
    
    let multiplier = null;
    let decisionDate = null;
    let decisionReference = null;
    let motivatedDecisionConfirmed = false;
    
    if (active) {
        const mNum = Number(multVal);
        if (isNaN(mNum) || mNum < 3 || mNum > 5) {
            showToast('Невалиден множител. Въведете число от 3 до 5.', 'error');
            if (statusMsg) statusMsg.textContent = 'Невалиден множител. Въведете число от 3 до 5.';
            return;
        }
        multiplier = mNum;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(dateVal) || isNaN(Date.parse(dateVal + 'T00:00:00.000Z'))) {
            showToast('Моля, въведете дата на решение на ОС.', 'error');
            if (statusMsg) statusMsg.textContent = 'Моля, въведете дата на решение на ОС.';
            return;
        }
        decisionDate = dateVal;
        decisionReference = refVal;
        motivatedDecisionConfirmed = true;
    } else {
        multiplier = null;
        decisionDate = null;
        decisionReference = null;
        motivatedDecisionConfirmed = false;
    }
    
    const request = {
        contractVersion: 1,
        changeRequestId: crypto.randomUUID(),
        apartment: apt,
        active: active,
        multiplier: multiplier,
        effectiveFromPeriod: period,
        decisionDate: decisionDate,
        decisionReference: decisionReference,
        motivatedDecisionConfirmed: motivatedDecisionConfirmed
    };
    
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = 'Записване...';
    }
    if (statusMsg) statusMsg.textContent = 'Записване на настройката...';
    
    const adminEmail = art51CurrentAdminEmail_();
    const owner = captureRouteRequestContext();
    try {
        const result = await apiCall('saveArt51V1', {
            pin: getStoredPin(),
            request: JSON.stringify(request),
            adminEmail: adminEmail
        });
        throwIfStaleRouteRequestContext(owner);
        
        if (result && result.success) {
            showToast('Настройката е запазена успешно.', 'success');
            if (statusMsg) statusMsg.textContent = 'Настройката е запазена успешно.';
            
            // Calculate applicable status for current period
            const badge = document.getElementById('art51CurrentBadge');
            let isCurrentDa = false;
            if (art51PeriodNumber_(period) <= art51PeriodNumber_(currentPeriod)) {
                isCurrentDa = active;
            } else {
                const wasDa = badge && badge.classList.contains('art51-badge-da');
                isCurrentDa = wasDa;
            }
            if (badge) {
                if (isCurrentDa) {
                    badge.innerHTML = `${art51EscapeHtml_(apt)} (общ. достъп -&nbsp;<span class="art51-status-da">ДА</span>)`;
                    badge.className = 'art51-badge art51-badge-da';
                } else {
                    badge.innerHTML = `${art51EscapeHtml_(apt)} (общ. достъп -&nbsp;<span class="art51-status-ne">НЕ</span>)`;
                    badge.className = 'art51-badge art51-badge-ne';
                }
            }
            
            // 5. Update cache after successful save
            if (window.art51Cache) {
                window.art51Cache.set(apt, {
                    success: true,
                    version: {
                        apartment: apt,
                        active: isCurrentDa,
                        multiplier: isCurrentDa ? multiplier : null,
                        decisionDate: isCurrentDa ? decisionDate : null,
                        decisionReference: isCurrentDa ? decisionReference : null,
                        effectiveFromPeriod: period
                    },
                    actions: Array.isArray(result.actions) ? result.actions : (window.art51Cache.get(apt)?.actions || [])
                });
            }
            
            if (Array.isArray(result.actions)) {
                renderArt51ActionsTable_(result.actions);
            } else {
                window.loadArt51Actions();
            }
        } else {
            let errorMsg = 'Възникна грешка при запазване.';
            const err = result ? result.error : '';
            if (err === 'ART51_DECISION') errorMsg = 'Невалидни данни за решението на ОС (необходими са валиден множител от 3 до 5 и дата на ОС).';
            else if (err === 'ART51_PROSPECTIVE_PERIOD') errorMsg = 'Периодът не може да бъде в миналото. Изберете текущ или бъдещ месец.';
            else if (err === 'ART51_VALIDATION') errorMsg = 'Невалидни данни за настройката.';
            else if (err === 'ART51_FINANCIAL_CONFLICT') errorMsg = 'Финансов конфликт: съществуват приключени начисления или плащания.';
            else if (err) errorMsg = 'Грешка: ' + err;
            
            showToast(errorMsg, 'error');
            if (statusMsg) statusMsg.textContent = errorMsg;
        }
    } catch(err) {
        const errorMsg = 'Грешка при връзка със сървъра: ' + (err.message || err);
        showToast(errorMsg, 'error');
        if (statusMsg) statusMsg.textContent = errorMsg;
    } finally {
        if (saveBtn) {
            saveBtn.disabled = (art51CurrentLoadedApt !== apt);
            saveBtn.textContent = 'ЗАПАЗИ';
        }
    }
};

// Aliases for compatibility
window.loadArt51Settings = window.art51ApartmentChanged;
window.art51ContextChanged = function() {};
window.retryArt51Settings = window.saveArt51Settings;
// END ART51 CLIENT
async function apiCall(action, params = {}, operationContext) {
    showLoading();
    const owner = captureRouteRequestContext();

    // Ако SCRIPT_URL не съдържа истински google script URL, връщаме грешка
    if (!SCRIPT_URL.startsWith("https://script.google.com/macros")) {
        hideLoading();
        console.error("Моля, сложете реалния SCRIPT_URL в app.js");
        showToast("Грешка: Липсва връзка с Google Script (API)", "error");
        return { error: 'No Script URL configured' };
    }

    params = apiRequestParams(action, params);

    const queryParams = new URLSearchParams(params).toString();

    try {
        // STAGE 2A.2: Cache invalidation on config writes & fast cached read for admin config tabs when flag is ON
        if (['updateMaster', 'saveArt51V1', 'saveElevatorChipsConfigV1', 'saveRecurringExpenseV1', 'updateAdminEmail'].indexOf(action) !== -1) {
            purgeAdminConfigCache_();
        }
        if ((action === 'getBuildingIdealParts' || action === 'getPeriodOccupants') && window._projFlags && window._projFlags.ADMIN_ENTRANCE_CONFIG === 'ON' && currentRouteKey) {
            const snap = await fetchAdminConfigSnapshotV1_(currentRouteKey, false);
            if (snap && snap.data) {
                if (action === 'getBuildingIdealParts' && snap.data.idealPartsMeta) {
                    hideLoading();
                    return Object.assign({ success: true, parts: snap.data.idealParts || {}, _fromPrecomputed: true }, snap.data.idealPartsMeta);
                }
                if (action === 'getPeriodOccupants' && params.period && snap.data.occupantsByPeriod && snap.data.occupantsByPeriod[params.period]) {
                    hideLoading();
                    return { success: true, period: params.period, occupants: snap.data.occupantsByPeriod[params.period], _fromPrecomputed: true };
                }
            }
        }
        // The accepted form-POST contract avoids URL limits for nine per-category notes.
        const response = (action === 'getAdminConfigSnapshotV1' || action === 'getAdminFinancialBundleV1' || action === 'retryFailedProjectionsV1' || action === 'distributeMaintenanceV1' || action === 'fin01Preview' || action === 'fin01Settle' || action === 'addChargesV2' || action === 'saveRecurringExpenseV1' || action === 'previewExternalUnitPaymentV1' || action === 'recordExternalUnitPaymentV1' || action === 'reverseExternalUnitPaymentV1' || action === 'distributeIncomeV2') ? // SLICE5_RECURRING_UI // FIN01_POST // MAINTENANCE_POST
            await fetch(SCRIPT_URL, {method: 'POST', body: new URLSearchParams(params)}) :
            await fetch(`${SCRIPT_URL}?${queryParams}`);
        if (!response.ok) throw new Error('HTTP_' + response.status);
        const result = await response.json();
        if (result && (String(result.error || '').indexOf('Unauthorized') !== -1 || result.isHardBlocked)) {
            purgeAdminConfigCache_();
        }
        throwIfStaleRouteRequestContext(owner);
        if (operationContext) assertFinancialOperationContextCurrent(operationContext);
        hideLoading();
        return result;
    } catch (error) {
        reconcileRouteRequestContext(owner, error);
        if (isStaleRouteRequestError(error)) throw error;
        if (operationContext) {
            assertFinancialOperationContextCurrent(operationContext, error);
            hideLoading();
            console.error("API Call failed:", error);
            throw error;
        }
        hideLoading();
        console.error("API Call failed:", error);
        showToast("Проблем с връзката към сървъра", "error");
        return { error: error.toString() };
    }
}

// ==============================================
// UI HELPERS
// ==============================================

window.activeLoadingRequests = 0;
window.showLoading = function () { return;
    window.activeLoadingRequests++;
    const loader = document.getElementById("loadingOverlay");
    if (loader) loader.classList.add("active");

    // Safety timeout: ако нещо забие, скриваме лоудъра след 15 секунди
    clearTimeout(window.loaderSafetyTimeout);
    window.loaderSafetyTimeout = setTimeout(() => {
        window.activeLoadingRequests = 0;
        const loader = document.getElementById("loadingOverlay");
        if (loader) loader.classList.remove("active");
    }, 15000);
}
window.hideLoading = function () { return;
    window.activeLoadingRequests--;
    if (window.activeLoadingRequests > 0) return;
    window.activeLoadingRequests = 0;
    const loader = document.getElementById("loadingOverlay");
    if (loader) loader.classList.remove("active");
    clearTimeout(window.loaderSafetyTimeout);
}

window.normalizeAptName = function (name) {
    if (!name) return "";
    return name.toString().toUpperCase().replace(/А/g, "A").replace(/\s+/g, "");
}

function resetApartmentData() {
    const sc = document.getElementById("saldoCard");
    sc.className = "card saldo-card saldo-zero";
    document.getElementById("saldo").textContent = "-";
    document.getElementById("tableBody").innerHTML = "";
    document.getElementById("payment-reference-box").style.display = "none";
    document.getElementById("payment-details-box").style.display = "none";
    document.getElementById("individualAptNotice").style.display = "none";
    const aBox = document.getElementById("individualAptArt51Box");
    if (aBox) aBox.style.display = "none";
}

// --- TOAST ---
let toastTimeout;
window.showToast = function (msg, type, durationMs) {
    const t = document.getElementById("toast");
    // innerHTML вместо textContent, за да могат съобщения с частично оцветен
    // текст (напр. "Записано!" в зелено + обяснение в червено) да се показват.
    // Обикновените текстови съобщения (без HTML тагове) изглеждат идентично.
    t.innerHTML = msg;
    t.className = "toast " + type;
    clearTimeout(toastTimeout);
    requestAnimationFrame(() => { t.classList.add("show"); });
    toastTimeout = setTimeout(() => { t.classList.remove("show"); }, durationMs || 3500);
}

// Общо съобщение за "записано локално, ще се отрази реално скоро" —
// ползва се при Начисления, Разпределение и Приходи в админ панела.
const SAVED_SYNC_TOAST_MSG = '<strong style="color:#2e9e4f; font-weight:800;">Записано!</strong> <span style="color:#d32f2f; font-weight:400;">Ще се отрази реално до минута</span>';

// --- SAVING STATE (Unified circular spinner + truthful status) ---
window.showSaving = function (btn, text = "Обработва се…") {
    if (!btn) return;
    if (btn._originalText === undefined || !btn.disabled) {
        btn._originalText = btn.innerHTML;
    }
    btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:6px;"><span class="btn-spinner" aria-hidden="true"></span><span>${text}</span></span>`;
    btn.disabled = true;
    btn.style.opacity = "0.85";
};
window.hideSaving = function (btn, originalText) {
    if (!btn) return;
    btn.innerHTML = originalText || btn._originalText || "Запази";
    btn.disabled = false;
    btn.style.opacity = "";
};

window.refreshCurrentView = function () {
    console.log("Refreshing current view data...");
    loadDashboardData();
    const apt = document.getElementById("apartmentSelect").value;
    if (apt) {
        loadApartmentData(apt);
    }
}

window.toggleContactForm = function() {
    const section = document.getElementById('contact-section');
    if (section.classList.contains('hidden')) {
        // Затваряме формата за регистрация, ако е отворена
        document.getElementById('registration-section').classList.add('hidden');
        
        section.classList.remove('hidden');
        setTimeout(() => {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } else {
        section.classList.add('hidden');
    }
};

window.toggleRegistrationForm = function() {
    const section = document.getElementById('registration-section');
    if (section.classList.contains('hidden')) {
        // Затваряме формата за контакт, ако е отворена
        document.getElementById('contact-section').classList.add('hidden');
        
        section.classList.remove('hidden');
        // Плавно скролване до формата, за да я види потребителят веднага
        setTimeout(() => {
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }, 100);
    } else {
        section.classList.add('hidden');
    }
};

// ==============================================
// ENTRANCE NAVIGATION
// ==============================================

window.exitEntrance = function () {
    setFinancialEntranceRoute_("");
    apartmentList = [];
    
    // Clear hash and UI
    window.location.hash = "";
    document.getElementById('access-id').value = "";
    resetApartmentData();

    // Скриваме банера със съобщение от домоуправителя.
    const noticeBanner = document.getElementById('userEntranceNotice');
    if (noticeBanner) noticeBanner.style.display = 'none';
    const noticeBannerHome = document.getElementById('userEntranceNoticeHome');
    if (noticeBannerHome) noticeBannerHome.style.display = 'none';

    // Switch views
    document.getElementById('view-entrance-home').classList.remove('active');
    document.getElementById('view-entrance-home').classList.add('hidden');
    // Скриваме и hard-block view ако е показан
    const hardBlockView = document.getElementById('view-hard-blocked');
    if (hardBlockView) {
        hardBlockView.classList.remove('active');
        hardBlockView.classList.add('hidden');
    }
    document.documentElement.classList.remove('direct-entrance-route');
    document.getElementById('view-selector').classList.remove('hidden');
    document.getElementById('view-selector').classList.add('active');
    
    // Smooth reset the apartment dropdown
    const select = document.getElementById("apartmentSelect");
    if (select) select.innerHTML = '<option value="">Избери апартамент</option>';
};

window.openLoginPrompt = function() {
    const modal = document.getElementById("accessIdModal");
    if (modal) modal.style.display = "flex";
    const err = document.getElementById("accessIdError");
    if (err) err.textContent = "";
    const input = document.getElementById("access-id");
    if (input) {
        input.value = "";
        setTimeout(() => { input.focus(); }, 100);
    }
};

window.closeAccessIdModal = function() {
    const modal = document.getElementById("accessIdModal");
    if (modal) modal.style.display = "none";
};

window.submitAccessIdModal = async function() {
    const accessId = document.getElementById("access-id").value.trim();
    if (!accessId) {
        const err = document.getElementById("accessIdError");
        if (err) err.textContent = "Моля, въведете код за достъп!";
        return;
    }
    
    const success = await window.enterEntrance();
    if (success !== false) {
        window.closeAccessIdModal();
    }
};

window.toggleMobileMenu = function() {
    const menu = document.getElementById("landing-mobile-menu");
    if (menu) {
        menu.classList.toggle("hidden");
        menu.classList.toggle("active");
    }
};

window.enterEntrance = async function () {
    let accessId = document.getElementById('access-id').value.trim();

    if (accessId.includes('%')) {
        try {
            accessId = decodeURIComponent(accessId);
            document.getElementById('access-id').value = accessId;
        } catch(e) {}
    }

    if (!accessId) {
        showToast("Моля, въведете вашето ID за достъп!", "error");
        return false;
    }

    localStorage.setItem("savedAccessId", accessId);
    setFinancialEntranceRoute_(accessId);

    const btn = document.getElementById("submitAccessIdBtn") || document.querySelector("#view-selector .btn-primary");
    const originalText = btn ? btn.textContent : "Вход";
    if (btn) {
        btn.textContent = "Зареждане...";
        btn.disabled = true;
    }

    purgeAdminConfigCache_();
    purgeFinancialMaterializedCache_(true);
    // Stage 2C.3 Perf Remediation: Ensure feature flags are hydrated AND prefetch entranceSummaryV1 +
    // financialManifestV1 (+ speculative buildingDashboardSummaryV1) in parallel during interactive navigation!
    await Promise.all([
        ensureProjFlagsLoaded_(),
        prefetchEntranceBootstrapV2_(currentRouteKey)
    ]);
    let result, configResult;
    const preSum = await readPrecomputedEntranceSummary_(currentRouteKey);
    if (preSum && preSum.apartments && preSum.configResult) {
        result = preSum.apartments;
        configResult = preSum.configResult;
    } else {
        [result, configResult] = await Promise.all([
            apiCall('list', { list: 'apartments' }),
            apiCall('getEntranceInfo')
        ]);
    }

    if (configResult && configResult.success && configResult.info) {
        const info = configResult.info;

        if (info.isHardBlocked) {
            hideLoading();
            // Показваме заключен екран вместо на екрана за избор на вход
            document.getElementById('view-selector').classList.remove('active');
            document.getElementById('view-selector').classList.add('hidden');
            const hardBlockView = document.getElementById('view-hard-blocked');
            if (hardBlockView) {
                hardBlockView.classList.remove('hidden');
                hardBlockView.classList.add('active');
                const hbId = hardBlockView.querySelector('#hard-block-id');
                if (hbId) hbId.textContent = currentRouteKey;
            } else {
                // Фалбак ако няма специален елемент
                showToast(`⚠️ Достъпът е напълно спрян поради над 3 месеца неплатен абонамент. (При превод задължително посочете ID: ${currentRouteKey})`, "error");
            }
            if (btn) {
                btn.textContent = originalText;
                btn.disabled = false;
            }
            return false;
        }

        if (btn) {
            btn.textContent = originalText;
            btn.disabled = false;
        }

        if (info.pricePerApt !== undefined) {
            sessionStorage.setItem("pricePerApt_" + currentRouteKey, info.pricePerApt);
            sessionStorage.setItem("lifetimePrice_" + currentRouteKey, info.lifetimePrice);
            sessionStorage.setItem("currency_" + currentRouteKey, info.currency);
        }

        // Запазваме статуса на абонамента за проверка при зареждане на апартамент и табло
        sessionStorage.setItem("isSoftBlocked_" + currentRouteKey, info.isSoftBlocked ? "true" : "false");
        sessionStorage.setItem("isHardBlocked_" + currentRouteKey, info.isHardBlocked ? "true" : "false");
        sessionStorage.setItem("subscriptionStatus_" + currentRouteKey, info.subscriptionStatus || "");
        if (info.currentActivePeriod && /^(0[1-9]|1[0-2])\.\d{4}$/.test(String(info.currentActivePeriod).trim())) {
            window._serverCurrentActivePeriod = String(info.currentActivePeriod).trim();
        }

        if (info.paymentInfo) {
            document.getElementById('payment-instructions').innerHTML = linkifyText(info.paymentInfo);
            document.getElementById('masterPaymentText').value = info.paymentInfo;
            sessionStorage.setItem('paymentInfo_' + currentRouteKey, info.paymentInfo);
        } else {
            sessionStorage.removeItem('paymentInfo_' + currentRouteKey);
        }
        document.getElementById('payment-details-box').style.display = 'none';

        const adminMailBtn = document.getElementById('admin-mailto-link');
        if (adminMailBtn) {
            if (info.adminEmail) {
                adminMailBtn.href = `mailto:${info.adminEmail}`;
                adminMailBtn.style.display = 'inline-block';
            } else {
                adminMailBtn.style.display = 'none';
            }
        }

        // Предпопълваме полето за смяна на имейла на домоуправителя с текущия
        sessionStorage.setItem("adminEmail_" + currentRouteKey, info.adminEmail || "");
        const newAdminEmailInput = document.getElementById('newAdminEmailInput');
        if (newAdminEmailInput) newAdminEmailInput.value = info.adminEmail || "";

        if (info.linkElectric) {
            document.getElementById('btn-electric-link').href = info.linkElectric;
            document.getElementById('btn-electric-link').style.display = 'inline-block';
            document.getElementById('masterLinkElectric').value = info.linkElectric;
        } else {
            document.getElementById('btn-electric-link').style.display = 'none';
        }

        let totalMonthly = 0;
        const basePrice = parseFloat(info.pricePerApt) || 0;
        const aptCount = (result && Array.isArray(result)) ? result.length : 0;
        const individual = info.individualPrices || [];
        const globalEx = individual.find(ex => ex.apartment === 'ALL');

        if (globalEx) {
            totalMonthly = aptCount * parseFloat(globalEx.price);
        } else {
            totalMonthly = 0;
            if (Array.isArray(result)) {
                result.forEach(apt => {
                    const aptEx = individual.find(ex => ex.apartment === apt);
                    totalMonthly += aptEx ? parseFloat(aptEx.price) : basePrice;
                });
            }
        }

        const subMonthlyEl = document.getElementById("subMonthlyPrice");
        const subLifetimeEl = document.getElementById("subLifetimePrice");
        const subCodeEl = document.getElementById("subscriptionCodeDisplay");

        if (subMonthlyEl) subMonthlyEl.textContent = `${totalMonthly.toFixed(2)} EUR`;
        if (subLifetimeEl) subLifetimeEl.textContent = `${parseFloat(info.lifetimePrice || 0).toFixed(2)} EUR`;
        if (subCodeEl) subCodeEl.textContent = currentRouteKey;

        // Инструкции за плащане към Супер Админа (платформено ниво) — идват
        // от Супер Админ настройките. Бекендът вече ги връща в
        // getEntranceInfo като info.superPaymentOptions (потвърдено в Code.gs).
        const platformPayBox = document.getElementById('platformPaymentInfoBox');
        const platformPayText = document.getElementById('platformPaymentInfoText');
        if (platformPayBox && platformPayText) {
            if (info.superPaymentOptions && info.superPaymentOptions.trim() !== "") {
                platformPayText.innerHTML = linkifyText(info.superPaymentOptions);
                platformPayBox.style.display = 'block';
            } else {
                platformPayBox.style.display = 'none';
            }
        }

        // Кешираме ВЕЧЕ изчислената (съобразена с индивидуални изключения) обща
        // месечна цена, за да не се налага показването ѝ в самия админ панел на
        // входа (showAdminContent) да я преизчислява наново без изключенията.
        sessionStorage.setItem("totalMonthly_" + currentRouteKey, totalMonthly.toFixed(2));

        if (totalMonthly === 0 && aptCount > 0) {
            if (subMonthlyEl) subMonthlyEl.innerHTML = '<span style="color:green;">🎁 БЕЗПЛАТНО</span>';
        }

        const newsBanner = document.getElementById("adminGlobalNews");
        const newsText = document.getElementById("adminGlobalNewsText");
        if (info.globalMessage && info.globalMessage.trim() !== "") {
            newsText.innerHTML = info.globalMessage.replace(/\n/g, '<br>');
            newsBanner.style.display = "block";
        } else {
            newsBanner.style.display = "none";
        }

        const userNoticeBanner = document.getElementById("userEntranceNotice");
        const userNoticeText = document.getElementById("userEntranceNoticeText");
        const userNoticeBannerHome = document.getElementById("userEntranceNoticeHome");
        const userNoticeTextHome = document.getElementById("userEntranceNoticeTextHome");

        const effectiveNotice = info.entranceNotice;

        if (effectiveNotice && effectiveNotice.trim() !== "") {
            const formatted = effectiveNotice.replace(/\n/g, '<br>');
            userNoticeText.innerHTML = formatted;
            userNoticeBanner.style.display = "block";
            if (userNoticeTextHome) userNoticeTextHome.innerHTML = formatted;
            if (userNoticeBannerHome) userNoticeBannerHome.style.display = "block";

            const adminNoticeInput = document.getElementById("masterEntranceNotice");
            if (adminNoticeInput) adminNoticeInput.value = effectiveNotice;
        } else {
            userNoticeBanner.style.display = "none";
            if (userNoticeBannerHome) userNoticeBannerHome.style.display = "none";
            const adminNoticeInput = document.getElementById("masterEntranceNotice");
            if (adminNoticeInput) adminNoticeInput.value = "";
        }
    } else {
        document.getElementById('payment-details-box').style.display = 'none';
        const mailEl = document.getElementById('admin-mailto-link');
        if (mailEl) mailEl.style.display = 'none';
        document.getElementById('btn-electric-link').style.display = 'none';
    }

    if (result && !result.error && Array.isArray(result)) {
        apartmentList = result;

        apartmentList.sort((a, b) => {
            const numA = parseInt(a.replace(/\D/g, '')) || 0;
            const numB = parseInt(b.replace(/\D/g, '')) || 0;
            return numA - numB;
        });

        if (configResult && configResult.info && configResult.info.entranceName) {
            document.getElementById('entrance-title').textContent = configResult.info.entranceName;
        } else {
            document.getElementById('entrance-title').textContent = `Етажна собственост - ID ${currentRouteKey}`;
        }

        document.getElementById('view-selector').classList.remove('active');
        document.getElementById('view-selector').classList.add('hidden');
        document.getElementById('view-entrance-home').classList.remove('hidden');
        document.getElementById('view-entrance-home').classList.add('active');

        const select = document.getElementById("apartmentSelect");
        select.innerHTML = '<option value="">Избери апартамент</option>';
        apartmentList.forEach(a => {
            const opt = document.createElement("option");
            opt.value = opt.textContent = a;
            select.appendChild(opt);
        });

        const targetHash = "#" + encodeURIComponent(currentRouteKey);
        if (window.location.hash !== targetHash && !window.location.hash.includes("/")) {
            window.location.hash = targetHash;
        }

        attachEntranceSubscriptionWatcher_(currentRouteKey);
        loadDashboardData();
        return true;
    } else {
        if (btn) {
            btn.textContent = originalText;
            btn.disabled = false;
        }
        document.documentElement.classList.remove('direct-entrance-route');
        const errStr = result && result.error ? result.error.toString() : "";
        if (errStr.includes("fetch") || errStr.includes("NetworkError")) {
            showToast("Грешка при връзка (Failed to fetch). Проверете интернет връзката си.", "error");
        } else {
            showToast(`Грешен вход: ${currentRouteKey} не е намерен в базата.`, "error");
        }
        return false;
    }
}

// (Moved logic to main DOMContentLoaded at the top)

async function loadDashboardFromFirebase(routeKey) {
  if ((!window.fb || !window.db) && typeof window.ensureFirebaseSdk_ === 'function') {
    await window.ensureFirebaseSdk_();
  }
  const { collection, getDocs, query, where } = window.fb;
  const db = window.db;

  const q = query(
    collection(db, "apartments"),
    where("buildingId", "==", routeKey)
  );
  const qDist = query(
    collection(db, "distributionsV2"),
    where("routeKey", "==", routeKey),
    where("category", "==", "Фонд ремонт")
  );
  const qCredit = query(
    collection(db, "creditLiabilitiesV2"),
    where("routeKey", "==", routeKey)
  );

  const [snapshot, snapDistRes, snapCreditRes] = await Promise.all([
    getDocs(q),
    getDocs(qDist).catch(err => ({ _err: err })),
    getDocs(qCredit).catch(err => ({ _err: err }))
  ]);

  let totalDebt = 0;
  let totalBalance = 0;
  let totalTargetFund = 0;

  const apartments = [];

  snapshot.forEach(doc => {
    const data = doc.data();
    const balance = Number(data.balance || 0);
    const targetFund = Number(data.targetFund || 0);

    apartments.push({
      id: data.apartmentId,
      balance,
      targetFund
    });

    if (balance > 0) {
      totalDebt += balance;
      totalBalance += Math.max(0, targetFund - balance);
    } else {
      totalBalance += targetFund;
    }
    
    totalTargetFund += targetFund;
  });

  let totalSpent = 0;
  if (snapDistRes && !snapDistRes._err) {
    snapDistRes.forEach(d => {
      totalSpent += parseFloat(d.data().amount) || 0;
    });
  } else if (snapDistRes && snapDistRes._err) {
    if (isStaleRouteRequestError(snapDistRes._err)) throw snapDistRes._err;
    console.error("Error loading distributions for dashboard:", snapDistRes._err);
  }

  let totalCreditRemaining = 0;
  let totalCreditOriginal = 0;
  if (snapCreditRes && !snapCreditRes._err) {
    snapCreditRes.forEach(d => {
      const cData = d.data();
      totalCreditRemaining += Number(cData.remaining || 0);
      totalCreditOriginal += Number(cData.original || 0);
    });
  } else if (snapCreditRes && snapCreditRes._err) {
    if (isStaleRouteRequestError(snapCreditRes._err)) throw snapCreditRes._err;
    console.error("Error loading credit liabilities for dashboard:", snapCreditRes._err);
  }

  return {
    success: true,
    dashboard: {
      totalDebts: totalDebt.toFixed(2),
      totalBalance: totalBalance.toFixed(2),
      totalTargetFund: totalTargetFund.toFixed(2),
      totalSpent: totalSpent.toFixed(2),
      totalCreditRemaining: totalCreditRemaining.toFixed(2),
      totalCreditOriginal: totalCreditOriginal.toFixed(2),
      trendData: []
    }
  };
}

async function loadDashboardData() {
    const requestContext = captureRouteRequestContext();
    try {
        // Ensure feature flags are hydrated BEFORE maintenanceRefreshSummary_ or dashboard read
        // so neither card can race into a slow legacy GAS fallback!
        if (!window._projFlagsLoaded_) {
            await ensureProjFlagsLoaded_();
            throwIfStaleRouteRequestContext(requestContext);
        }
        if(typeof maintenanceRefreshSummary_==='function')maintenanceRefreshSummary_(); // MAINTENANCE_HOME
        // Hard block или Soft block (за неавтентикирани живущи) — не зареждаме финансови данни от Firebase
        const isHardBlockedDash = sessionStorage.getItem("isHardBlocked_" + currentRouteKey) === "true";
        const isSoftBlockedDash = sessionStorage.getItem("isSoftBlocked_" + currentRouteKey) === "true";
        const isAdminLoggedDash = isEntranceAdminLoggedIn_(currentRouteKey);
        if (isHardBlockedDash || (isSoftBlockedDash && !isAdminLoggedDash)) {
            clearProtectedFinancialDomOnBlock_(currentRouteKey, isHardBlockedDash);
            return;
        }

        const dashFlag = (window._projFlags && window._projFlags.FIN_DASHBOARD) || 'OFF';
        let result = null;
        let extStmtRes = null;
        let matBundle = null;

        if (dashFlag === 'ON') {
            matBundle = await readFinancialManifestBundleV2_(currentRouteKey, { dashboard: true });
            throwIfStaleRouteRequestContext(requestContext);
        } else if (dashFlag === 'PARITY') {
            const [matRes, legDash, legExt] = await Promise.all([
                readFinancialManifestBundleV2_(currentRouteKey, { dashboard: true }).catch(() => null),
                loadDashboardFromFirebase(currentRouteKey),
                bgApiCall('getExternalUnitsStatementV1', { routeKey: currentRouteKey }).catch(() => null)
            ]);
            throwIfStaleRouteRequestContext(requestContext);
            result = legDash;
            extStmtRes = legExt;
            if (matRes && matRes.dashboard && legDash && legDash.success && legDash.dashboard) {
                const ld = legDash.dashboard;
                const md = matRes.dashboard;
                let legExtCents = 0;
                if (legExt && legExt.success && Array.isArray(legExt.unitStatements)) {
                    legExt.unitStatements.forEach(us => { legExtCents += Math.max(0, Number(us.endingDebtCents || 0)); });
                }
                const parityOk =
                    Math.round((parseFloat(ld.totalDebts) || 0) * 100) === md.apartmentDebtsCents &&
                    legExtCents === md.externalDebtsCents &&
                    Math.round((parseFloat(ld.totalBalance) || 0) * 100) === md.repairFundCollectedCents &&
                    Math.round((parseFloat(ld.totalSpent) || 0) * 100) === md.repairFundSpentCents &&
                    Math.round((parseFloat(ld.totalCreditRemaining) || 0) * 100) === md.creditRemainingCents;
                if (Array.isArray(window._finMatParityLog_)) {
                    window._finMatParityLog_.push({ model: 'BUILDING_DASHBOARD_SUMMARY_V1', exact: parityOk, routeKey: currentRouteKey });
                }
                if (parityOk) matBundle = matRes;
            }
        } else if (dashFlag === 'SHADOW') {
            readFinancialManifestBundleV2_(currentRouteKey, { dashboard: true }).catch(() => null);
        }

        if (matBundle && matBundle.dashboard) {
            const md = matBundle.dashboard;
            result = {
                success: true,
                _fromPrecomputed: true,
                dashboard: {
                    totalDebts: md.totalDebts,
                    totalBalance: md.totalBalance,
                    totalTargetFund: md.totalTargetFund,
                    totalSpent: md.totalSpent,
                    totalCreditRemaining: md.totalCreditRemaining,
                    totalCreditOriginal: md.totalCreditOriginal,
                    trendData: md.trendData || []
                }
            };
            extStmtRes = {
                success: true,
                _fromPrecomputed: true,
                unitStatements: md.hasExternalUnits ? [{ endingDebtCents: md.externalDebtsCents }] : []
            };
        } else if (!result) {
            [result, extStmtRes] = await Promise.all([
                loadDashboardFromFirebase(currentRouteKey),
                bgApiCall('getExternalUnitsStatementV1', { routeKey: currentRouteKey }).catch(() => null)
            ]);
            throwIfStaleRouteRequestContext(requestContext);
        }
        if (result && result.success && result.dashboard) {
            const d = result.dashboard;
            const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
            const aptDebtsCents = Math.round((parseFloat(d.totalDebts) || 0) * 100);
            let extDebtsCents = 0;
            let hasExtUnits = false;
            if (extStmtRes && extStmtRes.success && Array.isArray(extStmtRes.unitStatements) && extStmtRes.unitStatements.length > 0) {
                hasExtUnits = true;
                extStmtRes.unitStatements.forEach(us => {
                    extDebtsCents += Math.max(0, Number(us.endingDebtCents || 0));
                });
            }
            const combinedDebtsCents = aptDebtsCents + extDebtsCents;
            document.getElementById('dash-debts').textContent = `${(combinedDebtsCents / 100).toFixed(2)} ${cur}`;
            const breakdownEl = document.getElementById('dash-debts-breakdown');
            if (breakdownEl) {
                if (hasExtUnits) {
                    breakdownEl.innerHTML =
                        `Апартаменти: <b>${(aptDebtsCents / 100).toFixed(2)} ${cur}</b><br>` +
                        `Самостоятелни обекти: <b>${(extDebtsCents / 100).toFixed(2)} ${cur}</b><br>` +
                        `Общо за входа: <b>${(combinedDebtsCents / 100).toFixed(2)} ${cur}</b>`;
                    breakdownEl.style.display = "block";
                } else {
                    breakdownEl.style.display = "none";
                }
            }
            
            const collected = parseFloat(d.totalBalance) || 0;
            const target = parseFloat(d.totalTargetFund) || 0;
            const spent = parseFloat(d.totalSpent) || 0;

            const netBalance = Math.max(0, collected - spent);
            const netTarget = Math.max(0, target - spent);

            document.getElementById('dash-balance').textContent = `${netBalance.toFixed(2)} ${cur} (${netTarget.toFixed(2)} ${cur})`;

            const debtsTrendEl = document.getElementById('dash-debts-trend');
            const balanceTrendEl = document.getElementById('dash-balance-trend');

            if (debtsTrendEl) {
                debtsTrendEl.textContent = parseFloat(d.totalDebts) > 0 ? "Изисква се заплащане" : "Всичко е изплатено";
            }
            if (balanceTrendEl) {
                if (netTarget > 0) {
                    balanceTrendEl.textContent = `Събрано ${netBalance.toFixed(2)} от ${netTarget.toFixed(2)} ${cur}`;
                } else if (target > 0 && spent >= target) {
                    balanceTrendEl.textContent = "Всички събрани средства са усвоени";
                } else {
                    balanceTrendEl.textContent = "Няма начислен фонд";
                }
            }

            const creditBalEl = document.getElementById('dash-credit-balance');
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    const tNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    document.documentElement.dataset.perfDashMs = String(Math.round(tNow));
                });
            }
            const creditTrendEl = document.getElementById('dash-credit-trend');
            if (creditBalEl) {
                const remainingNum = parseFloat(d.totalCreditRemaining) || 0;
                creditBalEl.textContent = `${remainingNum.toFixed(2)} ${cur}`;
                if (creditTrendEl) {
                    if (remainingNum > 0) {
                        const origNum = parseFloat(d.totalCreditOriginal) || 0;
                        creditTrendEl.textContent = `Текущ остатък (от ${origNum.toFixed(2)} ${cur})`;
                    } else {
                        creditTrendEl.textContent = "Няма активен кредит";
                    }
                }
            }

            if (d.trendData && d.trendData.length > 0) {
                if (typeof Chart !== 'undefined') {
                    initChart(d.trendData);
                } else {
                    console.warn("Chart.js is not loaded yet.");
                    setTimeout(() => { if (isCurrentRouteRequestContext(requestContext) && typeof Chart !== 'undefined') initChart(d.trendData); }, 1000);
                }
            } else {
                console.log("No trend data available for dashboard chart.");
            }
        } else {
            const errMsg = result?.error || "Неуспешно зареждане на обобщените данни.";
            console.error("Dashboard data load failed:", errMsg);
            document.getElementById('dash-debts-trend').textContent = "Грешка при зареждане";
            document.getElementById('dash-balance-trend').textContent = "Грешка при зареждане";
            if (document.getElementById('dash-credit-trend')) document.getElementById('dash-credit-trend').textContent = "Грешка при зареждане";
        }
    } catch (err) {
        if (isStaleRouteRequestError(err)) return;
        console.error("Critical error in loadDashboardData:", err);
    }
}

let myChart = null;
function initChart(data) {
    const ctx = document.getElementById('trendChart').getContext('2d');

    if (myChart) {
        myChart.destroy();
    }

    const labels = data.map(i => i.period);

    myChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [
                {
                    label: 'Асансьор ел.',
                    data: data.map(i => i.elevator),
                    borderColor: '#3b6edc',
                    backgroundColor: 'rgba(59, 110, 220, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Асансьор абон. и др.',
                    data: data.map(i => i.subscription),
                    borderColor: '#ff9500',
                    backgroundColor: 'rgba(255, 149, 0, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Етажно ел.',
                    data: data.map(i => i.light),
                    borderColor: '#34c759',
                    backgroundColor: 'rgba(52, 199, 89, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Почистване',
                    data: data.map(i => i.cleaning),
                    borderColor: '#5856d6',
                    backgroundColor: 'rgba(88, 86, 214, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Фонд Поддръжка',
                    data: data.map(i => i.podrajka),
                    borderColor: '#ff2d55',
                    backgroundColor: 'rgba(255, 45, 85, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Фонд ремонт',
                    data: data.map(i => i.remont),
                    borderColor: '#8e8e93',
                    backgroundColor: 'rgba(142, 142, 147, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            interaction: {
                mode: 'index',
                intersect: false,
            },
            plugins: {
                legend: {
                    position: 'bottom',
                    labels: {
                        boxWidth: 12,
                        font: { size: 11 }
                    }
                }
            },
            scales: {
                y: {
                    beginAtZero: true,
                    grid: {
                        color: 'rgba(0,0,0,0.05)'
                    }
                },
                x: {
                    grid: {
                        display: false
                    }
                }
            }
        }
    });
}

// ==============================================
// CENTRALIZED FRONTEND PERIOD POLICY (Europe/Sofia) & ASYNC SECTION STATES (V3.1)
// ==============================================

function periodToSortableUI(period) {
    if (!period) return 0;
    const parts = String(period).trim().split('.');
    if (parts.length !== 2) return 0;
    return (parseInt(parts[1], 10) || 0) * 100 + (parseInt(parts[0], 10) || 0);
}

function getActiveSofiaPeriod(optNow) {
    if (!optNow && window._serverCurrentActivePeriod && /^(0[1-9]|1[0-2])\.\d{4}$/.test(window._serverCurrentActivePeriod)) {
        return window._serverCurrentActivePeriod;
    }
    const now = optNow instanceof Date ? optNow : new Date();
    try {
        const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Sofia', year: 'numeric', month: '2-digit' }).formatToParts(now);
        const mm = (parts.find(p => p.type === 'month') || {}).value;
        const yyyy = (parts.find(p => p.type === 'year') || {}).value;
        if (mm && yyyy) return `${mm}.${yyyy}`;
    } catch (e) {}
    return String(now.getMonth() + 1).padStart(2, '0') + '.' + now.getFullYear();
}

function isFutureTechnicalPeriodUI(period, optNow) {
    const pOrd = periodToSortableUI(period);
    if (!pOrd) return false;
    return pOrd > periodToSortableUI(getActiveSofiaPeriod(optNow));
}

window.getActiveSofiaPeriod = getActiveSofiaPeriod;
window.isFutureTechnicalPeriodUI = isFutureTechnicalPeriodUI;

/**
 * Explicit async section state renderer: 'LOADING' | 'READY' | 'EMPTY' | 'ERROR'
 * Never shows fictitious zeros or premature empty messages while loading; supports isolated per-section Retry.
 */
function setSectionAsyncState_(target, state, opts) {
    const el = typeof target === 'string' ? document.getElementById(target) : target;
    if (!el) return;
    const options = opts || {};
    const colspan = options.colspan || 0;
    el.setAttribute('data-async-state', state);

    const wrap = (innerHtml) => colspan > 0
        ? `<tr><td colspan="${colspan}" style="text-align:center; padding:16px;">${innerHtml}</td></tr>`
        : innerHtml;

    if (state === 'LOADING') {
        const msg = options.loadingText || 'Зареждане на данните…';
        el.innerHTML = wrap(`<span style="display:inline-flex; align-items:center; gap:8px; color:#475569; font-weight:500;"><span class="btn-spinner" style="border-color:rgba(37,99,235,0.25); border-top-color:#2563eb;"></span>${msg}</span>`);
    } else if (state === 'EMPTY') {
        const msg = options.emptyText || 'Няма налични данни.';
        el.innerHTML = wrap(`<span style="color:#64748b;">${msg}</span>`);
    } else if (state === 'ERROR') {
        const msg = options.errorText || 'Грешка при зареждане на секцията.';
        const retryFnName = options.retryAction || '';
        const retryHtml = retryFnName
            ? ` <button type="button" class="btn-secondary" style="margin-left:8px; padding:4px 10px; font-size:0.85em;" onclick="${retryFnName}">↻ Опитай отново</button>`
            : '';
        el.innerHTML = wrap(`<span style="color:#dc2626; font-weight:600;">⚠️ ${msg}</span>${retryHtml}`);
    }
}
window.setSectionAsyncState_ = setSectionAsyncState_;

// ==============================================
// APARTMENT DATA
// ==============================================

async function loadApartmentFromFirebase(routeKey, apartmentId) {
  if ((!window.fb || !window.db) && typeof window.ensureFirebaseSdk_ === 'function') {
    await window.ensureFirebaseSdk_();
  }
  const { collection, getDocs, query, where } = window.fb;
  const db = window.db;

  const qApt = query(
    collection(db, "apartments"),
    where("buildingId", "==", routeKey),
    where("apartmentId", "==", apartmentId)
  );
  const qPeriods = query(
    collection(db, "monthlyReports"),
    where("buildingId", "==", routeKey),
    where("apartmentId", "==", apartmentId)
  );
  const [snapApt, snapPeriods] = await Promise.all([getDocs(qApt), getDocs(qPeriods)]);

  let result = { saldo: 0, periods: [], aptNotice: "" };

  snapApt.forEach(doc => {
    const data = doc.data();
    result.saldo = Number(data.balance || 0);
    result.targetFund = Number(data.targetFund || 0);
  });

  const rawPeriods = [];
  snapPeriods.forEach(doc => {
    const data = doc.data();
    const pid = data.periodId || data.period || "";
    // PERIOD INTEGRITY (P0): Exclude future technical reserve periods from public financial statements
    if (isFutureTechnicalPeriodUI(pid)) return;
    rawPeriods.push(data);
  });

  rawPeriods.sort((a, b) => {
    const [mA, yA] = (a.periodId || a.period || "").split(".");
    const [mB, yB] = (b.periodId || b.period || "").split(".");
    const dA = new Date(yA, mA - 1);
    const dB = new Date(yB, mB - 1);
    return dA - dB;
  });

  const pickNullableNum = (...vals) => {
    for (const v of vals) {
      if (v !== undefined && v !== null && v !== '') {
        const n = Number(v);
        if (Number.isFinite(n)) return n;
      }
    }
    return null;
  };

  result.periods = rawPeriods.map(p => {
    const d = p.details || {};
    const incomplete = p.breakdownStatus === 'INCOMPLETE';
    return {
      period: p.periodId || p.period,
      breakdownStatus: p.breakdownStatus || 'COMPLETE',
      breakdownReason: p.breakdownReason || '',
      elevator: pickNullableNum(d["Асансьор ел."], d["Асансьор"], p.elevator, incomplete ? null : 0),
      subscription: pickNullableNum(d["Асансьор абон. и др."], d["Абонамент"], p.subscription, incomplete ? null : 0),
      light: pickNullableNum(d["Етажно ел."], d["Ток"], d["Осветление"], p.light, incomplete ? null : 0),
      security: pickNullableNum(d["Охрана"], d["Вход"], p.security, incomplete ? null : 0),
      cleaning: pickNullableNum(d["Почистване"], d["Чистач"], p.cleaning, incomplete ? null : 0),
      podrajka: pickNullableNum(d["Фонд Поддръжка"], d["Поддръжка"], p.podrajka, p.maintenance, incomplete ? null : 0),
      remont: pickNullableNum(d["Фонд ремонт"], d["Ремонтен фонд"], d["Ремонт"], p.remont, p.repairFund, incomplete ? null : 0),
      water: pickNullableNum(d["ВиК"], d["ВиК ЕС"], p.water, incomplete ? null : 0),
      platformSubscription: pickNullableNum(d["Управление"], d["Абонамент Платформа"], p.platformSubscription, incomplete ? null : 0),
      due: Number(p.totalDue || p.due || 0),
      paid: Number(p.receivedPaid ?? p.totalPaid ?? p.paid ?? 0),
      credit: Number(d["Кредит"] || p.credit || 0)
    };
  });

  return result;
}

async function loadApartmentData(apartment) {
    const _aptPerfStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    const requestContext = captureRouteRequestContext();
    resetApartmentData();

    // Скриваме инструкциите за плащане докато не знаем дали има дълг
    document.getElementById('payment-details-box').style.display = 'none';

    // Update URL Hash for persistence
    if (currentRouteKey) {
        window.location.hash = `${encodeURIComponent(currentRouteKey)}/${encodeURIComponent(apartment)}`;
    }

    // Показваме кода за плащане веднага
    document.getElementById("payment-reference-value").textContent = `${currentRouteKey}-${apartment}`;
    document.getElementById("payment-reference-box").style.display = "block";

    // Проверяваме за блок ПРЕДИ Firebase заявката
    const isHardBlocked = sessionStorage.getItem("isHardBlocked_" + currentRouteKey) === "true";
    if (isHardBlocked) {
        document.getElementById("saldo").textContent = "Спрян достъп";
        const tBody = document.getElementById("tableBody");
        if (tBody) tBody.innerHTML = '<tr><td colspan="14" style="text-align:center; color:#e74c3c;">⚠️ Достъпът е напълно спрян поради неплатен абонамент.</td></tr>';
        showToast("Достъпът до входа е напълно спрян поради неплатен абонамент", "error");
        return;
    }

    const isSoftBlocked = sessionStorage.getItem("isSoftBlocked_" + currentRouteKey) === "true";
    if (isSoftBlocked) {
        document.getElementById("saldo").textContent = "Скрит";
        // Скриваме таблицата с периодите
        const tBody = document.getElementById("tableBody");
        if (tBody) tBody.innerHTML = '<tr><td colspan="14" style="text-align:center; color:#e74c3c;">⚠️ Информацията е скрита поради неплатен абонамент.</td></tr>';
        showToast("Информацията за салдото Ви не се показва поради неплатен абонамент", "error");
        return;
    }

    const result = await loadApartmentFromFirebase(currentRouteKey, apartment);
    throwIfStaleRouteRequestContext(requestContext);

    // Кредитно задължение (паралелен регистър, не влияе на Салдото по-горе)
    if (typeof loadApartmentCreditLiability === 'function') loadApartmentCreditLiability(apartment);
    if (typeof populateRangeReportSelects === 'function') populateRangeReportSelects('aptRangeFrom', 'aptRangeTo');

    if (result && result.error && result.showMessage) {
        document.getElementById("saldo").textContent = "Скрит";
        showToast("Информацията за салдото Ви, не се показва поради неплатен абонамент", "error");
        return;
    }

    if (result && !result.error) {
        const saldoVal = Number(result.saldo || 0);
        const targetFund = Number(result.targetFund || 0);
        const sEl = document.getElementById("saldo");
        const sCard = document.getElementById("saldoCard");

        sEl.textContent = saldoVal.toFixed(2) + " EUR";

        sCard.classList.remove("saldo-positive", "saldo-negative", "saldo-zero");
        if (saldoVal > 0) sCard.classList.add("saldo-positive");
        else if (saldoVal < 0) sCard.classList.add("saldo-negative");
        else sCard.classList.add("saldo-zero");

        // --- ИНСТРУКЦИИ ЗА ПЛАЩАНЕ — показват се само при дълг ---
        const payBox = document.getElementById('payment-details-box');
        if (saldoVal > 0) {
            const storedPayInfo = sessionStorage.getItem('paymentInfo_' + currentRouteKey);
            if (storedPayInfo) {
                document.getElementById('payment-instructions').innerHTML = linkifyText(storedPayInfo);
                payBox.style.display = 'block';
            }
        } else {
            payBox.style.display = 'none';
        }

        const tBody = document.getElementById("tableBody");
        if (result.periods && Array.isArray(result.periods) && result.periods.length > 0) {
            let sumElevator = 0, sumSub = 0, sumLight = 0, sumSec = 0, sumClean = 0;
            let sumPodr = 0, sumRemont = 0, sumWater = 0, sumPlat = 0;
            let sumDue = 0, sumPaid = 0, sumSaldo = 0, sumCredit = 0;

            let hasIncompleteBreakdown = false;
            const fmtCat = (val) => (val === null || val === undefined) ? '<span style="color:#b45309;" title="Непълна разбивка по пера">—</span>' : Number(val).toFixed(2);

            (result.periods || []).forEach((r) => {
                const tr = document.createElement("tr");
                const isInc = r.breakdownStatus === 'INCOMPLETE';
                if (isInc) hasIncompleteBreakdown = true;
                const rowElevator = r.elevator === null ? null : Number(r.elevator);
                const rowSub = r.subscription === null ? null : Number(r.subscription);
                const rowLight = r.light === null ? null : Number(r.light);
                const rowSec = r.security === null ? null : Number(r.security);
                const rowClean = r.cleaning === null ? null : Number(r.cleaning);
                const rowPodr = r.podrajka === null ? null : Number(r.podrajka);
                const rowRemont = r.remont === null ? null : Number(r.remont);
                const rowWater = r.water === null ? null : Number(r.water);
                const rowPlat = r.platformSubscription === null ? null : Number(r.platformSubscription);
                const rowDue = Number(r.due || 0);
                const rowPaid = Number(r.paid || 0);
                const rowSaldo = rowDue - rowPaid;
                const rowCredit = Number(r.credit || 0);

                if (rowElevator !== null) sumElevator += rowElevator;
                if (rowSub !== null) sumSub += rowSub;
                if (rowLight !== null) sumLight += rowLight;
                if (rowSec !== null) sumSec += rowSec;
                if (rowClean !== null) sumClean += rowClean;
                if (rowPodr !== null) sumPodr += rowPodr;
                if (rowRemont !== null) sumRemont += rowRemont;
                if (rowWater !== null) sumWater += rowWater;
                if (rowPlat !== null) sumPlat += rowPlat;
                sumDue += rowDue;
                sumPaid += rowPaid;
                sumSaldo += rowSaldo;
                sumCredit += rowCredit;

                tr.innerHTML = `
                <td>${r.period}${isInc ? ' <span title="Непълна разбивка по пера" style="color:#b45309;">⚠️</span>' : ''}</td>
                <td>${fmtCat(rowElevator)}</td>
                <td>${fmtCat(rowSub)}</td>
                <td>${fmtCat(rowLight)}</td>
                <td>${fmtCat(rowSec)}</td>
                <td>${fmtCat(rowClean)}</td>
                <td>${fmtCat(rowPodr)}</td>
                <td>${fmtCat(rowRemont)}</td>
                <td>${fmtCat(rowWater)}</td>
                <td>${fmtCat(rowPlat)}</td>
                <td>${rowDue.toFixed(2)}</td>
                <td>${rowPaid.toFixed(2)}</td>
                <td>${rowSaldo.toFixed(2)}</td>
                <td>${rowCredit.toFixed(2)}</td>
            `;
                tBody.appendChild(tr);
            });
            if (hasIncompleteBreakdown) {
                const warnTr = document.createElement("tr");
                warnTr.innerHTML = '<td colspan="14" style="background:#fffbeb; color:#92400e; text-align:left; font-size:0.85em; padding:8px 10px;">⚠️ За един или повече периоди разбивката по пера е непълна (маркирана с „—“). Общата дължима сума е взета от MASTER; необходима е синхронизация.</td>';
                tBody.appendChild(warnTr);
            }

            const totalTr = document.createElement("tr");
            totalTr.className = "total-row";
            totalTr.style.fontWeight = "bold";
            totalTr.style.background = "#f1f5f9";
            totalTr.innerHTML = `
                <td>Общо</td>
                <td>${sumElevator.toFixed(2)}</td>
                <td>${sumSub.toFixed(2)}</td>
                <td>${sumLight.toFixed(2)}</td>
                <td>${sumSec.toFixed(2)}</td>
                <td>${sumClean.toFixed(2)}</td>
                <td>${sumPodr.toFixed(2)}</td>
                <td>${sumRemont.toFixed(2)}</td>
                <td>${sumWater.toFixed(2)}</td>
                <td>${sumPlat.toFixed(2)}</td>
                <td>${sumDue.toFixed(2)}</td>
                <td>${sumPaid.toFixed(2)}</td>
                <td>${sumSaldo.toFixed(2)}</td>
                <td>${sumCredit.toFixed(2)}</td>
            `;
            tBody.appendChild(totalTr);
        } else {
            tBody.innerHTML = '<tr><td colspan="14" style="text-align:center;">Няма налични данни за избрания апартамент.</td></tr>';
        }
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                const tNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                document.documentElement.dataset.perfAptMs = String(Math.round(tNow - _aptPerfStart));
            });
        }

        // --- ПЕРСОНАЛНО СЪОБЩЕНИЕ ЗА АПАРТАМЕНТА ---
        const aptNoticeBanner = document.getElementById("individualAptNotice");
        const aptNoticeText = document.getElementById("individualAptNoticeText");
        if (result.aptNotice && result.aptNotice.trim() !== "") {
            aptNoticeText.innerHTML = result.aptNotice.replace(/\n/g, '<br>');
            aptNoticeBanner.style.display = "block";
        } else {
            aptNoticeBanner.style.display = "none";
        }

        // --- ОБЩЕСТВЕН ДОСТЪП (ЧЛ. 51 ЗУЕС) ---
        const art51Box = document.getElementById("individualAptArt51Box");
        const art51Text = document.getElementById("individualAptArt51Text");
        try {
            let a51 = null;
            const dashFlagApt = (window._projFlags && window._projFlags.FIN_DASHBOARD) || 'OFF';
            if (dashFlagApt === 'ON') {
                const matApt = await readFinancialManifestBundleV2_(currentRouteKey, { dashboard: true });
                throwIfStaleRouteRequestContext(requestContext);
                if (matApt && matApt.dashboard && matApt.dashboard.art51ByApartment) {
                    a51 = matApt.dashboard.art51ByApartment[normalizeAptName(apartment)] || matApt.dashboard.art51ByApartment[apartment] || { active: false };
                }
            }
            if (a51 === null) {
                const summaryRes = await apiCall('getApartmentMasterSummary', { apartment: apartment });
                a51 = (summaryRes && summaryRes.success && summaryRes.data && summaryRes.data.art51 && summaryRes.data.art51.active) ? summaryRes.data.art51 : { active: false };
            }
            if (a51 && a51.active) {
                const mult = a51.multiplier || 3;
                const eff = a51.effectiveFromPeriod ? ` (в сила от период ${a51.effectiveFromPeriod})` : '';
                const dec = (a51.decisionReference || a51.decisionDate)
                    ? `<br><span style="color:#475569;">Основание: Решение на ОС ${[a51.decisionReference, a51.decisionDate].filter(Boolean).join(' / ')}</span>`
                    : '';
                if (art51Text) art51Text.innerHTML = `Приложим коефициент: <b>${mult}×</b>${eff}${dec}`;
                if (art51Box) art51Box.style.display = "block";
            } else {
                if (art51Box) art51Box.style.display = "none";
            }
        } catch (eArt) {
            if (art51Box) art51Box.style.display = "none";
        }

        // --- САМОСТОЯТЕЛНИ ОБЕКТИ (ПОЯСНЕНИЕ + ПУБЛИЧНА СПРАВКА) ---
        try {
            const extNote = document.getElementById("individualAptExtUnitsNote");
            const extSect = document.getElementById("publicExternalUnitsSection");
            const isBlockedPub = sessionStorage.getItem("isHardBlocked_" + currentRouteKey) === "true" ||
                (sessionStorage.getItem("isSoftBlocked_" + currentRouteKey) === "true" && !isEntranceAdminLoggedIn_(currentRouteKey));
            if (isBlockedPub) {
                if (extNote) extNote.style.display = "none";
                if (extSect) extSect.style.display = "none";
            } else {
                let units = [];
                const extFlagApt = (window._projFlags && window._projFlags.FIN_EXTERNAL_UNITS) || 'OFF';
                let usedPreExt = false;
                if (extFlagApt === 'ON') {
                    const matExt = await readFinancialManifestBundleV2_(currentRouteKey, { dashboard: false, externalSummary: true });
                    throwIfStaleRouteRequestContext(requestContext);
                    if (matExt && matExt.externalUnitsSummary && Array.isArray(matExt.externalUnitsSummary.unitSummaries)) {
                        units = matExt.externalUnitsSummary.unitSummaries;
                        usedPreExt = true;
                    }
                }
                if (!usedPreExt) {
                    const extStmt = await bgApiCall('getExternalUnitsStatementV1', { routeKey: currentRouteKey }).catch(() => null);
                    units = (extStmt && extStmt.success && Array.isArray(extStmt.unitStatements)) ? extStmt.unitStatements : [];
                }
                const hasPart = units.some(us => { const u = (us && us.unit) || us || {}; return Boolean(u.managementParticipation); });
                if (extNote) extNote.style.display = hasPart ? "block" : "none";
                if (extSect && units.length > 0) {
                    window._publicExtUnitStatements_ = units;
                    const sel = document.getElementById("publicExtUnitSelect");
                    if (sel) {
                        sel.innerHTML = units.map((us, idx) => {
                            const u = us.unit || us || {};
                            return `<option value="${idx}">${reportEscape_(u.unitId || us.unitId || '')} — ${reportEscape_(u.name || '')}</option>`;
                        }).join('');
                    }
                    extSect.style.display = "block";
                    if (typeof window.renderPublicExternalUnitCard_ === 'function') window.renderPublicExternalUnitCard_();
                } else if (extSect) {
                    extSect.style.display = "none";
                }
            }
        } catch (eExtPub) {}
    } else {
        showToast("Грешка при зареждане на данните", "error");
    }
}

window.renderPublicExternalUnitCard_ = function () {
    const units = window._publicExtUnitStatements_ || [];
    const sel = document.getElementById("publicExtUnitSelect");
    const box = document.getElementById("publicExtUnitDetails");
    if (!sel || !box || !units.length) return;
    const us = units[Number(sel.value) || 0];
    if (!us) return;
    const u = us.unit || us || {};
    const idealTxt = u.idealPartsStatus === 'ESTABLISHED'
        ? `${Number(u.idealPartsPercent || 0).toFixed(2)}% (Установени)`
        : 'Неустановени';
    const partTxt = u.managementParticipation ? 'Участва в управление и поддръжка' : 'Не участва в управление и поддръжка';
    const artTxt = (u.art51Active && Number(u.art51Multiplier || 1) > 1) ? `Да (${u.art51Multiplier}×)` : 'Не';
    const debtEur = (Number(us.endingDebtCents || 0) / 100).toFixed(2);
    const advEur = (Number(us.endingAdvanceCents || 0) / 100).toFixed(2);
    const chgEur = (Number(us.totalChargedCents || 0) / 100).toFixed(2);
    const paidEur = (Number(us.totalPaidCents || 0) / 100).toFixed(2);
    box.innerHTML =
        `<div><strong>Статус:</strong> ${partTxt} | <strong>Ид. части:</strong> ${idealTxt} | <strong>чл. 51, ал. 5:</strong> ${artTxt}</div>` +
        `<div style="margin-top:4px;"><strong>Общо начислено:</strong> ${chgEur} EUR | <strong>Платено:</strong> ${paidEur} EUR | ` +
        `<strong>Задължение:</strong> <span style="color:${Number(debtEur) > 0 ? '#b91c1c' : '#047857'};font-weight:700;">${debtEur} EUR</span>` +
        (Number(advEur) > 0 ? ` | <strong>Аванс:</strong> <span style="color:#047857;font-weight:700;">${advEur} EUR</span>` : '') + `</div>`;
};

// ==============================================
// ADMIN PANEL LOGIC 
// ==============================================

window.openAdmin = function () {
    document.getElementById("adminOverlay").classList.add("active");
    if (sessionStorage.getItem("adminAuth_" + currentRouteKey)) {
        showAdminContent();
    } else {
        document.getElementById("loginCard").style.display = "block";
        document.getElementById("adminCard").style.display = "none";
        document.getElementById("pinInput").value = "";

    }
}

window.closeAdmin = function () {
    document.getElementById("adminOverlay").classList.remove("active");
}

window.verifyPin = async function () {
    const email = document.getElementById("adminEmailInput").value.trim();
    const pin = document.getElementById("pinInput").value.trim();
    const err = document.getElementById("pinError");

    if (!email || !pin) {
        err.textContent = "Моля, въведете имейл и парола.";
        return;
    }

    const result = await apiCall('verifyPin', { pin: pin });

    if (result && result.success) {
        sessionStorage.setItem("adminAuth_" + currentRouteKey, pin);
        localStorage.setItem("savedAdminEmail", email);
        err.textContent = "";
        showAdminContent();
    } else {
        err.textContent = result?.error || "Грешен PIN код.";
    }
}

function showAdminContent() {
    const adminRoute = currentRouteKey;
    const adminContext = captureRouteRequestContext();
    document.getElementById("loginCard").style.display = "none";
    document.getElementById("adminCard").style.display = "block";

    // V2 Incomes Admin Nav Injection - forced to true for all users
    const isV2 = true;
    const v2AdminNav = document.getElementById('v2-admin-nav');
    if (v2AdminNav) v2AdminNav.style.display = 'block';
    
    // V2 mode: use tab switching
    if (window.switchAdminTab) switchAdminTab('expenses');


    // Първоначална подкана за MASTER настройки
    const masterPromptKey = "hasSeenMasterPrompt_" + currentRouteKey;
    if (!localStorage.getItem(masterPromptKey)) {
        setTimeout(() => {
            if (currentRouteKey !== adminRoute || (adminContext && !isCurrentRouteRequestContext(adminContext))) return;
            showToast("🎁 Добре дошли! Препоръчваме първо да посетите секция 'MASTER – Настройки', за да въведете началните параметри на входа.", "success");
            localStorage.setItem(masterPromptKey, "true");
        }, 1000);
    }

    const subCodeEl = document.getElementById("subscriptionCodeDisplay");
    if (subCodeEl) {
        subCodeEl.textContent = currentRouteKey;
    }

    // Попълваме цените, ако ги имаме запазени
    const p1 = sessionStorage.getItem("pricePerApt_" + currentRouteKey);
    const p2 = sessionStorage.getItem("lifetimePrice_" + currentRouteKey);
    const curr = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
    const cachedTotal = sessionStorage.getItem("totalMonthly_" + currentRouteKey);

    if (p1 && p2) {
        const aptCount = apartmentList ? apartmentList.length : 0;
        // Ползваме кешираната стойност от enterEntrance() (съобразена с
        // индивидуални изключения от Супер Админ), а не преизчисляваме наново
        // само с базовата цена — иначе зададена индивидуална цена никога не
        // се вижда тук.
        const totalMonthly = cachedTotal !== null ? parseFloat(cachedTotal).toFixed(2) : (parseFloat(p1) * aptCount).toFixed(2);

        const mPriceEl = document.getElementById("subMonthlyPrice");
        const lPriceEl = document.getElementById("subLifetimePrice");

        if (mPriceEl) mPriceEl.textContent = `${totalMonthly} ${curr}`;
        if (lPriceEl) lPriceEl.textContent = `${p2} ${curr}`;
    }

    populateAdminDropdowns();
    resetManualExpenseView_();
    if (typeof loadRecurringExpenseState_ === 'function') loadRecurringExpenseState_(); // SLICE5_RECURRING_UI
    if(typeof checkRemontEligibility === 'function') checkRemontEligibility();
    // Stage 2C.2 Final Gate: Warm-prefetch materialized External Units bundle on Admin open (0 GAS)
    if (window._projFlags && window._projFlags.FIN_EXTERNAL_UNITS === 'ON' && currentRouteKey) {
        readFinancialManifestBundleV2_(currentRouteKey, { dashboard: false, externalSummary: true, externalRows: true }).catch(() => null);
    }
}

function autoFillCurrentPeriod() {
    const currentPeriod = getActiveSofiaPeriod();
    const curYear = parseInt(currentPeriod.split('.')[1], 10) || new Date().getFullYear();

    // Financial transaction selectors: ONLY historical & current active periods (NEVER future reserve periods)
    const financialPeriodFields = ["adminPeriod", "chargesPeriod", "v2IncomePeriod"];
    // Technical config selectors: allow future periods for forward-effective settings
    const technicalConfigFields = ["masterLogikaFrom", "masterUchFrom", "masterObFrom", "masterChFrom", "masterIdFrom"];
    const periodFields = financialPeriodFields.concat(technicalConfigFields);

    const monthNames = [
        "Януари", "Февруари", "Март", "Април", "Май", "Юни",
        "Юли", "Август", "Септември", "Октомври", "Ноември", "Декември"
    ];

    periodFields.forEach(id => {
        const el = document.getElementById(id);
        const isFinancialField = financialPeriodFields.includes(id);
        if (el && el.tagName === 'SELECT') {
            // Populate if empty
            if (el.options.length === 0) {
                monthNames.forEach((name, index) => {
                    const m = String(index + 1).padStart(2, '0');
                    const val = `${m}.${curYear}`;
                    if (isFinancialField && isFutureTechnicalPeriodUI(val)) return;
                    const opt = new Option(`${name} ${curYear}`, val);
                    el.appendChild(opt);
                });
            }
            // Always try to set current period as default if no value is set
            if (!el.getAttribute('data-init-done')) {
                el.value = currentPeriod;
                el.setAttribute('data-init-done', 'true');
            }
        } else if (el && !el.value) {
            el.value = currentPeriod;
        }
    });
}

function populateAdminDropdowns() {
    ["adminApt", "adminEmailApt", "masterUchApt", "masterObApt", "masterChApt", "masterIdApt", "masterBookApt", "docAptSelect", "masterInfoApt", "emailAptTarget"].forEach(id => {
        const sel = document.getElementById(id);
        if (sel && sel.options.length <= 1) {
            sel.innerHTML = '<option value="">Избери апартамент</option>';
            apartmentList.forEach(a => sel.appendChild(new Option(a, a)));
        }
    });
// FIX-ART51-OCCUPANTS: Валидация в реално време за обитатели и избор на логика
    const obInput = document.getElementById("masterObVal");
    if (obInput) {
        obInput.addEventListener("change", async (e) => {
            const valNum = Number(e.target.value);
            if (e.target.value === "" || isNaN(valNum) || !Number.isInteger(valNum) || valNum < 1) {
                const fromP = (document.getElementById("masterObFrom")?.value || "").trim();
                const apt = (document.getElementById("masterObApt")?.value || "").trim();
                if (fromP) {
                    try {
                        const check = await apiCall('getPeriodOccupants', { period: fromP });
                        if (check && check.currentMode === 'Обитатели') {
                            showToast("При разпределение по обитатели за всеки апартамент трябва да бъде посочен поне 1 обитател. Коригирайте данните за: Ап. " + (apt || ""), "error");
                            // Не променяме автоматично стойността на 1
                        }
                    } catch (err) {}
                }
            }
        });
    }

    const logikaSelect = document.getElementById("masterLogikaVal");
    const logikaFrom = document.getElementById("masterLogikaFrom");
    if (logikaFrom) {
        logikaFrom.addEventListener("change", async (e) => {
            const p = e.target.value.trim();
            if (p) {
                try {
                    const check = await apiCall('getPeriodOccupants', { period: p });
                    if (logikaSelect && check && check.currentMode) {
                        logikaSelect.value = check.currentMode;
                        logikaSelect.dataset.prevVal = check.currentMode;
                    }
                } catch (err) {}
            }
        });
    }
    if (logikaSelect) {
        if (!logikaSelect.dataset.prevVal) logikaSelect.dataset.prevVal = logikaSelect.value || "Равно";
        logikaSelect.addEventListener("change", async (e) => {
            const newVal = e.target.value;
            const fromP = (logikaFrom?.value || "").trim();
            if (newVal === 'Обитатели' && fromP) {
                try {
                    const check = await apiCall('getPeriodOccupants', { period: fromP });
                    if (check && check.invalidApts && check.invalidApts.length > 0) {
                        showToast("При разпределение по обитатели за всеки апартамент трябва да бъде посочен поне 1 обитател. Коригирайте данните за: Ап. " + check.invalidApts.join(', '), "error");
                        e.target.value = logikaSelect.dataset.prevVal || "Равно";
                        return;
                    }
                    logikaSelect.dataset.prevVal = newVal;
                } catch (err) {
                    e.target.value = logikaSelect.dataset.prevVal || "Равно";
                }
            } else {
                logikaSelect.dataset.prevVal = newVal;
            }
        });
    }
    autoFillCurrentPeriod();
    
    const v2AptSel = document.getElementById("v2IncomeApt");
    if (v2AptSel && apartmentList.length > 0 && v2AptSel.options.length <= 3) {
        v2AptSel.innerHTML = '<option value="">Избери...</option>';
        v2AptSel.appendChild(new Option("Външен източник", "EXTERNAL"));
        v2AptSel.appendChild(new Option("Самостоятелни обекти (извън A1–AN)", "EXTERNAL_UNIT"));
        apartmentList.forEach(a => v2AptSel.appendChild(new Option(a, a)));
    }
if (typeof loadCurrentCharges === 'function') loadCurrentCharges();
    if (typeof loadPaymentDue === 'function') loadPaymentDue();
}

const getStoredPin = () => sessionStorage.getItem("adminAuth_" + currentRouteKey);

window.submitPayment = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("adminApt").value;
    const period = document.getElementById("adminPeriod").value.trim();
    const amount = document.getElementById("adminAmount").value.trim();

    if (amount.includes(',')) {
        showToast("Използвайте точка (.) за десетични стойности.", "error");
        return;
    }

    if (!apt || !period || !amount) {
        showToast("Попълнете всички полета за плащане!", "error");
        return;
    }

    const btn = document.getElementById("payBtn");
    showSaving(btn, "Записване...");

    const result = await apiCall('addPayment', {
        pin: getStoredPin(),
        apartment: apt,
        period: period,
        amount: amount
    });
    throwIfStaleRouteRequestContext(requestContext);

    hideSaving(btn, "Добави плащане");

    if (result && result.success) {
        showToast("✅ Успешно добавено плащане. Данните се синхронизират...", "success");
        document.getElementById("adminAmount").value = "";
        bgApiCall('forceSync', { pin: getStoredPin() }).then(() => {
            if (!isCurrentRouteRequestContext(requestContext)) return;
            refreshCurrentView();
            if (typeof loadPaymentDue === 'function') loadPaymentDue();
        }).catch(error => { if (!isStaleRouteRequestError(error)) console.warn('forceSync failed', error); });
    } else {
        showToast(result?.error || "Възникна грешка", "error");
    }
}


window.loadPaymentDue = async function() {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("adminApt").value;
    const period = document.getElementById("adminPeriod").value.trim();
    const lbl = document.getElementById("lbl-paymentDue");
    
    if (!lbl) return;
    
    if (!apt || !period || !window.fb || !window.db) {
        lbl.innerHTML = "";
        lbl.className = "charge-current";
        return;
    }
    
    lbl.innerHTML = '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>';
    lbl.className = "charge-current loading";
    
    try {
        const { routeDoc, getDoc } = window.fb;
        const db = window.db;
        
        const docId = currentRouteKey + "_" + apt + "_" + period;
        const docRef = routeDoc(db, "monthlyReports", docId, currentRouteKey);
        const aptDocRef = routeDoc(db, "apartments", currentRouteKey + "_" + apt, currentRouteKey);
        
        const [snap, aptSnap] = await Promise.all([getDoc(docRef), getDoc(aptDocRef)]);
        throwIfStaleRouteRequestContext(requestContext);
        
        const currency = sessionStorage.getItem("currency_" + currentRouteKey) || "лв.";
        let balanceStr = "";
        
        if (aptSnap.exists()) {
            const aptData = aptSnap.data();
            const bal = Number(aptData.balance || 0);
            const colorClass = bal > 0 ? "value-red" : "value-green";
            balanceStr = `, салдо <span class="${colorClass}">${bal.toFixed(2)} ${currency}</span>`;
        }
        
        if (snap.exists()) {
            const data = snap.data();
            const paid = Number(data.receivedPaid ?? data.totalPaid ?? data.paid ?? 0); // MAINTENANCE_RECEIPT_UI
            
            lbl.className = "charge-current";
            lbl.innerHTML = `(платено <span class="value-green">${paid.toFixed(2)} ${currency}</span>${balanceStr})`;
        } else {
            lbl.className = "charge-current";
            lbl.innerHTML = `(платено 0.00 ${currency}${balanceStr})`;
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        lbl.className = "charge-current";
        lbl.innerText = "";
    }
};

window.loadBookData = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("masterBookApt").value;
    if (!apt) return;

    // Clear fields first
    const fields = ["Owner", "Email", "Occupants", "EntryDate", "Pets", "Purpose"];
    fields.forEach(f => {
        const el = document.getElementById("book-" + f);
        if (el) el.value = "";
    });

    try {
        const result = await apiCall('getBookData', { apartment: apt });
        throwIfStaleRouteRequestContext(requestContext);
        if (result && result.success && result.data) {
            const d = result.data;
            if (d["Собственик"]) document.getElementById("book-Owner").value = d["Собственик"];
            if (d["Имейл"]) document.getElementById("book-Email").value = d["Имейл"];
            if (d["Обитатели"]) document.getElementById("book-Occupants").value = d["Обитатели"];
            if (d["Домашни любимци"]) document.getElementById("book-Pets").value = d["Домашни любимци"];
            if (d["Предназначение"]) document.getElementById("book-Purpose").value = d["Предназначение"];

            if (d["Дата вписване"]) {
                try {
                    const date = new Date(d["Дата вписване"]);
                    if (!isNaN(date.getTime())) {
                        document.getElementById("book-EntryDate").value = date.toISOString().split('T')[0];
                    }
                } catch (e) { }
            }
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Грешка при зареждане на данните", "error");
    }
}

window.submitBookData = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("masterBookApt").value;
    if (!apt) {
        showToast("Моля, изберете апартамент!", "error");
        return;
    }

    const mapping = [
        { id: "book-Owner", key: "Собственик" },
        { id: "book-Email", key: "Имейл" },
        { id: "book-Occupants", key: "Обитатели" },
        { id: "book-EntryDate", key: "Дата вписване" },
        { id: "book-Pets", key: "Домашни любимци" },
        { id: "book-Purpose", key: "Предназначение" }
    ];

    const updates = {};
    mapping.forEach(item => {
        const el = document.getElementById(item.id);
        if (el) updates[item.key] = el.value;
    });

    const btn = document.getElementById('book-save-btn');
    showSaving(btn, "Записване...");

    try {
        const result = await apiCall('updateBookData', {
            pin: getStoredPin(),
            apartment: apt,
            updates: JSON.stringify(updates)
        });

        throwIfStaleRouteRequestContext(requestContext);
        if (result && result.success) {
            showToast("✅ Книгата на ЕС е успешно обновена за " + apt, "success");
        } else {
            showToast(result?.error || "Грешка при запис", "error");
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        showToast("Възникна грешка при записа", "error");
    } finally {
        if (isCurrentRouteRequestContext(requestContext)) hideSaving(btn, "Запиши Промените");
    }
}

// ==============================================
// ЗАРЕЖДАНЕ НА ТЕКУЩИ НАЧИСЛЕНИЯ ЗА ИЗБРАН ПЕРИОД
// ==============================================

const chargeLabelsMap = [
    { labelId: 'lbl-chargesElevator',     name: 'Асансьор ел.',     key: 'elevator' },
    { labelId: 'lbl-chargesSubscription', name: 'Асансьор абон. и др.',    key: 'subscription' },
    { labelId: 'lbl-chargesLight',        name: 'Етажно ел.',         key: 'light' },
    { labelId: 'lbl-chargesSecurity',     name: 'Охрана',       key: 'security' },
    { labelId: 'lbl-chargesCleaning',     name: 'Почистване',   key: 'cleaning' },
    { labelId: 'lbl-chargesPodrajka',     name: 'Фонд Поддръжка', key: 'maintenance', legacyKey: 'podrajka' },
    { labelId: 'lbl-chargesRemont',       name: 'Фонд ремонт',  key: 'repairFund', legacyKey: 'remont' },
    { labelId: 'lbl-chargesWater',        name: 'ВиК',         key: 'water' },
    { labelId: 'lbl-chargesPlatformSubscription', name: 'Управление', key: 'platformSubscription' }
];

function updateChargeLabel(labelId, name, value) {
    const lbl = document.getElementById(labelId);
    if (!lbl) return;
    const span = lbl.querySelector('.charge-current');
    if (!span) return;

    if (typeof value === 'number' && Number.isFinite(value)) {
        const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
        span.textContent = `(текущо ${Number(value).toFixed(2)} ${cur})`;
        span.className = 'charge-current has-value';
    } else {
        span.textContent = '(Няма данни)';
        span.className = 'charge-current no-value';
    }
}

function setChargeLabelsLoading() {
    chargeLabelsMap.forEach(c => {
        const lbl = document.getElementById(c.labelId);
        if (!lbl) return;
        const span = lbl.querySelector('.charge-current');
        if (span) {
            span.textContent = '(зареждане...)';
            span.className = 'charge-current loading';
        }
    });
}

function clearChargeLabels() {
    chargeLabelsMap.forEach(c => {
        const lbl = document.getElementById(c.labelId);
        if (!lbl) return;
        const span = lbl.querySelector('.charge-current');
        if (span) {
            span.textContent = '';
            span.className = 'charge-current';
        }
    });
}

window.loadCurrentCharges = async function () {
    const requestContext = captureRouteRequestContext();
    const period = document.getElementById("chargesPeriod").value.trim();
    if (!period) {
        clearChargeLabels();
        return;
    }

    setChargeLabelsLoading();

    try {
        // Четем buildingCharges (MASTER) и chargesV2 (брутни начислени суми) паралелно от Firebase.
        // При наличие на външни самостоятелни обекти (EXT_k), MASTER пази само апартаментния дял,
        // докато „Текущо“ трябва да показва общия действително въведен разход за категорията и периода.
        const { routeDoc, getDoc, collection, getDocs, query, where } = window.fb;
        const db = window.db;

        const docId = currentRouteKey + "_" + period;
        const docRef = routeDoc(db, "buildingCharges", docId, currentRouteKey);
        const chargesQuery = query(collection(db, "chargesV2"), where("routeKey", "==", currentRouteKey));

        const [snap, chargesSnap] = await Promise.all([
            getDoc(docRef),
            getDocs(chargesQuery).catch(() => null)
        ]);
        throwIfStaleRouteRequestContext(requestContext);

        // Изчисляваме точните брутни сборове в центове по категория за избрания период от chargesV2
        const grossCentsByCategory = Object.create(null);
        const hasGrossByCategory = Object.create(null);
        if (chargesSnap && typeof chargesSnap.forEach === 'function') {
            const rawDocs = [];
            chargesSnap.forEach(d => rawDocs.push({ id: d.id, ...d.data() }));
            let validRows = [];
            try {
                validRows = typeof reportChargeRows_ === 'function' ? reportChargeRows_(rawDocs) : rawDocs;
            } catch (valErr) {
                validRows = [];
            }
            validRows.forEach(r => {
                if (r.period !== period || !r.category) return;
                const cents = Math.round(Number(r.amount) * 100);
                if (!Number.isSafeInteger(cents)) return;
                grossCentsByCategory[r.category] = (grossCentsByCategory[r.category] || 0) + cents;
                hasGrossByCategory[r.category] = true;
            });
        }

        const data = snap.exists() ? snap.data() : null;
        chargeLabelsMap.forEach(c => {
            if (hasGrossByCategory[c.key]) {
                updateChargeLabel(c.labelId, c.name, grossCentsByCategory[c.key] / 100);
            } else if (data) {
                updateChargeLabel(c.labelId, c.name,
                    Object.prototype.hasOwnProperty.call(data, c.key) ? data[c.key] : data[c.legacyKey]);
            } else {
                updateChargeLabel(c.labelId, c.name, null);
            }
        });
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error('loadCurrentCharges error:', e);
        clearChargeLabels();
    }
}

// BEGIN SLICE4 MANUAL EXPENSE UX
// Presentation mapping only: keys/order mirror EXPENSE_SCHEMA; no allocation rules here.
const manualExpenseStates_ = new Map();
function manualExpensePendingKey_(route) { return 'manualExpensePendingV2_' + route; }
function manualExpensePersistPending_(route, pending) {
    try {
        if (!route) return;
        if (pending && pending.request && pending.raw) {
            sessionStorage.setItem(manualExpensePendingKey_(route), JSON.stringify({
                request: pending.request, raw: pending.raw, draft: pending.draft,
                confirmedCategories: pending.confirmedCategories || [], uncertainHistory: !!pending.uncertainHistory
            }));
        } else {
            sessionStorage.removeItem(manualExpensePendingKey_(route));
        }
    } catch (e) {}
}
function manualExpenseState_() {
    if (!manualExpenseStates_.has(currentRouteKey)) {
        const draft = Object.create(null);
        chargeLabelsMap.forEach(c => { draft[c.key] = {amount: '', note: ''}; });
        let restored = null;
        try {
            const saved = sessionStorage.getItem(manualExpensePendingKey_(currentRouteKey));
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && parsed.request && typeof parsed.request.requestId === 'string' && Array.isArray(parsed.request.operations) && parsed.request.operations.length) {
                    if (parsed.draft) chargeLabelsMap.forEach(c => { if (parsed.draft[c.key]) draft[c.key] = {...parsed.draft[c.key]}; });
                    restored = Object.freeze({
                        request: Object.freeze(parsed.request), raw: parsed.raw,
                        context: {routeKey: currentRouteKey}, draft: parsed.draft || draft,
                        confirmedCategories: Object.freeze(parsed.confirmedCategories || []),
                        uncertainHistory: !!parsed.uncertainHistory
                    });
                }
            }
        } catch (e) {}
        manualExpenseStates_.set(currentRouteKey, {
            draft, pending: restored, inFlight: false,
            message: restored ? 'Възстановена е непотвърдена заявка за разходи. Използвайте „Повтори същия запис“.' : ''
        });
    }
    return manualExpenseStates_.get(currentRouteKey);
}
function manualExpenseControls_(category) {
    const id = category.labelId.slice(4);
    return {amount: document.getElementById(id), note: document.getElementById(id + 'Note')};
}
window.updateManualExpenseDraft = function (key) {
    const category = chargeLabelsMap.find(c => c.key === key);
    if (!category) return;
    const state = manualExpenseState_(), controls = manualExpenseControls_(category);
    state.draft[key] = {amount: controls.amount.value, note: controls.note.value};
    const rawVal = state.draft[key].amount;
    if (rawVal.includes(',')) {
        showToast('Използвайте точка (.) за десетични стойности.', 'error');
        state.message = 'Използвайте точка (.) за десетични стойности.';
        renderManualExpenseState_();
    }
    const amount = rawVal.trim();
    controls.note.required = amount !== '' && Number.isFinite(Number(amount)) && Number(amount) < 0;
    controls.note.placeholder = controls.note.required ? 'Основание / Бележка — задължителна при отрицателна сума' : 'Основание / Бележка (по желание)';
};
function renderManualExpenseState_() {
    const state = manualExpenseState_();
    chargeLabelsMap.forEach(c => {
        const controls = manualExpenseControls_(c);
        controls.amount.disabled = !!state.pending || controls.amount.dataset.expenseUnavailable === 'true';
        controls.note.disabled = !!state.pending;
    });
    document.getElementById('chargesPeriod').disabled = !!state.pending;
    const button = document.getElementById('chargesBtn');
    button.disabled = state.inFlight;
    if (state.inFlight) {
        button.innerHTML = '<span style="display:inline-flex;align-items:center;gap:6px;"><span class="btn-spinner" aria-hidden="true"></span><span>Обработва се…</span></span>';
    } else {
        button.textContent = state.pending ? 'Повтори същия запис' : 'Запиши начисление (+/-)';
    }
    const feedback = document.getElementById('chargesFeedback');
    feedback.className = 'save-status-indicator ' + (
        state.inFlight ? 'state-pending' :
        state.pending ? 'state-verifying' :
        state.message && state.message.includes('успешно') ? 'state-success' :
        state.message ? 'state-error' : ''
    );
    feedback.innerHTML = state.inFlight
        ? '<span class="btn-spinner" aria-hidden="true"></span><span>' + reportEscape_(state.message || 'Изпращане…') + '</span>'
        : reportEscape_(state.message);
    feedback.hidden = state.message === '';
}
function resetManualExpenseView_() {
    const state = manualExpenseState_();
    chargeLabelsMap.forEach(c => {
        const controls = manualExpenseControls_(c);
        controls.amount.value = state.draft[c.key].amount;
        controls.note.value = state.draft[c.key].note;
        updateManualExpenseDraft(c.key);
    });
    if (state.pending) document.getElementById('chargesPeriod').value = state.pending.request.operations[0].period;
    renderManualExpenseState_();
}
function buildManualExpenseOperations_(draft, period) {
    if (typeof period !== 'string' || !/^(0[1-9]|1[0-2])\.(20[0-4][0-9]|2050)$/.test(period)) {
        throw new Error('Изберете валиден период MM.YYYY.');
    }
    const operations = [];
    chargeLabelsMap.forEach(c => {
        const {amount, note} = draft[c.key];
        if (typeof amount !== 'string' || typeof note !== 'string' || note.length > 4096) throw new Error('Проверете сумата и бележката за ' + c.name + '.');
        const text = amount.trim();
        if (text === '') return;
        if (text.includes(',')) {
            throw new Error('Използвайте точка (.) за десетични стойности.');
        }
        if (!/^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$/.test(text) || !Number.isFinite(Number(text))) {
            throw new Error('Въведете крайна числова сума за ' + c.name + ' (десетичен знак: точка).');
        }
        const signedAmount = Number(text) === 0 ? 0 : Number(text);
        if (signedAmount < 0 && note.trim() === '') throw new Error('Добавете основание за отрицателната сума: ' + c.name + '.');
        operations.push(Object.freeze({category: c.key, signedAmount, period, note}));
    });
    if (operations.length === 0) throw new Error('Въведете поне една сума. Нулата е валидна сума.');
    return Object.freeze(operations);
}
function newManualExpenseRequestId_() {
    const id = window.crypto.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw new Error('UUID unavailable');
    return id;
}
function classifyManualExpenseResponse_(response, request) {
    if (!response || response.contractVersion !== 2 || !Array.isArray(response.operations)) return 'UNKNOWN';
    if (response.success === false && response.status === 'FAILED' && response.requestId === null &&
        response.batchId === null && response.operations.length === 0) return 'NOT_ADMITTED';
    if (response.requestId !== request.requestId || typeof response.batchId !== 'string' || !/^[0-9a-f]{64}$/.test(response.batchId)) return 'UNKNOWN';
    const results = response.operations;
    if (results.length > request.operations.length) return 'UNKNOWN';
    for (let index = 0; index < results.length; index++) {
        const item = results[index];
        if (!item || item.category !== request.operations[index].category || typeof item.operationId !== 'string' ||
            !/^[0-9a-f]{64}$/.test(item.operationId)) return 'UNKNOWN';
        if (item.status !== 'APPLIED' && item.status !== 'APPLIED_REPLAY' &&
            !(response.success === false && item.status === 'FAILED' && index === results.length - 1)) return 'UNKNOWN';
    }
    if (response.success === true && response.status === 'APPLIED' && results.length === request.operations.length &&
        results.every(item => item.status === 'APPLIED' || item.status === 'APPLIED_REPLAY')) return 'APPLIED';
    return response.success === false && response.status === 'FAILED' ? 'FAILED' : 'UNKNOWN';
}
function accumulateManualExpenseHistory_(pending, response, classification) {
    const confirmed = new Set(pending.confirmedCategories);
    if (classification === 'APPLIED' || classification === 'FAILED') {
        response.operations.forEach(item => {
            if (item.status === 'APPLIED' || item.status === 'APPLIED_REPLAY') confirmed.add(item.category);
        });
    }
    return Object.freeze({...pending,
        confirmedCategories: Object.freeze(pending.request.operations.filter(item => confirmed.has(item.category)).map(item => item.category)),
        uncertainHistory: pending.uncertainHistory || classification !== 'NOT_ADMITTED'
    });
}
function manualExpenseFailureMessage_(response, pending, classification) {
    if (response && typeof response.error === 'string' && response.error.indexOf("При разпределение по обитатели") === 0) {
        return response.error;
    }
    const request = pending.request, confirmed = new Set(pending.confirmedCategories);
    const label = key => chargeLabelsMap.find(c => c.key === key).name;
    let message = 'Резултатът е несигурен. Възможно е част от сумите вече да са записани. ';
    if (confirmed.size) message += 'Потвърдени: ' + pending.confirmedCategories.map(label).join(', ') + '. ';
    const unresolved = request.operations.filter(item => !confirmed.has(item.category));
    if (unresolved.length) message += (unresolved.length === 1 ? 'Непотвърдена категория: ' : 'Непотвърдени категории: ') +
        unresolved.map(item => label(item.category)).join(', ') + '. ';
    if (classification === 'NOT_ADMITTED') {
        message += 'Последният опит не е допуснат за обработка, но предходната заявка остава неразрешена. ';
    }
    if (classification === 'FAILED') {
        const results = response.operations;
        const failed = results.find(item => item.status === 'FAILED');
        if (failed && !confirmed.has(failed.category)) message += 'Последният опит спря при: ' + label(failed.category) + '. ';
        if (!results.length) message += 'Последният опит не потвърди ново продължение. ';
        const later = request.operations.slice(results.length).filter(item => !confirmed.has(item.category));
        if (later.length) message += 'Не са опитани в последния опит: ' + later.map(item => label(item.category)).join(', ') + '. ';
    }
    return message + 'Използвайте „Повтори същия запис“ със запазената заявка. Не въвеждайте сумите повторно като нов запис. Не презареждайте страницата преди изясняване.';
}
window.submitCharges = async function () {
    const state = manualExpenseState_();
    if (state.inFlight) return;
    if (!state.pending) {
        try {
            chargeLabelsMap.forEach(c => updateManualExpenseDraft(c.key));
            const operations = buildManualExpenseOperations_(state.draft, document.getElementById('chargesPeriod').value);
            const context = captureFinancialOperationContext();
            const request = Object.freeze({contractVersion: 2, requestId: newManualExpenseRequestId_(), operations});
            const draft = Object.freeze(Object.fromEntries(chargeLabelsMap.map(c => [c.key, Object.freeze({...state.draft[c.key]})])));
            state.pending = Object.freeze({request, raw: JSON.stringify(request), context, draft,
                confirmedCategories: Object.freeze([]), uncertainHistory: false});
            manualExpensePersistPending_(context.routeKey, state.pending);
        } catch (error) {
            // Only our bounded validation messages enter the ordinary UI.
            state.message = error instanceof Error && /^(Изберете|Проверете|Въведете|Добавете|Използвайте)/.test(error.message) ?
                error.message : 'Не може да се подготви заявката. Проверете активния вход и поддръжката на защитен UUID в браузъра.';
            renderManualExpenseState_();
            return;
        }
    }
    const snapshot = state.pending;
    // Re-entry into an entrance gets a new navigation context, but keeps the exact request.
    const attemptContext = captureFinancialOperationContext();
    if (attemptContext.routeKey !== snapshot.context.routeKey) return;
    state.inFlight = true;
    state.message = 'Записване…';
    renderManualExpenseState_();
    let response;
    try {
        response = await apiCall('addChargesV2', {routeKey: snapshot.context.routeKey, pin: getStoredPin(), request: snapshot.raw}, attemptContext);
    } catch (error) { /* Unknown response preserves the same frozen request. */ }
    const classification = classifyManualExpenseResponse_(response, snapshot.request);
    const history = accumulateManualExpenseHistory_(snapshot, response, classification);
    state.inFlight = false;
    if (classification === 'APPLIED') {
        snapshot.request.operations.forEach(item => {
            const original = snapshot.draft[item.category], draft = state.draft[item.category];
            if (draft.amount === original.amount && draft.note === original.note) state.draft[item.category] = {amount: '', note: ''};
        });
        state.pending = null;
        manualExpensePersistPending_(snapshot.context.routeKey, null);
        state.message = 'Всички въведени начисления са записани успешно.';
    } else if (classification === 'NOT_ADMITTED' && !history.uncertainHistory && !history.confirmedCategories.length) {
        state.pending = null;
        manualExpensePersistPending_(snapshot.context.routeKey, null);
        state.message = 'Заявката не е допусната за обработка. Проверете данните и достъпа; след корекция изпратете нов запис.';
    } else {
        state.pending = history;
        manualExpensePersistPending_(snapshot.context.routeKey, history);
        state.message = manualExpenseFailureMessage_(response, history, classification);
    }
    if (!isFinancialOperationContextCurrent(attemptContext)) return;
    resetManualExpenseView_();
    if (classification === 'APPLIED') {
        const appliedPeriod = snapshot.request.operations && snapshot.request.operations[0] ? snapshot.request.operations[0].period : '';
        Promise.resolve(loadCurrentCharges()).catch(() => {});
        if (typeof loadChargesV2Register === 'function') Promise.resolve(loadChargesV2Register()).catch(() => {});
        // Keep monthlyReports and apartments in Firestore in sync immediately after expense writes.
        // If post-commit sync fails, report it separately and NEVER re-submit addChargesV2.
        bgApiCall('forceSync', { routeKey: snapshot.context.routeKey, pin: getStoredPin(), period: appliedPeriod }).then((syncRes) => {
            if (!isFinancialOperationContextCurrent(attemptContext)) return;
            if (syncRes && syncRes.success === false) {
                console.warn('Post-expense forceSync returned error:', syncRes.error);
                showToast('Разходът е записан успешно, но обновяването на справките се забави. Не повтаряйте записа.', 'warning');
                return;
            }
            refreshCurrentView();
        }).catch((syncErr) => {
            if (isStaleRouteRequestError(syncErr)) return;
            console.warn('Post-expense forceSync failed:', syncErr);
            showToast('Разходът е записан успешно, но синхронизацията на справките временно не успя. Не повтаряйте записа.', 'warning');
        });
    }
};
// END SLICE4 MANUAL EXPENSE UX

window.loadCurrentEmail = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("adminEmailApt").value;
    if (!apt) {
        document.getElementById("currentEmailBox").style.display = "none";
        return;
    }

    const result = await apiCall('getEmail', { apartment: apt });
    throwIfStaleRouteRequestContext(requestContext);
    if (result && typeof result.email !== 'undefined') {
        const span = document.getElementById("currentEmail");
        span.textContent = result.email ? result.email : "Няма записан";
        document.getElementById("currentEmailBox").style.display = "block";
    }
}

window.submitEmail = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("adminEmailApt").value;
    const email = document.getElementById("adminEmail").value.trim();

    if (!apt || !email) {
        showToast("Изберете апартамент и имейл!", "error");
        return;
    }

    const btn = document.getElementById("emailBtn");
    btn.textContent = "Записване...";

    const result = await apiCall('addEmail', {
        pin: getStoredPin(),
        apartment: apt,
        email: email
    });
    throwIfStaleRouteRequestContext(requestContext);

    btn.textContent = "Запази имейл";

    if (result && result.success) {
        showToast("Имейлът е обновен.", "success");
        document.getElementById("adminEmail").value = "";
        loadCurrentEmail(); // Refresh current email display
    } else {
        showToast(result?.error || "Възникна грешка", "error");
    }
}

window.submitAdminEmail = async function () {
    const requestContext = captureRouteRequestContext();
    const email = document.getElementById("newAdminEmailInput").value.trim();

    if (!email) {
        showToast("Моля, въведете имейл адрес!", "error");
        return;
    }

    if (!confirm("Сигурни ли сте, че искате да смените имейла на домоуправителя на \"" + email + "\"? Ако текущият имейл е настроен за автоматизация, тя ще спре, докато не я настроите наново към новия имейл.")) {
        return;
    }

    const btn = document.getElementById("adminEmailBtn");
    btn.textContent = "Записване...";
    btn.disabled = true;

    const result = await apiCall('updateAdminEmail', {
        pin: getStoredPin(),
        newEmail: email
    });

    throwIfStaleRouteRequestContext(requestContext);
    btn.textContent = "Запази имейл";
    btn.disabled = false;

    if (result && result.success) {
        showToast("✅ " + result.message, "success");
        sessionStorage.setItem("adminEmail_" + currentRouteKey, email);
    } else {
        showToast(result?.error || "Възникна грешка", "error");
    }
}

let _masterDirtyTab = null;

window.clearMasterDirtyState = function () {
    _masterDirtyTab = null;
};

function checkMasterDirtyAndConfirm_(nextKey) {
    if (_masterDirtyTab && _masterDirtyTab !== nextKey) {
        const proceed = typeof window.confirm === 'function'
            ? window.confirm("Имате незапазени промени в текущия раздел на настройките. Сигурни ли сте, че искате да превключите без запис?")
            : true;
        if (!proceed) return false;
        _masterDirtyTab = null;
    }
    return true;
}

document.addEventListener("input", function (e) {
    const panel = e.target && typeof e.target.closest === 'function' ? e.target.closest(".master-panel") : null;
    if (panel && panel.id && panel.id.startsWith("master-tab-")) {
        _masterDirtyTab = panel.id.replace("master-tab-", "");
    }
}, true);

document.addEventListener("change", function (e) {
    const panel = e.target && typeof e.target.closest === 'function' ? e.target.closest(".master-panel") : null;
    if (panel && panel.id && panel.id.startsWith("master-tab-")) {
        const ignoreIds = ["masterInfoApt", "art51Apartment", "extUnitSelect", "extUnitStatementFilter", "zuesFilterApt", "zuesFilterStatus", "zuesReportApt"];
        if (e.target.id && ignoreIds.includes(e.target.id)) return;
        _masterDirtyTab = panel.id.replace("master-tab-", "");
    }
}, true);

window.toggleMasterAccordionGroup = function (groupKey, btn) {
    const body = document.getElementById("masterGroupBody_" + groupKey);
    const groupEl = btn && typeof btn.closest === 'function' ? btn.closest(".master-acc-group") : null;
    const isCurrentlyOpen = body && body.style.display !== "none";

    if (isCurrentlyOpen) {
        if (!checkMasterDirtyAndConfirm_(null)) return;
        body.style.display = "none";
        if (groupEl) groupEl.classList.remove("open");
        if (btn) {
            btn.classList.remove("active");
            btn.setAttribute("aria-expanded", "false");
            const chev = btn.querySelector(".master-acc-chevron");
            if (chev) chev.textContent = "▸";
        }
        body.querySelectorAll(".master-panel").forEach(p => p.style.display = "none");
        body.querySelectorAll(".master-tab").forEach(b => {
            b.classList.remove("active");
            const c = b.querySelector(".master-item-chevron");
            if (c) c.textContent = "▸";
        });
        return;
    }

    if (!checkMasterDirtyAndConfirm_("group_" + groupKey)) return;

    // Затваряме всички други групи и самостоятелни панели
    document.querySelectorAll(".master-acc-group").forEach(g => {
        g.classList.remove("open");
        const gBtn = g.querySelector(".master-acc-group-btn");
        if (gBtn) {
            gBtn.classList.remove("active");
            gBtn.setAttribute("aria-expanded", "false");
            const c = gBtn.querySelector(".master-acc-chevron");
            if (c) c.textContent = "▸";
        }
        const gBody = g.querySelector(".master-acc-group-body");
        if (gBody) gBody.style.display = "none";
    });
    document.querySelectorAll(".master-panel").forEach(p => p.style.display = "none");
    document.querySelectorAll(".master-tab").forEach(b => {
        b.classList.remove("active");
        b.style.background = "";
        b.style.color = "";
        b.style.borderColor = "";
        const c = b.querySelector(".master-item-chevron");
        if (c) c.textContent = "▸";
    });

    if (body) body.style.display = "flex";
    if (groupEl) groupEl.classList.add("open");
    if (btn) {
        btn.classList.add("active");
        btn.setAttribute("aria-expanded", "true");
        const chev = btn.querySelector(".master-acc-chevron");
        if (chev) chev.textContent = "▾";
        if (typeof btn.scrollIntoView === 'function') {
            btn.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
    }
};

window.switchMasterTab = function (tab, btn) {
    const pane = document.getElementById("master-tab-" + tab);
    const isAlreadyOpen = pane && pane.style.display === "block";

    if (isAlreadyOpen) {
        if (!checkMasterDirtyAndConfirm_(null)) return;
        pane.style.display = "none";
        if (btn) {
            btn.classList.remove("active");
            btn.style.background = "";
            btn.style.color = "";
            btn.style.borderColor = "";
            const chev = btn.querySelector(".master-item-chevron");
            if (chev) chev.textContent = "▸";
        }
        return;
    }

    if (!checkMasterDirtyAndConfirm_(tab)) return;

    const parentGroup = btn && typeof btn.closest === 'function' ? btn.closest(".master-acc-group") : null;
    document.querySelectorAll(".master-acc-group").forEach(g => {
        const gBtn = g.querySelector(".master-acc-group-btn");
        const gBody = g.querySelector(".master-acc-group-body");
        if (g === parentGroup) {
            g.classList.add("open");
            if (gBody) gBody.style.display = "flex";
            if (gBtn) {
                gBtn.classList.add("active");
                gBtn.setAttribute("aria-expanded", "true");
                const c = gBtn.querySelector(".master-acc-chevron");
                if (c) c.textContent = "▾";
            }
        } else {
            g.classList.remove("open");
            if (gBody) gBody.style.display = "none";
            if (gBtn) {
                gBtn.classList.remove("active");
                gBtn.setAttribute("aria-expanded", "false");
                const c = gBtn.querySelector(".master-acc-chevron");
                if (c) c.textContent = "▸";
            }
        }
    });

    document.querySelectorAll(".master-panel").forEach(p => p.style.display = "none");
    document.querySelectorAll(".master-tab").forEach(b => {
        b.classList.remove("active");
        // Reset special styles for ZUES toggle
        b.style.background = "";
        b.style.color = "";
        b.style.borderColor = "";
        const c = b.querySelector(".master-item-chevron");
        if (c) c.textContent = "▸";
    });

    if (pane) pane.style.display = "block";
    if (btn) {
        btn.classList.add("active");
        const chev = btn.querySelector(".master-item-chevron");
        if (chev) chev.textContent = "▾";
    }

    if (tab === 'idealni') {
        if (typeof window.refreshIdealPartsTabState === 'function') {
            window.refreshIdealPartsTabState();
        }
    }

    if (tab === 'art51') {
        if (typeof window.openArt51Settings === 'function') {
            window.openArt51Settings();
        }
    }

    if (tab === 'chipove') {
        if (typeof window.loadElevatorChipsConfigUI === 'function') {
            window.loadElevatorChipsConfigUI();
        }
    }

    if (tab === 'extunits') {
        if (btn) {
            btn.style.background = "var(--primary)";
            btn.style.color = "white";
            btn.style.borderColor = "var(--primary)";
        }
        if (typeof window.openExternalUnitsSettings === 'function') {
            window.openExternalUnitsSettings();
        }
    }

    if (tab === 'zues') {
        if (btn) {
            btn.style.background = "var(--primary)";
            btn.style.color = "white";
            btn.style.borderColor = "var(--primary)";
        }
        switchZuesSubTab('z-book');
    }

    _masterDirtyTab = null;

    if (btn && typeof btn.scrollIntoView === 'function') {
        btn.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
}

let _currentBulkIdealPreview = null;

function parseStrictPositiveIdealPart_(raw) {
    if (raw === null || raw === undefined || typeof raw === 'boolean') return null;
    const s = String(raw).trim();
    if (s.includes(',')) return null;
    if (!s || !/^[+]?\d+(?:\.\d+)?$/.test(s)) return null;
    const n = Number(s);
    if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
    return Math.round(n * 10000) / 10000;
}

window.handleMasterIdAptChange = function () {
    const aptSel = document.getElementById("masterIdApt");
    const valInput = document.getElementById("masterIdVal");
    if (!aptSel || !valInput) return;
    const apt = normalizeAptName(aptSel.value);
    const currentVal = _currentIdealParts && _currentIdealParts[apt] !== undefined
        ? parseStrictPositiveIdealPart_(_currentIdealParts[apt])
        : null;
    valInput.value = currentVal !== null ? String(currentVal) : "";
};

window.refreshIdealPartsTabState = async function () {
    const requestContext = captureRouteRequestContext();
    const statusBox = document.getElementById("idealPartsCurrentStatus");
    try {
        const res = await apiCall('getBuildingIdealParts', { pin: getStoredPin() });
        throwIfStaleRouteRequestContext(requestContext);
        if (!res || !res.success) return;
        _currentIdealParts = res.parts || {};

        const aptSel = document.getElementById("masterIdApt");
        const valInput = document.getElementById("masterIdVal");
        if (aptSel && valInput && document.activeElement !== valInput) {
            const selectedApt = normalizeAptName(aptSel.value);
            const cur = parseStrictPositiveIdealPart_(_currentIdealParts[selectedApt]);
            valInput.value = cur !== null ? String(cur) : "";
        }

        const apts = (Array.isArray(apartmentList) && apartmentList.length > 0)
            ? apartmentList.map(a => normalizeAptName(a))
            : Object.keys(_currentIdealParts);
        const totalApts = apts.length;
        let popCount = 0;
        let scaledSum = 0;
        apts.forEach(a => {
            const v = parseStrictPositiveIdealPart_(_currentIdealParts[a]);
            if (v !== null) {
                popCount++;
                scaledSum += Math.round(v * 10000);
            }
        });
        const totalSum = Math.round(scaledSum) / 10000;
        const deviation = Math.round(scaledSum - 1000000) / 10000;
        const allPopulated = totalApts > 0 && popCount === totalApts;
        const sumValid = allPopulated && Math.abs(deviation) <= 0.0001;
        const devStr = (deviation > 0 ? "+" : "") + deviation.toFixed(2) + "%";

        if (statusBox) {
            statusBox.style.display = "block";
            if (allPopulated && sumValid) {
                statusBox.style.background = "rgba(46, 125, 50, 0.1)";
                statusBox.style.borderLeft = "4px solid #2e7d32";
                statusBox.style.color = "inherit";
                statusBox.innerHTML = `✅ <b>Валидни идеални части:</b> Попълнени са всички <b>${totalApts}</b> апартамента. Общ сбор: <b>${totalSum.toFixed(2)}%</b> (отклонение: 0.00%).`;
            } else if (allPopulated && !sumValid) {
                statusBox.style.background = "rgba(211, 47, 47, 0.12)";
                statusBox.style.borderLeft = "4px solid #d32f2f";
                statusBox.style.color = "#c62828";
                statusBox.innerHTML = `⚠️ <b>Отклонение в общия сбор:</b> Попълнени са ${popCount}/${totalApts} апартамента, но общият сбор е <b>${totalSum.toFixed(2)}%</b> (отклонение <b>${devStr}</b> спрямо 100.00%). Стойностите не се нормализират автоматично — коригирайте съответните апартаменти.`;
            } else {
                statusBox.style.background = "rgba(0, 122, 255, 0.06)";
                statusBox.style.borderLeft = "4px solid var(--primary, #007aff)";
                statusBox.style.color = "inherit";
                statusBox.innerHTML = `ℹ️ <b>Статус на идеалните части:</b> Въведени са <b>${popCount}</b> от <b>${totalApts}</b> апартамента (текущ сбор: <b>${totalSum.toFixed(2)}%</b>).`;
            }
        }
    } catch (e) {
        if (!isStaleRouteRequestError(e)) console.warn("refreshIdealPartsTabState error", e);
    }
};

window.toggleBulkIdealPartsSubmitBtn = function () {
    const chk = document.getElementById("masterIdBulkConfirmCheck");
    const btn = document.getElementById("masterIdBulkSaveBtn");
    if (!btn) return;
    const canSave = !!(_currentBulkIdealPreview && _currentBulkIdealPreview.canSave && chk && chk.checked);
    btn.disabled = !canSave;
};

window.cancelBulkIdealPartsPreview = function () {
    _currentBulkIdealPreview = null;
    const container = document.getElementById("masterIdBulkPreviewContainer");
    if (container) container.style.display = "none";
    const chk = document.getElementById("masterIdBulkConfirmCheck");
    if (chk) chk.checked = false;
    window.toggleBulkIdealPartsSubmitBtn();
};

window.previewBulkIdealParts = async function () {
    const requestContext = captureRouteRequestContext();
    const perFloorInput = document.getElementById("masterIdPerFloor");
    const container = document.getElementById("masterIdBulkPreviewContainer");
    const summaryEl = document.getElementById("masterIdBulkSummary");
    const warnEl = document.getElementById("masterIdBulkOverwriteWarning");
    const errEl = document.getElementById("masterIdBulkError");
    const tbody = document.getElementById("masterIdBulkPreviewTableBody");
    const chk = document.getElementById("masterIdBulkConfirmCheck");
    const confirmLabel = document.getElementById("masterIdBulkConfirmLabel");

    _currentBulkIdealPreview = null;
    if (chk) chk.checked = false;
    window.toggleBulkIdealPartsSubmitBtn();

    const apts = (Array.isArray(apartmentList) && apartmentList.length > 0)
        ? apartmentList.map(a => normalizeAptName(a))
        : [];
    const totalApartments = apts.length;
    if (totalApartments === 0) {
        showToast("Списъкът с апартаменти не е зареден.", "error");
        return;
    }

    const rawN = perFloorInput ? String(perFloorInput.value || "").trim() : "";
    const perFloor = Number(rawN);
    if (!rawN || !/^\d+$/.test(rawN) || !Number.isInteger(perFloor) || perFloor < 1 || perFloor > totalApartments) {
        const msg = `Броят апартаменти на етаж трябва да бъде положително цяло число между 1 и ${totalApartments}.`;
        showToast(msg, "error");
        if (container && errEl && summaryEl && tbody && warnEl) {
            container.style.display = "block";
            summaryEl.innerHTML = "";
            warnEl.style.display = "none";
            errEl.style.display = "block";
            errEl.textContent = "❌ " + msg;
            tbody.innerHTML = "";
            if (confirmLabel) confirmLabel.style.display = "none";
        }
        return;
    }

    try {
        const idealRes = await apiCall('getBuildingIdealParts', { pin: getStoredPin() });
        throwIfStaleRouteRequestContext(requestContext);
        if (!idealRes || !idealRes.success) {
            showToast(idealRes?.error || "Грешка при зареждане на идеалните части.", "error");
            return;
        }
        _currentIdealParts = idealRes.parts || {};
        const affectedHistoricalPeriods = Array.isArray(idealRes.affectedHistoricalPeriods)
            ? idealRes.affectedHistoricalPeriods
            : [];

        const templateValues = [];
        const invalidTemplateApts = [];
        for (let k = 0; k < perFloor; k++) {
            const aptName = apts[k];
            const parsed = parseStrictPositiveIdealPart_(_currentIdealParts[aptName]);
            if (parsed === null) {
                invalidTemplateApts.push(aptName);
            } else {
                templateValues.push(parsed);
            }
        }

        if (invalidTemplateApts.length > 0) {
            const msg = `Първите ${perFloor} апартамента трябва да имат въведени валидни идеални части (> 0%). Липсват или са невалидни данни за: ${invalidTemplateApts.join(", ")}`;
            showToast(msg, "error");
            if (container && errEl && summaryEl && tbody && warnEl) {
                container.style.display = "block";
                summaryEl.innerHTML = "";
                warnEl.style.display = "none";
                errEl.style.display = "block";
                errEl.textContent = "❌ " + msg;
                tbody.innerHTML = "";
                if (confirmLabel) confirmLabel.style.display = "none";
            }
            return;
        }

        const previewRows = [];
        const generatedParts = {};
        let changedCount = 0;
        const overwrittenApartments = [];
        let totalScaled = 0;

        for (let i = 0; i < totalApartments; i++) {
            const aptName = apts[i];
            const templateIdx = i % perFloor;
            const sourceApt = apts[templateIdx];
            const newVal = templateValues[templateIdx];
            const oldVal = parseStrictPositiveIdealPart_(_currentIdealParts[aptName]);

            generatedParts[aptName] = newVal;
            totalScaled += Math.round(newVal * 10000);

            const isChanged = oldVal === null || Math.abs(oldVal - newVal) > 1e-6;
            const isOverwritten = i >= perFloor && oldVal !== null && Math.abs(oldVal - newVal) > 1e-6;
            if (isChanged) changedCount++;
            if (isOverwritten) {
                overwrittenApartments.push({ apartment: aptName, oldValue: oldVal, newValue: newVal });
            }

            previewRows.push({
                apartment: aptName,
                floor: Math.floor(i / perFloor) + 1,
                sourceApartment: sourceApt,
                isTemplateRow: i < perFloor,
                oldValue: oldVal,
                newValue: newVal,
                changed: isChanged,
                overwritten: isOverwritten
            });
        }

        const totalSum = Math.round(totalScaled) / 10000;
        const deviation = Math.round(totalScaled - 1000000) / 10000;
        const sumValid = Math.abs(deviation) <= 0.0001;
        const devStr = (deviation > 0 ? "+" : "") + deviation.toFixed(2) + "%";
        const historyBlocked = affectedHistoricalPeriods.length > 0 && changedCount > 0;
        const canSave = sumValid && !historyBlocked;

        _currentBulkIdealPreview = {
            apartmentsPerFloor: perFloor,
            totalApartments: totalApartments,
            changedCount: changedCount,
            overwrittenCount: overwrittenApartments.length,
            overwrittenApartments: overwrittenApartments,
            totalSum: totalSum,
            deviation: deviation,
            sumValid: sumValid,
            affectedHistoricalPeriods: affectedHistoricalPeriods,
            canSave: canSave,
            parts: generatedParts,
            previewRows: previewRows
        };

        if (container) container.style.display = "block";
        if (summaryEl) {
            const tplDesc = templateValues.map((v, idx) => `${apts[idx]}: ${v.toFixed(2)}%`).join(", ");
            summaryEl.innerHTML = `
                <div><b>Общо апартаменти във входа:</b> ${totalApartments} | <b>Апартаменти на етаж:</b> ${perFloor}</div>
                <div><b>Шаблон (Етаж 1):</b> ${tplDesc}</div>
                <div><b>Променяни апартаменти:</b> ${changedCount} бр. | <b>Общ сбор на процентите:</b> <span style="font-weight:700; color:${sumValid ? '#2e7d32' : '#c62828'};">${totalSum.toFixed(2)}%</span> (отклонение: <b>${devStr}</b>)</div>
            `;
        }

        if (warnEl) {
            if (overwrittenApartments.length > 0) {
                const sample = overwrittenApartments.slice(0, 12).map(x => `${x.apartment} (${x.oldValue.toFixed(2)}% → ${x.newValue.toFixed(2)}%)`).join(", ");
                const more = overwrittenApartments.length > 12 ? ` и още ${overwrittenApartments.length - 12} ап.` : "";
                warnEl.style.display = "block";
                warnEl.innerHTML = `⚠️ <b>Предупреждение за презаписване:</b> Ще бъдат заменени вече въведени индивидуални стойности за <b>${overwrittenApartments.length}</b> апартамента: ${sample}${more}.`;
            } else {
                warnEl.style.display = "none";
            }
        }

        if (errEl) {
            const errors = [];
            if (!sumValid) {
                errors.push(`Отклонение от изисквания сбор (100.00%): ${devStr} (общ сбор: ${totalSum.toFixed(2)}%). Масовият запис е блокиран — не се извършва автоматична нормализация.`);
            }
            if (historyBlocked) {
                errors.push(`Масовото попълване е блокирано, тъй като вече има начислени задължения, зависещи от идеалните части, в периоди: ${affectedHistoricalPeriods.join(", ")}.`);
            }
            if (errors.length > 0) {
                errEl.style.display = "block";
                errEl.innerHTML = "❌ " + errors.join("<br>❌ ");
                showToast(errors[0], "error");
            } else {
                errEl.style.display = "none";
            }
        }

        if (tbody) {
            tbody.innerHTML = previewRows.map(r => {
                const oldTxt = r.oldValue !== null ? r.oldValue.toFixed(2) + "%" : "—";
                const newTxt = r.newValue.toFixed(2) + "%";
                let statusBadge = "";
                if (r.isTemplateRow) {
                    statusBadge = '<span style="color:#1565c0; font-weight:600;">Шаблон (Етаж 1)</span>';
                } else if (r.overwritten) {
                    statusBadge = '<span style="color:#e65100; font-weight:600;">Презаписване</span>';
                } else if (r.changed) {
                    statusBadge = '<span style="color:#2e7d32; font-weight:600;">Ново попълване</span>';
                } else {
                    statusBadge = '<span style="color:#666;">Без промяна</span>';
                }
                return `<tr style="border-bottom: 1px solid rgba(128,128,128,0.12);">
                    <td style="padding: 5px 8px; font-weight: 600;">${r.apartment}</td>
                    <td style="padding: 5px 8px; color: #555;">Етаж ${r.floor} (= ${r.sourceApartment})</td>
                    <td style="padding: 5px 8px; text-align: right;">${oldTxt}</td>
                    <td style="padding: 5px 8px; text-align: right; font-weight: 600;">${newTxt}</td>
                    <td style="padding: 5px 8px;">${statusBadge}</td>
                </tr>`;
            }).join("");
        }

        if (confirmLabel && chk) {
            confirmLabel.style.display = canSave ? "flex" : "none";
            chk.disabled = !canSave;
            chk.checked = false;
        }
        window.toggleBulkIdealPartsSubmitBtn();
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Сървърна грешка при генериране на прегледа.", "error");
    }
};

window.submitBulkIdealParts = async function () {
    const requestContext = captureRouteRequestContext();
    const chk = document.getElementById("masterIdBulkConfirmCheck");
    const saveBtn = document.getElementById("masterIdBulkSaveBtn");

    if (!_currentBulkIdealPreview || !_currentBulkIdealPreview.canSave) {
        showToast("Масовият запис не може да бъде изпълнен при невалидна конфигурация.", "error");
        return;
    }
    if (!chk || !chk.checked) {
        showToast("Моля, потвърдете изрично масовото попълване преди запис.", "error");
        return;
    }

    const perFloor = _currentBulkIdealPreview.apartmentsPerFloor;
    const origText = saveBtn ? saveBtn.textContent : "Потвърди и запиши масово";
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "Записване...";
    }

    try {
        const result = await apiCall('updateMaster', {
            pin: getStoredPin(),
            sheet: 'ИДЕАЛНИ_ЧАСТИ',
            apartment: 'BULK',
            bulk: 'true',
            apartmentsPerFloor: String(perFloor),
            value: String(perFloor),
            fromPeriod: '01.2000',
            toPeriod: '12.2050',
            confirmed: 'true',
            overwriteConfirmed: 'true'
        });
        throwIfStaleRouteRequestContext(requestContext);

        if (result && result.success) {
            _creditIdealPartsOk = null;
            if (result.parts) _currentIdealParts = result.parts;
            showToast(result.message || "Успешно масово попълване на идеалните части!", "success");
            window.cancelBulkIdealPartsPreview();
            await window.refreshIdealPartsTabState();
            if (typeof checkRemontEligibility === 'function') checkRemontEligibility();
            bgApiCall('forceSync', { pin: getStoredPin() }).then(() => {
                if (!isCurrentRouteRequestContext(requestContext)) return;
                refreshCurrentView();
            }).catch(error => { if (!isStaleRouteRequestError(error)) console.warn('forceSync failed', error); });
        } else {
            showToast(result?.error || "Възникна грешка при масовия запис", "error");
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Сървърна грешка при масовия запис", "error");
    } finally {
        if (isCurrentRouteRequestContext(requestContext) && saveBtn) {
            saveBtn.textContent = origText;
            window.toggleBulkIdealPartsSubmitBtn();
        }
    }
};

window.formatElevatorChipsUiState_ = function (res, selectedPeriod) {
    const parsePeriodSortable = function (p) {
        const m = /^(0[1-9]|1[0-2])\.(20\d{2})$/.exec(String(p || '').trim());
        return m ? (Number(m[2]) * 100 + Number(m[1])) : null;
    };
    const effPeriod = String((res && res.period) || selectedPeriod || '').trim();
    const effInt = parsePeriodSortable(effPeriod);

    if (!res || res.success !== true) {
        return {
            state: 'INACTIVE',
            toggleChecked: false,
            statusText: 'Статус: ИЗКЛЮЧЕНО'
        };
    }

    const activeForPeriod = res.activeForPeriod === true;
    if (activeForPeriod) {
        const since = res.activeSincePeriod || res.effectiveFromPeriod || effPeriod || '-';
        return {
            state: 'ACTIVE_FOR_PERIOD',
            toggleChecked: true,
            statusText: effPeriod
                ? ('Статус: АКТИВНО за период ' + effPeriod + ' (от период ' + since + ')')
                : ('Статус: АКТИВНО (от период ' + since + ')')
        };
    }

    let scheduledPeriod = res.scheduledActivationPeriod || null;
    if (!scheduledPeriod && effInt !== null) {
        const hist = Array.isArray(res.history) && res.history.length > 0
            ? res.history.slice().sort(function (a, b) {
                return (parsePeriodSortable(a && a.effectiveFromPeriod) || 0) - (parsePeriodSortable(b && b.effectiveFromPeriod) || 0);
            })
            : (res.active === true && res.effectiveFromPeriod ? [{ active: true, effectiveFromPeriod: res.effectiveFromPeriod }] : []);
        for (let i = 0; i < hist.length; i++) {
            const hInt = parsePeriodSortable(hist[i] && hist[i].effectiveFromPeriod);
            if (hInt !== null && hInt > effInt && hist[i].active === true) {
                scheduledPeriod = hist[i].effectiveFromPeriod;
                break;
            }
        }
    }

    if (scheduledPeriod) {
        return {
            state: 'SCHEDULED_FUTURE',
            toggleChecked: false,
            scheduledActivationPeriod: scheduledPeriod,
            statusText: 'Статус: ПЛАНИРАНО от бъдещ период ' + scheduledPeriod + (effPeriod ? (' (изключено за ' + effPeriod + ')') : '')
        };
    }

    return {
        state: 'INACTIVE',
        toggleChecked: false,
        statusText: 'Статус: ИЗКЛЮЧЕНО (асансьорът се разпределя по основния метод)'
    };
};

window.loadElevatorChipsConfigUI = async function () {
    const toggle = document.getElementById('masterElevatorChipsToggle');
    const statusEl = document.getElementById('masterElevatorChipsStatus');
    const errEl = document.getElementById('masterElevatorChipsError');
    const fromEl = document.getElementById('masterChFrom');
    if (!toggle) return;
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (statusEl) statusEl.textContent = 'Зареждане на настройката...';
    try {
        const period = fromEl ? String(fromEl.value || '').trim() : '';
        const res = await apiCall('getElevatorChipsConfigV1', { pin: getStoredPin(), period: period });
        const uiState = window.formatElevatorChipsUiState_(res, period);
        toggle.checked = uiState.toggleChecked;
        if (statusEl) {
            statusEl.setAttribute('data-chips-state', uiState.state);
            statusEl.textContent = uiState.statusText;
        }
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Неуспешно зареждане на настройката.';
    }
};

window.saveElevatorChipsConfigUI = async function () {
    const toggle = document.getElementById('masterElevatorChipsToggle');
    const statusEl = document.getElementById('masterElevatorChipsStatus');
    const errEl = document.getElementById('masterElevatorChipsError');
    const saveBtn = document.getElementById('masterElevatorChipsSaveBtn');
    const fromEl = document.getElementById('masterChFrom');
    if (!toggle) return;
    const active = toggle.checked === true;
    const effectiveFromPeriod = fromEl ? String(fromEl.value || '').trim() : '';
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Записване...'; }
    try {
        const res = await apiCall('saveElevatorChipsConfigV1', {
            pin: getStoredPin(),
            request: JSON.stringify({ active: active, effectiveFromPeriod: effectiveFromPeriod })
        });
        if (res && res.success) {
            const uiState = window.formatElevatorChipsUiState_({
                success: true,
                period: effectiveFromPeriod,
                active: res.active,
                activeForPeriod: res.activeForPeriod !== undefined ? res.activeForPeriod : res.active,
                effectiveFromPeriod: res.effectiveFromPeriod || effectiveFromPeriod,
                history: res.history || []
            }, effectiveFromPeriod);
            if (statusEl) {
                statusEl.setAttribute('data-chips-state', uiState.state);
                statusEl.textContent = uiState.statusText;
            }
            showToast(res.message || 'Настройката за чипове е запазена.', 'success');
            bgApiCall('forceSync', { pin: getStoredPin() }).then(() => {
                refreshCurrentView();
            }).catch(() => {});
        } else {
            const msg = (res && res.error) ? res.error : 'Неуспешно запазване на настройката за чипове.';
            if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
            showToast(msg, 'error', 6000);
            toggle.checked = !active;
        }
    } catch (e) {
        const msg = 'Сървърна грешка при запазване на настройката за чипове.';
        if (errEl) { errEl.textContent = msg; errEl.style.display = 'block'; }
        showToast(msg, 'error');
        toggle.checked = !active;
    } finally {
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Запази настройката за чипове'; }
    }
};

window.submitMaster = async function (sheetName) {
    const requestContext = captureRouteRequestContext();
    // В зависимост от подаденото име (Логика, и т.н.) събираме стойностите
    let val, fromP, toP, apt;

    if (sheetName === 'Логика') {
        val = document.getElementById('masterLogikaVal').value;
        fromP = document.getElementById('masterLogikaFrom').value.trim();
        toP = "12.2050"; 
        apt = "";
        if (val === 'Обитатели') {
            try {
                const check = await apiCall('getPeriodOccupants', { period: fromP });
                throwIfStaleRouteRequestContext(requestContext);
                if (check && check.invalidApts && check.invalidApts.length > 0) {
                    showToast("При разпределение по обитатели за всеки апартамент трябва да бъде посочен поне 1 обитател. Коригирайте данните за: Ап. " + check.invalidApts.join(', '), "error");
                    const logikaSelect = document.getElementById('masterLogikaVal');
                    if (logikaSelect) logikaSelect.value = logikaSelect.dataset.prevVal || (check.currentMode || "Равно");
                    return;
                }
            } catch (err) {
                if (isStaleRouteRequestError(err)) return;
            }
        }
    } else if (sheetName === 'УЧАСТИЕ_АСАНСЬОР') {
        apt = document.getElementById('masterUchApt').value;
        val = document.getElementById('masterUchVal').value;
        fromP = document.getElementById('masterUchFrom').value.trim();
        toP = "12.2050";
    } else if (sheetName === 'ОБИТАТЕЛИ') {
        apt = document.getElementById('masterObApt').value;
        val = document.getElementById('masterObVal').value;
        fromP = document.getElementById('masterObFrom').value.trim();
        toP = "12.2050";
        const valNum = Number(val);
        const isInvalid = val === "" || isNaN(valNum) || !Number.isInteger(valNum) || valNum < 1;
        if (isInvalid) {
            try {
                const check = await apiCall('getPeriodOccupants', { period: fromP });
                throwIfStaleRouteRequestContext(requestContext);
                if (check && check.currentMode === 'Обитатели') {
                    showToast("При разпределение по обитатели за всеки апартамент трябва да бъде посочен поне 1 обитател. Коригирайте данните за: Ап. " + apt, "error");
                    return;
                }
            } catch (err) {
                if (isStaleRouteRequestError(err)) return;
            }
        }
    } else if (sheetName === 'ЧИПОВЕ') {
        apt = document.getElementById('masterChApt').value;
        val = document.getElementById('masterChVal').value;
        fromP = document.getElementById('masterChFrom').value.trim();
        toP = "12.2050";
    } else if (sheetName === 'ИДЕАЛНИ_ЧАСТИ') {
        apt = document.getElementById('masterIdApt').value;
        val = document.getElementById('masterIdVal').value;
        fromP = document.getElementById('masterIdFrom').value.trim() || "01.2000";
        toP = "12.2050";
        if (String(val).includes(',')) {
            showToast("Използвайте точка (.) за десетични стойности.", "error");
            return;
        }
        const parsedIdealVal = parseStrictPositiveIdealPart_(val);
        if (parsedIdealVal === null) {
            showToast(`Невалидна стойност за идеални части за ${apt || 'апартамента'}. Въведете положително число между 0.01% и 100.00%.`, "error");
            return;
        }
        val = String(parsedIdealVal);
    }

    if (sheetName === 'PAYMENT_INFO') {
        const pText = document.getElementById('masterPaymentText').value.trim();

        const lElectric = document.getElementById('masterLinkElectric').value.trim();

        if (!pText && !lElectric) {
            showToast("Моля, попълнете поне едно поле!", "error");
            return;
        }

        // Пращаме го като обект, бекендът ще го разпознае
        val = JSON.stringify({
            paymentInfo: pText,
            linkElectric: lElectric
        });

        fromP = "01.2000";
        apt = "global";
    }

    if (sheetName !== 'PAYMENT_INFO' && (!val || !fromP || (sheetName !== 'Логика' && !apt))) {
        showToast("Моля, попълнете задължителните полета!", "error");
        return;
    }

    // Изчистваме и намираме активния бутон, за да му сложим Loading State
    const activeTabObj = document.querySelector(`.master-panel[style*="display: block"] button`);
    const originalText = activeTabObj ? activeTabObj.textContent : "Запиши";
    if (activeTabObj) {
        activeTabObj.disabled = true;
        activeTabObj.textContent = "Записване...";
    }

    try {
        const result = await apiCall('updateMaster', {
            pin: getStoredPin(),
            sheet: sheetName,
            value: val,
            apartment: apt,
            fromPeriod: fromP,
            toPeriod: toP
        });
        throwIfStaleRouteRequestContext(requestContext);

        if (result && result.success) {
            _masterDirtyTab = null;
            showToast(`Успешно обновен регистър: ${sheetName}. Данните се синхронизират...`, "success");
            if (sheetName === 'Логика') {
                const logikaSelect = document.getElementById('masterLogikaVal');
                if (logikaSelect) logikaSelect.dataset.prevVal = val;
            }
            if (sheetName === 'ИДЕАЛНИ_ЧАСТИ') {
                _creditIdealPartsOk = null; // инвалидираме кеша, за да прецени наново дали "Кредит" е достъпен
                if (apt) _currentIdealParts[normalizeAptName(apt)] = parseFloat(val);
                if (typeof window.refreshIdealPartsTabState === 'function') window.refreshIdealPartsTabState();
                if (typeof checkRemontEligibility === 'function') checkRemontEligibility();
                if (result.validationWarning) {
                    showToast(result.validationWarning, "error");
                }
            }
            if (sheetName === 'ОБИТАТЕЛИ') {
                const valInput = document.getElementById('masterObVal');
                if (valInput) valInput.value = "";
            }
            if (sheetName === 'ЧИПОВЕ') {
                const valInput = document.getElementById('masterChVal');
                if (valInput) valInput.value = "";
            }
            bgApiCall('forceSync', { pin: getStoredPin() }).then(() => {
                if (!isCurrentRouteRequestContext(requestContext)) return;
                refreshCurrentView();
            }).catch(error => { if (!isStaleRouteRequestError(error)) console.warn('forceSync failed', error); });
        } else {
            showToast(result?.error || "Възникна грешка", "error");
            if (sheetName === 'Логика') {
                const logikaSelect = document.getElementById('masterLogikaVal');
                if (logikaSelect) logikaSelect.value = logikaSelect.dataset.prevVal || "Равно";
            }
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Сървърна грешка при запис", "error");
        if (sheetName === 'Логика') {
            const logikaSelect = document.getElementById('masterLogikaVal');
            if (logikaSelect) logikaSelect.value = logikaSelect.dataset.prevVal || "Равно";
        }
    } finally {
        if (isCurrentRouteRequestContext(requestContext) && activeTabObj) {
            activeTabObj.disabled = false;
            activeTabObj.textContent = originalText;
        }
    }
}

window.loadApartmentMasterSummary = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("masterInfoApt").value;
    const container = document.getElementById("aptMasterSummary");
    if (!apt) {
        container.innerHTML = '<p style="color:#666; font-style:italic;">Изберете апартамент...</p>';
        return;
    }

    container.innerHTML = "⌛ Зареждане на информация...";

    try {
        const res = await apiCall('getApartmentMasterSummary', { apartment: apt, pin: getStoredPin() });
        throwIfStaleRouteRequestContext(requestContext);
        if (res && res.success) {
            const d = res.data;
            const a51 = d.art51;
            let art51Line = '<li><b>🏢 Обществен достъп (чл. 51):</b> <span style="color:#64748b;">❌ НЕ</span></li>';
            if (a51 && a51.active) {
                const mult = a51.multiplier || 3;
                const eff = a51.effectiveFromPeriod ? ` (в сила от ${a51.effectiveFromPeriod})` : '';
                const dec = (a51.decisionReference || a51.decisionDate)
                    ? `<br><small style="color:#64748b; font-weight:normal;">Решение: ${[a51.decisionReference, a51.decisionDate].filter(Boolean).join(' / ')}</small>`
                    : '';
                art51Line = `<li><b>🏢 Обществен достъп (чл. 51):</b> <span style="color:#2563eb; font-weight:700;">✅ ДА (${mult}×)</span>${eff}${dec}</li>`;
            }
            container.innerHTML = `
                <div style="background:rgba(0,122,255,0.05); padding:15px; border-radius:8px; border-left:4px solid var(--primary);">
                    <h4 style="margin-bottom:10px;">📊 Статус за Апт. ${apt}</h4>
                    <ul style="list-style:none; padding:0; display:flex; flex-direction:column; gap:6px;">
                        <li><b>👥 Обитатели:</b> ${d.occupants || 0} бр.</li>
                        <li><b>🔑 Чипове:</b> ${d.chips || 0} бр.</li>
                        <li><b>🔘 Уч. асансьор:</b> ${d.participation === 'Да' ? '✅ Да' : '❌ Не'}</li>
                        <li><b>📐 Идеални части:</b> ${d.idealParts || 0}%</li>
                        ${art51Line}
                    </ul>
                    <p style="font-size:11px; color:#666; margin-top:10px;">* Посочените данни са от действащите MASTER и ЗУЕС (чл. 51) регистри и се използват за следващите начисления.</p>
                </div>
            `;

            // Show notice editor
            const editor = document.getElementById("aptNoticeEditor");
            const input = document.getElementById("masterAptNoticeVal");
            if (editor && input) {
                editor.style.display = "block";
                input.value = d.notice || "";
            }
        } else {
            container.innerHTML = '<p style="color:red;">Грешка при зареждане на данните.</p>';
            const editor = document.getElementById("aptNoticeEditor");
            if (editor) editor.style.display = "none";
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        container.innerHTML = '<p style="color:red;">Сървърна грешка.</p>';
        const editor = document.getElementById("aptNoticeEditor");
        if (editor) editor.style.display = "none";
    }
}

window.submitAptNotice = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("masterInfoApt").value;
    const notice = document.getElementById("masterAptNoticeVal").value.trim();
    if (!apt) return;

    showLoading();
    const result = await apiCall('updateMaster', {
        pin: getStoredPin(),
        sheet: 'PAYMENT_INFO',
        apartment: apt,
        value: JSON.stringify({ ['notice_' + normalizeAptName(apt)]: notice })
    });
    throwIfStaleRouteRequestContext(requestContext);
    hideLoading();

    if (result && result.success) {
        showToast("Персоналното съобщение е запазено!", "success");
        refreshCurrentView();
    } else {
        showToast(result?.error || "Грешка при запис", "error");
    }
}

// ==============================================
// SUPER ADMIN LOGIC 
// ==============================================

window.openSuperAdmin = function () {
    console.log("Opening Super Admin Overlay...");
    document.getElementById("superAdminOverlay").style.display = "flex";
    if (sessionStorage.getItem("superAdminAuth")) {
        showSuperAdminDashboard();
    } else {
        document.getElementById("superAdminLoginCard").style.display = "block";
        document.getElementById("superAdminDashboard").style.display = "none";
        document.getElementById("superPinInput").value = "";
        document.getElementById("superPinInput").focus();
    }
}

window.closeSuperAdmin = function () {
    document.getElementById("superAdminOverlay").style.display = "none";
}

window.loginSuperAdmin = async function () {
    const pin = document.getElementById("superPinInput").value.trim();
    if (!pin) {
        document.getElementById("superPinError").textContent = "Въведете парола!";
        return;
    }

    // ПИН кодът се проверява централно през специалния endpoint verifySuperPin
    const result = await apiCall('verifySuperPin', { pin: pin });

    if (result && result.success) {
        sessionStorage.setItem("superAdminAuth", pin);
        showSuperAdminDashboard();
    } else {
        document.getElementById("superPinError").textContent = result.error || "Грешна парола за Супер Админ.";
    }
}

async function showSuperAdminDashboard() {
    const requestContext = captureRouteRequestContext();
    console.log("Loading Super Admin Dashboard...");
    document.getElementById("superAdminLoginCard").style.display = "none";
    document.getElementById("superAdminDashboard").style.display = "block";

    try {
        const res = await apiCall('getSuperSettings');
        throwIfStaleRouteRequestContext(requestContext);
        if (res && res.success) {
            const setVal = (id, val) => {
                const el = document.getElementById(id);
                if (el) el.value = val || "";
            };
            setVal("superPaymentOptions", res.paymentOptions);
            setVal("priceBigCities", res.priceBigCities);
            setVal("priceOtherCities", res.priceOtherCities);
            setVal("priceLifetime", res.priceLifetime);
            setVal("superGlobalMessage", res.globalMessage);
            setVal("superShowRegForm", res.showRegForm || "true");
            setVal("superRegFormText", res.regFormText);
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error("Error loading super settings:", e);
    }

    loadSuperAdminEntrances();
    loadSuperExceptions();
}

window.saveSuperSettings = async function () {
    const requestContext = captureRouteRequestContext();
    const btn = document.getElementById("saveSuperSettingsBtn");
    showSaving(btn, "Запазване...");

    try {
        const getVal = (id) => {
            const el = document.getElementById(id);
            return el ? el.value.trim() : "";
        };

        const reqData = {
            paymentOptions: getVal("superPaymentOptions"),
            priceBigCities: getVal("priceBigCities"),
            priceOtherCities: getVal("priceOtherCities"),
            priceLifetime: getVal("priceLifetime"),
            showRegForm: document.getElementById("superShowRegForm").value === "true",
            regFormText: getVal("superRegFormText")
        };

        const result = await apiCall('updateSuperSettings', {
            pin: sessionStorage.getItem("superAdminAuth"),
            settings: JSON.stringify(reqData)
        });
        throwIfStaleRouteRequestContext(requestContext);

        if (result && result.success) {
            showToast("✅ Настройките са запазени успешно!", "success");
        } else {
            showToast(result.error || "Грешка при запазване", "error");
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        showToast("Възникна грешка при запазване", "error");
    } finally {
        if (isCurrentRouteRequestContext(requestContext)) hideSaving(btn, "Запази настройките");
    }
}

window.submitMasterNotice = async function () {
    const requestContext = captureRouteRequestContext();
    const notice = document.getElementById("masterEntranceNotice").value.trim();
    showLoading();

    const result = await apiCall('updateMaster', {
        pin: getStoredPin(),
        sheet: 'PAYMENT_INFO', // Reuse config logic
        value: JSON.stringify({ entranceNotice: notice })
    });
    throwIfStaleRouteRequestContext(requestContext);

    hideLoading();

    if (result && result.success) {
        showToast("Съобщението е запазено!", "success");
        // Update local displays
        const banners = ["userEntranceNotice", "userEntranceNoticeHome"];
        const texts = ["userEntranceNoticeText", "userEntranceNoticeTextHome"];

        if (notice !== "") {
            const formatted = notice.replace(/\n/g, '<br>');
            banners.forEach(bId => {
                const b = document.getElementById(bId);
                if (b) b.style.display = "block";
            });
            texts.forEach(tId => {
                const t = document.getElementById(tId);
                if (t) t.innerHTML = formatted;
            });

            // Изпращаме имейл до всички живущи с регистриран имейл
            if (notice !== "") {
                apiCall('sendNoticeEmail', { pin: getStoredPin(), notice: notice })
                    .then(emailResult => {
                        if (!isCurrentRouteRequestContext(requestContext)) return;
                        if (emailResult && emailResult.success) {
                            showToast(`📧 Имейлът е изпратен до ${emailResult.sent || 0} апартамента.`, "success");
                        }
                    })
                    .catch(error => { if (!isStaleRouteRequestError(error)) console.warn('notice email failed', error); });
            }
        } else {
            banners.forEach(bId => {
                const b = document.getElementById(bId);
                if (b) b.style.display = "none";
            });
        }
    } else {
        showToast(result?.error || "Грешка при запис", "error");
    }
}

// Изпращане на индивидуален имейл до конкретен апартамент
window.sendAptEmail = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("emailAptTarget").value;
    const subject = document.getElementById("emailAptSubject").value.trim();
    const body = document.getElementById("emailAptBody").value.trim();

    if (!apt) { showToast("Изберете апартамент!", "error"); return; }
    if (!subject) { showToast("Попълнете тема на имейла!", "error"); return; }
    if (!body) { showToast("Попълнете текст на имейла!", "error"); return; }

    showLoading();
    const result = await apiCall('sendAptEmail', {
        pin: getStoredPin(),
        apartment: apt,
        subject: subject,
        body: body
    });
    throwIfStaleRouteRequestContext(requestContext);
    hideLoading();

    if (result && result.success) {
        showToast("✅ Имейлът е изпратен успешно!", "success");
        document.getElementById("emailAptSubject").value = "";
        document.getElementById("emailAptBody").value = "";
    } else {
        showToast(result?.error || "Грешка при изпращане", "error");
    }
}

window.saveGlobalMessage = async function () {
    const requestContext = captureRouteRequestContext();
    const btn = document.getElementById("saveGlobalMessageBtn");
    const msg = document.getElementById("superGlobalMessage").value.trim();

    showSaving(btn, "Изпращане...");

    try {
        const result = await apiCall('updateGlobalMessage', {
            pin: sessionStorage.getItem("superAdminAuth"),
            message: msg
        });
        throwIfStaleRouteRequestContext(requestContext);

        if (result && result.success) {
            showToast("✅ Съобщението е изпратено до всички!", "success");
        } else {
            showToast(result.error || "Грешка при изпращане", "error");
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Проблем при комуникация със сървъра", "error");
    } finally {
        if (isCurrentRouteRequestContext(requestContext)) hideSaving(btn, "Изпрати съобщение");
    }
}

async function loadSuperAdminEntrances() {
    const tbody = document.getElementById("superAdminEntrancesList");
    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Зареждане...</td></tr>';

    const result = await apiCall('getRegistryList');
    if (result && result.success && Array.isArray(result.registry)) {
        tbody.innerHTML = '';
        const select = document.getElementById("superExceptionRegistry");
        if (select) select.innerHTML = '<option value="">-- Избери вход --</option>';

        result.registry.forEach(ent => {
            if (select) select.appendChild(new Option(ent.name + " (" + ent.id + ")", ent.id));
            const st = ent.subscriptionStatus || (ent.validUntil === '2000-01-01' ? 'HARD_BLOCKED' : 'PAID_ACTIVE');
            const stColor = st === 'HARD_BLOCKED' ? '#fa5252' : (st === 'TRIAL_ADMIN_GRACE' || st === 'PAID_GRACE_7D' ? '#f59e0b' : '#4ade80');
            const stLabelMap = {
                TRIAL_FULL: 'Пробен (1–30)',
                TRIAL_ADMIN_GRACE: 'Гратис (31–90)',
                PAID_ACTIVE: 'Активен',
                PAID_GRACE_7D: 'Гратис (7 дн.)',
                HARD_BLOCKED: 'Спрян',
                LIFETIME: 'Безсрочен'
            };
            const stLabel = stLabelMap[st] || st;
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td style="padding: 8px;"><b>${ent.name}</b></td>
                <td style="padding: 8px; font-family: monospace;">${ent.id}</td>
                <td style="padding: 8px; color: ${st === 'HARD_BLOCKED' ? 'red' : 'inherit'};">
                    ${ent.validUntil === '2000-01-01' ? 'Блокиран' : (ent.validUntil || '---')}
                </td>
                <td style="padding: 8px;">
                    <span class="status-badge" style="background:${stColor}; color:white; padding: 2px 6px; border-radius: 4px; font-size: 11px;">
                        ${stLabel}
                    </span>
                </td>
                <td style="padding: 8px;">
                    <button class="admin-btn secondary small" onclick="manageSub('${ent.id}', 'unblock')" style="padding:4px 8px; font-size:11px; margin-right:4px;">+30 дн.</button>
                    <button class="admin-btn small" onclick="manageSub('${ent.id}', 'block')" style="background:#fa5252; color:white; padding:4px 8px; font-size:11px; margin-right:4px;">Спри</button>
                    <button class="admin-btn small" onclick="manageSub('${ent.id}', 'lifetime')" style="background:#4ade80; color:white; padding:4px 8px; font-size:11px;">Безсрочен</button>
                    <button class="admin-btn small" onclick="deleteFirebaseData('${ent.id}', this)" style="background:#000; color:white; padding:4px 8px; font-size:11px; margin-left:4px;" title="Изтрий всички данни за входа от Firestore">🗑️ FS</button>
                </td>
            `;
            tbody.appendChild(tr);
        });
    } else {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Грешка при зареждане.</td></tr>';
    }
}

window.manageSub = async function (targetId, subAction) {
    if (!confirm(`Сигурни ли сте, че искате да промените достъпа на ID: ${targetId}?`)) return;

    const result = await apiCall('updateSubscription', {
        superPin: sessionStorage.getItem("superAdminAuth"),
        targetId: targetId,
        subAction: subAction
    });

    if (result && result.success) {
        showToast("Правата са обновени успешно!", "success");
        loadSuperAdminEntrances();
    } else {
        showToast(result?.error || "Грешка при обновяване", "error");
    }
}


window.deleteFirebaseData = async function(buildingId, btn) {
    if(!confirm("⚠️ ВНИМАНИЕ!\nСигурни ли сте, че искате да ИЗТРИЕТЕ ВСИЧКИ ДАННИ за вход " + buildingId + " от Firestore?\nТова действие не може да бъде отменено!")) return;
    
    const rawPin = prompt("Моля, въведете паролата за Супер Админ, за да потвърдите изтриването:");
    if (!rawPin || rawPin.trim() !== sessionStorage.getItem("superAdminAuth")) {
        showToast("Грешна парола! Действието е прекратено.", "error");
        return;
    }

    const oldText = btn.innerHTML;
    btn.innerHTML = "⏳ Изтриване...";
    btn.disabled = true;

    try {
        const backendRes = await apiCall('deleteClient', {
            superPin: rawPin.trim(),
            targetId: buildingId
        });

        if (backendRes && backendRes.success && !backendRes.partial && !backendRes.recoveryRequired) {
            showToast("✅ Входът, Firestore данните и таблиците са проверено заличени.", "success");
            loadSuperAdminEntrances(); // Refresh list
        } else if (backendRes && (backendRes.partial || backendRes.recoveryRequired)) {
            showToast("⚠️ Изтриването е частично. Не повтаряйте действието на сляпо. " + (backendRes.warning || backendRes.error || "Необходима е контролирана проверка."), "warning", 9000);
        } else {
            showToast(backendRes?.error || "Изтриването не е завършено; ресурсите не са обявени за заличени.", "error");
        }
    } catch(e) {
        console.error(e);
        showToast("Грешка при изтриване: " + e.message, "error");
    } finally {
        if(btn) {
            btn.innerHTML = oldText;
            btn.disabled = false;
        }
    }
}
window.submitNewClient = async function () {
    const city = document.getElementById("newCity").value.trim();
    const block = document.getElementById("newBlock").value.trim();
    const entrance = document.getElementById("newEntrance").value.trim();
    const email = document.getElementById("newAdminEmail").value.trim();
    const aptCountInput = document.getElementById("newAptCount");
    const aptCount = aptCountInput.value.trim();

    if (!city || !block || !entrance || !email) {
        showToast("Моля, попълнете всички полета", "error");
        return;
    }

    if (!aptCount || !aptCountInput.checkValidity()) {
        showToast("Броят апартаменти трябва да е цяло положително число.", "error");
        aptCountInput.reportValidity();
        aptCountInput.focus();
        return;
    }

    const btn = document.getElementById("createClientBtn");
    btn.textContent = "Генериране (Изчакайте до 15 сек)...";

    const result = await apiCall('createClient', {
        superPin: sessionStorage.getItem("superAdminAuth"),
        city: city,
        block: block,
        entrance: entrance,
        adminEmail: email,
        apartmentsCount: aptCount
    });

    btn.textContent = "Създай Клиент & Генерирай Таблици";

    if (result && result.success) {
        const isPartial = result.partial === true || result.retryUnsafe === true;
        if (isPartial) {
            const warning = String(result.warning || "Firestore синхронизацията е непълна.").replace(/[<>]/g, "").slice(0, 600);
            showToast("⚠️ Входът и таблиците са създадени, но операцията е частична. Не създавайте входа повторно. " + warning + " Използвайте контролирана синхронизация за ID: " + String(result.routeKey || "").replace(/[<>]/g, ""), "warning", 10000);
        } else {
            showToast("✅ Клиентът е създаден успешно! Имейлът е изпратен.", "success");
        }
        document.getElementById("newCity").value = "";
        document.getElementById("newBlock").value = "";
        document.getElementById("newEntrance").value = "";
        document.getElementById("newAdminEmail").value = "";
        document.getElementById("newAptCount").value = "";

        // Refresh dropdowns if necessary by refreshing page
        if (!isPartial) setTimeout(() => location.reload(), 3000);
    } else {
        showToast(result?.error || "Грешка при създаване", "error");
    }
}

window.runSystemBackup = async function () {
    const btn = document.getElementById("runBackupBtn");
    const statusDiv = document.getElementById("backupStatus");
    const linkA = document.getElementById("backupFolderLink");

    btn.disabled = true;
    btn.textContent = "Архивиране (Моля, изчакайте)...";
    statusDiv.style.display = "block";
    statusDiv.innerHTML = "⏳ Обикаляне на всички входове и копиране на таблици...";
    statusDiv.style.color = "#666";

    const result = await apiCall('runBackup', {
        superPin: sessionStorage.getItem("superAdminAuth")
    });

    btn.disabled = false;
    btn.textContent = "📦 Създай Ръчен Архив Сега";

    if (result && result.success) {
        statusDiv.innerHTML = "✅ " + result.message;
        statusDiv.style.color = "green";
        if (result.folderUrl) {
            linkA.href = result.folderUrl;
            // Показваме и временен линк директно в статуса за удобство
            statusDiv.innerHTML += `<br><a href="${result.folderUrl}" target="_blank" style="color:var(--primary); font-weight:bold;">Виж новия архив тук ➔</a>`;
        }
    } else {
        statusDiv.innerHTML = "❌ Грешка: " + (result?.error || "Проблем при архивиране");
        statusDiv.style.color = "red";
    }
}

async function loadSuperExceptions() {
    const list = document.getElementById("superAdminExceptionsList");
    if (!list) return;
    list.innerHTML = '<tr><td colspan="4" style="text-align:center;">Зареждане...</td></tr>';

    const result = await apiCall('getSuperExceptions', {
        superPin: sessionStorage.getItem("superAdminAuth")
    });

    if (result && result.success && Array.isArray(result.exceptions)) {
        list.innerHTML = "";
        result.exceptions.forEach(ex => {
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td style="padding:6px;">${ex.targetId}</td>
                <td style="padding:6px;">${ex.price} EUR</td>
                <td style="padding:6px;">${ex.validUntil}</td>
                <td style="padding:6px;"><button class="delete-super-exception" style="color:red; background:none; border:none; cursor:pointer; font-size:14px;">✕</button></td>
            `;
            tr.querySelector('.delete-super-exception').addEventListener('click', () => deleteSuperException(ex.rowIdx, ex.targetId, ex.exceptionId));
            list.appendChild(tr);
        });
    } else {
        list.innerHTML = '<tr><td colspan="4" style="text-align:center; padding:10px; color:#999;">Няма активни изключения.</td></tr>';
    }
}

window.addSuperException = async function () {
    const targetId = document.getElementById("superExceptionRegistry").value;
    const price = document.getElementById("superExceptionPrice").value.trim();
    const validUntil = document.getElementById("superExceptionDate").value;

    if (!targetId || price === "") {
        showToast("Изберете вход и ценова стойност!", "error");
        return;
    }

    const res = await apiCall('addSuperException', {
        superPin: sessionStorage.getItem("superAdminAuth"),
        targetId: targetId,
        apartment: "ALL", // изключенията вече важат само за целия вход, не за отделен апартамент
        price: price,
        validUntil: validUntil || "2099-12-31"
    });

    if (res && res.success) {
        showToast("Специалната цена е добавена!", "success");
        document.getElementById("superExceptionPrice").value = "";
        loadSuperExceptions();
    } else {
        showToast(res?.error || "Възникна грешка", "error");
    }
}

window.deleteSuperException = async function (rowIdx, expectedTargetId, expectedExceptionId) {
    if (!confirm("Сигурни ли сте, че искате да премахнете това изключение?")) return;
    const res = await apiCall('deleteSuperException', {
        superPin: sessionStorage.getItem("superAdminAuth"),
        rowIdx: rowIdx,
        expectedTargetId: expectedTargetId,
        expectedExceptionId: expectedExceptionId
    });
    if (res && res.success) {
        showToast("Изключението е премахнато", "success");
        loadSuperExceptions();
    } else {
        showToast("Грешка при изтриване", "error");
    }
}

// ==============================================
// ⚖️ ЗУЕС МЕНИДЖЪР ЛОГИКА
// ==============================================

window.switchZuesSubTab = function (subId) {
    document.querySelectorAll(".zues-sub-panel").forEach(p => p.style.display = "none");
    const target = document.getElementById("zub-" + subId);
    if (target) target.style.display = "block";

    document.querySelectorAll(".zues-sub-btn").forEach(btn => {
        btn.classList.remove("active");
        btn.setAttribute("aria-selected", "false");
        btn.setAttribute("aria-expanded", "false");
    });
    const activeBtn = document.getElementById("zues-btn-" + subId);
    if (activeBtn) {
        activeBtn.classList.add("active");
        activeBtn.setAttribute("aria-selected", "true");
        activeBtn.setAttribute("aria-expanded", "true");
    }

    if (subId === 'z-meeting') {
        populateAttendanceTable();
    }
    if (subId === 'z-fullbook') {
        loadFullBook();
    }
}

// ==============================================
// 📋 ЦЯЛА ДОМОВА КНИГА
// ==============================================

let _fullBookData = []; // кеш за търсене

window.loadFullBook = async function () {
    const requestContext = captureRouteRequestContext();
    const tbody = document.getElementById("fullBookBody");
    const status = document.getElementById("fullBookStatus");
    tbody.innerHTML = '<tr><td colspan="7" style="padding:20px; text-align:center; color:#aaa;">⏳ Зареждане...</td></tr>';
    if (status) status.textContent = "";

    const result = await apiCall('getFullBook', { pin: getStoredPin() });
    throwIfStaleRouteRequestContext(requestContext);

    if (!result || !result.success) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:20px; text-align:center; color:red;">❌ Грешка при зареждане</td></tr>';
        return;
    }

    _fullBookData = result.rows || [];
    renderBookTable(_fullBookData);

    if (status) {
        const filled = _fullBookData.filter(r => r["Собственик"] && r["Собственик"].trim() !== "").length;
        status.textContent = `Общо: ${_fullBookData.length} апартамента | Попълнени: ${filled} | Непопълнени: ${_fullBookData.length - filled}`;
    }
}

function renderBookTable(rows) {
    const tbody = document.getElementById("fullBookBody");
    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="padding:20px; text-align:center; color:#aaa;">Няма данни в книгата.</td></tr>';
        return;
    }

    tbody.innerHTML = rows.map((r, idx) => {
        const hasMissing = !r["Собственик"] || r["Собственик"].trim() === "";
        const bg = hasMissing ? "background:#fffbf0;" : (idx % 2 === 0 ? "" : "background:#fafbfd;");
        const missingMark = hasMissing ? ' <span style="color:#e67e22; font-size:11px;">⚠️</span>' : '';

        return `<tr style="${bg} cursor:pointer;" onclick="switchZuesSubTab('z-book'); document.getElementById('masterBookApt').value='${r["Апартамент"] || ""}'; loadBookData();">
            <td style="padding:9px 12px; font-weight:700; color:#3b6edc;">${r["Апартамент"] || "—"}${missingMark}</td>
            <td style="padding:9px 12px;">${r["Собственик"] || '<span style="color:#ccc;">непопълнено</span>'}</td>
            <td style="padding:9px 12px; font-size:12px;">${r["Имейл"] || '—'}</td>
            <td style="padding:9px 12px; font-size:12px;">${r["Обитатели"] || '—'}</td>
            <td style="padding:9px 12px; font-size:12px;">${r["Предназначение"] || '—'}</td>
            <td style="padding:9px 12px; font-size:12px;">${r["Дата вписване"] || '—'}</td>
            <td style="padding:9px 12px; font-size:12px;">${r["Домашни любимци"] || '—'}</td>
        </tr>`;
    }).join('');
}

window.filterBookTable = function () {
    const q = (document.getElementById("bookSearchInput").value || "").toLowerCase();
    if (!q) {
        renderBookTable(_fullBookData);
        return;
    }
    const filtered = _fullBookData.filter(r =>
        Object.values(r).some(v => String(v).toLowerCase().includes(q))
    );
    renderBookTable(filtered);
    const status = document.getElementById("fullBookStatus");
    if (status) status.textContent = `Намерени: ${filtered.length} от ${_fullBookData.length} апартамента`;
}

window.printFullBook = function () {
    if (!_fullBookData || _fullBookData.length === 0) {
        showToast("Заредете книгата преди печат!", "error");
        return;
    }

    const rows = _fullBookData.map((r, idx) => `
        <tr style="${idx % 2 === 0 ? '' : 'background:#f9f9f9;'}">
            <td style="padding:6px 8px; border:1px solid #ddd; font-weight:600;">${r["Апартамент"] || "—"}</td>
            <td style="padding:6px 8px; border:1px solid #ddd;">${r["Собственик"] || "—"}</td>
            <td style="padding:6px 8px; border:1px solid #ddd; font-size:11px;">${r["Имейл"] || "—"}</td>
            <td style="padding:6px 8px; border:1px solid #ddd;">${r["Обитатели"] || "—"}</td>
            <td style="padding:6px 8px; border:1px solid #ddd;">${r["Предназначение"] || "—"}</td>
            <td style="padding:6px 8px; border:1px solid #ddd;">${r["Дата вписване"] || "—"}</td>
            <td style="padding:6px 8px; border:1px solid #ddd;">${r["Домашни любимци"] || "—"}</td>
        </tr>`).join('');

    const html = `<!DOCTYPE html><html><head>
        <meta charset="UTF-8">
        <title>Домова книга — Чл. 7 от ЗУЕС</title>
        <style>
            body { font-family: Arial, sans-serif; font-size: 13px; padding: 30px; color: #222; }
            h2 { text-align: center; margin-bottom: 4px; }
            p.subtitle { text-align: center; font-size: 12px; color: #666; margin-bottom: 20px; }
            table { width: 100%; border-collapse: collapse; }
            th { background: #1a1a2e; color: white; padding: 8px; border: 1px solid #333; font-size: 12px; }
            @media print { button { display: none; } }
        </style>
    </head><body>
        <h2>📋 ДОМОВА КНИГА — Книга на етажната собственост (Чл. 7 от ЗУЕС)</h2>
        <p class="subtitle">Дата на извличане: ${new Date().toLocaleDateString('bg-BG')} г. | Общо апартаменти: ${_fullBookData.length}</p>
        <table>
            <thead><tr>
                <th>Апт.</th><th>Собственик/ци</th><th>Имейл</th>
                <th>Обитатели</th><th>Предназн.</th><th>Дата вписване</th><th>Домашни</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table>
        <div style="margin-top:30px; font-size:11px; color:#888; text-align:right;">
            Управлявано от системата за управление на ЕС
        </div>
        <br><button onclick="window.print()" style="padding:8px 20px; background:#1a1a2e; color:white; border:none; border-radius:6px; cursor:pointer; font-size:13px;">🖨️ Печат</button>
    </body></html>`;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
}

window.populateAttendanceTable = async function () {
    const requestContext = captureRouteRequestContext();
    const list = document.getElementById("meeting-attendance-list");
    if (!list) return;
    list.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:15px; color:#666;">⏳ Зареждане на данни...</td></tr>';

    try {
        const result = await apiCall('getBuildingIdealParts', { pin: getStoredPin() });
        throwIfStaleRouteRequestContext(requestContext);
        _currentIdealParts = (result && result.success) ? result.parts : {};

        list.innerHTML = "";
        apartmentList.forEach(apt => {
            const tr = document.createElement("tr");
            tr.style.borderBottom = "1px solid #eee";

            const normApt = normalizeAptName(apt);
            const percent = _currentIdealParts[normApt] !== undefined ? parseFloat(_currentIdealParts[normApt]) : 0;

            tr.innerHTML = `
                <td style="padding:6px;">${apt}</td>
                <td style="padding:6px; text-align:center;">
                    <input type="checkbox" class="quorum-check" data-apt="${apt}" data-percent="${percent}" onchange="calculateQuorum()">
                </td>
                <td style="padding:6px; text-align:right;">${percent.toFixed(2)}%</td>
            `;
            list.appendChild(tr);
        });
        calculateQuorum();
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        list.innerHTML = '<tr><td colspan="3" style="text-align:center; color:red; padding:10px;">Грешка при зареждане на идеалните части.</td></tr>';
    }
}

window.calculateQuorum = function () {
    let total = 0;
    document.querySelectorAll(".quorum-check:checked").forEach(chk => {
        total += parseFloat(chk.dataset.percent);
    });

    const p = document.getElementById("quorum-percent");
    const s = document.getElementById("quorum-status");
    if (p) p.innerText = total.toFixed(2) + "%";

    const decisionType = document.getElementById("meetingDecisionType") ? document.getElementById("meetingDecisionType").value : "50_plus";

    let required = 50.0001;
    let reqText = ">50%";
    if (decisionType === "100") { required = 100; reqText = "100%"; }
    else if (decisionType === "75_violator" || decisionType === "75") { required = 75; reqText = "75%"; }
    else if (decisionType === "67") { required = 67; reqText = "67%"; }
    else if (decisionType === "51") { required = 51; reqText = "51%"; }

    if (s) {
        let meetingStatus = "";
        let meetColor = "";
        if (total >= 51) {
            meetingStatus = "✅ Старт: Редовен (има 51%)";
            meetColor = "green";
        } else if (total >= 26) {
            meetingStatus = "🔶 Старт: След 1 час (има 26%)";
            meetColor = "orange";
        } else if (total > 0) {
            meetingStatus = "⚠️ Старт: На следващия ден";
            meetColor = "#d28e00";
        } else {
            meetingStatus = "❌ Няма кворум за старт";
            meetColor = "red";
        }

        let decisionStatus = "";
        let decColor = "";
        if (total >= required) {
            decisionStatus = `✅ Решение: Може да се приеме (≥${reqText})`;
            decColor = "green";
        } else {
            decisionStatus = `❌ Решение: Не стига кворум (нужни ${reqText})`;
            decColor = "red";
        }

        s.innerHTML = `<div style="color:${meetColor}; margin-bottom:4px;">${meetingStatus}</div><div style="color:${decColor};">${decisionStatus}</div>`;
    }
}

window.printAttendanceList = function () {
    const agenda = document.getElementById("meetingAgenda").value || "Генерален дневен ред";
    const now = new Date();

    let html = `
        <div style="font-family: Arial, sans-serif; padding: 40px; line-height: 1.6;">
            <h2 style="text-align:center;">ПРИСЪСТВЕН СПИСЪК</h2>
            <p style="text-align:center;">на собствениците/обитателите в етажна собственост</p>
            <p><strong>Дата:</strong> ${now.toLocaleDateString('bg-BG')} г.</p>
            <p><strong>Дневен ред:</strong> ${agenda}</p>
            <table border="1" style="width:100%; border-collapse: collapse; margin-top:20px;">
                <thead>
                    <tr style="background:#eee;">
                        <th style="padding:8px;">Апт.</th>
                        <th style="padding:8px;">Представени Ид.части %</th>
                        <th style="padding:8px;">Име на присъстващия / Пълномощник</th>
                        <th style="padding:8px;">Подпис</th>
                    </tr>
                </thead>
                <tbody>
    `;

    apartmentList.forEach(apt => {
        const normApt = normalizeAptName(apt);
        const percent = _currentIdealParts[normApt] !== undefined ? parseFloat(_currentIdealParts[normApt]) : 0;

        html += `
            <tr>
                <td style="padding:10px;">${apt}</td>
                <td style="padding:10px; text-align:center;">${percent.toFixed(2)}%</td>
                <td style="padding:10px;"></td>
                <td style="padding:10px; height: 30px;"></td>
            </tr>
        `;
    });

    html += `
                </tbody>
            </table>
            <div style="margin-top:30px;">
                <p>Председател на събранието: ____________________</p>
                <p>Протоколчик: ____________________</p>
            </div>
        </div>
    `;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.print();
}

window.generateMeetingMinutes = function () {
    const agenda = document.getElementById("meetingAgenda").value || "Генерален дневен ред";
    const quorum = document.getElementById("quorum-percent").innerText;
    const now = new Date();

    let html = `
        <div style="font-family: Times New Roman, serif; padding: 50px; line-height: 1.5; color: #000;">
            <h2 style="text-align:center; text-decoration: underline;">ПРОТОКОЛ №____</h2>
            <h3 style="text-align:center;">от Общо събрание на собствениците</h3>
            <p>Днес, ${now.toLocaleDateString('bg-BG')} г., се проведе общо събрание на етажната собственост.</p>
            <p><strong>Представени идеални части:</strong> ${quorum}</p>
            <p><strong>Дневен ред:</strong></p>
            <p>${agenda}</p>
            <hr>
            <p><strong>ХОД НА СЪБРАНИЕТО И ПРИЕТИ РЕШЕНИЯ:</strong></p>
            <div style="min-height: 300px; border: 1px dashed #ccc; padding: 10px;">
                <em>[Тук опишете дискусиите и гласуванията за всяка точка...]</em>
            </div>
            <p style="margin-top:40px;">Протоколът е съставен съгласно Чл. 16 от ЗУЕС.</p>
            <div style="display:flex; justify-content: space-between; margin-top:50px;">
                <div>Председател: ......................</div>
                <div>Протоколчик: ......................</div>
            </div>
        </div>
    `;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
}

window.printOwnerDeclaration = async function () {
    const requestContext = captureRouteRequestContext();
    const apt = document.getElementById("docAptSelect").value;
    if (!apt) {
        showToast("Моля, изберете апартамент", "warning");
        return;
    }

    // Зареждаме данните от Книгата (ако са налични)
    const result = await apiCall('getBookData', { apartment: apt });
    throwIfStaleRouteRequestContext(requestContext);
    const data = result?.data || {};

    const ownerName = data.Owner || '';
    const occupants = data.Occupants || '';
    const purpose = data.Purpose || '';
    const pets = data.Pets || '';
    const idealParts = data.IdealParts || '';

    let html = `
        <div style="font-family: Arial, sans-serif; padding: 30px; max-width: 900px; margin: auto; line-height: 1.4; font-size: 12px; color: #000;">
            <p style="text-align:center; font-weight: bold; margin-top: 0; margin-bottom: 20px;">
                ДЕКЛАРАЦИЯ ЗА ВПИСВАНЕ НА ДАННИ И ЗА ПРОМЯНА НА ОБСТОЯТЕЛСТВА НА ДАННИ В КНИГАТА НА ЕТАЖНАТА СОБСТВЕНОСТ ПО ЧЛ. 7, АЛ. 3 ОТ ЗАКОНА ЗА УПРАВЛЕНИЕ НА ЕТАЖНАТА СОБСТВЕНОСТ
            </p>
            
            <p style="text-align:justify;">
                Долуподписаният/ата <strong>${ownerName ? ownerName : '...........................................................................'}</strong>, в качеството си на собственик/ползвател, декларирам следните данни за вписване в книгата на етажната собственост съгласно чл. 7, ал. 2 от ЗУЕС относно самостоятелен обект <strong>№ ${apt}</strong> в сграда в режим на етажна собственост по реда на чл. 7, ал. 3 от ЗУЕС:
            </p>
            
            <p>1. Местонахождение (вход, етаж и № на обекта в сградата): ..............................................................</p>
            <p>2. Застроена площ: ....................................................................................</p>
            <p>3. Предназначение: <strong>${purpose ? purpose : '............................................................................'}</strong></p>
            <p>4. Идеални части на обекта от общите части на сградата (в проценти): <strong>${idealParts ? idealParts : '............'}</strong> *</p>
            <p style="font-size: 10px; color: #555;">* Съгласно документ за собственост или по реда на чл. 17, ал. 4 от ЗУЕС.</p>
            
            <h4 style="margin-bottom: 5px; margin-top: 20px;">I. СОБСТВЕНИК/СОБСТВЕНИЦИ:</h4>
            <table border="1" style="width:100%; border-collapse: collapse; text-align: left;">
                <thead>
                    <tr style="background:#f9f9f9; font-size: 11px;">
                        <th style="padding: 5px; width: 5%;">№ по ред</th>
                        <th style="padding: 5px; width: 30%;">Трите имена на собственика/собствениците, в случай че собственик е юридическо лице или едноличен търговец - наименованието, БУЛСТАТ или единен идентификационен код (ЕИК)</th>
                        <th style="padding: 5px; width: 25%;">Трите имена на всеки член на домакинството, който живее заедно със собственика/собствениците</th>
                        <th style="padding: 5px; width: 15%;">Начална дата на ползване</th>
                        <th style="padding: 5px; width: 25%;">Електронна поща за уведомяване и време, в което собственикът/собствениците не обитава/т своята собственост</th>
                    </tr>
                </thead>
                <tbody>
                    <tr>
                        <td style="padding: 5px; text-align: center;">1</td>
                        <td style="padding: 5px; height: 30px;"><strong>${ownerName}</strong></td>
                        <td style="padding: 5px;"><strong>${occupants}</strong></td>
                        <td style="padding: 5px;"></td>
                        <td style="padding: 5px;"></td>
                    </tr>
                    <tr><td style="padding: 5px; text-align: center;">2</td><td style="padding: 5px; height: 30px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                </tbody>
            </table>
            <p style="font-size: 10px; margin-top: 2px;">Забележка. Добавете редове, ако е необходимо.</p>
            
            <h4 style="margin-bottom: 5px; margin-top: 15px;">II. ПОЛЗВАТЕЛ/ПОЛЗВАТЕЛИ:</h4>
            <table border="1" style="width:100%; border-collapse: collapse; text-align: left;">
                <thead>
                    <tr style="background:#f9f9f9; font-size: 11px;">
                        <th style="padding: 5px; width: 5%;">№ по ред</th>
                        <th style="padding: 5px; width: 30%;">Трите имена на ползвателя/ползвателите, в случай, ползвател е юридическо лице или едноличен търговец - наименованието, БУЛСТАТ или единен идентификационен код (ЕИК)</th>
                        <th style="padding: 5px; width: 25%;">Трите имена на всеки член на домакинството, който живее заедно с ползвателя/ползвателите</th>
                        <th style="padding: 5px; width: 10%;">Начална дата на ползване</th>
                        <th style="padding: 5px; width: 15%;">Електронна поща за уведомяване</th>
                        <th style="padding: 5px; width: 15%;">Права и задължения на ползвателя относно управлението на общите части на сградата</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td style="padding: 5px; text-align: center;">1</td><td style="padding: 5px; height: 30px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                    <tr><td style="padding: 5px; text-align: center;">2</td><td style="padding: 5px; height: 30px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                </tbody>
            </table>
            <p style="font-size: 10px; margin-top: 2px;">Забележка. Добавете редове, ако е необходимо.</p>

            <h4 style="margin-bottom: 5px; margin-top: 15px;">III. ОБИТАТЕЛ/ОБИТАТЕЛИ:</h4>
            <table border="1" style="width:100%; border-collapse: collapse; text-align: left;">
                <thead>
                    <tr style="background:#f9f9f9; font-size: 11px;">
                        <th style="padding: 5px; width: 5%;">№ по ред</th>
                        <th style="padding: 5px; width: 35%;">Трите имена на обитателя/обителите, в случай, че обитател е юридическо лице или едноличен търговец -наименованието, БУЛСТАТ или единен идентификационен код (ЕИК)</th>
                        <th style="padding: 5px; width: 30%;">Трите имена на всеки член на домакинството, който живее заедно с обитателя/обитателите</th>
                        <th style="padding: 5px; width: 15%;">Дата на вписване</th>
                        <th style="padding: 5px; width: 15%;">Дата на отписване</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td style="padding: 5px; text-align: center;">1</td><td style="padding: 5px; height: 30px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                    <tr><td style="padding: 5px; text-align: center;">2</td><td style="padding: 5px; height: 30px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                </tbody>
            </table>
            <p style="font-size: 10px; margin-top: 2px;">Забележка. Добавете редове, ако е необходимо.</p>

            <h4 style="margin-bottom: 5px; margin-top: 15px;">IV. ПРИТЕЖАВАНИ ИЛИ ВЗЕТИ ЗА ОТГЛЕЖДАНЕ ЖИВОТНИ В ОБЕКТА</h4>
            <table border="1" style="width:100%; border-collapse: collapse; text-align: left;">
                <thead>
                    <tr style="background:#f9f9f9; font-size: 11px;">
                        <th style="padding: 5px; width: 5%;">№ по ред</th>
                        <th style="padding: 5px; width: 45%;">Вид на притежаваните или взетите за отглеждане животни, които се извеждат на обществени места</th>
                        <th style="padding: 5px; width: 25%;">Брой на притежаваните или взетите за отглеждане животни, които се извеждат на обществени места</th>
                        <th style="padding: 5px; width: 25%;">За куче - номер на ветеринарномедицинския паспорт</th>
                    </tr>
                </thead>
                <tbody>
                    <tr><td style="padding: 5px; text-align: center;">1</td><td style="padding: 5px; height: 30px;"><strong>${pets}</strong></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                    <tr><td style="padding: 5px; text-align: center;">2</td><td style="padding: 5px; height: 30px;"></td><td style="padding: 5px;"></td><td style="padding: 5px;"></td></tr>
                </tbody>
            </table>
            <p style="font-size: 10px; margin-top: 2px;">Забележка. Добавете редове, ако е необходимо.</p>

            <div style="display:flex; justify-content: space-between; margin-top: 30px; font-size: 11px;">
                <div style="width: 30%;">Дата на съставяне: .......................</div>
                <div style="width: 30%; text-align: center;">Собственик/собственици или ползвател/ползватели<br>(три имена и подпис)<br><br>....................................................</div>
                <div style="width: 30%; text-align: center;">Обитател/обитатели<br>(три имена и подпис)<br><br>....................................................</div>
            </div>
            <div style="text-align: right; margin-top: 20px; font-size: 11px;">
                Председател на управителния съвет (управител)<br>(три имена и подпис)<br><br>....................................................
            </div>
            
            <hr style="margin-top: 20px; margin-bottom: 20px; border: 0; border-top: 1px dashed #ccc;">
            
            <p style="font-weight: bold; font-size: 11px;">Дата на вписване на промяната: .......................</p>
            <p style="font-weight: bold; font-size: 11px;">Поле, в което е вписана промяна на декларирани обстоятелства: .......................</p>
            
            <div style="display:flex; justify-content: space-between; margin-top: 30px; font-size: 11px;">
                <div style="width: 45%; text-align: center;">Собственик/собственици, ползвател/ползватели или обитател/обитатели, деклариращи промяна на обстоятелства<br>(име и подпис)<br><br>....................................................</div>
                <div style="width: 45%; text-align: center;">Председател на управителния съвет (управителя)<br>(три имена и подпис)<br><br>....................................................</div>
            </div>
            
            <p style="font-size: 10px; color: #555; margin-top: 20px;">*Забележка: Когато декларацията се подава при настъпила промяна на данните, подлежащи на вписване по чл. 7, ал. 2 от ЗУЕС, се попълват само редовете, при които има промяна.</p>
        </div>
    `;

    const win = window.open('', '_blank');
    win.document.write(html);
    win.document.close();
    win.print();
}

// ==============================================

function populateAvailableReportPeriodsList_(periods) {
    const dl = document.getElementById('reportAvailablePeriodsList');
    if (!dl || !Array.isArray(periods) || !periods.length) return;
    const sortedDesc = periods.slice().reverse();
    dl.innerHTML = sortedDesc.map(p => `<option value="${String(p).replace(/"/g, '&quot;')}"></option>`).join('');
}

window.openMonthlyReport = function () {
    switchPage('monthly-report');
    const d = new Date();
    // По подразбиране предходния месец (защото отчетите се правят за завършен период)
    const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const periodStr = String(lastMonth.getMonth() + 1).padStart(2, '0') + "." + lastMonth.getFullYear();
    document.getElementById("reportPeriodInput").value = periodStr;
    document.getElementById("report-content").style.display = "none";

    // Stage 2C.3: Deduplicated manifest warmup + available periods datalist + default period prefetch
    if (currentRouteKey) {
        const rkOpen = currentRouteKey;
        (async () => {
            try {
                if (!window._projFlagsLoaded_) await ensureProjFlagsLoaded_();
                if (rkOpen !== currentRouteKey) return;
                const cachedMan = window._finMatCache_ && window._finMatCache_.routeKey === rkOpen ? window._finMatCache_.manifest : null;
                if (cachedMan && Array.isArray(cachedMan.availablePeriods) && cachedMan.availablePeriods.length) {
                    populateAvailableReportPeriodsList_(cachedMan.availablePeriods);
                }
                if (window._projFlags && window._projFlags.FIN_MONTHLY_REPORT_V3 === 'ON') {
                    const pre = await readMaterializedMonthlyReportV3_(rkOpen, periodStr);
                    if (pre && pre.viewData && Array.isArray(pre.viewData.data.availablePeriods)) {
                        populateAvailableReportPeriodsList_(pre.viewData.data.availablePeriods);
                    }
                } else if (!cachedMan) {
                    const snap = await fastGetPublicDoc_('financialManifestV1', rkOpen, rkOpen);
                    if (snap && snap.exists()) {
                        const md = snap.data() || {};
                        const pers = Array.isArray(md.availablePeriods) && md.availablePeriods.length
                            ? md.availablePeriods
                            : Object.keys((md.parts && md.parts.monthlyReports) || {});
                        populateAvailableReportPeriodsList_(pers);
                    }
                }
            } catch (e) {}
        })();
    }
}

async function loadMonthlyReportFromFirebase(routeKey, period) {
  if (!window._projFlagsLoaded_) {
    await ensureProjFlagsLoaded_();
  }
  const flagMode = (window._projFlags && window._projFlags.FIN_MONTHLY_REPORT_V3) || 'OFF';

  // STAGE 2C.3 CUTOVER (ON): Direct Firestore read of precomputed monthlyReportSummaryV3 — 0 GAS calls!
  if (flagMode === 'ON') {
    const matRes = await readMaterializedMonthlyReportV3_(routeKey, period);
    if (matRes && matRes.permissionDenied) {
      return { success: false, error: 'Достъпът до финансовия отчет е ограничен поради неплатен абонамент.' };
    }
    if (matRes && matRes.success && matRes.viewData) {
      if (Array.isArray(matRes.viewData.data.availablePeriods) && matRes.viewData.data.availablePeriods.length) {
        populateAvailableReportPeriodsList_(matRes.viewData.data.availablePeriods);
      }
      return matRes.viewData;
    }
  }

  // SHADOW / PARITY: non-blocking background read to verify eurocent parity against legacy
  const shadowPromise = (flagMode === 'SHADOW' || flagMode === 'PARITY')
    ? readMaterializedMonthlyReportV3_(routeKey, period).catch(() => null)
    : Promise.resolve(null);

  if ((!window.fb || !window.db) && typeof window.ensureFirebaseSdk_ === 'function') {
    await window.ensureFirebaseSdk_();
  }
  const { collection, getDocs, query, where } = window.fb;
  const db = window.db;

  const q = query(
    collection(db, "monthlyReports"),
    where("buildingId", "==", routeKey),
    where("periodId", "==", period)
  );
  const qInc = query(
    collection(db, "incomesV2"),
    where("routeKey", "==", routeKey),
    where("period", "==", period)
  );
  const qDist = query(
    collection(db, "distributionsV2"),
    where("routeKey", "==", routeKey),
    where("period", "==", period)
  );

  const [snapshot, v3Summary, snapIncRes, snapDistRes] = await Promise.all([
    getDocs(q),
    bgApiCall('getMonthlyReportSummaryV3', { routeKey: routeKey, period: period }).catch(() => null),
    getDocs(qInc).catch(err => ({ _err: err })),
    getDocs(qDist).catch(err => ({ _err: err }))
  ]);

  let totalInvoiced = 0;
  let totalCollected = 0;

  const rows = [];
  
  let invoicedCounts = {
      elevator: 0, subscription: 0, light: 0,
      security: 0, cleaning: 0, podrajka: 0, remont: 0,
      water: 0, platformSubscription: 0
  };

  snapshot.forEach(doc => {
    const d = doc.data();

    const due = Number(d.totalDue || d.due || 0);
    const paid = Number(d.receivedPaid ?? d.totalPaid ?? d.paid ?? 0); // MAINTENANCE_RECEIPT_UI

    totalInvoiced += due;
    totalCollected += paid;

    const det = d.details || {};
    invoicedCounts.elevator += Number(det["Асансьор ел."] || det["Асансьор"] || d.elevator || 0);
    invoicedCounts.subscription += Number(det["Асансьор абон. и др."] || det["Абонамент"] || d.subscription || 0);
    invoicedCounts.light += Number(det["Етажно ел."] || det["Ток"] || det["Осветление"] || d.light || 0);
    invoicedCounts.security += Number(det["Охрана"] || det["Вход"] || d.security || 0);
    invoicedCounts.cleaning += Number(det["Почистване"] || det["Чистач"] || d.cleaning || 0);
    invoicedCounts.podrajka += Number(det["Фонд Поддръжка"] || det["Поддръжка"] || d.podrajka || 0);
    invoicedCounts.remont += Number(det["Фонд ремонт"] || det["Ремонтен фонд"] || det["Ремонт"] || d.remont || 0);
    invoicedCounts.water += Number(det["ВиК"] || det["ВиК ЕС"] || d.water || 0);
    invoicedCounts.platformSubscription += Number(det["Управление"] || det["Абонамент Платформа"] || d.platformSubscription || 0);

    rows.push(d);
  });

  // Authoritative V3 gross category totals (exact integer eurocents) override incomplete/stale breakdown sums
  const hasV3 = Boolean(v3Summary && v3Summary.success && v3Summary.reconciliation);
  if (hasV3 && v3Summary.grossByCategoryCents) {
    const g = v3Summary.grossByCategoryCents;
    invoicedCounts.elevator = Number(g.elevator || 0) / 100;
    invoicedCounts.subscription = Number(g.subscription || 0) / 100;
    invoicedCounts.light = Number(g.light || 0) / 100;
    invoicedCounts.security = Number(g.security || 0) / 100;
    invoicedCounts.cleaning = Number(g.cleaning || 0) / 100;
    invoicedCounts.podrajka = Number(g.maintenance || 0) / 100;
    invoicedCounts.remont = Number(g.repairFund || 0) / 100;
    invoicedCounts.water = Number(g.water || 0) / 100;
    invoicedCounts.platformSubscription = Number(g.platformSubscription || 0) / 100;
    invoicedCounts.total = Number(v3Summary.reconciliation.grossExpenseCents || 0) / 100;
  } else {
    invoicedCounts.total = totalInvoiced;
  }

  // Външни приходи (V2) за същия период
  let incomesV2 = [];
  if (snapIncRes && !snapIncRes._err) {
    snapIncRes.forEach(doc => {
      const income = { id: doc.id, ...doc.data() }; if (income.paymentId && income.settlementStatus !== 'APPLIED') return; // FIN01_UI
      incomesV2.push({ id: doc.id, ...doc.data() });
    });
  } else {
    const err = snapIncRes && snapIncRes._err;
    if (isStaleRouteRequestError(err)) throw err;
    console.warn("Error fetching V2 incomes for report, trying local storage:", err);
    const local = JSON.parse(localStorage.getItem('incomesV2_' + routeKey) || '[]');
    incomesV2 = local.filter(r => r.period === period);
  }

  // Разпределения (V2) за същия период
  let distributionsV2 = [];
  if (snapDistRes && !snapDistRes._err) {
    snapDistRes.forEach(doc => {
      distributionsV2.push({ id: doc.id, ...doc.data() });
    });
  } else {
    const err = snapDistRes && snapDistRes._err;
    if (isStaleRouteRequestError(err)) throw err;
    console.warn("Error fetching V2 distributions for report, trying local storage:", err);
    const local = JSON.parse(localStorage.getItem('distributionsV2_' + routeKey) || '[]');
    distributionsV2 = local.filter(r => r.period === period);
  }

  const art51Map = (hasV3 && v3Summary.art51ByApartment) ? v3Summary.art51ByApartment : {};
  const legacyResult = {
    success: true,
    _fromMaterializedV3: false,
    data: {
      invoiced: invoicedCounts,
      apartmentTotalDueCents: Math.round(totalInvoiced * 100),
      collected: totalCollected,
      logic: rows[0] ? (rows[0].logic || 'Равно') : 'Равно',
      incomesV2: incomesV2,
      distributionsV2: distributionsV2,
      v3Summary: hasV3 ? v3Summary : null,
      apartments: rows.map(r => {
        const d = r.details || {};
        const aptId = r.apartmentId || r.apt || '?';
        const authArt51 = art51Map[aptId] || (r.art51Active ? {
          active: true,
          multiplier: Number(r.art51Multiplier || 1),
          effectiveFromPeriod: r.art51EffectiveFromPeriod || '',
          decisionDate: r.art51DecisionDate || '',
          decisionReference: r.art51DecisionReference || ''
        } : null);
        return {
          apt: aptId,
          occupants: d["Обитатели"] !== undefined ? d["Обитатели"] : (r.occupants || 0),
          chips: d["Чипове"] !== undefined ? d["Чипове"] : (r.chips || 0),
          participation: d["Участие"] !== undefined ? d["Участие"] : (r.participation || 'Да'),
          idealParts: d["Ид. части"] !== undefined ? d["Ид. части"] : (r.idealParts || 0),
          art51Multiplier: (authArt51 && authArt51.active && authArt51.multiplier > 1)
            ? authArt51.multiplier
            : (d["Коефициент 3-5"] || d["чл. 51"] || d["Обществен достъп"] || (r.art51 ? r.art51.multiplier : null) || null),
          art51Info: authArt51,
          due: Number(r.totalDue || r.due || 0)
        };
      }).sort((a, b) => {
        const numA = parseInt(a.apt.replace(/[^0-9]/g, '')) || 0;
        const numB = parseInt(b.apt.replace(/[^0-9]/g, '')) || 0;
        return numA - numB;
      })
    }
  };

  if (flagMode === 'SHADOW' || flagMode === 'PARITY') {
    shadowPromise.then(mat => {
      if (mat && mat.success && mat.viewData && hasV3) {
        const mRec = mat.viewData.data.v3Summary && mat.viewData.data.v3Summary.reconciliation;
        const lRec = v3Summary.reconciliation;
        const grossMatch = Number(mRec && mRec.grossExpenseCents) === Number(lRec && lRec.grossExpenseCents);
        const totalMatch = Number(mRec && mRec.totalMgmtReceivablesByUnitCents) === Number(lRec && lRec.totalMgmtReceivablesByUnitCents);
        const collectedMatch = Math.round(mat.viewData.data.collected * 100) === Math.round(totalCollected * 100);
        window._finMatParityLog_.push({
          scope: 'FIN_MONTHLY_REPORT_V3',
          mode: flagMode,
          routeKey: routeKey,
          period: period,
          exactMatch: grossMatch && totalMatch && collectedMatch,
          ts: Date.now()
        });
      }
    }).catch(() => {});
  }

  return legacyResult;
}

window.generateReport = async function () {
    const requestContext = captureRouteRequestContext();
    const period = document.getElementById("reportPeriodInput").value.trim();
    if (!period) {
        showToast("Моля, въведете период!", "error");
        return;
    }
    if (isFutureTechnicalPeriodUI(period)) {
        showToast(`Период ${period} е бъдещ технически резервен период (текущ активен: ${getActiveSofiaPeriod()}). Месечен финансов отчет не се генерира за бъдещи периоди.`, "warning");
        return;
    }

    const btn = document.querySelector("#view-monthly-report .btn-primary");
    showSaving(btn, "Зареждане...");
    const _mrStartMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    document.documentElement.dataset.perfMonthlyReportMs = '';
    document.documentElement.dataset.perfMonthlyReportSource = '';

    try {
        const result = await loadMonthlyReportFromFirebase(currentRouteKey, period);
        if (result && result.success && result.data) {
            const d = result.data;
            document.getElementById("report-title-period").textContent = `за месец ${period} г.`;
            document.getElementById("report-gen-date").textContent = new Date().toLocaleDateString('bg-BG');

            const tableBody = document.getElementById("report-invoiced-rows");
            tableBody.innerHTML = "";

            const labels = {
                elevator: "Асансьор ел.",
                subscription: "Асансьор абон. и др.",
                light: "Етажно ел.",
                security: "Охрана",
                cleaning: "Почистване",
                podrajka: "Фонд Поддръжка",
                remont: "Фонд ремонт",
                water: "ВиК",
                platformSubscription: "Управление"
            };

            for (let key in labels) {
                const val = d.invoiced[key] || 0;
                if (val > 0) {
                    const tr = document.createElement("tr");
                    tr.innerHTML = `
                        <td style="padding: 10px 0; border-bottom: 1px dashed #eee;">${labels[key]}</td>
                        <td style="text-align: right; padding: 10px 0; border-bottom: 1px dashed #eee;">${val.toFixed(2)} EUR</td>
                    `;
                    tableBody.appendChild(tr);
                }
            }

            document.getElementById("report-total-invoiced").textContent = d.invoiced.total.toFixed(2) + " EUR";

            // Render V3.1 exact balance reconciliation (A = B + C, D1 Apt Art.51, D2 Ext Art.51, exact vs per-unit rounding)
            const recBox = document.getElementById("report-reconciliation-v3");
            if (recBox) {
                if (d.v3Summary && d.v3Summary.reconciliation) {
                    const rec = d.v3Summary.reconciliation;
                    const fmtE = c => (Number(c || 0) / 100).toFixed(2) + " EUR";
                    const fmtSigned = c => (Number(c || 0) > 0 ? "+" : "") + (Number(c || 0) / 100).toFixed(2) + " EUR";
                    const aptExactCents = rec.apartmentExactSumCents !== undefined ? Number(rec.apartmentExactSumCents) : Number(d.apartmentTotalDueCents || 0);
                    const aptRoundedCents = rec.apartmentRoundedSumCents !== undefined ? Number(rec.apartmentRoundedSumCents) : aptExactCents;
                    const aptArt51SurchargeCents = rec.apartmentArt51SurchargeCents !== undefined
                        ? Number(rec.apartmentArt51SurchargeCents)
                        : Math.max(0, aptExactCents - Number(rec.apartmentBaseCents || 0));
                    const displayRoundingDiffCents = rec.apartmentDisplayRoundingDiffCents !== undefined
                        ? Number(rec.apartmentDisplayRoundingDiffCents)
                        : (aptRoundedCents - aptExactCents);
                    const extMgmtTotalCents = Number(rec.externalBaseCents || 0) + Number(rec.externalSurchargeCents || 0) + Number(rec.externalRepairFundCents || 0);
                    const totalMgmtExactCents = rec.totalMgmtReceivablesExactCents !== undefined
                        ? Number(rec.totalMgmtReceivablesExactCents)
                        : (aptExactCents + extMgmtTotalCents);
                    const totalMgmtByUnitCents = rec.totalMgmtReceivablesByUnitCents !== undefined
                        ? Number(rec.totalMgmtReceivablesByUnitCents)
                        : (aptRoundedCents + extMgmtTotalCents);
                    const rentCents = Number(rec.externalContractRentCents || 0);
                    recBox.innerHTML = `
                        <div style="font-weight:700; margin-bottom:6px; color:#0f172a;">Разпределение и балансово равенство (в евроцентове)</div>
                        <div class="report-reconciliation-row"><span>A. Реално въведен общ разход за входа</span><strong>${fmtE(rec.grossExpenseCents)}</strong></div>
                        <div class="report-reconciliation-row"><span>B. Разпределен базов дял на апартаментите (A1–A${d.v3Summary.apartmentCount || d.apartments.length})</span><span>${fmtE(rec.apartmentBaseCents)}</span></div>
                        <div class="report-reconciliation-row"><span>C. Разпределен базов дял на външните самостоятелни обекти</span><span>${fmtE(rec.externalBaseCents)}</span></div>
                        <div class="report-reconciliation-row"><span>D1. Допълнителни начисления по чл. 51, ал. 5 ЗУЕС (апартаменти)</span><span>${fmtE(aptArt51SurchargeCents)}</span></div>
                        <div class="report-reconciliation-row"><span>D2. Допълнителни начисления по чл. 51, ал. 5 ЗУЕС (самостоятелни обекти)</span><span>${fmtE(rec.externalSurchargeCents)}</span></div>
                        ${rec.externalRepairFundCents ? `<div class="report-reconciliation-row"><span>Фонд ремонт (самостоятелни обекти)</span><span>${fmtE(rec.externalRepairFundCents)}</span></div>` : ''}
                        <div class="report-reconciliation-row"><span>Общо вземания за управление и поддръжка (точна сума MASTER + СО)</span><span>${fmtE(totalMgmtExactCents)}</span></div>
                        ${displayRoundingDiffCents !== 0 ? `<div class="report-reconciliation-row"><span>Разлика от закръгляване по индивидуални партиди (MASTER)</span><span>${fmtSigned(displayRoundingDiffCents)}</span></div>` : ''}
                        <div class="report-reconciliation-row strong"><span>Общо начислени вземания за управление и поддръжка (сбор по партиди)</span><span>${fmtE(totalMgmtByUnitCents)}</span></div>
                        ${rentCents > 0 ? `<div class="report-reconciliation-row"><span>Договорен наем от самостоятелни обекти (отделно от разходите)</span><span>${fmtE(rentCents)}</span></div>` : ''}
                    `;
                    recBox.style.display = "block";
                } else {
                    recBox.style.display = "none";
                }
            }

            // Populate V2 Incomes table in Section II
            const collectedRows = document.getElementById("report-collected-rows");
            collectedRows.innerHTML = "";
            
            // 1. Apartment payments (V1 total)
            let totalIncomesSum = d.collected || 0;
            const trApt = document.createElement("tr");
            trApt.innerHTML = `
                <td style="padding: 10px 0; border-bottom: 1px dashed #eee;">Постъпили плащания за периода (от апартаменти)</td>
                <td style="text-align: right; padding: 10px 0; border-bottom: 1px dashed #eee;">${d.collected.toFixed(2)} EUR</td>
            `;
            collectedRows.appendChild(trApt);

            // 2. V2 incomes
            if (d.incomesV2 && d.incomesV2.length > 0) {
                d.incomesV2.forEach(inc => {
                    totalIncomesSum += Number(inc.paymentId ? inc.loanRepaymentCents / 100 : inc.amount || 0); // FIN01_TOTAL
                    if (inc.paymentId && inc.allocationSummary) inc = {...inc, category:formatVisibleSummaryText(inc.allocationSummary)}; // FIN01_UI
                    if (inc.extPaymentId && inc.allocationSummary) inc = {...inc, category:(inc.category || 'Плащане за самостоятелен обект') + ' — ' + formatVisibleSummaryText(inc.allocationSummary)};
                    const tr = document.createElement("tr");
                    const parsedExt = typeof parseExternalUnitTagClient_ === 'function' ? parseExternalUnitTagClient_(inc.note) : null;
                    const extUnitLabel = parsedExt
                        ? `Външен обект: ${parsedExt.unitName} (${parsedExt.unitId})`
                        : (inc.extUnitId ? `Външен обект: ${inc.extUnitName || inc.extUnitId} (${inc.extUnitId})` : null);
                    const payer = inc.apt === "EXTERNAL"
                        ? (extUnitLabel || "Външен източник")
                        : `Ап. ${inc.apt}`;
                    const displayCat = formatVisibleCategory(inc.category);
                    const displayNote = parsedExt ? parsedExt.cleanNote : inc.note;
                    const noteStr = displayNote ? ` (${displayNote})` : "";
                    tr.innerHTML = `
                        <td style="padding: 10px 0; border-bottom: 1px dashed #eee;">Приход от ${payer} - кат. "${displayCat}"${noteStr}</td>
                        <td style="text-align: right; padding: 10px 0; border-bottom: 1px dashed #eee;">${Number(inc.amount || 0).toFixed(2)} EUR</td>
                    `;
                    collectedRows.appendChild(tr);
                });
            }
            document.getElementById("report-total-collected").textContent = totalIncomesSum.toFixed(2) + " EUR";

            // Populate V2 Distributions in Section III
            const distRows = document.getElementById("report-distribution-rows");
            distRows.innerHTML = "";
            let totalDistSum = 0;
            
            if (d.distributionsV2 && d.distributionsV2.length > 0) {
                d.distributionsV2.forEach(dist => {
                    totalDistSum += Number(dist.amount || 0);
                    const tr = document.createElement("tr");
                    const destType = dist.type === "balance" ? "На салдо" : "На каса";
                    const distCat = dist.sourceBreakdownSummary ? `${formatVisibleCategory(dist.category)} [${formatVisibleSummaryText(dist.sourceBreakdownSummary)}]` : formatVisibleCategory(dist.category);
                    const noteStr = dist.note ? ` (${dist.note})` : "";
                    tr.innerHTML = `
                        <td style="padding: 10px 0; border-bottom: 1px dashed #eee;">Разпределено от "${distCat}" към ${destType}${noteStr}</td>
                        <td style="text-align: right; padding: 10px 0; border-bottom: 1px dashed #eee;">${Number(dist.amount || 0).toFixed(2)} EUR</td>
                    `;
                    distRows.appendChild(tr);
                });
            } else {
                const trEmpty = document.createElement("tr");
                trEmpty.innerHTML = `
                    <td colspan="2" style="padding: 10px 0; text-align: center; color: #666; font-style: italic;">Няма разпределени средства за периода</td>
                `;
                distRows.appendChild(trEmpty);
            }
            document.getElementById("report-total-distributed").textContent = totalDistSum.toFixed(2) + " EUR";

            // --- ДОБАВЯНЕ НА СТАТИСТИКА ЗА ПЕРИОДА (ПАРАМЕТРИ ПЕРСОНАЛНО) ---
            const statsBoxId = "monthly-report-stats-box";
            let statsSect = document.getElementById(statsBoxId);
            if (!statsSect) {
                statsSect = document.createElement("div");
                statsSect.id = statsBoxId;
                statsSect.style.marginTop = "30px";
                statsSect.style.paddingTop = "15px";
                statsSect.style.borderTop = "1px solid #eee";
            }
            // Винаги го добавяме наново, за да сме сигурни, че е вътре в самия отчет (преди подписите):
            const signatures = document.getElementById("report-signatures-area");
            if (signatures) {
                signatures.parentNode.insertBefore(statsSect, signatures);
            } else {
                document.getElementById("report-print-area").appendChild(statsSect);
            }

            let aptRowsHTML = "";
            let summaryTotalDue = 0;
            if (d.apartments && d.apartments.length > 0) {
                d.apartments.forEach(a => {
                    summaryTotalDue += a.due;
                    let art51Cell = 'Не';
                    if (a.art51Multiplier && a.art51Multiplier > 1) {
                        const info = a.art51Info || {};
                        const basis = [info.decisionReference, info.decisionDate].filter(Boolean).join(' / ');
                        art51Cell = `<strong>${a.art51Multiplier}×</strong>` + (basis ? `<div style="font-size:10px;color:#475569;">ОС ${reportEscape_(basis)}</div>` : '');
                    }
                    aptRowsHTML += `
                        <tr style="text-align: center; border-bottom: 1px dashed #eee;">
                            <td style="padding: 6px 0;"><strong>${a.apt}</strong></td>
                            <td style="padding: 6px 0;">${a.occupants}</td>
                            <td style="padding: 6px 0;">${a.chips}</td>
                            <td style="padding: 6px 0;">${a.participation}</td>
                            <td style="padding: 6px 0;">${a.idealParts}%</td>
                            <td style="padding: 6px 0;">${art51Cell}</td>
                            <td style="padding: 6px 0; font-weight: bold;">${a.due.toFixed(2)} EUR</td>
                        </tr>
                    `;
                });
            } else {
                aptRowsHTML = `<tr><td colspan="7" style="padding: 10px; text-align: center;">Няма налични детайлни данни</td></tr>`;
            }

            // Section V: Самостоятелни обекти (извън апартаментите)
            let extSectionHTML = "";
            const extUnits = (d.v3Summary && Array.isArray(d.v3Summary.externalUnits)) ? d.v3Summary.externalUnits : [];
            if (extUnits.length > 0) {
                const fmtE = c => (Number(c || 0) / 100).toFixed(2);
                const extRows = extUnits.map(u => {
                    const partLabel = u.managementParticipation ? 'Да' : 'Не';
                    const idealLabel = u.idealPartsStatus === 'ESTABLISHED' ? `${Number(u.idealPartsPercent || 0).toFixed(2)}%` : 'Неустановени';
                    const artLabel = (u.art51Active && u.art51Multiplier > 1) ? `${u.art51Multiplier}×` : '—';
                    const balLabel = u.endingAdvanceCents > 0
                        ? `Аванс ${fmtE(u.endingAdvanceCents)} EUR`
                        : `${fmtE(u.endingDebtCents)} EUR`;
                    return `
                        <tr style="text-align: center; border-bottom: 1px dashed #eee;">
                            <td style="padding: 6px 4px; text-align:left;"><strong>${reportEscape_(u.unitId)}</strong> — ${reportEscape_(u.name)}<div style="font-size:10px;color:#64748b;">Ид. части: ${idealLabel}</div></td>
                            <td style="padding: 6px 4px;">${partLabel}</td>
                            <td style="padding: 6px 4px;">${fmtE(u.baseManagementCents)}</td>
                            <td style="padding: 6px 4px;">${fmtE(u.surchargeCents)} <span style="font-size:10px;color:#64748b;">(${artLabel})</span></td>
                            <td style="padding: 6px 4px;">${fmtE(u.repairFundCents)}</td>
                            <td style="padding: 6px 4px;">${fmtE(u.contractRentCents)}</td>
                            <td style="padding: 6px 4px; font-weight:bold;">${fmtE(u.totalChargedPeriodCents)}</td>
                            <td style="padding: 6px 4px;">${fmtE(u.paidPeriodCents)}</td>
                            <td style="padding: 6px 4px; font-weight:bold;">${balLabel}</td>
                        </tr>
                    `;
                }).join('');
                extSectionHTML = `
                    <div id="monthly-report-external-units-box" style="margin-top: 26px; padding-top: 15px; border-top: 1px solid #ddd; page-break-inside: avoid;">
                        <h4 style="margin: 0 0 8px; font-size: 14px; text-transform: uppercase;">
                            V. Самостоятелни обекти (извън апартаментите)
                        </h4>
                        <div style="overflow-x:auto;">
                            <table style="width: 100%; font-size: 11.5px; color: #333; border-collapse: collapse;">
                                <thead>
                                    <tr style="background: #f8f9fa; border-bottom: 1px solid #ccc; text-align: center;">
                                        <th style="padding: 7px 4px; text-align:left; border-bottom: 2px solid #ddd;">Обект</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Участие РУП</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">База (EUR)</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Надбавка чл. 51 (EUR)</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Фонд ремонт (EUR)</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Наем (EUR)</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Общо начислено (EUR)</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Платено (EUR)</th>
                                        <th style="padding: 7px 4px; border-bottom: 2px solid #ddd;">Салдо / Аванс</th>
                                    </tr>
                                </thead>
                                <tbody>${extRows}</tbody>
                            </table>
                        </div>
                    </div>
                `;
            }

            statsSect.innerHTML = `
                <div style="page-break-inside: avoid;">
                    <h4 style="margin: 0 0 5px; font-size: 14px; text-transform: uppercase;">
                        IV. Подробни параметри по апартаменти
                    </h4>
                    <p style="font-size: 11px; margin-bottom: 15px; color: #555;">Логика на разпределение (Асансьор): <strong>${d.logic || 'Равно'}</strong></p>
                    <table style="width: 100%; font-size: 12px; color: #333; border-collapse: collapse;">
                        <thead>
                            <tr style="background: #f8f9fa; border-bottom: 1px solid #ccc; text-align: center; font-weight: normal;">
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Ап.</th>
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Обитатели</th>
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Чипове</th>
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Участие Асан.</th>
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Ид. Части</th>
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Общ. достъп (чл. 51)</th>
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Начислено</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${aptRowsHTML}
                        </tbody>
                    </table>
                </div>
                ${extSectionHTML}
            `;

            document.getElementById("report-content").style.display = "block";
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    const _mrEndMs = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    document.documentElement.dataset.perfMonthlyReportMs = String(Math.round(_mrEndMs - _mrStartMs));
                    document.documentElement.dataset.perfMonthlyReportSource = result._fromMaterializedV3 ? 'MATERIALIZED_V3' : 'LEGACY_GAS';
                    document.documentElement.dataset.perfMonthlyReportPeriod = period;
                });
            }
        } else {
            showToast(result?.error || "Няма данни за този период.", "error");
            document.getElementById("report-content").style.display = "none";
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Грешка при генериране на отчета", "error");
    } finally {
        if (isCurrentRouteRequestContext(requestContext)) hideSaving(btn, "Покажи");
    }
}

window.printReport = function () {
    const printContents = document.getElementById('report-print-area').innerHTML;
    const originalContents = document.body.innerHTML;

    // Временна смяна на тялото за принтиране (или по-добре чрез CSS media print)
    // Тъй като това е SPA, print() ще хване всичко. Използваме прост метод:
    const printWindow = window.open('', '', 'height=800,width=800');
    printWindow.document.write('<html><head><title>Месечен отчет - ' + document.getElementById("reportPeriodInput").value + '</title>');
    printWindow.document.write('<style>body{font-family: Arial, sans-serif; padding: 40px;} table{width:100%; border-collapse:collapse;} td{padding:10px 0;} tr.total{font-weight:bold; border-top:2px solid black;}</style>');
    printWindow.document.write('</head><body>');
    printWindow.document.write(printContents);
    printWindow.document.write('</body></html>');
    printWindow.document.close();
    printWindow.print();
}

// Помощна функция за смяна на страниците
window.switchPage = function (pageId) {
    // Всички панели
    const panels = ['view-selector', 'view-entrance-home', 'view-monthly-report'];
    panels.forEach(id => {
        const el = document.getElementById(id);
        if (el) {
            el.classList.remove('active');
            el.classList.add('hidden');
        }
    });

    const activePanel = document.getElementById('view-' + pageId) || document.getElementById(pageId);
    if (activePanel) {
        activePanel.classList.remove('hidden');
        activePanel.classList.add('active');
    }
}



async function checkRemontEligibility() {
    const requestContext = captureRouteRequestContext();
    try {
        const res = await apiCall('getBuildingIdealParts');
        throwIfStaleRouteRequestContext(requestContext);
        const input = document.getElementById("chargesRemont");
        const warn = document.getElementById("remontWarning");
        
        let allHaveParts = false;
        let missing = [];
        let extUnestablished = [];
        let extSumDeviation = null;
        if (res && res.success && res.parts && typeof apartmentList !== 'undefined' && apartmentList.length > 0) {
            missing = apartmentList.filter(apt => res.parts[apt] === undefined || res.parts[apt] === "" || parseFloat(res.parts[apt]) <= 0);
            extUnestablished = Array.isArray(res.unestablishedRepairExternalUnits) ? res.unestablishedRepairExternalUnits : [];
            if (typeof res.externalIdealPartsSum === 'number' && res.externalIdealPartsSum > 0 && res.buildingSumValid === false) {
                extSumDeviation = res;
            }
            allHaveParts = missing.length === 0 && extUnestablished.length === 0 && !extSumDeviation;
        }

        if (input) {
            const pending = !!manualExpenseState_().pending;
            input.dataset.expenseUnavailable = String(!allHaveParts);
            input.disabled = !allHaveParts || pending;
            input.placeholder = allHaveParts ? "Обща сума за входа" : "Деактивирано (непълна база за Ид. части)";
            if (!allHaveParts && !pending) {
                input.value = "";
                updateManualExpenseDraft('repairFund');
            }
        }
        
        if (warn) {
            warn.style.display = allHaveParts ? "none" : "block";
            if (!allHaveParts) {
                if (extUnestablished.length > 0) {
                    warn.innerHTML = `⚠️ За начисления към фонд ремонт идеалните части трябва да са установени за всички участващи обекти.<br><b>Неустановени за:</b> ${extUnestablished.join(", ")}`;
                } else if (extSumDeviation) {
                    warn.innerHTML = `⚠️ Общият сбор на идеалните части (Апартаменти: ${Number(extSumDeviation.totalSum).toFixed(2)}% + Външни обекти: ${Number(extSumDeviation.externalIdealPartsSum).toFixed(2)}% = ${Number(extSumDeviation.buildingTotalSum).toFixed(2)}%) се отклонява от 100.00%.`;
                } else if (missing.length > 0 && missing.length <= 15) {
                    warn.innerHTML = `⚠️ За начисления към фонд ремонт първо въведете Ид. част (%) за <b>всички</b> апартаменти.<br><b>Липсват за:</b> ${missing.join(", ")}`;
                } else if (missing.length > 15) {
                    warn.innerHTML = `⚠️ За начисления към фонд ремонт първо въведете Ид. част (%) за <b>всички</b> апартаменти.<br><b>Липсват за ${missing.length} апартамента.</b>`;
                } else {
                    warn.innerHTML = `⚠️ За начисления към фонд ремонт първо въведете Ид. част (%) за всеки апартамент в MASTER.`;
                }
            }
        }
    } catch(e) { if (!isStaleRouteRequestError(e)) console.warn('remont eligibility failed', e); }
}






// ==============================================
// FORCE FIREBASE SYNC (Manual Trigger)
// ==============================================
window.forceFirebaseSync = async function() {
    const requestContext = captureRouteRequestContext();
    const btn = document.getElementById("forceSyncBtn");
    if (!btn) return;
    showSaving(btn, "Синхронизиране... (отнема 5-15 сек)");
    try {
        const result = await apiCall("forceDataSync", { pin: getStoredPin() });
        throwIfStaleRouteRequestContext(requestContext);
        if (result && result.success) {
            showToast("Синхронизацията приключи успешно!", "success");
            refreshCurrentView();
        } else {
            showToast(result?.error || "Проблем при синхронизацията.", "error");
        }
    } catch(e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Грешка при комуникация със сървъра", "error");
    } finally {
        if (isCurrentRouteRequestContext(requestContext)) hideSaving(btn, "Изпрати данните към приложението");
    }
}

// --- V2 INCOMES MODULE ---
function switchAdminTab(tab) {
    const viewIncomes = document.getElementById('admin-view-incomes');
    const viewDistribution = document.getElementById('admin-view-distribution');
    const viewExpensesWrapper = document.getElementById('admin-view-expenses');
    
    if (!viewExpensesWrapper) return;
    
    const adminSections = Array.from(viewExpensesWrapper.querySelectorAll('.admin-section'));
    const quickNav = viewExpensesWrapper.querySelector('.admin-quick-nav');
    if (quickNav) quickNav.style.display = (tab === 'expenses' || tab === 'settings') ? 'block' : 'none';

    if (viewIncomes) viewIncomes.style.display = (tab === 'incomes') ? 'block' : 'none';
    if (viewDistribution) viewDistribution.style.display = (tab === 'distribution') ? 'block' : 'none';
    
    if (tab === 'expenses') {
        viewExpensesWrapper.style.display = 'block';
        // Показваме секциите, изрично маркирани data-tab="expenses".
        // "Добавяне на плащане" (data-tab="payment") остава скрито в V2 режим.
        adminSections.forEach(sec => {
            sec.style.display = (sec.getAttribute('data-tab') === 'expenses') ? 'block' : 'none';
        });
        if (quickNav) quickNav.style.display = 'none'; // Няма нужда от бързи бутони, защото има само 1-2 секции
    } else if (tab === 'settings') {
        viewExpensesWrapper.style.display = 'block';
        adminSections.forEach(sec => {
            sec.style.display = (sec.getAttribute('data-tab') === 'settings') ? 'block' : 'none';
        });
        if (typeof populateRangeReportSelects === 'function') populateRangeReportSelects('adminRangeFrom', 'adminRangeTo');
        const newAdminEmailInput = document.getElementById('newAdminEmailInput');
        if (newAdminEmailInput && !newAdminEmailInput.value) {
            newAdminEmailInput.value = sessionStorage.getItem("adminEmail_" + currentRouteKey) || "";
        }
        if (quickNav) {
            quickNav.style.display = 'block';
            // Скриване на бутона "Начисления" от quick nav
            const links = quickNav.querySelectorAll('a');
            links.forEach(l => {
                if (l.textContent.includes('Начисления')) l.style.display = 'none';
                else l.style.display = 'inline-block';
            });
        }
    } else {
        viewExpensesWrapper.style.display = 'none';
    }

    const navExpenses = document.getElementById('nav-admin-expenses');
    const navIncomes = document.getElementById('nav-admin-incomes');
    const navSettings = document.getElementById('nav-admin-settings');
    const navDist = document.getElementById('nav-admin-distribution');

    if (navExpenses) { navExpenses.style.opacity = (tab === 'expenses') ? '1' : '0.5'; navExpenses.style.boxShadow = (tab === 'expenses') ? '0 0 0 2px #fff, 0 0 0 4px #ef4444' : 'none'; }
    if (navIncomes) { navIncomes.style.opacity = (tab === 'incomes') ? '1' : '0.5'; navIncomes.style.boxShadow = (tab === 'incomes') ? '0 0 0 2px #fff, 0 0 0 4px #10b981' : 'none'; }
    if (navSettings) { navSettings.style.opacity = (tab === 'settings') ? '1' : '0.5'; navSettings.style.boxShadow = (tab === 'settings') ? '0 0 0 2px #fff, 0 0 0 4px #64748b' : 'none'; }
    if (navDist) { navDist.style.opacity = (tab === 'distribution') ? '1' : '0.5'; navDist.style.boxShadow = (tab === 'distribution') ? '0 0 0 2px #fff, 0 0 0 4px #3b82f6' : 'none'; }
    
    if (tab === 'incomes') {
        const periodField = document.getElementById("v2IncomePeriod");
        if (periodField) {
            const now = new Date();
            periodField.value = String(now.getMonth() + 1).padStart(2, '0') + "." + now.getFullYear();
        }
        if (typeof loadIncomesV2 === 'function') loadIncomesV2();
        if (typeof loadExternalPayers === 'function') loadExternalPayers();
        if (typeof loadExternalUnitsData === 'function') loadExternalUnitsData(true);
        if (typeof loadCreditLiabilitiesRegister === 'function') loadCreditLiabilitiesRegister();
        if (typeof updateCreditCategoryAvailability === 'function') updateCreditCategoryAvailability();
    }
    if (tab === 'distribution') {
        if (typeof loadDistributionsV2 === 'function') loadDistributionsV2();
        if (typeof updateV2DistAvailableSum === 'function') updateV2DistAvailableSum();
    }
    if (tab === 'expenses') {
        if (typeof loadChargesV2Register === 'function') loadChargesV2Register();
    }
}
window.switchAdminTab = switchAdminTab;

// ==============================================
// V2 INCOMES LOGIC (BETA)
// ==============================================

// Изискване 2: опцията "Кредит" изисква ВСИЧКИ апартаменти да имат зададени
// идеални части — но САМО когато се взима НОВ кредит (платец = Външен
// източник), защото тогава се разпределя автоматично между всички. Когато
// плаща КОНКРЕТЕН апартамент (погасяване), проверката не е нужна.
let _creditIdealPartsOk = null; // кеш за текущата сесия, за да не спамим бекенда
window.updateCreditCategoryAvailability = async function() {
    const requestContext = captureRouteRequestContext();
    const aptSel = document.getElementById("v2IncomeApt");
    const catSel = document.getElementById("v2IncomeCategory");
    if (!aptSel || !catSel) return;
    const creditOption = Array.from(catSel.options).find(o => o.value === "Кредит");
    if (!creditOption) return;

    const apt = aptSel.value;
    if (apt !== "EXTERNAL") {
        // Погасяване от апартамент — винаги позволено, без проверка.
        creditOption.disabled = false;
        creditOption.title = "";
        return;
    }

    if (_creditIdealPartsOk === null) {
        try {
            const res = await apiCall('getBuildingIdealParts', { pin: getStoredPin() });
            throwIfStaleRouteRequestContext(requestContext);
            const missing = res && res.success && apartmentList
                ? apartmentList.filter(a => !res.parts || res.parts[a] === undefined || res.parts[a] === "" || parseFloat(res.parts[a]) <= 0)
                : apartmentList;
            _creditIdealPartsOk = missing.length === 0;
        } catch (e) {
            if (isStaleRouteRequestError(e)) return;
            _creditIdealPartsOk = false;
        }
    }

    creditOption.disabled = !_creditIdealPartsOk;
    creditOption.title = _creditIdealPartsOk ? "" : "Изисква се да въведете идеални части за ВСИЧКИ апартаменти в MASTER – Настройки, преди да можете да въвеждате нов кредит.";

    if (creditOption.disabled && catSel.value === "Кредит") {
        catSel.value = "Наем";
        showToast("⚠️ Не са въведени идеални части за всички апартаменти — попълнете ги в MASTER – Настройки, за да въвеждате нов кредит.", "error");
    }
};

window.v2HandleAptChange = function() {
    const apt = document.getElementById("v2IncomeApt").value;
    const catSel = document.getElementById("v2IncomeCategory");
    const isExtUnitMode = apt === "EXTERNAL_UNIT";
    const isExternalSourceMode = apt === "EXTERNAL";
    const isApartment = apt && !isExtUnitMode && !isExternalSourceMode;

    const extGroup = document.getElementById("v2IncomeExtUnitGroup");
    if (extGroup) {
        extGroup.style.display = isExtUnitMode ? "block" : "none";
        if (isExtUnitMode && typeof populateExternalUnitSelects_ === 'function') {
            populateExternalUnitSelects_();
        }
    }

    const previewBox = document.getElementById("extUnitPaymentPreviewBox");
    if (previewBox && !isExtUnitMode) {
        previewBox.style.display = "none";
    }

    Array.from(catSel.options).forEach(opt => {
        if (isApartment) {
            opt.style.display = (opt.value === "Управление и поддръжка" || opt.value === "Кредит" || opt.value === "") ? "" : "none";
        } else if (isExtUnitMode) {
            opt.style.display = (opt.value === "Плащане за СО") ? "" : "none";
        } else if (isExternalSourceMode) {
            opt.style.display = (opt.value !== "Плащане за СО" && opt.value !== "Управление и поддръжка") ? "" : "none";
        } else {
            opt.style.display = (opt.value !== "Плащане за СО") ? "" : "none";
        }
    });

    if (isExtUnitMode) {
        catSel.value = "Плащане за СО";
        catSel.disabled = true;
    } else if (isApartment) {
        catSel.disabled = false;
        if (catSel.value !== "Кредит" && catSel.value !== "Управление и поддръжка") {
            catSel.value = "Управление и поддръжка";
        }
    } else if (isExternalSourceMode) {
        catSel.disabled = false;
        if (catSel.value === "Плащане за СО" || catSel.value === "Управление и поддръжка") {
            catSel.value = "Наем";
        }
    } else {
        catSel.disabled = false;
    }

    v2LoadPaymentDue();
    if (typeof updateCreditCategoryAvailability === 'function') updateCreditCategoryAvailability();
    if (!isExtUnitMode && typeof fin01RefreshPaymentView_ === 'function') fin01RefreshPaymentView_(); // FIN01_UI
    if (isExtUnitMode) {
        const fin01Controls = document.getElementById('fin01PaymentControls');
        if (fin01Controls) fin01Controls.hidden = true;
        if (typeof onV2IncomeExtPaymentInputChanged === 'function') onV2IncomeExtPaymentInputChanged();
    }
};

window.v2HandleExtUnitChange = function() {
    v2LoadPaymentDue();
    if (typeof onV2IncomeExtPaymentInputChanged === 'function') onV2IncomeExtPaymentInputChanged();
};


window.v2LoadPaymentDue = async function(operationContext) {
    const requestContext = operationContext ? null : captureRouteRequestContext();
    if (operationContext) assertFinancialOperationContextCurrent(operationContext);
    const operationRouteKey = operationContext ? operationContext.routeKey : currentRouteKey;
    const apt = document.getElementById("v2IncomeApt").value;
    const period = document.getElementById("v2IncomePeriod").value;
    const catSel = document.getElementById("v2IncomeCategory");
    const category = catSel ? catSel.value : "";
    const lbl = document.getElementById("v2IncomeCurrentBal");
    const refreshSelection = Object.freeze({ apt: apt, period: period, category: category });
    
    if (!lbl) return;

    if (apt === "EXTERNAL_UNIT" || apt === "EXTERNAL") {
        const extSel = document.getElementById("v2IncomeExtUnit");
        const extUnitId = (apt === "EXTERNAL_UNIT" && extSel) ? extSel.value : "";
        if (extUnitId && typeof renderExternalUnitPaymentDueBadge_ === 'function') {
            renderExternalUnitPaymentDueBadge_(extUnitId, category, lbl);
            return;
        }
        lbl.innerHTML = "";
        lbl.className = "charge-current";
        return;
    }
    
    // Външен източник няма салдо/задължения към входа
    if (!apt || apt === "EXTERNAL" || apt === "EXTERNAL_UNIT" || !window.fb || !window.db) {
        lbl.innerHTML = "";
        lbl.className = "charge-current";
        return;
    }

    const assertRefreshContextCurrent = function(cause) {
        if (operationContext) {
            assertFinancialOperationContextCurrent(operationContext, cause);
            const currentCategory = document.getElementById("v2IncomeCategory");
            if (document.getElementById("v2IncomeApt").value !== refreshSelection.apt ||
                document.getElementById("v2IncomePeriod").value !== refreshSelection.period ||
                (currentCategory ? currentCategory.value : "") !== refreshSelection.category) {
                const error = new Error("Stale financial dependent refresh");
                error.staleRouteResponse = true;
                if (cause) error.cause = cause;
                throw error;
            }
            return operationContext;
        }
        if (cause) return reconcileRouteRequestContext(requestContext, cause);
        return throwIfStaleRouteRequestContext(requestContext);
    };
    const currency = sessionStorage.getItem("currency_" + operationRouteKey) || "лв.";

    // За категория "Кредит" показваме кредитния остатък на апартамента
    // (отделен паралелен регистър), НЕ обичайния оперативен баланс.
    if (category === "Кредит") {
        lbl.innerHTML = '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>';
        lbl.className = "charge-current loading";
        try {
            const { routeDoc, getDoc } = window.fb;
            const db = window.db;
            const ref = routeDoc(db, "creditLiabilitiesV2", operationRouteKey + "_" + apt, operationRouteKey);
            const snap = await getDoc(ref);
            assertRefreshContextCurrent();
            let original = 0, remaining = 0;
            if (snap.exists()) {
                original = parseFloat(snap.data().original) || 0;
                remaining = parseFloat(snap.data().remaining) || 0;
            }
            const paid = Math.max(0, original - remaining);
            const colorClass = remaining > 0 ? "value-red" : "value-green";
            lbl.className = "charge-current";
            lbl.innerHTML = `(платено <span class="value-green">${paid.toFixed(2)} ${currency}</span>, салдо по кредит <span class="${colorClass}">${remaining.toFixed(2)} ${currency}</span>)`;
        } catch (e) {
            if (isStaleRouteRequestError(e)) return;
            try {
                assertRefreshContextCurrent(e);
            } catch (contextError) {
                if (isStaleRouteRequestError(contextError)) return;
                throw contextError;
            }
            lbl.className = "charge-current";
            lbl.innerText = "";
        }
        return;
    }

    if (!period) {
        lbl.innerHTML = "";
        lbl.className = "charge-current";
        return;
    }
    
    lbl.innerHTML = '<span class="loading-dots"><span>.</span><span>.</span><span>.</span></span>';
    lbl.className = "charge-current loading";
    
    try {
        const { routeDoc, getDoc } = window.fb;
        const db = window.db;
        
        // Взимане на данни от V1 колекциите
        const docId = operationRouteKey + "_" + apt + "_" + period;
        const docRef = routeDoc(db, "monthlyReports", docId, operationRouteKey);
        const aptDocRef = routeDoc(db, "apartments", operationRouteKey + "_" + apt, operationRouteKey);
        
        const [snap, aptSnap] = await Promise.all([getDoc(docRef), getDoc(aptDocRef)]);
        assertRefreshContextCurrent();
        
        let balanceStr = "";
        
        if (aptSnap.exists()) {
            const aptData = aptSnap.data();
            const bal = Number(aptData.balance || 0);
            const colorClass = bal > 0 ? "value-red" : "value-green";
            balanceStr = `, салдо <span class="${colorClass}">${bal.toFixed(2)} ${currency}</span>`;
        }
        
        if (snap.exists()) {
            const data = snap.data();
            const paid = Number(data.receivedPaid ?? data.totalPaid ?? data.paid ?? 0); // MAINTENANCE_RECEIPT_UI
            lbl.className = "charge-current";
            lbl.innerHTML = `(платено <span class="value-green">${paid.toFixed(2)} ${currency}</span>${balanceStr})`;
        } else {
            lbl.className = "charge-current";
            lbl.innerHTML = `(платено 0.00 ${currency}${balanceStr})`;
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        try {
            assertRefreshContextCurrent(e);
        } catch (contextError) {
            if (isStaleRouteRequestError(contextError)) return;
            throw contextError;
        }
        lbl.className = "charge-current";
        lbl.innerText = "";
    }
};

// ==============================================
// КРЕДИТНИ ЗАДЪЛЖЕНИЯ (creditLiabilitiesV2) — паралелен регистър, НЕ пипа
// формулите/Салдото на апартаментите. Проследява отделно кой колко дължи
// по взет кредит, независимо от обичайния оперативен баланс.
// ==============================================
async function addCreditLiabilityDelta_(operationContext, originalDelta, remainingDelta) {
    assertFinancialOperationContextCurrent(operationContext);
    if (typeof operationContext.apartment !== "string" || !operationContext.apartment) {
        throw new TypeError("Credit liability operation requires an apartment-bound context");
    }
    const operationRouteKey = operationContext.routeKey;
    const operationApartment = operationContext.apartment;
    const pin = sessionStorage.getItem("adminAuth_" + operationRouteKey) || getStoredPin();
    const res = await apiCall('saveCreditLiabilityV2', {
        routeKey: operationRouteKey,
        pin: pin,
        request: JSON.stringify({
            apartment: operationApartment,
            originalDelta: originalDelta,
            remainingDelta: remainingDelta
        })
    }, operationContext);
    assertFinancialOperationContextCurrent(operationContext);
    assertSuccessfulApiResult(res, "Записването на кредитното задължение");
}

window.loadCreditLiabilitiesRegister = async function(operationContext) {
    operationContext = operationContext || captureFinancialOperationContext();
    const tbody = document.getElementById("creditLiabilitiesTableBody");
    if (!tbody || !window.fb || !window.fb.getDocs) return;

    tbody.innerHTML = '<tr><td colspan="3" style="text-align:center;">Зареждане...</td></tr>';
    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;
        const q = query(collection(db, "creditLiabilitiesV2"), where("routeKey", "==", operationContext.routeKey));
        const snap = await getDocs(q);
        assertFinancialOperationContextCurrent(operationContext);
        let records = [];
        snap.forEach(d => records.push(d.data()));
        records = records.filter(r => (parseFloat(r.original) || 0) > 0);
        records.sort((a, b) => (a.apt || "").localeCompare(b.apt || "", undefined, { numeric: true }));

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding:15px; color:#666;">Няма кредитни задължения.</td></tr>';
            return;
        }

        let html = "";
        records.forEach(r => {
            const original = parseFloat(r.original) || 0;
            const remaining = parseFloat(r.remaining) || 0;
            const paid = original - remaining;
            const statusColor = remaining <= 0 ? '#16a34a' : '#b45309';
            html += `
                <tr>
                    <td style="padding:8px; border-bottom:1px solid #eee;">Ап. ${r.apt}</td>
                    <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">${original.toFixed(2)}</td>
                    <td style="padding:8px; border-bottom:1px solid #eee; text-align:right;">${paid.toFixed(2)}</td>
                    <td style="padding:8px; border-bottom:1px solid #eee; text-align:right; font-weight:700; color:${statusColor};">${remaining.toFixed(2)}</td>
                </tr>`;
        });
        tbody.innerHTML = html;
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        assertFinancialOperationContextCurrent(operationContext, e);
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="3" style="text-align:center; color:red;">Грешка: ${e.message}</td></tr>`;
    }
};

// Показва "Дължимо по кредит" за КОНКРЕТЕН апартамент в личния му изглед
// (отделно от Салдо-то по-горе, не влияе на изчисленията там).
// Попълва dropdown-и за диапазонна справка (последните 5 год. + текущата)
function populateRangeReportSelects(fromId, toId) {
    const fromEl = document.getElementById(fromId);
    const toEl = document.getElementById(toId);
    if (!fromEl || !toEl || fromEl.options.length > 0) return; // вече е попълнено

    const now = new Date();
    const monthNames = ["Януари", "Февруари", "Март", "Април", "Май", "Юни", "Юли", "Август", "Септември", "Октомври", "Ноември", "Декември"];
    for (let y = now.getFullYear() - 5; y <= now.getFullYear(); y++) {
        for (let m = 1; m <= 12; m++) {
            const val = String(m).padStart(2, '0') + "." + y;
            const label = monthNames[m - 1] + " " + y;
            fromEl.appendChild(new Option(label, val));
            toEl.appendChild(new Option(label, val));
        }
    }
    const currentPeriod = String(now.getMonth() + 1).padStart(2, '0') + "." + now.getFullYear();
    fromEl.value = currentPeriod;
    toEl.value = currentPeriod;
}

// Справка от период до период за КОНКРЕТЕН апартамент (личен изглед)
// Справка от период до период за ЦЕЛИЯ ВХОД (админ панел)
window.calcEntranceRangeReport = async function() {
    const requestContext = captureRouteRequestContext();
    const fromPeriod = document.getElementById("adminRangeFrom").value;
    const toPeriod = document.getElementById("adminRangeTo").value;
    const resultEl = document.getElementById("adminRangeReportResult");
    const btn = document.getElementById("adminRangeReportBtn");

    if (!fromPeriod || !toPeriod) {
        resultEl.innerHTML = '<span style="color:red;">Моля, изберете двата периода.</span>';
        return;
    }
    if (periodToSortableClient(fromPeriod) > periodToSortableClient(toPeriod)) {
        resultEl.innerHTML = '<span style="color:red;">Началният период трябва да е преди крайния.</span>';
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = "Изпращане..."; }
    resultEl.innerHTML = "Подготвяне на подробната справка и изпращане по имейл...";

    try {
        const res = await apiCall('sendRangeReportEmail', {
            pin: getStoredPin(),
            fromPeriod: fromPeriod,
            toPeriod: toPeriod
        });

        throwIfStaleRouteRequestContext(requestContext);
        if (res && res.success) {
            resultEl.innerHTML = `<span style="color:#16a34a;">✅ ${res.message}</span>`;
        } else {
            resultEl.innerHTML = `<span style="color:red;">${(res && res.error) || 'Възникна грешка при изпращането.'}</span>`;
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        resultEl.innerHTML = `<span style="color:red;">Грешка: ${e.message}</span>`;
    } finally {
        if (isCurrentRouteRequestContext(requestContext) && btn) { btn.disabled = false; btn.textContent = "Изпрати по имейл"; }
    }
};

window.calcApartmentRangeReport = async function() {
    const requestContext = captureRouteRequestContext();
    const fromPeriod = document.getElementById("aptRangeFrom").value;
    const toPeriod = document.getElementById("aptRangeTo").value;
    const resultEl = document.getElementById("aptRangeReportResult");
    const apt = document.getElementById("apartmentSelect") ? document.getElementById("apartmentSelect").value : null;

    if (!fromPeriod || !toPeriod || !apt) {
        resultEl.innerHTML = '<span style="color:red;">Моля, изберете апартамент и двата периода.</span>';
        return;
    }
    if (periodToSortableClient(fromPeriod) > periodToSortableClient(toPeriod)) {
        resultEl.innerHTML = '<span style="color:red;">Началният период трябва да е преди крайния.</span>';
        return;
    }
    if (!window.fb || !window.fb.getDocs) {
        resultEl.innerHTML = '<span style="color:red;">Firebase не е зареден.</span>';
        return;
    }

    resultEl.innerHTML = "Изчисляване...";
    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;
        const q = query(collection(db, "monthlyReports"), where("buildingId", "==", currentRouteKey), where("apartmentId", "==", apt));
        const snap = await getDocs(q);
        throwIfStaleRouteRequestContext(requestContext);

        let totalDue = 0, totalPaid = 0, monthsCount = 0;
        const fromN = periodToSortableClient(fromPeriod);
        const toN = periodToSortableClient(toPeriod);
        snap.forEach(d => {
            const r = d.data();
            const pN = periodToSortableClient(r.periodId);
            if (pN >= fromN && pN <= toN) {
                totalDue += parseFloat(r.totalDue) || 0;
                totalPaid += parseFloat(r.totalPaid) || 0;
                monthsCount++;
            }
        });

        const currency = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
        const diff = totalDue - totalPaid;
        const diffColor = diff > 0.01 ? "value-red" : "value-green";
        resultEl.innerHTML = `
            <div style="display:flex; flex-direction:column; gap:4px;">
                <div>Периоди в диапазона: <strong>${monthsCount}</strong></div>
                <div>Общо начислено: <strong>${totalDue.toFixed(2)} ${currency}</strong></div>
                <div>Общо платено: <strong class="value-green">${totalPaid.toFixed(2)} ${currency}</strong></div>
                <div>Разлика за диапазона: <strong class="${diffColor}">${diff.toFixed(2)} ${currency}</strong></div>
            </div>
        `;
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        resultEl.innerHTML = `<span style="color:red;">Грешка: ${e.message}</span>`;
    }
};

window.loadApartmentCreditLiability = async function(apartment) {
    const requestContext = captureRouteRequestContext();
    const box = document.getElementById("creditLiabilityBox");
    const amountEl = document.getElementById("creditLiabilityAmount");
    if (!box || !amountEl || !window.fb || !window.fb.getDoc) {
        if (box) box.style.display = "none";
        return;
    }
    try {
        const { routeDoc, getDoc } = window.fb;
        const db = window.db;
        const ref = routeDoc(db, "creditLiabilitiesV2", currentRouteKey + "_" + apartment, currentRouteKey);
        const snap = await getDoc(ref);
        throwIfStaleRouteRequestContext(requestContext);
        if (snap.exists()) {
            const remaining = parseFloat(snap.data().remaining) || 0;
            if (remaining > 0) {
                const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
                amountEl.textContent = remaining.toFixed(2) + " " + cur;
                box.style.display = "block";
                return;
            }
        }
        box.style.display = "none";
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        box.style.display = "none";
    }
};

window.submitIncomeV2 = async function() {
    if (typeof submitApartmentFin01IfActive_ === 'function' && await submitApartmentFin01IfActive_()) return; // FIN01_UI
    const period = document.getElementById("v2IncomePeriod").value;
    const apt = document.getElementById("v2IncomeApt").value;
    const category = document.getElementById("v2IncomeCategory").value;
    const amountStr = document.getElementById("v2IncomeAmount").value;
    const docNum = document.getElementById("v2IncomeDoc").value.trim();
    const note = document.getElementById("v2IncomeNote").value.trim();
    const editId = document.getElementById("v2IncomeEditId").value;
    const operationContext = captureFinancialOperationContext(apt, editId);
    const operationPin = sessionStorage.getItem("adminAuth_" + operationContext.routeKey);
    const operationApartmentList = snapshotFinancialApartmentList_(apartmentList);

    if (!period || !apt || !category || !amountStr) {
        showToast("Моля, попълнете Период, Платец, Категория и Сума.", "error");
        return;
    }

    if (typeof amountStr === 'string' && amountStr.includes(',')) {
        showToast("Използвайте точка (.) за десетични стойности.", "error");
        return;
    }

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount === 0) {
        showToast("Невалидна сума.", "error");
        return;
    }

    const extUnitSelEl = document.getElementById("v2IncomeExtUnit");
    const selectedExtUnitId = ((apt === "EXTERNAL_UNIT" || apt === "EXTERNAL") && extUnitSelEl) ? extUnitSelEl.value : "";

    if (apt === "EXTERNAL_UNIT" || (apt === "EXTERNAL" && selectedExtUnitId)) {
        if (!selectedExtUnitId) {
            showToast("Моля, изберете самостоятелен обект.", "error");
            return;
        }
        if (amount <= 0) {
            showToast("За самостоятелен обект въведете положителна сума (за корекция използвайте Сторно в Регистър Приходи).", "error");
            return;
        }
        if (editId) {
            showToast("Прието плащане на самостоятелен обект не се редактира. Използвайте Сторно.", "error");
            return;
        }

        const extPendingKey = 'extUnitPendingV1_' + operationContext.routeKey;
        const readExtPending = () => {
            try {
                const raw = sessionStorage.getItem(extPendingKey);
                return raw ? JSON.parse(raw) : null;
            } catch (e) { return null; }
        };
        const writeExtPending = (val) => {
            try {
                if (val) sessionStorage.setItem(extPendingKey, JSON.stringify(val));
                else sessionStorage.removeItem(extPendingKey);
            } catch (e) {}
        };
        // BLOCKER C + BLOCKER D (v57): Mandatory 4-component validator + complete verified pre-POST persistence
        const extUnitValidateExpectedComponents_ = window.extUnitValidateExpectedComponents_ || function(ec, expectedAmountCents) {
            if (!ec || typeof ec !== 'object' || Array.isArray(ec)) {
                return { ok: false, code: 'PENDING_COMPONENTS_REQUIRED', error: 'Липсва задължителната разбивка по финансови компоненти (expectedComponents).' };
            }
            const reqKeys = ['rupBaseCents', 'rupSurchargeCents', 'repairFundCents', 'contractRentCents'];
            const norm = {};
            let sum = 0;
            for (const k of reqKeys) {
                const rawV = ec[k];
                if (rawV === undefined || rawV === null || rawV === '' || typeof rawV === 'boolean') {
                    return { ok: false, code: 'PENDING_COMPONENTS_MISSING_FIELD', error: 'Липсва задължителен финансов компонент: ' + k };
                }
                const n = Number(rawV);
                if (!Number.isSafeInteger(n) || n < 0) {
                    return { ok: false, code: 'PENDING_COMPONENTS_INVALID_CENTS', error: 'Невалидна стойност в евроцентове за ' + k };
                }
                norm[k] = n;
                sum += n;
            }
            let adv = 0;
            if (ec.unallocatedAdvanceCents !== undefined && ec.unallocatedAdvanceCents !== null && ec.unallocatedAdvanceCents !== '') {
                if (typeof ec.unallocatedAdvanceCents === 'boolean') {
                    return { ok: false, code: 'PENDING_COMPONENTS_INVALID_CENTS', error: 'Невалидна стойност за unallocatedAdvanceCents' };
                }
                adv = Number(ec.unallocatedAdvanceCents);
                if (!Number.isSafeInteger(adv) || adv < 0) {
                    return { ok: false, code: 'PENDING_COMPONENTS_INVALID_CENTS', error: 'Невалидна стойност за unallocatedAdvanceCents' };
                }
            }
            norm.unallocatedAdvanceCents = adv;
            if (expectedAmountCents !== undefined && expectedAmountCents !== null) {
                if (!Number.isSafeInteger(Number(expectedAmountCents)) || sum + adv !== Number(expectedAmountCents)) {
                    return { ok: false, code: 'PENDING_COMPONENTS_SUM_MISMATCH', error: 'Сборът на финансовите компоненти не съвпада с общата сума.' };
                }
            }
            return { ok: true, components: norm };
        };
        window.extUnitValidateExpectedComponents_ = extUnitValidateExpectedComponents_;

        const extUnitPersistPendingVerified_ = window.extUnitPersistPendingVerified_ || function(storage, key, pendingObj) {
            const validateComp_ = function(ec, expCents) {
                if (!ec || typeof ec !== 'object' || Array.isArray(ec)) return { ok: false, code: 'PENDING_COMPONENTS_REQUIRED', error: 'Липсва задължителната разбивка по финансови компоненти (expectedComponents).' };
                const reqKeys = ['rupBaseCents', 'rupSurchargeCents', 'repairFundCents', 'contractRentCents'];
                const norm = {};
                let sum = 0;
                for (const k of reqKeys) {
                    const rawV = ec[k];
                    if (rawV === undefined || rawV === null || rawV === '' || typeof rawV === 'boolean') return { ok: false, code: 'PENDING_COMPONENTS_MISSING_FIELD', error: 'Липсва задължителен финансов компонент: ' + k };
                    const n = Number(rawV);
                    if (!Number.isSafeInteger(n) || n < 0) return { ok: false, code: 'PENDING_COMPONENTS_INVALID_CENTS', error: 'Невалидна стойност в евроцентове за ' + k };
                    norm[k] = n;
                    sum += n;
                }
                let adv = 0;
                if (ec.unallocatedAdvanceCents !== undefined && ec.unallocatedAdvanceCents !== null && ec.unallocatedAdvanceCents !== '') {
                    if (typeof ec.unallocatedAdvanceCents === 'boolean') return { ok: false, code: 'PENDING_COMPONENTS_INVALID_CENTS', error: 'Невалидна стойност за unallocatedAdvanceCents' };
                    adv = Number(ec.unallocatedAdvanceCents);
                    if (!Number.isSafeInteger(adv) || adv < 0) return { ok: false, code: 'PENDING_COMPONENTS_INVALID_CENTS', error: 'Невалидна стойност за unallocatedAdvanceCents' };
                }
                norm.unallocatedAdvanceCents = adv;
                if (!Number.isSafeInteger(Number(expCents)) || sum + adv !== Number(expCents)) return { ok: false, code: 'PENDING_COMPONENTS_SUM_MISMATCH', error: 'Сборът на финансовите компоненти не съвпада с общата сума.' };
                return { ok: true, components: norm };
            };
            if (!storage || typeof storage.setItem !== 'function' || typeof storage.getItem !== 'function') {
                return { ok: false, code: 'PENDING_STORAGE_UNAVAILABLE', error: 'Локалното хранилище (sessionStorage) не е достъпно.' };
            }
            if (!pendingObj || typeof pendingObj !== 'object' || Array.isArray(pendingObj)) {
                return { ok: false, code: 'PENDING_PAYLOAD_INCOMPLETE', error: 'Непълен пакет за възстановяване преди изпращане.' };
            }
            if (!pendingObj.paymentId || !pendingObj.routeKey || !pendingObj.unitId || !pendingObj.period ||
                !Number.isSafeInteger(Number(pendingObj.amountCents)) || Number(pendingObj.amountCents) <= 0 ||
                !pendingObj.category || !Number.isSafeInteger(Number(pendingObj.timestamp)) || Number(pendingObj.timestamp) <= 0 ||
                !/^[0-9a-f]{64}$/.test(String(pendingObj.requestFingerprint || ''))) {
                return { ok: false, code: 'PENDING_PAYLOAD_INCOMPLETE', error: 'Липсват задължителни полета за финансова идентичност преди изпращане.' };
            }
            if (pendingObj.uiState !== 'AMBIGUOUS_UNKNOWN') {
                return { ok: false, code: 'PENDING_UISTATE_REQUIRED', error: 'Липсва или е невалидно състоянието за възстановяване (uiState).' };
            }
            const compCheck = validateComp_(pendingObj.expectedComponents, pendingObj.amountCents);
            if (!compCheck.ok) {
                return { ok: false, code: compCheck.code, error: compCheck.error };
            }
            let serialized;
            try {
                serialized = JSON.stringify(pendingObj);
                storage.setItem(key, serialized);
            } catch (e) {
                return { ok: false, code: 'PENDING_STORAGE_WRITE_FAILED', error: 'Неуспешен запис в локалното хранилище: ' + String(e && e.message || e) };
            }
            let readBackRaw;
            let readBack;
            try {
                readBackRaw = storage.getItem(key);
                if (!readBackRaw) {
                    return { ok: false, code: 'PENDING_STORAGE_READBACK_EMPTY', error: 'Записът не може да бъде прочетен обратно от локалното хранилище.' };
                }
                readBack = JSON.parse(readBackRaw);
            } catch (e) {
                return { ok: false, code: 'PENDING_STORAGE_READBACK_CORRUPT', error: 'Повреден запис при обратно прочитане от локалното хранилище.' };
            }
            const coreMatch = Boolean(readBack && typeof readBack === 'object') &&
                readBack.paymentId === pendingObj.paymentId &&
                readBack.routeKey === pendingObj.routeKey &&
                readBack.unitId === pendingObj.unitId &&
                readBack.period === pendingObj.period &&
                Number(readBack.amountCents) === Number(pendingObj.amountCents) &&
                readBack.category === pendingObj.category &&
                Number(readBack.timestamp) === Number(pendingObj.timestamp) &&
                readBack.requestFingerprint === pendingObj.requestFingerprint &&
                readBack.uiState === pendingObj.uiState;
            if (!coreMatch) {
                return { ok: false, code: 'PENDING_STORAGE_READBACK_MISMATCH', error: 'Несъответствие при верификация на локално запазения запис за възстановяване.' };
            }
            const rbCompCheck = validateComp_(readBack.expectedComponents, readBack.amountCents);
            if (!rbCompCheck.ok) {
                return { ok: false, code: 'PENDING_STORAGE_READBACK_COMPONENTS_MISMATCH', error: 'Невалидни финансови компоненти при обратно прочитане.' };
            }
            const ec = compCheck.components;
            const rc = rbCompCheck.components;
            if (rc.rupBaseCents !== ec.rupBaseCents ||
                rc.rupSurchargeCents !== ec.rupSurchargeCents ||
                rc.repairFundCents !== ec.repairFundCents ||
                rc.contractRentCents !== ec.contractRentCents ||
                rc.unallocatedAdvanceCents !== ec.unallocatedAdvanceCents) {
                return { ok: false, code: 'PENDING_STORAGE_READBACK_COMPONENTS_MISMATCH', error: 'Несъответствие на финансовите компоненти при обратно прочитане.' };
            }
            return { ok: true, pending: readBack };
        };
        window.extUnitPersistPendingVerified_ = extUnitPersistPendingVerified_;
        // BLOCKER C: Synchronous UTF-8 SHA-256 matching backend manualExpenseSha256_ byte-for-byte
        const extUnitSha256Hex_ = window.extUnitSha256Hex_ || function(str) {
            const bytes = (typeof TextEncoder !== 'undefined')
                ? new TextEncoder().encode(String(str))
                : (function(s) {
                    const out = [];
                    for (let i = 0; i < s.length; i++) {
                        let c = s.charCodeAt(i);
                        if (c < 0x80) out.push(c);
                        else if (c < 0x800) { out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f)); }
                        else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
                            const c2 = s.charCodeAt(++i);
                            const cp = 0x10000 + (((c & 0x3ff) << 10) | (c2 & 0x3ff));
                            out.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
                        } else {
                            out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
                        }
                    }
                    return new Uint8Array(out);
                })(String(str));
            const K = [
                0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
                0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
                0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
                0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
                0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
                0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
                0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
                0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
            ];
            const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
            const bitLen = bytes.length * 8;
            const paddedLen = (((bytes.length + 9 + 63) >> 6) << 6);
            const padded = new Uint8Array(paddedLen);
            padded.set(bytes);
            padded[bytes.length] = 0x80;
            const view = new DataView(padded.buffer);
            view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x100000000), false);
            view.setUint32(paddedLen - 4, bitLen >>> 0, false);
            const W = new Uint32Array(64);
            for (let off = 0; off < paddedLen; off += 64) {
                for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4, false);
                for (let i = 16; i < 64; i++) {
                    const s0 = ((W[i-15] >>> 7) | (W[i-15] << 25)) ^ ((W[i-15] >>> 18) | (W[i-15] << 14)) ^ (W[i-15] >>> 3);
                    const s1 = ((W[i-2] >>> 17) | (W[i-2] << 15)) ^ ((W[i-2] >>> 19) | (W[i-2] << 13)) ^ (W[i-2] >>> 10);
                    W[i] = (W[i-16] + s0 + W[i-7] + s1) >>> 0;
                }
                let a=H[0],b=H[1],c=H[2],d=H[3],e=H[4],f=H[5],g=H[6],h=H[7];
                for (let i = 0; i < 64; i++) {
                    const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
                    const ch = (e & f) ^ ((~e) & g);
                    const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0;
                    const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
                    const maj = (a & b) ^ (a & c) ^ (b & c);
                    const t2 = (S0 + maj) >>> 0;
                    h=g; g=f; f=e; e=(d + t1) >>> 0; d=c; c=b; b=a; a=(t1 + t2) >>> 0;
                }
                H[0]=(H[0]+a)>>>0; H[1]=(H[1]+b)>>>0; H[2]=(H[2]+c)>>>0; H[3]=(H[3]+d)>>>0;
                H[4]=(H[4]+e)>>>0; H[5]=(H[5]+f)>>>0; H[6]=(H[6]+g)>>>0; H[7]=(H[7]+h)>>>0;
            }
            return H.map(x => x.toString(16).padStart(8, '0')).join('');
        };
        window.extUnitSha256Hex_ = extUnitSha256Hex_;

        const extUnitBuildCanonicalRequestFingerprint_ = window.extUnitBuildCanonicalRequestFingerprint_ || function(raw) {
            const unitId = String((raw && raw.unitId) || '').trim().toUpperCase();
            const period = String((raw && raw.period) || '').trim();
            let amountCents = 0;
            if (raw && raw.amountCents !== undefined && raw.amountCents !== null && Number.isSafeInteger(Number(raw.amountCents))) {
                amountCents = Number(raw.amountCents);
            } else if (raw && raw.amount !== undefined && raw.amount !== null && raw.amount !== '') {
                const s = String(raw.amount).trim().replace(',', '.');
                const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
                if (m) {
                    const whole = Number(m[2]);
                    const frac = m[3] ? Number((m[3] + '00').slice(0, 2)) : 0;
                    amountCents = (m[1] ? -1 : 1) * (whole * 100 + frac);
                } else {
                    amountCents = Math.round(Number(raw.amount) * 100);
                }
            }
            const requestedCategory = String((raw && raw.category) || 'Плащане за СО').trim();
            const rawNote = String((raw && raw.note) || '').trim();
            const basis = (raw && raw.basis !== undefined) ? String(raw.basis).trim() : rawNote;
            const docNum = String((raw && raw.docNum) || '').trim();
            const reversesPaymentId = String((raw && raw.reversesPaymentId) || '').trim();
            return extUnitSha256Hex_(JSON.stringify({
                unitId: unitId,
                period: period,
                amountCents: amountCents,
                requestedCategory: requestedCategory,
                basis: basis,
                docNum: docNum,
                rawNote: rawNote,
                reversesPaymentId: reversesPaymentId
            }));
        };
        window.extUnitBuildCanonicalRequestFingerprint_ = extUnitBuildCanonicalRequestFingerprint_;

        const extUnitPreparePendingPayment_ = window.extUnitPreparePendingPayment_ || function(params) {
            const ts = params.timestamp || new Date().getTime();
            const unitId = String(params.unitId || '').trim().toUpperCase();
            const paymentId = params.paymentId || ('manual_' + ts + '_' + unitId);
            const amountNum = Number(params.amount);
            const amountCents = Math.round(amountNum * 100);
            const category = String(params.category || 'Плащане за СО').trim();
            const noteStr = String(params.note || '').trim();
            const basisStr = params.basis !== undefined ? String(params.basis).trim() : noteStr;
            const docNumStr = String(params.docNum || '').trim();
            const reqPayload = {
                routeKey: params.routeKey,
                paymentId: paymentId,
                unitId: unitId,
                period: String(params.period || '').trim(),
                category: category,
                amount: amountNum,
                docNum: docNumStr,
                note: noteStr,
                basis: basisStr,
                source: params.source || 'manual',
                timestamp: ts,
                expectedDebtFingerprint: params.expectedDebtFingerprint || undefined,
                skipIncomeWrite: Boolean(params.skipIncomeWrite)
            };
            let expectedComponents = null;
            if (params.expectedComponents && typeof params.expectedComponents === 'object' && !Array.isArray(params.expectedComponents)) {
                const ec = params.expectedComponents;
                const keys = ['rupBaseCents', 'rupSurchargeCents', 'repairFundCents', 'contractRentCents'];
                let allValid = true;
                const norm = {};
                let sum = 0;
                for (const k of keys) {
                    if (ec[k] === undefined || ec[k] === null || ec[k] === '' || typeof ec[k] === 'boolean') { allValid = false; break; }
                    const n = Number(ec[k]);
                    if (!Number.isSafeInteger(n) || n < 0) { allValid = false; break; }
                    norm[k] = n;
                    sum += n;
                }
                const adv = (ec.unallocatedAdvanceCents !== undefined && ec.unallocatedAdvanceCents !== null && ec.unallocatedAdvanceCents !== '')
                    ? Number(ec.unallocatedAdvanceCents) : 0;
                if (allValid && Number.isSafeInteger(adv) && adv >= 0 && sum + adv === amountCents) {
                    norm.unallocatedAdvanceCents = adv;
                    expectedComponents = norm;
                }
            }
            const requestFingerprint = extUnitBuildCanonicalRequestFingerprint_(reqPayload);
            reqPayload.requestFingerprint = requestFingerprint;
            const pendingRecord = {
                routeKey: params.routeKey,
                paymentId: paymentId,
                unitId: unitId,
                period: reqPayload.period,
                amount: amountNum,
                amountCents: amountCents,
                category: category,
                docNum: docNumStr,
                note: noteStr,
                basis: basisStr,
                expectedComponents: expectedComponents,
                requestFingerprint: requestFingerprint,
                timestamp: ts,
                uiState: 'AMBIGUOUS_UNKNOWN'
            };
            return { reqPayload: reqPayload, pendingRecord: pendingRecord };
        };
        window.extUnitPreparePendingPayment_ = extUnitPreparePendingPayment_;

        const extUnitUiSuccess_ = window.extUnitUiSuccess_ || function(res, req) {
            const ALLOWED_EXT_COMPONENTS = ['rupBase', 'rupSurcharge', 'repairFund', 'contractRent'];
            if (!res || res.success !== true) return false;
            const finStatus = res.financialStatus || res.status;
            // BLOCKER D: Separate financial status from projection/overall status.
            // Proven financialStatus === 'APPLIED' is valid when overall status is 'APPLIED' or 'PARTIALLY_APPLIED' (projection lag/failure).
            if (finStatus !== 'APPLIED') return false;
            if (res.status !== 'APPLIED' && res.status !== 'PARTIALLY_APPLIED') return false;
            if (!req || res.paymentId !== req.paymentId) return false;
            if (req.routeKey && res.routeKey && res.routeKey !== req.routeKey) return false;
            if (!res.unitId || res.unitId !== req.unitId) return false;
            if (!res.period || res.period !== req.period) return false;
            // BLOCKER C: Mandatory canonical requestFingerprint match (never confirm blindly without fingerprint)
            const expectedFp = String((req && req.requestFingerprint) || '').trim();
            if (!expectedFp || !res.requestFingerprint || res.requestFingerprint !== expectedFp) return false;
            const expectedCents = Number.isSafeInteger(req.amountCents) ? req.amountCents : Math.round(Number(req.amount) * 100);
            const receivedCents = Number(res.receivedCents);
            const allocatedCents = Number(res.allocatedCents);
            const unallocatedCents = Number(res.unallocatedAdvanceCents || 0);
            if (!Number.isSafeInteger(receivedCents) || receivedCents !== expectedCents) return false;
            if (!Number.isSafeInteger(allocatedCents) || allocatedCents < 0) return false;
            if (!Number.isSafeInteger(unallocatedCents) || unallocatedCents < 0) return false;
            if (allocatedCents + unallocatedCents !== receivedCents) return false;
            if (!Array.isArray(res.allocations)) return false;
            let lineSum = 0;
            const actualByComp = { rupBase: 0, rupSurcharge: 0, repairFund: 0, contractRent: 0 };
            for (const l of res.allocations) {
                if (!l || !Number.isSafeInteger(l.amountCents) || l.amountCents <= 0) return false;
                if (!l.component || ALLOWED_EXT_COMPONENTS.indexOf(l.component) === -1) return false;
                lineSum += l.amountCents;
                actualByComp[l.component] += l.amountCents;
            }
            if (lineSum !== allocatedCents) return false;
            // BLOCKER C (v57): Mandatory exact 4-component validation (NEVER skip when expectedComponents is null/missing!)
            const ec = req.expectedComponents;
            if (!ec || typeof ec !== 'object' || Array.isArray(ec)) return false;
            const reqCompKeys = ['rupBaseCents', 'rupSurchargeCents', 'repairFundCents', 'contractRentCents'];
            for (const k of reqCompKeys) {
                if (ec[k] === undefined || ec[k] === null || ec[k] === '' || typeof ec[k] === 'boolean') return false;
                const n = Number(ec[k]);
                if (!Number.isSafeInteger(n) || n < 0) return false;
            }
            const expAdv = (ec.unallocatedAdvanceCents !== undefined && ec.unallocatedAdvanceCents !== null && ec.unallocatedAdvanceCents !== '')
                ? Number(ec.unallocatedAdvanceCents) : 0;
            if (!Number.isSafeInteger(expAdv) || expAdv < 0) return false;
            if (Number(ec.rupBaseCents) + Number(ec.rupSurchargeCents) + Number(ec.repairFundCents) + Number(ec.contractRentCents) + expAdv !== expectedCents) return false;
            if (actualByComp.rupBase !== Number(ec.rupBaseCents) ||
                actualByComp.rupSurcharge !== Number(ec.rupSurchargeCents) ||
                actualByComp.repairFund !== Number(ec.repairFundCents) ||
                actualByComp.contractRent !== Number(ec.contractRentCents) ||
                unallocatedCents !== expAdv) {
                return false;
            }
            return true;
        };
        window.extUnitUiSuccess_ = extUnitUiSuccess_;

        const extUnitConfirmationState_ = window.extUnitConfirmationState_ || function(receiptRes) {
            const proj = receiptRes && receiptRes.projectionSyncStatus ? String(receiptRes.projectionSyncStatus).toUpperCase() : 'COMPLETE';
            const summary = (receiptRes && receiptRes.allocationSummary) ? (' ' + receiptRes.allocationSummary) : '';
            if (proj === 'PENDING') {
                return {
                    state: 'CONFIRMED_PROJECTION_PENDING',
                    message: 'Плащането е потвърдено. Справките се обновяват.' + summary,
                    toast: 'Плащането е потвърдено. Справките се обновяват.',
                    toastType: 'success'
                };
            }
            if (proj === 'FAILED') {
                return {
                    state: 'CONFIRMED_PROJECTION_FAILED',
                    message: 'Плащането е потвърдено. Справките все още не са актуализирани.' + summary,
                    toast: 'Плащането е потвърдено. Справките все още не са актуализирани.',
                    toastType: 'neutral'
                };
            }
            return {
                state: 'CONFIRMED',
                message: 'Плащането е потвърдено.' + summary,
                toast: 'Плащането е потвърдено.',
                toastType: 'success'
            };
        };
        window.extUnitConfirmationState_ = extUnitConfirmationState_;

        const extUnitResolveStatusOutcome_ = window.extUnitResolveStatusOutcome_ || function(stRes, pendingReq) {
            if (!stRes || stRes.success !== true) {
                return { action: 'RETRY_STATUS', uiState: 'AMBIGUOUS_UNKNOWN' };
            }
            if (stRes.financialStatus === 'CONFLICT' || stRes.status === 'CONFLICT') {
                return { action: 'CONFLICT', uiState: 'CONFLICT' };
            }
            const candidateReceipt = stRes.receipt
                ? Object.assign({}, stRes.receipt, {
                    routeKey: stRes.receipt.routeKey || stRes.routeKey,
                    financialStatus: stRes.receipt.financialStatus || stRes.financialStatus,
                    projectionSyncStatus: stRes.receipt.projectionSyncStatus || stRes.projectionSyncStatus
                })
                : null;
            const financiallyApplied = (stRes.financialStatus === 'APPLIED') ||
                (candidateReceipt && candidateReceipt.financialStatus === 'APPLIED');
            if (financiallyApplied && candidateReceipt) {
                if (!pendingReq || !pendingReq.requestFingerprint || candidateReceipt.requestFingerprint !== pendingReq.requestFingerprint) {
                    return { action: 'CONFLICT', uiState: 'CONFLICT', reason: 'REQUEST_FINGERPRINT_MISMATCH' };
                }
                if (extUnitUiSuccess_(candidateReceipt, pendingReq)) {
                    return {
                        action: 'CONFIRM_PAYMENT',
                        receipt: candidateReceipt,
                        confirmation: extUnitConfirmationState_(candidateReceipt)
                    };
                }
                return { action: 'CONFLICT', uiState: 'CONFLICT', reason: 'RECEIPT_IDENTITY_MISMATCH' };
            }
            return { action: 'RECOVERY_REQUIRED', uiState: 'RECOVERY_REQUIRED' };
        };
        window.extUnitResolveStatusOutcome_ = extUnitResolveStatusOutcome_;

        const btn = document.getElementById("v2SubmitBtn");
        const feedbackEl = document.getElementById("fin01PaymentFeedback");
        let pending = readExtPending();
        if (pending && (pending.unitId !== selectedExtUnitId || pending.period !== period || Math.round(Number(pending.amount) * 100) !== Math.round(amount * 100))) {
            // Different payment while previous is unresolved -> check previous status first or clear if idle
            if (pending.uiState !== 'AMBIGUOUS_UNKNOWN' && pending.uiState !== 'RECOVERY_REQUIRED') {
                pending = null;
                writeExtPending(null);
            }
        }

        const isStatusCheckStep = Boolean(pending && pending.uiState === 'AMBIGUOUS_UNKNOWN');
        btn.disabled = true;
        btn.textContent = isStatusCheckStep ? "Проверка на статуса..." : "Записване...";

        const completeExtConfirmation = async (receiptRes) => {
            writeExtPending(null);
            window._currentExtPaymentId = null;
            window._currentExtPaymentUnitId = null;
            window._lastExtPaymentPreviewFingerprint = null;
            window._lastExtPaymentPreviewComponents = null;
            document.getElementById("v2IncomeAmount").value = "";
            document.getElementById("v2IncomeDoc").value = "";
            document.getElementById("v2IncomeNote").value = "";
            const previewBox = document.getElementById("extUnitPaymentPreviewBox");
            if (previewBox) previewBox.style.display = "none";
            const conf = extUnitConfirmationState_(receiptRes);
            if (feedbackEl) {
                feedbackEl.setAttribute('data-ext-state', conf.state);
                feedbackEl.textContent = conf.message;
            }
            showToast(conf.toast, conf.toastType, 4000);
            if (typeof loadExternalUnitsData === 'function') await loadExternalUnitsData(true);
            await loadIncomesV2(operationContext);
            await v2LoadPaymentDue(operationContext);
            if (typeof loadDashboardData === 'function') Promise.resolve(loadDashboardData()).catch(() => {});
            if (typeof updateV2DistAvailableSum === 'function') await updateV2DistAvailableSum();
        };

        try {
            assertFinancialOperationContextCurrent(operationContext);

            // PHASE 0.1 (P0.2 + Blocker D + Blocker C): On ambiguous/lost-response state, ALWAYS perform read-only status check FIRST
            // using the canonical requestFingerprint persisted BEFORE the first POST!
            if (isStatusCheckStep) {
                const pendingFp = String((pending && pending.requestFingerprint) || '').trim();
                const pendingCompCheck = extUnitValidateExpectedComponents_(pending && pending.expectedComponents, pending && pending.amountCents);
                if (!pendingFp || !pendingCompCheck.ok) {
                    pending.uiState = 'CONFLICT';
                    writeExtPending(pending);
                    if (feedbackEl) {
                        feedbackEl.setAttribute('data-ext-state', 'CONFLICT');
                        feedbackEl.textContent = !pendingFp
                            ? 'Липсва каноничен отпечатък (requestFingerprint) за чакащото плащане. Изисква се административна проверка.'
                            : 'Липсва валидна разбивка по финансови компоненти (expectedComponents) за чакащото плащане. Изисква се административна проверка.';
                    }
                    showToast("Непълна финансова идентичност за чакащото плащане.", "error");
                    return;
                }
                const stRes = await apiCall('externalUnitPaymentStatus', {
                    routeKey: operationContext.routeKey,
                    pin: operationPin,
                    request: JSON.stringify({
                        paymentId: pending.paymentId,
                        routeKey: pending.routeKey || operationContext.routeKey,
                        unitId: pending.unitId,
                        period: pending.period,
                        amount: pending.amount,
                        amountCents: pending.amountCents,
                        expectedComponents: pendingCompCheck.components,
                        expectedRequestFingerprint: pendingFp,
                        requireFingerprint: true,
                        requireComponents: true
                    })
                }, operationContext);
                assertFinancialOperationContextCurrent(operationContext);
                const outcome = extUnitResolveStatusOutcome_(stRes, pending);
                if (outcome.action === 'RETRY_STATUS') {
                    if (feedbackEl) {
                        feedbackEl.setAttribute('data-ext-state', 'AMBIGUOUS_UNKNOWN');
                        feedbackEl.textContent = 'Статусът не може да бъде проверен в момента. Опитайте „Провери статуса“ отново.';
                    }
                    showToast("Статусът не може да бъде проверен. Опитайте „Провери статуса“ отново.", "error");
                    return;
                }
                if (outcome.action === 'CONFIRM_PAYMENT') {
                    // BLOCKER D: Financial payment is proven APPLIED (even if overall status is PARTIALLY_APPLIED with PENDING/FAILED projection).
                    // Confirm payment immediately and NEVER initiate a second financial payment or prompt "Възстанови същото плащане".
                    await completeExtConfirmation(outcome.receipt);
                    return;
                }
                if (outcome.action === 'CONFLICT') {
                    pending.uiState = 'CONFLICT';
                    writeExtPending(pending);
                    if (feedbackEl) {
                        feedbackEl.setAttribute('data-ext-state', 'CONFLICT');
                        feedbackEl.textContent = 'Конфликт на идентификатор: заявката изисква административна проверка.';
                    }
                    showToast("Конфликт на идентификатор за плащането.", "error");
                    return;
                }
                // PREPARED or NOT_FOUND (unproven financial commit) -> allow safe same-ID recovery
                pending.uiState = 'RECOVERY_REQUIRED';
                writeExtPending(pending);
                if (feedbackEl) {
                    feedbackEl.setAttribute('data-ext-state', 'RECOVERY_REQUIRED');
                    feedbackEl.textContent = stRes.message || 'Натиснете „Възстанови същото плащане“, за да приключите безопасно със същия идентификатор.';
                }
                showToast("Статусът е проверен. Натиснете „Възстанови същото плащане“ със същия идентификатор.", "neutral");
                return;
            }

            const ts = (pending && pending.timestamp) ? pending.timestamp : new Date().getTime();
            const extPayId = (pending && pending.paymentId)
                ? pending.paymentId
                : ((window._currentExtPaymentId && window._currentExtPaymentUnitId === selectedExtUnitId)
                    ? window._currentExtPaymentId
                    : ('manual_' + ts + '_' + selectedExtUnitId));
            window._currentExtPaymentId = extPayId;
            window._currentExtPaymentUnitId = selectedExtUnitId;

            const prepared = extUnitPreparePendingPayment_({
                routeKey: operationContext.routeKey,
                paymentId: extPayId,
                unitId: selectedExtUnitId,
                period: period,
                category: "Плащане за СО",
                amount: amount,
                docNum: docNum,
                note: note,
                basis: note,
                source: 'manual',
                timestamp: ts,
                expectedComponents: window._lastExtPaymentPreviewComponents || undefined,
                expectedDebtFingerprint: window._lastExtPaymentPreviewFingerprint || undefined,
                skipIncomeWrite: false
            });
            const reqPayload = prepared.reqPayload;
            pending = prepared.pendingRecord;
            const persistCheck = extUnitPersistPendingVerified_(sessionStorage, extPendingKey, pending);
            if (!persistCheck || !persistCheck.ok) {
                window._currentExtPaymentId = null;
                window._currentExtPaymentUnitId = null;
                const msg = 'Плащането НЕ е изпратено: неуспешно локално съхранение на данните за възстановяване (' + ((persistCheck && persistCheck.code) || 'STORAGE_ERROR') + '). Моля, опитайте отново.';
                if (feedbackEl) {
                    feedbackEl.setAttribute('data-ext-state', 'NOT_SENT_STORAGE_ERROR');
                    feedbackEl.textContent = msg;
                }
                showToast(msg, 'error', 6000);
                return;
            }

            const payRes = await apiCall('recordExternalUnitPaymentV1', {
                routeKey: operationContext.routeKey,
                pin: operationPin,
                request: JSON.stringify(reqPayload)
            }, operationContext);
            assertFinancialOperationContextCurrent(operationContext);
            if (payRes && payRes.success === false) {
                const errText = String(payRes.error || '');
                // Proven pre-commit validation/stale errors clear pending; conflicts lock; unknown errors keep AMBIGUOUS_UNKNOWN
                if (errText.indexOf('EXT_UNIT_PAYMENT_CONFLICT') !== -1) {
                    pending.uiState = 'CONFLICT';
                    writeExtPending(pending);
                } else if (errText.indexOf('EXT_UNIT_STALE_PREVIEW') !== -1 || errText.indexOf('EXT_UNIT_PAYMENT_VALIDATION') !== -1 || errText.indexOf('EXT_UNIT_NOT_FOUND') !== -1 || errText.indexOf('EXT_UNIT_CONTRADICTORY_BASIS') !== -1) {
                    writeExtPending(null);
                    window._currentExtPaymentId = null;
                }
                throw new Error(errText || "Грешка при запис на плащане за самостоятелен обект.");
            }
            if (!extUnitUiSuccess_(payRes, reqPayload)) {
                throw new Error("Отговорът от сървъра не съдържа валидна канонична разписка. Натиснете „Провери статуса“.");
            }

            await completeExtConfirmation(payRes);
        } catch (extErr) {
            if (!isStaleRouteRequestError(extErr) && isFinancialOperationContextCurrent(operationContext)) {
                const curPending = readExtPending();
                if (curPending && curPending.uiState === 'AMBIGUOUS_UNKNOWN' && feedbackEl) {
                    feedbackEl.setAttribute('data-ext-state', 'AMBIGUOUS_UNKNOWN');
                    feedbackEl.textContent = 'Отговорът от сървъра не е потвърден. Натиснете „Провери статуса“ преди всяка друга стъпка.';
                }
                showToast("Грешка при запис на плащане за самостоятелен обект: " + (extErr.message || extErr), "error");
            }
        } finally {
            if (isFinancialOperationContextCurrent(operationContext)) {
                const curPending = readExtPending();
                btn.disabled = !!(curPending && curPending.uiState === 'CONFLICT');
                if (curPending && curPending.uiState === 'AMBIGUOUS_UNKNOWN') {
                    btn.textContent = "Провери статуса";
                } else if (curPending && curPending.uiState === 'RECOVERY_REQUIRED') {
                    btn.textContent = "Възстанови същото плащане";
                } else {
                    btn.textContent = "➕ Добави приход";
                }
            }
        }
        return;
    }

    if (!window.fb || !window.fb.addDoc) {
        showToast("Грешка при връзка с базата данни (Firebase AddDoc липсва).", "error");
        return;
    }

    const btn = document.getElementById("v2SubmitBtn");
    btn.disabled = true;
    btn.textContent = "Записване...";

    let finalNote = note;
    let selectedExtUnitObj = null;
    if (selectedExtUnitId && Array.isArray(window._cachedExternalUnits)) {
        selectedExtUnitObj = window._cachedExternalUnits.find(u => u.unitId === selectedExtUnitId) || null;
        if (selectedExtUnitObj) {
            const tag = `[ОБЕКТ:${selectedExtUnitObj.unitId}|${selectedExtUnitObj.name}]`;
            finalNote = note.startsWith(tag) ? note : (note ? `${tag} ${note}` : tag);
        }
    }

    const recordData = {
        routeKey: operationContext.routeKey,
        period: period,
        apt: operationContext.apartment,
        category: category,
        amount: amount,
        docNum: docNum,
        note: finalNote
    };
    if (!editId) recordData.timestamp = new Date().getTime();
    let primaryIncomePersisted = false;
    let incomeSuccessMessage = editId ? "Успешно редактиран приход!" : SAVED_SYNC_TOAST_MSG;

    try {
        assertFinancialOperationContextCurrent(operationContext);
        const saveRes = await apiCall('saveIncomeV2', {
            routeKey: operationContext.routeKey,
            pin: operationPin,
            request: JSON.stringify(Object.assign({}, recordData, editId ? { editId: operationContext.documentId } : {}))
        }, operationContext);
        assertFinancialOperationContextCurrent(operationContext);
        assertSuccessfulApiResult(saveRes, "Записването на прихода");
        primaryIncomePersisted = true;
        if (editId) {
            v2CancelEdit();
        } else {
            // P0.5: Legacy dual-write (EXTERNAL + selectedExtUnitId) removed — routed exclusively through canonical EXTERNAL_UNIT flow above.
            // Връзка с V1: Ако е от апартамент, запиши го и като плащане във V1
            if (apt !== "EXTERNAL" && category === "Управление и поддръжка") {
                try {
                    assertFinancialOperationContextCurrent(operationContext);
                    const paymentResult = await apiCall('addPayment', {
                        routeKey: operationContext.routeKey,
                        pin: operationPin,
                        apartment: operationContext.apartment,
                        period: period,
                        amount: amount.toFixed(2) // Може да е отрицателно за корекции
                    }, operationContext);
                    assertFinancialOperationContextCurrent(operationContext);
                    assertSuccessfulApiResult(paymentResult, "Отразяването на плащането");
                    // forceSync е best-effort post-commit refresh. Не показва
                    // отделен success toast и не променя основния запис.
                    bgApiCall('forceSync', { routeKey: operationContext.routeKey, pin: operationPin }).then(syncResult => {
                        if (!isFinancialOperationContextCurrent(operationContext)) return;
                        try {
                            assertSuccessfulApiResult(syncResult, "Синхронизацията на плащането");
                        } catch (syncError) {
                            console.warn("forceSync failed", syncError);
                            return;
                        }
                        if (typeof v2LoadPaymentDue === 'function') return v2LoadPaymentDue(operationContext);
                    }).catch(error => { if (!isStaleRouteRequestError(error)) console.warn('forceSync failed', error); });
                } catch (apiErr) {
                    if (isStaleRouteRequestError(apiErr)) throw apiErr;
                    assertFinancialOperationContextCurrent(operationContext, apiErr);
                    throw createFinancialPartialCompletionError_(
                        "Приходът е записан, но плащането във V1 не е потвърдено. Необходима е операторска проверка.",
                        "income-payment",
                        { committedStages: ["income"] },
                        apiErr
                    );
                }
            }

            // Специална логика за приходи от Кредит — паралелен регистър
            // (creditLiabilitiesV2), НЕ пипа Салдото/формулите на апартаментите.
            if (category === "Кредит") {
                try {
                    if (apt === "EXTERNAL") {
                        // НОВ КРЕДИТ: разпределя се автоматично между ВСИЧКИ
                        // апартаменти пропорционално на идеалните им части.
                        assertFinancialOperationContextCurrent(operationContext);
                        const idealRes = await apiCall('getBuildingIdealParts', {
                            routeKey: operationContext.routeKey,
                            pin: operationPin
                        }, operationContext);
                        assertFinancialOperationContextCurrent(operationContext);
                        assertSuccessfulApiResult(idealRes, "Зареждането на идеалните части");
                        const allocationPlan = buildValidatedCreditAllocationPlan_(
                            operationApartmentList,
                            idealRes.parts,
                            amount
                        );
                        for (const allocation of allocationPlan.allocations) {
                            const apartmentContext = deriveFinancialApartmentContext(operationContext, allocation.apartment);
                            await addCreditLiabilityDelta_(apartmentContext, allocation.amount, allocation.amount);
                            assertFinancialOperationContextCurrent(operationContext);
                        }
                    } else {
                        // ПОГАСЯВАНЕ от конкретен апартамент — намалява остатъка му (не под 0)
                        await addCreditLiabilityDelta_(operationContext, 0, -amount);
                        assertFinancialOperationContextCurrent(operationContext);
                    }
                    if (typeof loadCreditLiabilitiesRegister === 'function') {
                        await loadCreditLiabilitiesRegister(operationContext);
                        assertFinancialOperationContextCurrent(operationContext);
                    }
                } catch (creditErr) {
                    if (isStaleRouteRequestError(creditErr)) throw creditErr;
                    assertFinancialOperationContextCurrent(operationContext, creditErr);
                    console.error("Credit liability error:", creditErr);
                    throw createFinancialPartialCompletionError_(
                        "Приходът е записан, но кредитният регистър не е обновен изцяло. Причина: " +
                            creditErr.message + ". Необходима е операторска проверка.",
                        "income-credit-allocation",
                        { committedStages: ["income"] },
                        creditErr
                    );
                }
            }

            // Clear form
            assertFinancialOperationContextCurrent(operationContext);
            document.getElementById("v2IncomeAmount").value = "";
            document.getElementById("v2IncomeDoc").value = "";
            document.getElementById("v2IncomeNote").value = "";
            document.getElementById("v2IncomeApt").value = "";
            v2HandleAptChange();
        }

        await loadIncomesV2(operationContext);
        assertFinancialOperationContextCurrent(operationContext);
        showToast(incomeSuccessMessage, editId ? "success" : "neutral", editId ? undefined : 3000);
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        if (!isFinancialOperationContextCurrent(operationContext)) return;
        if (!primaryIncomePersisted && isFirestorePermissionFallbackError(e)) {
            try {
                const storageKey = 'incomesV2_' + operationContext.routeKey;
                const localIncomes = readLocalFinancialRecords_(storageKey);
                if (editId) {
                    const idx = localIncomes.findIndex(record => record.id === editId);
                    if (idx < 0) throw new Error("Локалният приход за редакция не съществува");
                    localIncomes[idx] = { ...localIncomes[idx], ...recordData };
                } else {
                    localIncomes.push({ ...recordData, id: 'loc_' + new Date().getTime() });
                }
                assertFinancialOperationContextCurrent(operationContext);
                localStorage.setItem(storageKey, JSON.stringify(localIncomes));
                assertFinancialOperationContextCurrent(operationContext);
                showToast("ВНИМАНИЕ: Липсват Firebase права за incomesV2. Записът е запазен ЛОКАЛНО в браузъра (за тестване).", "error");
                if (!editId) {
                    document.getElementById("v2IncomeAmount").value = "";
                    document.getElementById("v2IncomeDoc").value = "";
                    document.getElementById("v2IncomeNote").value = "";
                    document.getElementById("v2IncomeApt").value = "";
                    v2HandleAptChange();
                }
                await loadIncomesV2(operationContext);
                assertFinancialOperationContextCurrent(operationContext);
            } catch (fallbackError) {
                if (isStaleRouteRequestError(fallbackError) || !isFinancialOperationContextCurrent(operationContext)) return;
                console.error("Local income persistence failed", fallbackError);
                showToast("Локалното запазване на прихода не бе извършено: " + fallbackError.message, "error");
            }
        } else {
            showToast((e.financialPartialCompletion ? "Частично изпълнение: " : "Грешка при запис: ") + e.message, "error");
        }
    
    }

    if (isFinancialOperationContextCurrent(operationContext)) {
        btn.disabled = false;
        btn.textContent = editId ? "💾 Запиши промените" : "➕ Добави приход";
    }
};

window.v2CancelEdit = function() {
    document.getElementById("v2IncomeEditId").value = "";
    document.getElementById("v2IncomeAmount").value = "";
    document.getElementById("v2IncomeDoc").value = "";
    document.getElementById("v2IncomeNote").value = "";
    document.getElementById("v2IncomeApt").value = "";
    v2HandleAptChange();
    
    document.getElementById("v2SubmitBtn").textContent = "➕ Добави приход";
    document.getElementById("v2CancelEditBtn").style.display = "none";
};

window.editIncomeV2 = function(id, period, apt, category, amount, docNum, note) {
    document.getElementById("v2IncomeEditId").value = id;
    document.getElementById("v2IncomePeriod").value = period;
    document.getElementById("v2IncomeApt").value = apt;
    document.getElementById("v2IncomeCategory").disabled = false;
    document.getElementById("v2IncomeCategory").value = category;
    document.getElementById("v2IncomeAmount").value = amount;
    document.getElementById("v2IncomeDoc").value = docNum || "";
    document.getElementById("v2IncomeNote").value = note || "";
    
    v2HandleAptChange();

    document.getElementById("v2SubmitBtn").textContent = "💾 Запиши промените";
    document.getElementById("v2CancelEditBtn").style.display = "inline-block";
    document.getElementById("v2IncomeAmount").focus();
};

window.deleteIncomeV2 = async function(id) {
    const operationContext = captureFinancialOperationContext(undefined, id);
    if (!confirm("Сигурни ли сте, че искате да изтриете този приход?")) return;
    
    try {
        assertFinancialOperationContextCurrent(operationContext);
        const storageKey = 'incomesV2_' + operationContext.routeKey;
        if (id.startsWith('loc_')) {
            let localIncomes = JSON.parse(localStorage.getItem(storageKey) || '[]');
            localIncomes = localIncomes.filter(r => r.id !== id);
            localStorage.setItem(storageKey, JSON.stringify(localIncomes));
        } else {
            const delRes = await apiCall('deleteIncomeV2', {
                routeKey: operationContext.routeKey,
                pin: sessionStorage.getItem("adminAuth_" + operationContext.routeKey) || getStoredPin(),
                request: JSON.stringify({ id: operationContext.documentId })
            }, operationContext);
            assertFinancialOperationContextCurrent(operationContext);
            assertSuccessfulApiResult(delRes, "Изтриването на прихода");
        }
        showToast("Приходът е изтрит.", "success");
        await loadIncomesV2(operationContext);
        assertFinancialOperationContextCurrent(operationContext);
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        if (!isFinancialOperationContextCurrent(operationContext)) return;
        showToast("Грешка при изтриване: " + e.message, "error");
    }
};

// ==============================================
// РЕГИСТЪР РАЗХОДИ (chargesV2) — само за история/одит на начисленията.
// Източник на истина за реалните суми си остава MASTER (Sheets), тук
// просто пазим "лог" на всяко +/- въвеждане, за да се вижда историята.
// ==============================================
function reportChargeHash_(text) {
    if (typeof text !== 'string' || text.length > 4096) throw new Error('Invalid identity text.');
    const bytes = [];
    for (let i = 0; i < text.length; i++) {
        let cp = text.charCodeAt(i);
        if (cp >= 0xD800 && cp <= 0xDBFF) {
            const low = text.charCodeAt(++i);
            if (!(low >= 0xDC00 && low <= 0xDFFF)) throw new Error('Invalid identity Unicode.');
            cp = 0x10000 + ((cp - 0xD800) << 10) + low - 0xDC00;
        } else if (cp >= 0xDC00 && cp <= 0xDFFF) {
            throw new Error('Invalid identity Unicode.');
        }
        if (cp < 0x80) bytes.push(cp);
        else if (cp < 0x800) bytes.push(0xC0 | (cp >>> 6), 0x80 | (cp & 63));
        else if (cp < 0x10000) bytes.push(0xE0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 63), 0x80 | (cp & 63));
        else bytes.push(0xF0 | (cp >>> 18), 0x80 | ((cp >>> 12) & 63), 0x80 | ((cp >>> 6) & 63), 0x80 | (cp & 63));
    }
    const bitLength = bytes.length * 8;
    bytes.push(0x80);
    while (bytes.length % 64 !== 56) bytes.push(0);
    // The bounded input is far below 2^32 bits; the high length word is zero.
    bytes.push(0, 0, 0, 0, (bitLength >>> 24) & 255, (bitLength >>> 16) & 255, (bitLength >>> 8) & 255, bitLength & 255);
    const k = [
        0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
        0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
        0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
        0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
        0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
        0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
        0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
        0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
    ];
    const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
    function rotate(x, n) { return (x >>> n) | (x << (32 - n)); }
    for (let offset = 0; offset < bytes.length; offset += 64) {
        const w = new Array(64);
        for (let i = 0; i < 16; i++) {
            const j = offset + 4 * i;
            w[i] = (bytes[j] << 24) | (bytes[j + 1] << 16) | (bytes[j + 2] << 8) | bytes[j + 3];
        }
        for (let i = 16; i < 64; i++) {
            const s0 = rotate(w[i - 15], 7) ^ rotate(w[i - 15], 18) ^ (w[i - 15] >>> 3);
            const s1 = rotate(w[i - 2], 17) ^ rotate(w[i - 2], 19) ^ (w[i - 2] >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
        }
        let [a,b,c,d,e,f,g,z] = h;
        for (let i = 0; i < 64; i++) {
            const t1 = (z + (rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25)) + ((e & f) ^ (~e & g)) + k[i] + w[i]) | 0;
            const t2 = ((rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) | 0;
            z = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
        }
        [a,b,c,d,e,f,g,z].forEach(function(value, i) { h[i] = (h[i] + value) | 0; });
    }
    return h.map(function(value) { return (value >>> 0).toString(16).padStart(8, '0'); }).join('');
}

// Read-only projection of the source-specific persistence contracts.
function reportValidateCharge_(r) {
    function fail() { throw Error('REPORT_CHARGES_INCOMPLETE: невалидна операция; сборът не е потвърден.'); }
    function fields(v, names) {
        if (!v || typeof v !== 'object' || Array.isArray(v) || Object.getOwnPropertyNames(v).length !== names.length || Object.getOwnPropertySymbols(v).length) fail();
        names.forEach(k => { const d=Object.getOwnPropertyDescriptor(v,k); if(!d || !Object.prototype.hasOwnProperty.call(d,'value')) fail(); });
    }
    const data=Object.assign({},r); delete data.id;
    fields(data,['contractVersion','routeKey','requestId','batchId','status','beforeValue','afterValue','operation']);
    const o=data.operation;
    fields(o,['category','signedAmount','period','note','source','createdAt','operationId','importIdentity']);
    const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
    const hex=/^[0-9a-f]{64}$/;
    if(data.status!=='applied' || ![2,3].includes(data.contractVersion) ||
       typeof data.routeKey!=='string' || !data.routeKey || data.routeKey.length>256 || data.routeKey!==data.routeKey.trim() || /[|\u0000-\u001f\u007f]/.test(data.routeKey) ||
       typeof data.requestId!=='string' || typeof data.batchId!=='string' || typeof o.operationId!=='string' ||
       (o.source!=='manual' && typeof o.importIdentity!=='string') ||
       !uuid.test(data.requestId) || !hex.test(data.batchId) || !hex.test(o.operationId) ||
       (r.id && (typeof r.id!=='string' || r.id.split('/').pop()!==o.operationId)) ||
       typeof o.signedAmount!=='number' || !Number.isFinite(o.signedAmount) || Object.is(o.signedAmount,-0) ||
       typeof o.note!=='string' || typeof o.createdAt!=='string' || !Number.isFinite(Date.parse(o.createdAt)) || new Date(o.createdAt).toISOString()!==o.createdAt ||
       typeof o.period!=='string' || !/^(0[1-9]|1[0-2])\.\d{4}$/.test(o.period) ||
       !(data.beforeValue===null ? data.contractVersion===3 : typeof data.beforeValue==='number' && Number.isFinite(data.beforeValue) && !Object.is(data.beforeValue,-0)) ||
       typeof data.afterValue!=='number' || !Number.isFinite(data.afterValue) || Object.is(data.afterValue,-0)) fail();
    const beforeNum = data.beforeValue === null ? 0 : data.beforeValue;
    const masterDeltaCents = Math.round((data.afterValue - beforeNum) * 100);
    const signedCents = Math.round(o.signedAmount * 100);
    const exactFullMatch = Math.abs((beforeNum + o.signedAmount) - data.afterValue) < 1e-6;
    const validExternalSplit = o.source === 'manual' && (
        (signedCents === 0 && masterDeltaCents === 0) ||
        (signedCents > 0 && masterDeltaCents >= 0 && masterDeltaCents <= signedCents) ||
        (signedCents < 0 && masterDeltaCents <= 0 && masterDeltaCents >= signedCents)
    );
    if (!exactFullMatch && !validExternalSplit) fail();
    const hash=reportChargeHash_, route=data.routeKey;
    if(o.source==='manual') {
        if(!['elevator','subscription','light','security','cleaning','maintenance','repairFund','water','platformSubscription'].includes(o.category) ||
           !/^(0[1-9]|1[0-2])\.(20[0-4][0-9]|2050)$/.test(o.period) || o.note.length>4096 ||
           (o.signedAmount<0 && !o.note.trim()) || o.importIdentity!==null || data.contractVersion!==2 ||
           !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(o.createdAt) ||
           data.batchId!==hash('manual-batch|'+route+'|'+data.requestId) ||
           o.operationId!==hash('manual|'+route+'|'+data.requestId+'|'+o.category)) fail();
    } else if(o.source==='epay') {
        let p; try {p=JSON.parse(o.importIdentity);} catch(e) {fail();}
        function event(v) {return Array.isArray(v)&&v.length===2&&v[0]==='epay-transfer'&&typeof v[1]==='string'&&/^\d{1,128}$/.test(v[1]);}
        let id;
        if(event(p)) id=hash(JSON.stringify(['epay-expense-v1',route,o.importIdentity]));
        else if(Array.isArray(p)&&p.length===3&&p[0]==='epay-expense-line-v2'&&typeof p[1]==='string'&&Number.isInteger(p[2])&&p[2]>=0&&p[2]<256) {
            let parent; try {parent=JSON.parse(p[1]);} catch(e) {fail();}
            if(!event(parent)||JSON.stringify(parent)!==p[1]) fail();
            id=hash(JSON.stringify(['epay-expense-line-v2',route,p[1],p[2]]));
        } else fail();
        const request=id.slice(0,8)+'-'+id.slice(8,12)+'-4'+id.slice(13,16)+'-'+((parseInt(id[16],16)&3)|8).toString(16)+id.slice(17,20)+'-'+id.slice(20,32);
        if(JSON.stringify(p)!==o.importIdentity || !['elevator','light','water'].includes(o.category) ||
           o.note!=='Автоматичен ePay разход: '+o.category || o.operationId!==id || data.requestId!==request || data.batchId!==hash('epay-expense-batch|'+id) ||
           data.contractVersion!==(data.beforeValue===null?3:2)) fail();
    } else if(o.source==='recurring') {
        if(o.signedAmount<=0 || !['subscription','security','cleaning','maintenance','platformSubscription'].includes(o.category) || !hex.test(o.importIdentity) ||
           o.operationId!==hash('recurring|'+route+'|'+o.importIdentity) || data.batchId!==hash('recurring-batch|'+route+'|'+o.period) || o.note!=='') fail();
    } else fail();
    return true;
}

function reportChargeRows_(records) {
    const seen = new Set();
    return records.slice().sort(function(a,b) { return Number(!!b.operation)-Number(!!a.operation); }).flatMap(function(r) {
        const op = r.operation;
        if (Object.prototype.hasOwnProperty.call(r, 'operation') && r.status === 'prepared') return [];
        if (Object.prototype.hasOwnProperty.call(r, 'operation')) {
            reportValidateCharge_(r);
            r = Object.assign({}, r, {operationId:op.operationId, category:op.category,
                amount:op.signedAmount, period:op.period, note:op.note, timestamp:Date.parse(op.createdAt)});
        } else {
            if (r.status && r.status !== 'applied') return [];
            if (typeof r.amount === 'string' && r.amount.trim() && Number.isFinite(Number(r.amount))) r = Object.assign({},r,{amount:Number(r.amount)});
        }
        if (typeof r.amount !== 'number' || !Number.isFinite(r.amount)) return [];
        const id = r.operationId || (r.id && r.id.split('/').pop());
        if (id && seen.has(id)) return [];
        if (id) seen.add(id);
        return [r];
    });
}

function reportEscape_(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function(c) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
}

function reportEvidence_(row) {
    return [row.docNum, row.basis, row.note].filter(function(v) { return typeof v === 'string' && v.length; })
        .map(reportEscape_).join(' — ');
}

function reportDetails_(row) {
    const text = reportEvidence_(row);
    return text ? '<br><small>' + text + '</small>' : '';
}

window.loadChargesV2Register = async function() {
    const requestContext = captureRouteRequestContext();
    const tbody = document.getElementById("chargesV2TableBody");
    if (!tbody) return;

    if (!window.fb || !window.fb.getDocs) {
        tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Грешка: Firebase не е зареден.</td></tr>';
        return;
    }

    setSectionAsyncState_(tbody, 'LOADING', { colspan: 5, loadingText: 'Зареждане на регистъра на разходите…' });

    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;

        const q = query(collection(db, "chargesV2"), where("routeKey", "==", currentRouteKey));
        let records = [];
        let cached = false;
        try {
            const snap = await getDocs(q);
            throwIfStaleRouteRequestContext(requestContext);
            if (snap.metadata && snap.metadata.fromCache) throw Error('REPORT_READ_UNCONFIRMED');
            snap.forEach(d => records.push({ id: d.id, ...d.data() }));
        } catch (fbErr) {
            if (isStaleRouteRequestError(fbErr)) throw fbErr;
            console.warn("Firebase Read Error for chargesV2", fbErr);
            const cache = localStorage.getItem('chargesV2_' + currentRouteKey);
            if (cache === null) throw Error('Прочитът е неуспешен; регистърът не е потвърден.');
            records = JSON.parse(cache);
            if (!Array.isArray(records)) throw Error('Невалиден кеш; регистърът не е потвърден.');
            cached = true;
        }

        records = reportChargeRows_(records);
        records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (cached && records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4">Кеширани данни — непотвърдени към момента. Няма показваеми потвърдени записи в кеша.</td></tr>';
            return;
        }
        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="4" style="text-align: center; padding: 15px; color: #666;">Няма въведени начисления.</td></tr>';
            return;
        }

        let html = cached ? '<tr><td colspan="4">Кеширани данни — непотвърдени към момента.</td></tr>' : "";
        records.forEach(r => {
            const amountNum = parseFloat(r.amount) || 0;
            const amountColor = amountNum < 0 ? '#dc2626' : '#b45309';
            const amountStr = (amountNum >= 0 ? '+' : '') + amountNum.toFixed(2);
            html += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${formatRegisterDate(r.timestamp)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${reportEscape_(r.period)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${reportEscape_((chargeLabelsMap.find(e => e.key === r.category) || {}).name || r.category)}${reportDetails_(r)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: ${amountColor};">${amountStr}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;

    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="4" style="text-align:center; color: red;">Грешка при зареждане: ${e.message}</td></tr>`;
    }
};

window.loadIncomesV2 = async function(operationContext) {
    operationContext = operationContext || captureFinancialOperationContext();
    const tbody = document.getElementById("v2IncomesTableBody");
    if (!tbody) return;

    if (!window.fb || !window.fb.getDocs) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Грешка: Firebase не е зареден.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Зареждане...</td></tr>';

    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;
        
        const q = query(collection(db, "incomesV2"), where("routeKey", "==", operationContext.routeKey));
        let records = [];
        try {
            const snap = await getDocs(q);
            assertFinancialOperationContextCurrent(operationContext);
            snap.forEach(d => {
                records.push({ id: d.id, ...d.data() });
            });
        } catch (fbErr) {
            if (isStaleRouteRequestError(fbErr)) throw fbErr;
            assertFinancialOperationContextCurrent(operationContext, fbErr);
            console.warn("Firebase Read Error, loading from LocalStorage", fbErr);
            const localIncomes = JSON.parse(localStorage.getItem('incomesV2_' + operationContext.routeKey) || '[]');
            records = localIncomes;
        }
        records = records.filter(r => (!r.paymentId || r.settlementStatus === 'APPLIED') && (!r.extPaymentId || r.settlementStatus === 'APPLIED' || r.settlementStatus === 'REVERSED')); // FIN01_UI
        
        records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Няма въведени приходи.</td></tr>';
            return;
        }

        let html = "";
        records.forEach(r => {
            const parsedExt = typeof parseExternalUnitTagClient_ === 'function' ? parseExternalUnitTagClient_(r.note) : null;
            const extUnitLabel = parsedExt
                ? `Външен обект: ${parsedExt.unitName} (${parsedExt.unitId})`
                : (r.extUnitId ? `Външен обект: ${r.extUnitName || r.extUnitId} (${r.extUnitId})` : null);
            const payer = r.apt === "EXTERNAL"
                ? (extUnitLabel || "Външен източник")
                : "Ап. " + r.apt;
            const displayCat = formatVisibleCategory(r.category);
            let rawNote = parsedExt ? parsedExt.cleanNote : (r.note || "");
            if (r.paymentId && r.allocationSummary) rawNote = rawNote + (rawNote ? '\n' : '') + formatVisibleSummaryText(r.allocationSummary); // FIN01_UI
            const docText = r.docNum ? `<b>Док:</b> ${r.docNum}<br>` : "";
            const noteText = rawNote ? `<span style="color:#666; font-size:11px;">${rawNote}</span>` : "";
            let extSummaryHtml = "";
            if (r.extPaymentId && r.allocationSummary && (!r.note || !r.note.includes(r.allocationSummary))) {
                extSummaryHtml = `<div style="margin-top:4px; font-size:11px; color:#1e40af; font-weight:600;">${formatVisibleSummaryText(r.allocationSummary)}</div>`;
            }
            let stornoHtml = "";
            if (r.extPaymentId && r.kind !== "REVERSAL" && r.settlementStatus !== "REVERSED" && !r.reversedByPaymentId) {
                const safePayId = String(r.extPaymentId).replace(/'/g, "\\'");
                stornoHtml = `<div style="margin-top:4px;"><button type="button" class="admin-btn" style="background:#ef4444; color:#fff; padding:2px 8px; font-size:11px;" onclick="reverseExternalUnitPaymentUI('${safePayId}')">↩ Сторно</button></div>`;
            } else if (r.settlementStatus === "REVERSED" || r.reversedByPaymentId) {
                stornoHtml = `<div style="margin-top:4px; font-size:11px; color:#dc2626; font-weight:600;">[СТОРНИРАНО]</div>`;
            }

            const amtNum = parseFloat(r.amount) || 0;
            const amtColor = amtNum < 0 ? "#dc2626" : "#16a34a";

            html += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${formatRegisterDate(r.timestamp)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${payer}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${displayCat}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: ${amtColor};">${amtNum.toFixed(2)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${docText}${noteText}${extSummaryHtml}${stornoHtml}</td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
        
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: red;">Грешка при зареждане: ${e.message}</td></tr>`;
    }
};

// ==============================================
// V2 EXTERNAL PAYERS REGISTRY
// ==============================================

window.saveExternalPayer = async function() {
    const operationContext = captureFinancialOperationContext();
    const payerType = document.getElementById("v2PayerType").value;
    const payerName = document.getElementById("v2PayerName").value.trim();
    const rawNote = document.getElementById("v2PayerNote").value.trim();
    const extUnitSel = document.getElementById("v2PayerExtUnit");
    const extUnitId = extUnitSel ? extUnitSel.value : "";
    let note = rawNote;
    if (extUnitId && Array.isArray(window._cachedExternalUnits)) {
        const u = window._cachedExternalUnits.find(x => x.unitId === extUnitId);
        if (u) {
            const tag = `[ОБЕКТ:${u.unitId}|${u.name}]`;
            note = rawNote.startsWith(tag) ? rawNote : (rawNote ? `${tag} ${rawNote}` : tag);
        }
    }

    if (!payerType || !payerName) {
        showToast("Моля, попълнете Вид платец и Наименование на платеца.", "error");
        return;
    }

    if (!window.fb || !window.fb.addDoc) {
        showToast("Грешка при връзка с базата данни (Firebase AddDoc липсва).", "error");
        return;
    }

    const btn = document.getElementById("v2SavePayerBtn");
    btn.disabled = true;
    btn.textContent = "Записване...";

    // Generate date in format YYYY/MM/DD
    const dateObj = new Date();
    const yyyy = dateObj.getFullYear();
    const mm = String(dateObj.getMonth() + 1).padStart(2, '0');
    const dd = String(dateObj.getDate()).padStart(2, '0');
    const dateStr = `${yyyy}/${mm}/${dd}`;
    const recordData = {
        routeKey: operationContext.routeKey,
        payerType: payerType,
        payerName: payerName,
        note: note,
        dateAdded: dateStr,
        timestamp: new Date().getTime()
    };
    let primaryPayerPersisted = false;

    try {
        assertFinancialOperationContextCurrent(operationContext);
        const saveRes = await apiCall('saveExternalPayerV2', {
            routeKey: operationContext.routeKey,
            pin: sessionStorage.getItem("adminAuth_" + operationContext.routeKey) || getStoredPin(),
            request: JSON.stringify(recordData)
        }, operationContext);
        assertFinancialOperationContextCurrent(operationContext);
        assertSuccessfulApiResult(saveRes, "Записването на външния платец");
        primaryPayerPersisted = true;
        showToast("Успешно записан външен платец!", "success");

        // Clear input fields
        document.getElementById("v2PayerName").value = "";
        document.getElementById("v2PayerNote").value = "";

        await loadExternalPayers(operationContext);
        assertFinancialOperationContextCurrent(operationContext);
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        if (!isFinancialOperationContextCurrent(operationContext)) return;
        if (!primaryPayerPersisted && isFirestorePermissionFallbackError(e)) {
            try {
                const storageKey = 'externalPayers_' + operationContext.routeKey;
                const localPayers = readLocalFinancialRecords_(storageKey);
                localPayers.push({ ...recordData, id: 'loc_' + new Date().getTime() });
                assertFinancialOperationContextCurrent(operationContext);
                localStorage.setItem(storageKey, JSON.stringify(localPayers));
                assertFinancialOperationContextCurrent(operationContext);
                showToast("Липсват Firebase права за externalPayers. Записът е запазен ЛОКАЛНО.", "error");
                document.getElementById("v2PayerName").value = "";
                document.getElementById("v2PayerNote").value = "";
                await loadExternalPayers(operationContext);
                assertFinancialOperationContextCurrent(operationContext);
            } catch (fallbackError) {
                if (isStaleRouteRequestError(fallbackError) || !isFinancialOperationContextCurrent(operationContext)) return;
                console.error("Local external payer persistence failed", fallbackError);
                showToast("Локалното запазване на външния платец не бе извършено: " + fallbackError.message, "error");
            }
        } else {
            showToast("Грешка при запис: " + e.message, "error");
        }
    }

    if (isFinancialOperationContextCurrent(operationContext)) {
        btn.disabled = false;
        btn.textContent = "💾 Запиши";
    }
};

window.deleteExternalPayer = async function(id) {
    const operationContext = captureFinancialOperationContext(undefined, id);
    if (!confirm("Сигурни ли сте, че искате да изтриете този външен платец?")) return;

    try {
        assertFinancialOperationContextCurrent(operationContext);
        const storageKey = 'externalPayers_' + operationContext.routeKey;
        if (id.startsWith('loc_')) {
            let localPayers = JSON.parse(localStorage.getItem(storageKey) || '[]');
            localPayers = localPayers.filter(r => r.id !== id);
            localStorage.setItem(storageKey, JSON.stringify(localPayers));
        } else {
            const delRes = await apiCall('deleteExternalPayerV2', {
                routeKey: operationContext.routeKey,
                pin: sessionStorage.getItem("adminAuth_" + operationContext.routeKey) || getStoredPin(),
                request: JSON.stringify({ id: operationContext.documentId })
            }, operationContext);
            assertFinancialOperationContextCurrent(operationContext);
            assertSuccessfulApiResult(delRes, "Изтриването на външния платец");
        }
        showToast("Външният платец е изтрит.", "success");
        await loadExternalPayers(operationContext);
        assertFinancialOperationContextCurrent(operationContext);
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        if (!isFinancialOperationContextCurrent(operationContext)) return;
        showToast("Грешка при изтриване: " + e.message, "error");
    }
};

window.loadExternalPayers = async function(operationContext) {
    operationContext = operationContext || captureFinancialOperationContext();
    const tbody = document.getElementById("v2PayersTableBody");
    if (!tbody) return;

    if (!window.fb || !window.fb.getDocs) {
        tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Грешка: Firebase не е зареден.</td></tr>';
        return;
    }

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Зареждане...</td></tr>';

    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;

        const q = query(collection(db, "externalPayers"), where("routeKey", "==", operationContext.routeKey));
        let records = [];
        try {
            const snap = await getDocs(q);
            assertFinancialOperationContextCurrent(operationContext);
            snap.forEach(d => {
                records.push({ id: d.id, ...d.data() });
            });
        } catch (fbErr) {
            if (isStaleRouteRequestError(fbErr)) throw fbErr;
            assertFinancialOperationContextCurrent(operationContext, fbErr);
            console.warn("Firebase Read Error, loading from LocalStorage", fbErr);
            const localPayers = JSON.parse(localStorage.getItem('externalPayers_' + operationContext.routeKey) || '[]');
            records = localPayers;
        }

        records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Няма въведени външни платци.</td></tr>';
            return;
        }

        let html = "";
        records.forEach(r => {
            html += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.dateAdded}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.payerType}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.payerName}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.note || ""}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: center;">
                        <button class="admin-btn" style="background: #ef4444; color: white; padding: 2px 6px; font-size: 11px;" onclick="deleteExternalPayer('${r.id}')">🗑️</button>
                    </td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: red;">Грешка при зареждане: ${e.message}</td></tr>`;
    }
};

// ==============================================
// V2 DISTRIBUTION LOGIC
// ==============================================

window._cachedV2DistBalancesByCatCents = {};

function getSelectedV2DistCategories_() {
    const cbs = document.querySelectorAll('#v2DistCategoryList .v2-dist-cat-cb:checked');
    if (cbs && cbs.length > 0) {
        return Array.from(cbs).map(cb => cb.value);
    }
    const sel = document.getElementById("v2DistCategory");
    return (sel && sel.value) ? [sel.value] : [];
}

window.onV2DistCategoriesChanged = function() {
    const selected = getSelectedV2DistCategories_();
    const sel = document.getElementById("v2DistCategory");
    if (sel) {
        sel.value = selected.length === 1 ? selected[0] : (selected.length > 1 ? selected[0] : "");
    }
    updateV2DistAvailableSum();
};

function updateV2DistCategoryListBadges_(balancesMap, cur) {
    const currency = cur || sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
    document.querySelectorAll('#v2DistCategoryList .v2-dist-cat-avail').forEach(el => {
        const cat = el.getAttribute('data-avail-for');
        if (!cat) return;
        const cents = balancesMap && Number.isFinite(balancesMap[cat]) ? balancesMap[cat] : 0;
        const eur = (cents / 100).toFixed(2);
        el.textContent = `${eur} ${currency}`;
        el.style.color = cents > 0 ? '#16a34a' : '#64748b';
        el.style.fontWeight = cents > 0 ? '700' : '500';
    });
}

window.updateV2DistAvailableSum = async function() {
    const selectedCats = getSelectedV2DistCategories_();
    const selEl = document.getElementById("v2DistCategory");
    if (selectedCats.length === 1 && selectedCats[0] === 'maintenance') {
        if (selEl) selEl.value = 'maintenance';
    } else if (selEl && selEl.value === 'maintenance' && selectedCats.length !== 1) {
        selEl.value = selectedCats[0] || '';
    }

    const lbl = document.getElementById("lbl-v2DistAmount");
    if (!lbl) return;

    const hasCredit = selectedCats.includes("Кредит");
    const balanceLabel = document.getElementById("v2DistTypeBalanceLabel");
    const creditNote = document.getElementById("v2DistCreditNote");
    const cashRadio = document.querySelector('input[name="v2DistType"][value="cash"]');
    const balanceRadio = document.querySelector('input[name="v2DistType"][value="balance"]');
    if (balanceLabel && cashRadio && balanceRadio) {
        if (hasCredit) {
            balanceLabel.style.display = "none";
            if (creditNote) creditNote.style.display = "block";
            cashRadio.checked = true;
        } else {
            balanceLabel.style.display = "";
            if (creditNote) creditNote.style.display = "none";
        }
    }

    const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";

    try {
        const balancesCents = {};
        const allCategories = [
            "РУП — надбавка чл. 51, ал. 5",
            "Наем",
            "Средства от бюджетни институции",
            "Кредит",
            "ВЕИ на ЕС",
            "Дарения",
            "Други",
            "Фонд ремонт",
            "maintenance"
        ];
        allCategories.forEach(c => { balancesCents[c] = 0; });

        // 1. Server authoritative balances (includes СО payments, Paid Apartment ART51 surcharges, Rent mapping, Repair Fund, Maintenance)
        let serverBalancesAuthoritative = false;
        let serverIncompleteReason = '';
        try {
            const srvRes = await apiCall('getDistributableBalancesV2', { routeKey: currentRouteKey });
            if (srvRes && srvRes.success && Array.isArray(srvRes.categories)) {
                serverBalancesAuthoritative = (srvRes.authoritative !== false && srvRes.completenessStatus !== 'UNVERIFIED');
                if (!serverBalancesAuthoritative) {
                    serverIncompleteReason = Array.isArray(srvRes.incompleteSources) ? srvRes.incompleteSources.join(', ') : 'UNVERIFIED';
                }
                srvRes.categories.forEach(item => {
                    const catKey = item && (item.key || item.category);
                    if (catKey && Number.isFinite(item.availableCents)) {
                        balancesCents[catKey] = Math.max(0, Math.round(item.availableCents));
                    }
                });
            }
        } catch (srvErr) {
            serverIncompleteReason = (srvErr && srvErr.message) ? srvErr.message : 'SERVER_UNAVAILABLE';
            console.warn("getDistributableBalancesV2 fallback to informational client calculation:", srvErr);
        }
        window._v2DistBalanceAuthoritative = serverBalancesAuthoritative;
        window._v2DistBalanceIncompleteReason = serverIncompleteReason;
        const distSubmitBtn = document.getElementById("v2DistSubmitBtn");
        if (distSubmitBtn && !(selectedCats.length === 1 && selectedCats[0] === 'maintenance')) {
            distSubmitBtn.disabled = !serverBalancesAuthoritative;
        }

        // 2. Client Firestore informational fallback ONLY if server authoritative balances failed (NEVER authorizes distribution)
        if (!serverBalancesAuthoritative && window.fb && window.fb.getDocs && window.db) {
            const { collection, getDocs, query, where } = window.fb;
            const db = window.db;
            const [snapInc, snapDist, snapApts] = await Promise.all([
                getDocs(query(collection(db, "incomesV2"), where("routeKey", "==", currentRouteKey))),
                getDocs(query(collection(db, "distributionsV2"), where("routeKey", "==", currentRouteKey))),
                getDocs(query(collection(db, "apartments"), where("buildingId", "==", currentRouteKey)))
            ]);

            const fbCollected = {};
            const fbUsed = {};
            allCategories.forEach(c => { fbCollected[c] = 0; fbUsed[c] = 0; });

            snapApts.forEach(d => {
                const v = Math.round((parseFloat(d.data().collectedTargetFund) || 0) * 100);
                if (v > 0) fbCollected["Фонд ремонт"] += v;
            });

            snapInc.forEach(d => {
                const rec = d.data() || {};
                if (rec.paymentId && rec.settlementStatus && rec.settlementStatus !== 'APPLIED') return;
                if (rec.extPaymentId) {
                    if (rec.settlementStatus && rec.settlementStatus !== 'APPLIED' && rec.settlementStatus !== 'REVERSED') return;
                    fbCollected["РУП — надбавка чл. 51, ал. 5"] += Number(rec.rupSurchargeCents || 0);
                    fbCollected["Фонд ремонт"] += Number(rec.repairFundCents || 0);
                    fbCollected["Наем"] += Number(rec.contractRentCents || 0);
                    return;
                }
                const rawCat = String(rec.category || '').trim();
                const normCat = rawCat === 'Наем на общи части' ? 'Наем' : rawCat;
                const amtCents = Math.round((parseFloat(rec.amount) || 0) * 100);
                if (normCat === 'Кредит') {
                    if (rec.apt === 'EXTERNAL') fbCollected['Кредит'] += amtCents;
                } else if (Object.prototype.hasOwnProperty.call(fbCollected, normCat)) {
                    fbCollected[normCat] += amtCents;
                }
            });

            snapDist.forEach(d => {
                const dist = d.data() || {};
                let breakdown = dist.sourceBreakdown;
                if (typeof breakdown === 'string' && breakdown.trim()) {
                    try { breakdown = JSON.parse(breakdown); } catch (e) { breakdown = null; }
                }
                if (Array.isArray(breakdown) && breakdown.length > 0) {
                    breakdown.forEach(b => {
                        const bCat = b.category === 'Наем на общи части' ? 'Наем' : b.category;
                        const bCents = Number.isSafeInteger(b.amountCents) ? b.amountCents : Math.round((parseFloat(b.amount) || 0) * 100);
                        if (Object.prototype.hasOwnProperty.call(fbUsed, bCat)) fbUsed[bCat] += bCents;
                    });
                } else {
                    const dCat = dist.category === 'Наем на общи части' ? 'Наем' : dist.category;
                    const dCents = Number.isSafeInteger(dist.amountCents) ? dist.amountCents : Math.round((parseFloat(dist.amount) || 0) * 100);
                    if (Object.prototype.hasOwnProperty.call(fbUsed, dCat)) fbUsed[dCat] += dCents;
                }
            });

            allCategories.forEach(c => {
                if (c === 'maintenance') return;
                const fbAvail = Math.max(0, fbCollected[c] - fbUsed[c]);
                if (fbAvail > balancesCents[c] || balancesCents[c] === 0) {
                    balancesCents[c] = fbAvail;
                }
            });
        }

        window._cachedV2DistBalancesByCatCents = balancesCents;
        updateV2DistCategoryListBadges_(balancesCents, cur);

        if (selectedCats.length === 1 && selectedCats[0] === 'maintenance' && typeof maintenanceUpdateAvailable_ === 'function') {
            if (await maintenanceUpdateAvailable_()) return; // MAINTENANCE_AVAILABLE
        }

        if (selectedCats.length === 0) {
            lbl.innerHTML = 'Сума за разпределяне <span style="color:#64748b; font-size:12px;">(Изберете категория/и)</span>';
            return;
        }

        const totalSelectedCents = selectedCats.reduce((acc, c) => acc + (balancesCents[c] || 0), 0);
        const totalSelectedEur = (totalSelectedCents / 100).toFixed(2);
        lbl.innerHTML = `Сума за разпределяне <span style="color:#16a34a; font-size:12px;">(Налични по избраните (${selectedCats.length}): ${totalSelectedEur} ${cur})</span>`;
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error("Error updating available sum:", e);
        lbl.innerHTML = 'Сума за разпределяне <span style="color:#ef4444; font-size:12px;">(Грешка)</span>';
    }
};

window.v2DistSelectAll = function(selectAll) {
    const container = document.getElementById("v2DistApts");
    if (!container) return;
    const checkboxes = container.querySelectorAll("input[type='checkbox']");
    checkboxes.forEach(cb => cb.checked = selectAll);
};

window.populateDistPeriods = function() {
    const d = new Date();
    const currentPeriod = String(d.getMonth() + 1).padStart(2, '0') + "." + d.getFullYear();
    const autoLbl = document.getElementById("v2DistAutoPeriodLabel");
    if (autoLbl) autoLbl.textContent = currentPeriod;

    const pEl = document.getElementById("v2DistPeriod");
    if (!pEl) return;
    if (pEl.options.length <= 1) {
        const year = d.getFullYear();
        const monthNames = [
            "Януари", "Февруари", "Март", "Април", "Май", "Юни",
            "Юли", "Август", "Септември", "Октомври", "Ноември", "Декември"
        ];
        monthNames.forEach((name, index) => {
            const m = String(index + 1).padStart(2, '0');
            const val = `${m}.${year}`;
            const opt = new Option(`${name} ${year}`, val);
            pEl.appendChild(opt);
        });
    }
    pEl.value = currentPeriod;
};

window.loadDistributionsV2 = async function(operationContext) {
    operationContext = operationContext || captureFinancialOperationContext();
    // Populate checkboxes
    const container = document.getElementById("v2DistApts");
    if (container && container.innerHTML.trim() === '<!-- Checkboxes will be populated here -->') {
        container.innerHTML = '';
        apartmentList.forEach(apt => {
            const lbl = document.createElement("label");
            lbl.style.cssText = "display: flex; align-items: center; gap: 5px; background: white; padding: 4px 8px; border: 1px solid #cbd5e1; border-radius: 4px; font-size: 13px; cursor: pointer;";
            lbl.innerHTML = `<input type="checkbox" value="${apt}" checked> ${apt}`;
            container.appendChild(lbl);
        });
    }
    
    populateDistPeriods();
    if(typeof maintenanceRenderPending_==='function')maintenanceRenderPending_(); // MAINTENANCE_RESTORE

    // Load table
    const tbody = document.getElementById("v2DistTableBody");
    if (!tbody) return;

    if (!window.fb || !window.fb.getDocs) return;

    tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Зареждане...</td></tr>';

    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;
        
        const q = query(collection(db, "distributionsV2"), where("routeKey", "==", operationContext.routeKey));
        let records = [];
        try {
            const snap = await getDocs(q);
            assertFinancialOperationContextCurrent(operationContext);
            snap.forEach(d => records.push({ id: d.id, ...d.data() }));
        } catch (fbErr) {
            if (isStaleRouteRequestError(fbErr)) throw fbErr;
            assertFinancialOperationContextCurrent(operationContext, fbErr);
            console.warn("Firebase Read Error for distributionsV2", fbErr);
            records = JSON.parse(localStorage.getItem('distributionsV2_' + operationContext.routeKey) || '[]');
        }
        
        records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Няма въведени разпределения.</td></tr>';
            return;
        }

        let html = "";
        records.forEach(r => {
            const dateStr = formatRegisterDate(r.timestamp);
            const displayCat = r.category === "Наем на общи части" ? "Наем" : (r.category || "");
            const breakdownInfo = r.sourceBreakdownSummary
                ? `<div style="font-size:10px; color:#1e40af; margin-top:2px;">Източници: ${r.sourceBreakdownSummary}</div>`
                : "";
            const periodInfo = r.period ? `<span style="color:#64748b; font-size:10px;">(${r.period})</span> ` : "";

            html += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${dateStr}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${displayCat}${breakdownInfo}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.type === 'balance' ? 'На салдо' : 'На каса'}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #3b82f6;">${parseFloat(r.amount).toFixed(2)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; font-size: 11px;">${periodInfo}${r.note || ""} <br><span style="color:#64748b">Апт: ${(r.apts || []).length}</span></td>
                </tr>
            `;
        });
        tbody.innerHTML = html;
        
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        tbody.innerHTML = `<tr><td colspan="5" style="text-align:center; color: red;">Грешка: ${e.message}</td></tr>`;
    }
};

window.submitDistributionV2 = async function() {
    populateDistPeriods();
    const selectedCats = getSelectedV2DistCategories_();
    const note = (document.getElementById("v2DistNote")?.value || "").trim();
    if (!note) {
        showToast("Полето „Основание / Бележка“ е задължително при всяко разпределяне.", "error");
        return;
    }

    if (selectedCats.length === 1 && selectedCats[0] === 'maintenance') {
        const selEl = document.getElementById("v2DistCategory");
        if (selEl) selEl.value = 'maintenance';
        if(typeof submitMaintenanceDistributionIfSelected_==='function'&&await submitMaintenanceDistributionIfSelected_())return; // MAINTENANCE_SUBMIT
    }

    const operationContext = captureFinancialOperationContext();
    const operationPin = sessionStorage.getItem("adminAuth_" + operationContext.routeKey);
    const period = document.getElementById("v2DistPeriod").value;
    const category = selectedCats.length === 1 ? selectedCats[0] : (selectedCats.length > 1 ? selectedCats.join(" + ") : document.getElementById("v2DistCategory").value);
    const amountStr = document.getElementById("v2DistAmount").value;
    const typeRadio = document.querySelector('input[name="v2DistType"]:checked');
    const type = typeRadio ? typeRadio.value : 'cash';

    if (!period || selectedCats.length === 0 || !amountStr) {
        showToast("Моля, изберете поне една Категория и въведете Сума.", "error");
        return;
    }

    if (typeof amountStr === 'string' && amountStr.includes(',')) {
        showToast("Използвайте точка (.) за десетични стойности.", "error");
        return;
    }

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast("Невалидна сума.", "error");
        return;
    }

    const amountCents = Math.round(amount * 100);
    const availMap = window._cachedV2DistBalancesByCatCents || {};
    const totalAvailCents = selectedCats.reduce((acc, c) => acc + (Number(availMap[c]) || 0), 0);
    if (totalAvailCents > 0 && amountCents > totalAvailCents) {
        showToast(`Въведената сума (${amount.toFixed(2)} EUR) надвишава общата наличност по избраните категории (${(totalAvailCents / 100).toFixed(2)} EUR).`, "error");
        return;
    }

    const container = document.getElementById("v2DistApts");
    const checkboxes = container.querySelectorAll("input[type='checkbox']:checked");
    const selectedApts = Object.freeze(Array.from(checkboxes).map(cb => cb.value));

    if (selectedApts.length === 0) {
        showToast("Изберете поне един апартамент за разпределение.", "error");
        return;
    }

    const btn = document.getElementById("v2SubmitDistBtn");
    const originalText = btn.textContent;
    btn.disabled = true;
    btn.textContent = "Изчисляване и Запис...";

    try {
        const { getDoc, routeDoc, mutationCollection, addDoc } = window.fb;
        const db = window.db;

        assertFinancialOperationContextCurrent(operationContext);
        const selectedApartmentSet = buildValidatedFinancialApartmentSet_(selectedApts);
        const promises = selectedApartmentSet.map(apartment => getDoc(routeDoc(
            db,
            "apartments",
            operationContext.routeKey + "_" + apartment.targetId,
            operationContext.routeKey
        )));
        const snaps = await Promise.all(promises);
        assertFinancialOperationContextCurrent(operationContext);

        const selectedIdealParts = {};
        snaps.forEach((snap, index) => {
            if (snap.exists()) {
                const apartmentData = snap.data();
                if (apartmentData && typeof apartmentData === "object" &&
                    Object.prototype.hasOwnProperty.call(apartmentData, "idealParts")) {
                    selectedIdealParts[selectedApartmentSet[index].canonicalId] = apartmentData.idealParts;
                }
            }
        });
        const allocationPlan = buildValidatedFinancialAllocationPlan_(
            selectedApts,
            selectedIdealParts,
            amount
        );
        const distributedDetails = {};
        allocationPlan.allocations.forEach(allocation => {
            distributedDetails[allocation.apartment] = allocation.amount;
        });

        // Build exact per-source breakdown in selection order
        let remToDraw = amountCents;
        const clientSourceBreakdown = [];
        selectedCats.forEach(cat => {
            if (remToDraw <= 0) return;
            const catAvail = Number.isFinite(availMap[cat]) && availMap[cat] > 0 ? availMap[cat] : remToDraw;
            const draw = Math.min(remToDraw, catAvail);
            if (draw > 0) {
                clientSourceBreakdown.push({
                    category: cat,
                    amountCents: draw,
                    amount: Number((draw / 100).toFixed(2))
                });
                remToDraw -= draw;
            }
        });
        const sourceBreakdownSummary = clientSourceBreakdown.map(b => `${b.category}: ${(b.amountCents / 100).toFixed(2)} EUR`).join(" + ");

        // Authoritative server validation & multi-source distribution record
        const distRequestId = (typeof newManualExpenseRequestId_ === 'function')
            ? newManualExpenseRequestId_()
            : ('dist_' + Date.now());
        let serverDistSaved = false;
        let serverDistResult = null;
        try {
            serverDistResult = await apiCall('distributeIncomeV2', {
                routeKey: operationContext.routeKey,
                pin: operationPin,
                request: JSON.stringify({
                    requestId: distRequestId,
                    categories: selectedCats,
                    amount: amount,
                    type: type,
                    note: note,
                    apartments: allocationPlan.allocations.map(a => a.apartment),
                    apts: allocationPlan.allocations.map(a => a.apartment),
                    details: distributedDetails
                })
            }, operationContext);
            assertFinancialOperationContextCurrent(operationContext);
            if (serverDistResult && serverDistResult.success === false && serverDistResult.rejectedBeforeCommit) {
                throw new Error(serverDistResult.error || "Разпределянето е отхвърлено от сървъра.");
            }
            if (serverDistResult && serverDistResult.success === true) {
                serverDistSaved = true;
            }
        } catch (srvDistErr) {
            if (isStaleRouteRequestError(srvDistErr)) throw srvDistErr;
            if (serverDistResult && serverDistResult.rejectedBeforeCommit) {
                throw srvDistErr;
            }
            console.warn("distributeIncomeV2 server call fallback:", srvDistErr);
        }

        const completedBalancePayments = [];
        if (type === 'balance') {
            try {
                for (const allocation of allocationPlan.allocations) {
                    assertFinancialOperationContextCurrent(operationContext);
                    const paymentResult = await apiCall('addPayment', {
                        routeKey: operationContext.routeKey,
                        pin: operationPin,
                        apartment: allocation.apartment,
                        period: period,
                        amount: allocation.amount.toFixed(2)
                    }, operationContext);
                    assertFinancialOperationContextCurrent(operationContext);
                    assertSuccessfulApiResult(paymentResult, "Плащането за апартамент " + allocation.apartment);
                    completedBalancePayments.push(Object.freeze({
                        apartment: allocation.apartment,
                        amount: allocation.amount
                    }));
                }
            } catch (paymentError) {
                if (completedBalancePayments.length && !isStaleRouteRequestError(paymentError)) {
                    const completedText = completedBalancePayments.map(item =>
                        item.apartment + " (" + item.amount.toFixed(2) + ")").join(", ");
                    throw createFinancialPartialCompletionError_(
                        "Разпределението е частично изпълнено. Успешни плащания: " + completedText +
                            ". Пълният запис не е създаден; необходима е операторска проверка.",
                        "distribution-payments",
                        { completedPayments: completedBalancePayments, distributionPersisted: serverDistSaved },
                        paymentError
                    );
                }
                throw paymentError;
            }
        }

        if (!serverDistSaved) {
            // P0.3: Single Authoritative Distribution Writer — NEVER fall back to unvalidated client or localStorage write.
            throw new Error("Разпределянето не бе потвърдено от авторитетния сървър (distributeIncomeV2). Операцията е прекратена без локален запис.");
        }

        // Синхронизираме Firebase с актуалните данни от Google Sheets (салда и отчети)
        if (type === 'balance') {
            try {
                const syncResult = await apiCall('forceDataSync', {
                    routeKey: operationContext.routeKey,
                    pin: operationPin
                }, operationContext);
                assertFinancialOperationContextCurrent(operationContext);
                assertSuccessfulApiResult(syncResult, "Синхронизацията след разпределението");
            } catch (syncErr) {
                if (isStaleRouteRequestError(syncErr)) throw syncErr;
                assertFinancialOperationContextCurrent(operationContext, syncErr);
                throw createFinancialPartialCompletionError_(
                    "Плащанията и разпределението са записани, но последващата синхронизация е неуспешна.",
                    "distribution-sync",
                    { completedPayments: completedBalancePayments, distributionPersisted: true },
                    syncErr
                );
            }
        }

        assertFinancialOperationContextCurrent(operationContext);
        showToast(SAVED_SYNC_TOAST_MSG, "neutral", 3000);
        document.getElementById("v2DistAmount").value = "";
        document.getElementById("v2DistNote").value = "";
        document.getElementById("v2DistCategory").value = "";
        document.querySelectorAll('#v2DistCategoryList .v2-dist-cat-cb').forEach(cb => { cb.checked = false; });
        
        await loadDistributionsV2(operationContext);
        assertFinancialOperationContextCurrent(operationContext);
        await updateV2DistAvailableSum();
        
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error(e);
        if (!isFinancialOperationContextCurrent(operationContext)) return;
        showToast((e.financialPartialCompletion ? "Частично изпълнение: " : "Грешка при разпределение: ") + e.message, "error");
    }

    if (isFinancialOperationContextCurrent(operationContext)) {
        btn.disabled = false;
        btn.textContent = originalText;
    }
};

// Global validation for decimal inputs: block comma and prompt dot separator
document.addEventListener('input', function (e) {
    if (!e.target) return;
    const target = e.target;
    if (target.inputMode === 'decimal' || target.id === 'adminAmount' || target.id === 'masterIdVal' || target.id === 'v2IncomeAmount' || target.id === 'v2DistAmount' || target.id?.startsWith('charges') || target.id?.startsWith('recurringBase_') || target.id?.startsWith('fin01') || target.id?.startsWith('extUnit')) {
        if (typeof target.value === 'string' && target.value.includes(',')) {
            showToast('Използвайте точка (.) за десетични стойности.', 'error');
        }
    }
}, true);

// ============================================================================
// BEGIN EXTERNAL UNITS CLIENT (REV. 3)
// ============================================================================
window._cachedExternalUnits = [];
window._cachedExternalUnitStatements = [];
window._cachedExternalReconciliation = [];
window._cachedExternalPendingPayments = [];
window._cachedExternalUnitActions = [];

function parseExternalUnitTagClient_(note) {
    const m = /^\[ОБЕКТ:(EXT_\d+)\|([^\]]+)\]\s*(.*)$/.exec(String(note || '').trim());
    if (!m) return null;
    return { unitId: m[1], unitName: m[2], cleanNote: m[3] || '' };
}

function getDefaultExternalUnitPeriod_() {
    const now = new Date();
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const yyyy = String(now.getFullYear());
    return `${mm}.${yyyy}`;
}

function populateExternalUnitSelects_() {
    const units = Array.isArray(window._cachedExternalUnits) ? window._cachedExternalUnits : [];
    const incSel = document.getElementById('v2IncomeExtUnit');
    if (incSel) {
        const cur = incSel.value;
        incSel.innerHTML = '<option value="">— Изберете самостоятелен обект —</option>';
        units.forEach(u => {
            incSel.appendChild(new Option(`${u.unitId} — ${u.name} (${u.documentedPurpose})`, u.unitId));
        });
        if (cur && units.some(u => u.unitId === cur)) incSel.value = cur;
    }

    const payerSel = document.getElementById('v2PayerExtUnit');
    if (payerSel) {
        const cur = payerSel.value;
        payerSel.innerHTML = '<option value="">— Без връзка към конкретен обект —</option>';
        units.forEach(u => {
            payerSel.appendChild(new Option(`${u.unitId} — ${u.name}`, u.unitId));
        });
        if (cur && units.some(u => u.unitId === cur)) payerSel.value = cur;
    }
}

function renderExternalUnitPaymentDueBadge_(unitId, category, lblEl) {
    if (!lblEl) return;
    const stmts = Array.isArray(window._cachedExternalUnitStatements) ? window._cachedExternalUnitStatements : [];
    const st = stmts.find(s => s.unitId === unitId);
    if (!st) {
        lblEl.innerHTML = '';
        return;
    }
    const debtCents = Number(st.endingDebtCents !== undefined ? st.endingDebtCents : (st.totalDebtCents || 0));
    const advCents = Number(st.endingAdvanceCents !== undefined ? st.endingAdvanceCents : (st.totalAdvanceCents || 0));
    if (debtCents > 0) {
        const b = st.summaryByComponent || st.summaryByBucket || {};
        const parts = [];
        if (b.rupBase && b.rupBase.debtCents > 0) parts.push(`Упр. и поддръжка (основа): ${(b.rupBase.debtCents / 100).toFixed(2)}`);
        if (b.rupSurcharge && b.rupSurcharge.debtCents > 0) parts.push(`Упр. и поддръжка (надбавка): ${(b.rupSurcharge.debtCents / 100).toFixed(2)}`);
        if (b.repairFund && b.repairFund.debtCents > 0) parts.push(`Фонд ремонт: ${(b.repairFund.debtCents / 100).toFixed(2)}`);
        if (b.contractRent && b.contractRent.debtCents > 0) parts.push(`Наем: ${(b.contractRent.debtCents / 100).toFixed(2)}`);
        const detail = parts.length > 0 ? ` [${parts.join(' · ')}]` : '';
        lblEl.innerHTML = `(Общо дължимо: <b style="color:#dc2626;">${(debtCents / 100).toFixed(2)} EUR</b>${detail})`;
    } else if (advCents > 0) {
        lblEl.innerHTML = `(Аванс по партида: <b style="color:#16a34a;">+${(advCents / 100).toFixed(2)} EUR</b>)`;
    } else {
        lblEl.innerHTML = `(Салдо по партида: <b>0.00 EUR</b>)`;
    }
}

let _extPaymentPreviewTimer = null;
let _extPaymentPreviewSeq = 0;

window.onV2IncomeExtPaymentInputChanged = function() {
    const apt = document.getElementById('v2IncomeApt')?.value || '';
    const box = document.getElementById('extUnitPaymentPreviewBox');
    const content = document.getElementById('extUnitPaymentPreviewContent');
    if (!box || !content) return;

    if (apt !== 'EXTERNAL_UNIT') {
        box.style.display = 'none';
        window._lastExtPaymentPreviewFingerprint = null;
        return;
    }

    const unitId = document.getElementById('v2IncomeExtUnit')?.value || '';
    const amountStr = (document.getElementById('v2IncomeAmount')?.value || '').trim();
    const note = (document.getElementById('v2IncomeNote')?.value || '').trim();
    const period = document.getElementById('v2IncomePeriod')?.value || getDefaultExternalUnitPeriod_();

    if (!unitId || !amountStr || amountStr.includes(',')) {
        box.style.display = 'none';
        window._lastExtPaymentPreviewFingerprint = null;
        return;
    }
    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
        box.style.display = 'none';
        window._lastExtPaymentPreviewFingerprint = null;
        return;
    }

    window._currentExtPaymentId = null;
    window._currentExtPaymentUnitId = null;

    if (_extPaymentPreviewTimer) clearTimeout(_extPaymentPreviewTimer);
    box.style.display = 'block';
    content.innerHTML = '<div style="font-size:12px; color:#64748b;">Изчисляване на разпределението...</div>';

    const seq = ++_extPaymentPreviewSeq;
    _extPaymentPreviewTimer = setTimeout(async function() {
        try {
            const res = await apiCall('previewExternalUnitPaymentV1', {
                routeKey: currentRouteKey,
                pin: getStoredPin(),
                request: JSON.stringify({
                    unitId: unitId,
                    period: period,
                    amount: amount,
                    basis: note,
                    note: note
                })
            });
            if (seq !== _extPaymentPreviewSeq) return;
            if (!res || !res.success) {
                window._lastExtPaymentPreviewFingerprint = null;
                window._lastExtPaymentPreviewComponents = null;
                content.innerHTML = `<div style="font-size:12px; color:#dc2626;">⚠️ ${(res && res.error) || 'Неуспешен предварителен преглед.'}</div>`;
                return;
            }
            window._lastExtPaymentPreviewFingerprint = res.expectedDebtFingerprint || null;
            const c = res.components || res;
            window._lastExtPaymentPreviewComponents = {
                rupBaseCents: Number(c.rupBaseCents || 0),
                rupSurchargeCents: Number(c.rupSurchargeCents || 0),
                repairFundCents: Number(c.repairFundCents || 0),
                contractRentCents: Number(c.contractRentCents || 0),
                unallocatedAdvanceCents: Number(c.unallocatedAdvanceCents || 0)
            };
            const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
            const fmt = v => ((Number(v || 0)) / 100).toFixed(2) + ' ' + cur;
            const explicitBadge = res.explicitComponent
                ? `<div class="ext-unit-preview-note">Изрично основание: <b>${res.explicitComponentLabel || res.explicitComponent}</b> (остатъкът се разпределя по стандартния приоритет)</div>`
                : '';
            content.innerHTML = `
                ${explicitBadge}
                <div class="ext-unit-preview-row"><span>Управление и поддръжка (основа)</span><strong>${fmt(c.rupBaseCents)}</strong></div>
                <div class="ext-unit-preview-row"><span>Управление и поддръжка — надбавка по чл. 51, ал. 5</span><strong>${fmt(c.rupSurchargeCents)}</strong></div>
                <div class="ext-unit-preview-row"><span>Фонд ремонт</span><strong>${fmt(c.repairFundCents)}</strong></div>
                <div class="ext-unit-preview-row"><span>Наем</span><strong>${fmt(c.contractRentCents)}</strong></div>
                <div class="ext-unit-preview-row ext-unit-preview-advance"><span>Аванс</span><strong>${fmt(c.unallocatedAdvanceCents)}</strong></div>
                <div class="ext-unit-preview-row ext-unit-preview-total"><span>Общо</span><strong>${fmt(res.amountCents)}</strong></div>
            `;
        } catch (e) {
            if (seq !== _extPaymentPreviewSeq) return;
            window._lastExtPaymentPreviewFingerprint = null;
            content.innerHTML = '<div style="font-size:12px; color:#dc2626;">⚠️ Грешка при връзка за предварителен преглед.</div>';
        }
    }, 260);
};

window.reverseExternalUnitPaymentUI = async function(paymentId) {
    if (!paymentId) return;
    const reason = typeof window.prompt === 'function'
        ? window.prompt("Въведете причина за сторниране на плащането (задължително):", "Корекция на грешно въведено плащане")
        : "Корекция";
    if (reason === null) return;
    const cleanReason = String(reason || "").trim();
    if (!cleanReason) {
        showToast("Моля, въведете причина за сторниране.", "error");
        return;
    }
    try {
        const res = await apiCall('reverseExternalUnitPaymentV1', {
            routeKey: currentRouteKey,
            pin: getStoredPin(),
            request: JSON.stringify({
                reversesPaymentId: paymentId,
                reversalPaymentId: 'rev_' + paymentId,
                note: cleanReason
            })
        });
        if (!res || !res.success) {
            showToast((res && res.error) || "Сторнирането е отказано.", "error");
            return;
        }
        showToast("Плащането е сторнирано успешно с компенсиращ запис.", "success");
        purgeFinancialMaterializedCache_();
        if (typeof loadExternalUnitsData === 'function') await loadExternalUnitsData(true);
        if (typeof loadIncomesV2 === 'function') await loadIncomesV2();
        if (typeof updateV2DistAvailableSum === 'function') await updateV2DistAvailableSum();
    } catch (e) {
        showToast("Грешка при сторниране: " + (e.message || e), "error");
    }
};

window.openExternalUnitsSettings = function() {
    const periodEl = document.getElementById('extUnitPeriod');
    if (periodEl && !periodEl.value) {
        periodEl.value = getDefaultExternalUnitPeriod_();
    }
    loadExternalUnitsData(false);
};

window.extUnitAccessTypeChanged = function() {
    const accessEl = document.getElementById('extUnitAccessType');
    const art51Group = document.getElementById('extUnitArt51Group');
    const art51ActiveEl = document.getElementById('extUnitArt51Active');
    if (!accessEl || !art51Group) return;
    if (accessEl.value === 'COMMON_ENTRANCE') {
        art51Group.style.display = '';
    } else {
        art51Group.style.display = 'none';
        if (art51ActiveEl) art51ActiveEl.value = 'false';
    }
    extUnitArt51ActiveChanged();
};

window.extUnitArt51ActiveChanged = function() {
    const accessEl = document.getElementById('extUnitAccessType');
    const art51ActiveEl = document.getElementById('extUnitArt51Active');
    const multGroup = document.getElementById('extUnitMultiplierGroup');
    if (!multGroup) return;
    const show = accessEl && accessEl.value === 'COMMON_ENTRANCE' && art51ActiveEl && art51ActiveEl.value === 'true';
    multGroup.style.display = show ? '' : 'none';
};

window.extUnitIdealStatusChanged = function() {
    const statusEl = document.getElementById('extUnitIdealStatus');
    const pctGroup = document.getElementById('extUnitIdealPercentGroup');
    const pctInput = document.getElementById('extUnitIdealPercent');
    if (!statusEl || !pctGroup) return;
    if (statusEl.value === 'ESTABLISHED') {
        pctGroup.style.display = '';
    } else {
        pctGroup.style.display = 'none';
        if (pctInput) pctInput.value = '';
    }
};

window.extUnitSelectionChanged = function() {
    const sel = document.getElementById('extUnitSelect');
    const badge = document.getElementById('extUnitCurrentBadge');
    const statusMsg = document.getElementById('extUnitStatusMsg');
    if (statusMsg) statusMsg.textContent = '';
    if (!sel) return;
    const unitId = sel.value;
    const units = Array.isArray(window._cachedExternalUnits) ? window._cachedExternalUnits : [];
    const u = units.find(x => x.unitId === unitId);

    if (!u) {
        if (badge) badge.innerHTML = '<span class="art51-status-ne">Нов обект</span>';
        document.getElementById('extUnitName').value = '';
        document.getElementById('extUnitAccessType').value = 'SEPARATE_ENTRANCE';
        document.getElementById('extUnitDocPurpose').value = 'Магазин';
        document.getElementById('extUnitActualUsage').value = 'Търговски обект';
        document.getElementById('extUnitArea').value = '';
        const cadElNew = document.getElementById('extUnitCadastre');
        if (cadElNew) cadElNew.value = '';
        document.getElementById('extUnitMgmtPart').value = 'true';
        document.getElementById('extUnitOccupants').value = '1';
        document.getElementById('extUnitArt51Active').value = 'false';
        document.getElementById('extUnitMultiplier').value = '3';
        document.getElementById('extUnitIdealStatus').value = 'UNESTABLISHED';
        document.getElementById('extUnitIdealPercent').value = '';
        document.getElementById('extUnitRepairPart').value = 'false';
        document.getElementById('extUnitRentAmount').value = '0';
        document.getElementById('extUnitPeriod').value = getDefaultExternalUnitPeriod_();
        extUnitAccessTypeChanged();
        extUnitIdealStatusChanged();
        return;
    }

    if (badge) {
        badge.innerHTML = u.managementParticipation
            ? `<span class="art51-status-ne">${u.unitId}: Участие УП - ДА (${u.art51Multiplier || 1}x)</span>`
            : `<span class="art51-status-da">${u.unitId}: Участие УП - НЕ</span>`;
    }
    document.getElementById('extUnitName').value = u.name || '';
    document.getElementById('extUnitAccessType').value = u.accessType || 'SEPARATE_ENTRANCE';
    document.getElementById('extUnitDocPurpose').value = u.documentedPurpose || 'Магазин';
    document.getElementById('extUnitActualUsage').value = u.actualUsage || 'Търговски обект';
    document.getElementById('extUnitArea').value = u.areaSqm !== null && u.areaSqm !== undefined ? String(u.areaSqm) : '';
    const cadElExisting = document.getElementById('extUnitCadastre');
    if (cadElExisting) cadElExisting.value = u.cadastralId || '';
    document.getElementById('extUnitMgmtPart').value = String(Boolean(u.managementParticipation));
    document.getElementById('extUnitOccupants').value = String(u.occupantsCount !== undefined ? u.occupantsCount : 1);
    document.getElementById('extUnitArt51Active').value = String(Boolean(u.art51Active));
    document.getElementById('extUnitMultiplier').value = String(u.art51Multiplier && u.art51Multiplier >= 3 ? u.art51Multiplier : 3);
    document.getElementById('extUnitIdealStatus').value = u.idealPartsStatus || 'UNESTABLISHED';
    document.getElementById('extUnitIdealPercent').value = (u.idealPartsStatus === 'ESTABLISHED' && u.idealPartsPercent !== null) ? String(u.idealPartsPercent) : '';
    document.getElementById('extUnitRepairPart').value = String(Boolean(u.autoChargeRepairFund));
    document.getElementById('extUnitRentAmount').value = String(u.contractRentAmount || 0);
    document.getElementById('extUnitPeriod').value = u.effectiveFromPeriod || getDefaultExternalUnitPeriod_();
    extUnitAccessTypeChanged();
    extUnitIdealStatusChanged();
};

window.loadExternalUnitsData = async function(silent) {
    const _extPerfStart = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    if (window._extUnitsInFlightPromise && window._extUnitsInFlightRoute === currentRouteKey) {
        return window._extUnitsInFlightPromise;
    }
    const requestContext = captureRouteRequestContext();
    const hasCache = Array.isArray(window._cachedExternalUnits) && window._cachedExternalUnitsRoute === currentRouteKey;
    const hasWarmBundle = Boolean(
        window._projFlags && window._projFlags.FIN_EXTERNAL_UNITS === 'ON' &&
        window._finMatCache_ && window._finMatCache_.routeKey === currentRouteKey &&
        window._finMatCache_.externalUnitsReconstructed && (Date.now() - window._finMatCache_.fetchedAt) < 15000
    );
    if (!hasCache && !hasWarmBundle) {
        setSectionAsyncState_('extUnitsRegistryBody', 'LOADING', { colspan: 7, loadingText: 'Зареждане на самостоятелните обекти…' });
        setSectionAsyncState_('extUnitsStatementBody', 'LOADING', { colspan: 8, loadingText: 'Зареждане на справката по периоди…' });
        setSectionAsyncState_('extUnitsReconciliationBody', 'LOADING', { colspan: 7, loadingText: 'Зареждане на сверката…' });
        setSectionAsyncState_('extUnitActionsBody', 'LOADING', { colspan: 6, loadingText: 'Зареждане на регистъра на промените…' });
    }
    window._extUnitsInFlightRoute = currentRouteKey;
    const runPromise = (async () => {
        try {
            const extFlag = (window._projFlags && window._projFlags.FIN_EXTERNAL_UNITS) || 'OFF';
            let res = null;
            if (extFlag === 'ON') {
                const matBundle = await readFinancialManifestBundleV2_(currentRouteKey, { dashboard: false, externalSummary: true, externalRows: true });
                throwIfStaleRouteRequestContext(requestContext);
                if (matBundle && matBundle.externalUnitsReconstructed && matBundle.externalUnitsReconstructed.success) {
                    res = Object.assign({ _fromPrecomputed: true }, matBundle.externalUnitsReconstructed);
                }
            } else if (extFlag === 'PARITY') {
                const [matBundle, legRes] = await Promise.all([
                    readFinancialManifestBundleV2_(currentRouteKey, { dashboard: false, externalSummary: true, externalRows: true }).catch(() => null),
                    apiCall('getExternalUnitsV1', { routeKey: currentRouteKey })
                ]);
                throwIfStaleRouteRequestContext(requestContext);
                res = legRes;
                if (matBundle && matBundle.externalUnitsReconstructed && legRes && legRes.success) {
                    const matSum = (matBundle.externalUnitsReconstructed.unitStatements || []).reduce((s, u) => s + Number(u.endingDebtCents || 0), 0);
                    const legSum = (legRes.unitStatements || []).reduce((s, u) => s + Number(u.endingDebtCents || 0), 0);
                    const exact = matSum === legSum && (matBundle.externalUnitsReconstructed.units || []).length === (legRes.units || []).length;
                    if (Array.isArray(window._finMatParityLog_)) {
                        window._finMatParityLog_.push({ model: 'EXTERNAL_UNITS_V1', exact, matSum, legSum });
                    }
                    if (exact) res = Object.assign({ _fromPrecomputed: true }, matBundle.externalUnitsReconstructed);
                }
            } else if (extFlag === 'SHADOW') {
                readFinancialManifestBundleV2_(currentRouteKey, { dashboard: false, externalSummary: true, externalRows: true }).catch(() => null);
            }
            if (!res) {
                res = await apiCall('getExternalUnitsV1', { routeKey: currentRouteKey });
            }
            throwIfStaleRouteRequestContext(requestContext);
            if (!res || !res.success) {
                throw new Error((res && res.error) ? res.error : 'Неуспешно зареждане на самостоятелните обекти.');
            }

            window._cachedExternalUnitsRoute = currentRouteKey;
            window._cachedExternalUnits = Array.isArray(res.units) ? res.units : [];
            window._cachedExternalUnitStatements = Array.isArray(res.unitStatements) ? res.unitStatements : [];
            window._cachedExternalReconciliation = Array.isArray(res.reconciliationByPeriod) ? res.reconciliationByPeriod : [];
            window._cachedExternalPendingPayments = Array.isArray(res.pendingPayments) ? res.pendingPayments : [];
            window._cachedExternalUnitActions = Array.isArray(res.actions) ? res.actions : [];

            const sel = document.getElementById('extUnitSelect');
            if (sel) {
                const prevVal = sel.value;
                sel.innerHTML = '<option value="">➕ Нов самостоятелен обект</option>';
                window._cachedExternalUnits.forEach(u => {
                    sel.appendChild(new Option(`${u.unitId} — ${u.name}`, u.unitId));
                });
                if (prevVal && window._cachedExternalUnits.some(u => u.unitId === prevVal)) {
                    sel.value = prevVal;
                }
                if (!silent) extUnitSelectionChanged();
            }

            const filterSel = document.getElementById('extUnitStatementFilter');
            if (filterSel) {
                const prevFilter = filterSel.value || 'ALL';
                filterSel.innerHTML = '<option value="ALL">Всички самостоятелни обекти</option>';
                window._cachedExternalUnits.forEach(u => {
                    filterSel.appendChild(new Option(`${u.unitId} — ${u.name}`, u.unitId));
                });
                if (prevFilter === 'ALL' || window._cachedExternalUnits.some(u => u.unitId === prevFilter)) {
                    filterSel.value = prevFilter;
                }
            }

            populateExternalUnitSelects_();
            renderExternalUnitsRegistry();
            renderExternalUnitsStatementView();
            renderExternalUnitActions();
            renderPendingExternalPayments_();
            updateExternalIdealWarningBanner_();
            if (typeof requestAnimationFrame === 'function') {
                requestAnimationFrame(() => {
                    const tNow = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
                    document.documentElement.dataset.perfExtMs = String(Math.round(tNow - _extPerfStart));
                });
            }
        } catch (err) {
            if (!isStaleRouteRequestError(err)) {
                const errMsg = (err && err.message) ? err.message : 'Грешка при зареждане.';
                setSectionAsyncState_('extUnitsRegistryBody', 'ERROR', { colspan: 7, errorText: errMsg, retryAction: 'loadExternalUnitsData(false)' });
                setSectionAsyncState_('extUnitsStatementBody', 'ERROR', { colspan: 8, errorText: errMsg, retryAction: 'loadExternalUnitsData(false)' });
                setSectionAsyncState_('extUnitsReconciliationBody', 'ERROR', { colspan: 7, errorText: errMsg, retryAction: 'loadExternalUnitsData(false)' });
                setSectionAsyncState_('extUnitActionsBody', 'ERROR', { colspan: 6, errorText: errMsg, retryAction: 'loadExternalUnitsData(false)' });
            }
        } finally {
            window._extUnitsInFlightPromise = null;
        }
    })();
    window._extUnitsInFlightPromise = runPromise;
    return runPromise;
};

function updateExternalIdealWarningBanner_() {
    const warnEl = document.getElementById('extUnitIdealWarning');
    if (!warnEl) return;
    const units = Array.isArray(window._cachedExternalUnits) ? window._cachedExternalUnits : [];
    const unest = units.filter(u => u.idealPartsStatus === 'UNESTABLISHED');
    if (unest.length > 0) {
        const names = unest.map(u => `${u.unitId} (${u.name})`).join(', ');
        warnEl.style.display = 'block';
        warnEl.innerHTML = `ℹ️ <b>Обекти с неустановени идеални части:</b> ${names}. В режими „Равно“ и „Обитатели“ те участват нормално по съответния параметър. При режим „Идеални части“ и „Фонд ремонт“ автоматичното начисляване за обект с неустановен дял е блокирано до установяване на дяловете.`;
    } else {
        warnEl.style.display = 'none';
        warnEl.innerHTML = '';
    }
}

window.navigateToExternalPayerForUnit = function(unitId) {
    if (typeof window.clearMasterDirtyState === 'function') window.clearMasterDirtyState();
    if (typeof window.switchAdminTab === 'function') window.switchAdminTab('incomes');
    setTimeout(function() {
        if (typeof populateExternalUnitSelects_ === 'function') populateExternalUnitSelects_();
        const payerUnitSel = document.getElementById('v2PayerExtUnit');
        if (payerUnitSel && unitId) {
            payerUnitSel.value = unitId;
        }
        const payerTypeSel = document.getElementById('v2PayerType');
        if (payerTypeSel) {
            payerTypeSel.value = 'Наем';
        }
        const payerNameInput = document.getElementById('v2PayerName');
        const payerSection = payerNameInput && typeof payerNameInput.closest === 'function'
            ? payerNameInput.closest('.admin-section')
            : payerUnitSel;
        if (payerSection && typeof payerSection.scrollIntoView === 'function') {
            payerSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        if (payerNameInput && typeof payerNameInput.focus === 'function') {
            payerNameInput.focus();
        }
    }, 80);
};

window.saveExternalUnitSettings = async function() {
    const requestContext = captureRouteRequestContext();
    const btn = document.getElementById('extUnitSaveBtn');
    const statusMsg = document.getElementById('extUnitStatusMsg');
    if (statusMsg) statusMsg.textContent = '';

    const origBtnHtml = btn ? btn.innerHTML : '';
    const t0 = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

    const unitId = document.getElementById('extUnitSelect')?.value || '';
    const name = document.getElementById('extUnitName')?.value.trim() || '';
    const accessType = document.getElementById('extUnitAccessType')?.value || 'SEPARATE_ENTRANCE';
    const documentedPurpose = document.getElementById('extUnitDocPurpose')?.value || 'Магазин';
    const actualUsage = document.getElementById('extUnitActualUsage')?.value || 'Търговски обект';
    const areaSqm = document.getElementById('extUnitArea')?.value.trim() || '';
    const cadastreEl = document.getElementById('extUnitCadastre');
    const cadastralId = cadastreEl ? cadastreEl.value.trim() : undefined;
    const managementParticipation = document.getElementById('extUnitMgmtPart')?.value === 'true';
    const occupantsStr = document.getElementById('extUnitOccupants')?.value.trim() || '0';
    const art51Active = accessType === 'COMMON_ENTRANCE' && document.getElementById('extUnitArt51Active')?.value === 'true';
    const art51Multiplier = art51Active ? Number(document.getElementById('extUnitMultiplier')?.value || 3) : 1;
    const idealPartsStatus = document.getElementById('extUnitIdealStatus')?.value || 'UNESTABLISHED';
    const idealPartsPercent = idealPartsStatus === 'ESTABLISHED' ? document.getElementById('extUnitIdealPercent')?.value.trim() : null;
    const autoChargeRepairFund = document.getElementById('extUnitRepairPart')?.value === 'true';
    const contractRentAmount = document.getElementById('extUnitRentAmount')?.value.trim() || '0';
    const effectiveFromPeriod = document.getElementById('extUnitPeriod')?.value.trim() || '';

    if ([areaSqm, String(idealPartsPercent || ''), contractRentAmount].some(s => s.includes(','))) {
        showToast('Използвайте точка (.) за десетични стойности.', 'error');
        if (statusMsg) statusMsg.textContent = 'Грешка: Използвайте точка (.) за десетични стойности.';
        return;
    }

    const changeRequestId = (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function')
        ? crypto.randomUUID()
        : '10000000-1000-4000-8000-' + String(Date.now()).padStart(12, '0');

    const payload = {
        changeRequestId: changeRequestId,
        unitId: unitId || undefined,
        name: name,
        documentedPurpose: documentedPurpose,
        actualUsage: actualUsage,
        areaSqm: areaSqm === '' ? null : areaSqm,
        accessType: accessType,
        idealPartsStatus: idealPartsStatus,
        idealPartsPercent: idealPartsStatus === 'ESTABLISHED' ? idealPartsPercent : null,
        occupantsCount: occupantsStr,
        managementParticipation: managementParticipation,
        autoChargeRepairFund: autoChargeRepairFund,
        art51Active: art51Active,
        art51Multiplier: art51Multiplier,
        contractRentAmount: contractRentAmount,
        effectiveFromPeriod: effectiveFromPeriod,
        active: true
    };
    if (cadastralId !== undefined) {
        payload.cadastralId = cadastralId === '' ? null : cadastralId;
    }

    if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="art51-spinner" style="display:inline-block; vertical-align:middle; width:14px; height:14px; border:2px solid rgba(255,255,255,0.4); border-top-color:#fff; border-radius:50%; margin-right:6px; animation:spin 0.7s linear infinite;"></span>Запазване…';
    }
    if (statusMsg) statusMsg.textContent = 'Записване...';

    const t1 = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

    try {
        const adminEmail = sessionStorage.getItem('adminEmail_' + currentRouteKey) || localStorage.getItem('savedAdminEmail') || '';
        const res = await apiCall('saveExternalUnitV1', {
            routeKey: currentRouteKey,
            pin: getStoredPin(),
            adminEmail: adminEmail,
            request: JSON.stringify(payload)
        });
        throwIfStaleRouteRequestContext(requestContext);

        const t2 = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();

        if (!res || !res.success) {
            const errText = (res && res.error) ? res.error : 'Грешка при запис на самостоятелния обект.';
            if (statusMsg) statusMsg.textContent = errText;
            showToast(errText, 'error');
            if (btn) {
                btn.disabled = false;
                btn.innerHTML = origBtnHtml;
            }
            return;
        }

        if (typeof window.clearMasterDirtyState === 'function') window.clearMasterDirtyState();
        const savedUnitId = res.unit && res.unit.unitId ? res.unit.unitId : '';
        
        // Instant UI update using data returned directly from saveExternalUnitV1!
        if (Array.isArray(res.units)) {
            window._cachedExternalUnits = res.units;
        }
        if (Array.isArray(res.actions)) {
            window._cachedExternalUnitActions = res.actions;
        }
        const sel = document.getElementById('extUnitSelect');
        if (sel) {
            sel.innerHTML = '<option value="">➕ Нов самостоятелен обект</option>';
            (window._cachedExternalUnits || []).forEach(u => {
                sel.appendChild(new Option(`${u.unitId} — ${u.name}`, u.unitId));
            });
            if (savedUnitId) {
                sel.value = savedUnitId;
                extUnitSelectionChanged();
            }
        }
        const filterSel = document.getElementById('extUnitStatementFilter');
        if (filterSel) {
            const prevFilter = filterSel.value || 'ALL';
            filterSel.innerHTML = '<option value="ALL">Всички самостоятелни обекти</option>';
            (window._cachedExternalUnits || []).forEach(u => {
                filterSel.appendChild(new Option(`${u.unitId} — ${u.name}`, u.unitId));
            });
            filterSel.value = prevFilter;
        }
        populateExternalUnitSelects_();
        renderExternalUnitsRegistry();
        renderExternalUnitActions();
        updateExternalIdealWarningBanner_();

        const t3 = (typeof performance !== 'undefined' && typeof performance.now === 'function') ? performance.now() : Date.now();
        console.log(`[PERF_SAVE_EXT_UNIT] Total UI time: ${(t3 - t0).toFixed(1)}ms | API roundtrip: ${(t2 - t1).toFixed(1)}ms | UI render: ${(t3 - t2).toFixed(1)}ms`);

        showToast('Обектът е запазен', 'success');
        if (statusMsg && res.unit) {
            statusMsg.innerHTML = `✅ Обектът е запазен успешно: <b>${res.unit.unitId} (${res.unit.name})</b> от период ${res.unit.effectiveFromPeriod}. &nbsp;🔗 <a href="#" class="ext-unit-epay-link" onclick="navigateToExternalPayerForUnit('${savedUnitId}'); return false;">За ePay: свържи обекта с платец</a>`;
        }

        // Non-blocking background sync for statements and ideal parts checks
        purgeFinancialMaterializedCache_();
        setTimeout(() => {
            if (typeof loadExternalUnitsData === 'function') loadExternalUnitsData(true);
            if (typeof checkRemontEligibility === 'function') checkRemontEligibility();
        }, 50);
    } catch (e) {
        if (!isStaleRouteRequestError(e)) {
            if (statusMsg) statusMsg.textContent = e.message || 'Грешка при запис.';
            showToast(e.message || 'Грешка при запис.', 'error');
        }
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.innerHTML = origBtnHtml;
        }
    }
};

window.renderExternalUnitsRegistry = function() {
    const tbody = document.getElementById('extUnitsRegistryBody');
    if (!tbody) return;
    const units = Array.isArray(window._cachedExternalUnits) ? window._cachedExternalUnits : [];
    if (units.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align: center; color: #64748b; padding: 14px;">Няма регистрирани самостоятелни обекти.</td></tr>';
        return;
    }
    tbody.innerHTML = units.map(u => {
        const accessText = u.accessType === 'COMMON_ENTRANCE'
            ? `Общ вход (${u.art51Active ? u.art51Multiplier + 'x чл. 51' : '1x'})`
            : 'Самостоятелен (1x, чл. 51 ал. 6)';
        const idealText = u.idealPartsStatus === 'ESTABLISHED'
            ? `${Number(u.idealPartsPercent).toFixed(2)}%`
            : 'Неустановени';
        const areaInfo = u.areaSqm ? ` (${u.areaSqm} кв.м)` : '';
        return `<tr>
            <td><b>${u.unitId}</b> — ${u.name}${areaInfo}</td>
            <td>${u.documentedPurpose} / ${u.actualUsage}</td>
            <td>${accessText}</td>
            <td>${idealText} / ${u.occupantsCount} обит.</td>
            <td>УП: <b>${u.managementParticipation ? 'ДА' : 'НЕ'}</b> | Рем.: <b>${u.autoChargeRepairFund ? 'ДА' : 'НЕ'}</b></td>
            <td>${Number(u.contractRentAmount || 0).toFixed(2)} EUR</td>
            <td>${u.effectiveFromPeriod}</td>
        </tr>`;
    }).join('');
};

window.renderExternalUnitsStatementView = function() {
    const tbody = document.getElementById('extUnitsStatementBody');
    const recBody = document.getElementById('extUnitsReconciliationBody');
    const filterVal = document.getElementById('extUnitStatementFilter')?.value || 'ALL';
    const stmts = Array.isArray(window._cachedExternalUnitStatements) ? window._cachedExternalUnitStatements : [];
    const recs = Array.isArray(window._cachedExternalReconciliation) ? window._cachedExternalReconciliation : [];

    if (tbody) {
        const filtered = filterVal === 'ALL' ? stmts : stmts.filter(s => s.unitId === filterVal);
        const rows = [];
        filtered.forEach(st => {
            (st.periods || []).forEach(p => {
                if (isFutureTechnicalPeriodUI(p.period)) return;
                if (p.chargedCents === 0 && p.paidCents === 0 && p.endingDebtCents === 0 && p.endingAdvanceCents === 0) return;
                const mgmt = p.buckets.management;
                const rep = p.buckets.repairFund;
                const rent = p.buckets.contractRent;
                rows.push(`<tr>
                    <td><b>${st.unitId}</b> (${st.name}) — ${p.period}</td>
                    <td>${(mgmt.chargedCents / 100).toFixed(2)} / ${(mgmt.paidCents / 100).toFixed(2)} EUR</td>
                    <td>${(rep.chargedCents / 100).toFixed(2)} / ${(rep.paidCents / 100).toFixed(2)} EUR</td>
                    <td>${(rent.chargedCents / 100).toFixed(2)} / ${(rent.paidCents / 100).toFixed(2)} EUR</td>
                    <td><b>${(p.chargedCents / 100).toFixed(2)} EUR</b></td>
                    <td style="color:#16a34a;"><b>${(p.paidCents / 100).toFixed(2)} EUR</b></td>
                    <td style="color:#0284c7;">${(p.endingAdvanceCents / 100).toFixed(2)} EUR</td>
                    <td style="color:${p.endingDebtCents > 0 ? '#dc2626' : '#16a34a'};"><b>${(p.endingDebtCents / 100).toFixed(2)} EUR</b></td>
                </tr>`);
            });
        });
        tbody.innerHTML = rows.length > 0
            ? rows.join('')
            : '<tr><td colspan="8" style="text-align: center; color: #64748b; padding: 14px;">Няма начисления или движения за избрания филтър.</td></tr>';
    }

    if (recBody) {
        const activeRecs = recs.filter(r => r.grossExpenseCents !== 0 || r.externalBaseCents !== 0);
        recBody.innerHTML = activeRecs.length > 0
            ? activeRecs.map(r => {
                const resSign = r.masterRoundingResidualCents > 0 ? '+' : '';
                return `<tr>
                    <td><b>${r.period}</b></td>
                    <td>${(r.grossExpenseCents / 100).toFixed(2)} EUR</td>
                    <td>${(r.masterBaseCents / 100).toFixed(2)} EUR</td>
                    <td>${(r.externalBaseCents / 100).toFixed(2)} EUR</td>
                    <td>+${(r.externalSurchargeCents / 100).toFixed(2)} EUR</td>
                    <td>${resSign}${(r.masterRoundingResidualCents / 100).toFixed(2)} EUR</td>
                    <td><b>${(r.totalReceivablesCents / 100).toFixed(2)} EUR</b></td>
                </tr>`;
            }).join('')
            : '<tr><td colspan="7" style="text-align: center; color: #64748b; padding: 12px;">Няма операции с двустепенно разпределение.</td></tr>';
    }
};

window.renderExternalUnitActions = function() {
    const tbody = document.getElementById('extUnitActionsBody');
    if (!tbody) return;
    const actions = Array.isArray(window._cachedExternalUnitActions) ? window._cachedExternalUnitActions : [];
    if (actions.length === 0) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: #64748b; padding: 14px;">Няма записани промени.</td></tr>';
        return;
    }
    tbody.innerHTML = actions.map(a => {
        const dt = a.timestamp ? new Date(a.timestamp).toLocaleString('bg-BG') : '';
        return `<tr>
            <td>${dt}</td>
            <td><b>${a.unitId}</b> — ${a.unitName || ''}</td>
            <td><b>${a.managementParticipation || '—'}</b></td>
            <td>${a.previousState || '—'}</td>
            <td>${a.newState || '—'}</td>
            <td>${a.effectiveFromPeriod || '—'}</td>
        </tr>`;
    }).join('');
};

function renderPendingExternalPayments_() {
    const card = document.getElementById('v2PendingExtPaymentsCard');
    const tbody = document.getElementById('v2PendingExtPaymentsBody');
    if (!card || !tbody) return;
    const pending = Array.isArray(window._cachedExternalPendingPayments) ? window._cachedExternalPendingPayments : [];
    if (pending.length === 0) {
        card.style.display = 'none';
        tbody.innerHTML = '';
        return;
    }
    card.style.display = 'block';
    tbody.innerHTML = pending.map((p, idx) => `<tr>
        <td style="padding: 6px;"><b>${p.period}</b><br>${p.unitId} (${p.unitName})</td>
        <td style="padding: 6px;">${p.payerName || ''}<br><span style="color:#666; font-size:11px;">${p.reasonFromEmail || ''}</span></td>
        <td style="padding: 6px; text-align:right;"><b>${Number(p.amount).toFixed(2)} EUR</b></td>
        <td style="padding: 6px;">
            <select id="pendingExtCat_${idx}" class="admin-input" style="font-size:11px; padding:4px; margin-bottom:4px;">
                <option value="Плащане за СО">Плащане за самостоятелен обект (автоматичен приоритет)</option>
                <option value="Управление и поддръжка">Управление и поддръжка</option>
                <option value="Фонд ремонт">Фонд ремонт</option>
                <option value="Наем">Наем</option>
            </select>
            <button type="button" class="admin-btn primary" style="font-size:11px; padding:4px 8px;" onclick="resolvePendingExternalEpayPayment('${p.pendingId}', ${idx})">Потвърди</button>
        </td>
    </tr>`).join('');
}

window.resolvePendingExternalEpayPayment = async function(pendingId, idx) {
    const pending = (window._cachedExternalPendingPayments || []).find(p => p.pendingId === pendingId);
    if (!pending) return;
    const catEl = document.getElementById('pendingExtCat_' + idx);
    const selectedCat = catEl ? catEl.value : 'Плащане за СО';
    const explicitBasis = selectedCat === 'Плащане за СО' ? '' : selectedCat;
    try {
        const res = await apiCall('resolveExternalPendingPaymentV1', {
            routeKey: currentRouteKey,
            pin: getStoredPin(),
            request: JSON.stringify({
                paymentId: pending.paymentId,
                resolvePendingId: pending.pendingId,
                unitId: pending.unitId,
                period: pending.period,
                category: 'Плащане за СО',
                basis: explicitBasis,
                amount: pending.amount,
                docNum: pending.ePayCode ? ('ePay ' + pending.ePayCode) : 'ePay',
                note: 'Потвърдено ePay плащане. Наредител: ' + (pending.payerName || '') + '. Основание: ' + (pending.reasonFromEmail || ''),
                source: 'epay-resolved',
                timestamp: pending.timestamp
            })
        });
        if (res && res.success) {
            showToast('Плащането е разпределено успешно!', 'success');
            purgeFinancialMaterializedCache_();
            await loadExternalUnitsData(true);
            if (typeof loadIncomesV2 === 'function') loadIncomesV2();
            if (typeof updateV2DistAvailableSum === 'function') updateV2DistAvailableSum();
        } else {
            showToast((res && res.error) || 'Грешка при потвърждаване.', 'error');
        }
    } catch (e) {
        showToast(e.message || 'Грешка при потвърждаване.', 'error');
    }
};
// ============================================================================
// END EXTERNAL UNITS CLIENT
// ============================================================================
