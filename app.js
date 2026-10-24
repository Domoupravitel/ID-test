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

    if (idValue) {
        const cleanId = idValue.trim();
        document.getElementById('access-id').value = cleanId;
        
        // Trigger entrance
        const success = await enterEntrance();

        if (success && aptValue) {
            const select = document.getElementById("apartmentSelect");
            const targetApt = decodeURIComponent(aptValue);
            
            // Polling approach is safer than a fixed timeout
            // removed attempts
            // removed interval wrapper
                if (apartmentList && apartmentList.length > 0) {
                    // Try to find matching apartment
                    const found = apartmentList.find(a => normalizeAptName(a) === normalizeAptName(targetApt)) || 
                                  apartmentList.find(a => a === targetApt);
                    
                    if (found) {
                        select.value = found;
                        loadApartmentData(found);
                    }
                    // removed clearInterval
                }
                // removed attempts check
            // removed interval closing braces
        }
    }

    // Зареждаме публичните настройки (Бутон за регистрация и т.н.)
    loadPublicSettings();

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

async function loadPublicSettings() {
    try {
        const res = await apiCall('getPublicSettings');
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
let art51Pending = null;
let art51ContextKey_ = null, art51RequestSequence_ = 0;
let art51DataKey_ = null;
function art51CurrentKey_() { return JSON.stringify([currentRouteKey,document.getElementById('art51Apartment').value,document.getElementById('art51Period').value,typeof financialNavigationRevision_==='number'?financialNavigationRevision_:0]); }
window.art51ContextChanged = function() {
    art51DataKey_=null;art51ContextKey_=art51CurrentKey_();art51RequestSequence_++;
    document.getElementById('art51Confirmed').checked=false;
    document.getElementById('art51Reference').value='';
    document.getElementById('art51DecisionDate').value='';
    document.getElementById('art51Active').value='false';
    document.getElementById('art51Multiplier').value='';
    document.getElementById('art51Status').textContent='Изберете и потвърдете решение за текущия обект.';
};
window.openArt51Settings = function() {
    if(art51ContextKey_!==art51CurrentKey_())window.art51ContextChanged();
    if(art51Pending&&art51Pending.route!==currentRouteKey)art51Pending=null;
    if(!art51Pending){const retained=sessionStorage.getItem('art51Pending_'+currentRouteKey);if(retained){const p=JSON.parse(retained);if(p.route===currentRouteKey&&typeof p.raw==='string')art51Pending=Object.freeze(p);}}
    const target=document.getElementById('art51Apartment'),source=document.getElementById('masterInfoApt');
    if(!target.options.length&&source)target.innerHTML=source.innerHTML;
};
window.loadArt51Settings = async function() {
    if(art51ContextKey_!==art51CurrentKey_())window.art51ContextChanged();
    const key=art51CurrentKey_(),sequence=++art51RequestSequence_;art51ContextKey_=key;art51DataKey_=null;
    document.getElementById('art51Confirmed').checked=false;
    const owner=captureRouteRequestContext(),route=currentRouteKey,apartment=document.getElementById('art51Apartment').value,period=document.getElementById('art51Period').value;
    let result;
    try{result=await apiCall('getArt51V1',{pin:getStoredPin(),request:JSON.stringify({apartment,period})});throwIfStaleRouteRequestContext(owner);}
    catch(e){if(key===art51CurrentKey_()&&sequence===art51RequestSequence_)document.getElementById('art51Status').textContent='Няма потвърдено прочитане. Заредете настройката отново.';return;}
    if(key!==art51CurrentKey_()||sequence!==art51RequestSequence_)return;
    const status=document.getElementById('art51Status');if(!result.success){status.textContent='Няма потвърдено прочитане: '+(result.error||'неясен резултат');return;}
    const v=result.version;document.getElementById('art51Active').value=v&&v.active?'true':'false';document.getElementById('art51Multiplier').value=v&&v.active?v.multiplier:'';
    document.getElementById('art51DecisionDate').value=v&&v.active?v.decisionDate:'';document.getElementById('art51Reference').value=v&&v.active?v.decisionReference:'';document.getElementById('art51Confirmed').checked=false;
    status.textContent=v?'Приложимо решение от '+v.effectiveFromPeriod+'; Общ. достъп: '+(v.active?'Да, множител '+v.multiplier:'Не'):'Общ. достъп: Не (няма приложимо решение)';
    document.getElementById('art51History').textContent=result.history.map(x=>x.effectiveFromPeriod+': '+(x.active?'Да ×'+x.multiplier:'Не')+'; '+(x.decisionDate||'')+' '+(x.decisionReference||'')).join('\n');
    art51DataKey_=key;
};
async function sendArt51Pending_() {
    if(!art51Pending)return;const attempt=art51Pending,owner=captureRouteRequestContext();
    if(attempt.route!==currentRouteKey)throw Error('Маршрутът е променен.');
    const key=art51CurrentKey_(),sequence=++art51RequestSequence_,intent=JSON.parse(attempt.raw);
    if(intent.apartment!==document.getElementById('art51Apartment').value||intent.effectiveFromPeriod!==document.getElementById('art51Period').value)throw Error('Възстановете обекта и периода на непотвърдения запис.');
    document.getElementById('art51Status').textContent='Непотвърден запис — изчаква се сървърът.';
    const result=await apiCall('saveArt51V1',{pin:getStoredPin(),request:attempt.raw});throwIfStaleRouteRequestContext(owner);
    if(key!==art51CurrentKey_()||sequence!==art51RequestSequence_)return;
    const status=document.getElementById('art51Status');
    if(!result.success){status.textContent=result.error==='ART51_REPORT_SYNC_PENDING'?'Решението е записано, но салдата и отчетите не са потвърдени. Използвайте „Повтори непотвърдения запис“.':'Непотвърден запис. Настройката не е потвърдена като приложена. За същия запис използвайте „Повтори непотвърдения запис“. '+(result.error||'');if(['ART51_VALIDATION','ART51_DECISION','ART51_PROSPECTIVE_PERIOD','ART51_FINANCIAL_CONFLICT'].includes(result.error)){sessionStorage.removeItem('art51Pending_'+attempt.route);art51Pending=null;}return;}
    if(art51Pending===attempt){sessionStorage.removeItem('art51Pending_'+attempt.route);art51Pending=null;}
    status.textContent='Потвърдено решение от '+result.version.effectiveFromPeriod+'.';
}
window.saveArt51Settings = async function() {
    if(art51ContextKey_!==null&&art51ContextKey_!==art51CurrentKey_()){window.art51ContextChanged();return;}
    art51ContextKey_=art51CurrentKey_();
    if(!art51Pending){const retained=sessionStorage.getItem('art51Pending_'+currentRouteKey);if(retained)art51Pending=Object.freeze(JSON.parse(retained));}
    if(art51Pending){document.getElementById('art51Status').textContent='Първо потвърдете предишния запис чрез „Повтори непотвърдения запис“.';return;}
    if(art51DataKey_!==art51CurrentKey_()){document.getElementById('art51Status').textContent='Първо заредете успешно настройката за текущия вход, апартамент и период.';return;}
    const active=document.getElementById('art51Active').value==='true';
    const request={contractVersion:1,changeRequestId:crypto.randomUUID(),apartment:document.getElementById('art51Apartment').value,active,
        multiplier:active?Number(document.getElementById('art51Multiplier').value):null,effectiveFromPeriod:document.getElementById('art51Period').value,
        decisionDate:active?document.getElementById('art51DecisionDate').value:null,decisionReference:active?document.getElementById('art51Reference').value:null,motivatedDecisionConfirmed:active?document.getElementById('art51Confirmed').checked:false};
    const pending=Object.freeze({route:currentRouteKey,raw:JSON.stringify(request)});sessionStorage.setItem('art51Pending_'+currentRouteKey,JSON.stringify(pending));art51Pending=pending;await sendArt51Pending_();
};
window.retryArt51Settings = sendArt51Pending_;
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
        // The accepted form-POST contract avoids URL limits for nine per-category notes.
        const response = (action === 'distributeMaintenanceV1' || action === 'fin01Preview' || action === 'fin01Settle' || action === 'addChargesV2' || action === 'saveRecurringExpenseV1') ? // SLICE5_RECURRING_UI // FIN01_POST // MAINTENANCE_POST
            await fetch(SCRIPT_URL, {method: 'POST', body: new URLSearchParams(params)}) :
            await fetch(`${SCRIPT_URL}?${queryParams}`);
        const result = await response.json();
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

// --- SAVING STATE (Задача 8: визуална индикация при запис) ---
window.showSaving = function (btn, text = "⏳ Записване...") {
    if (!btn) return;
    btn._originalText = btn.innerHTML;
    btn.innerHTML = `<span style="display:inline-flex;align-items:center;gap:7px;">
        <span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.4);border-top-color:#fff;border-radius:50%;animation:spin 0.7s linear infinite;"></span>
        ${text}
    </span>`;
    btn.disabled = true;
    btn.style.opacity = "0.8";
}
window.hideSaving = function (btn, originalText) {
    if (!btn) return;
    btn.innerHTML = originalText || btn._originalText || "Запази";
    btn.disabled = false;
    btn.style.opacity = "";
}

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

    const [result, configResult] = await Promise.all([
        apiCall('list', { list: 'apartments' }),
        apiCall('getEntranceInfo')
    ]);

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

        // Запазваме статуса на абонамента за проверка при зареждане на апартамент
        sessionStorage.setItem("isSoftBlocked_" + currentRouteKey, info.isSoftBlocked ? "true" : "false");
        sessionStorage.setItem("isHardBlocked_" + currentRouteKey, info.isHardBlocked ? "true" : "false");

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

        loadDashboardData();
        return true;
    } else {
        if (btn) {
            btn.textContent = originalText;
            btn.disabled = false;
        }
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
  const { collection, getDocs, query, where } = window.fb;
  const db = window.db;

  const q = query(
    collection(db, "apartments"),
    where("buildingId", "==", routeKey)
  );

  const snapshot = await getDocs(q);

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
  try {
    const qDist = query(
      collection(db, "distributionsV2"),
      where("routeKey", "==", routeKey),
      where("category", "==", "Фонд ремонт")
    );
    const snapDist = await getDocs(qDist);
    snapDist.forEach(d => {
      totalSpent += parseFloat(d.data().amount) || 0;
    });
  } catch (err) {
    if (isStaleRouteRequestError(err)) throw err;
    console.error("Error loading distributions for dashboard:", err);
  }

  return {
    success: true,
    dashboard: {
      totalDebts: totalDebt.toFixed(2),
      totalBalance: totalBalance.toFixed(2),
      totalTargetFund: totalTargetFund.toFixed(2),
      totalSpent: totalSpent.toFixed(2),
      trendData: []
    }
  };
}

async function loadDashboardData() {
    if(typeof maintenanceRefreshSummary_==='function')maintenanceRefreshSummary_(); // MAINTENANCE_HOME
    const requestContext = captureRouteRequestContext();
    try {
        // Hard block — не зареждаме Firebase данни
        if (sessionStorage.getItem("isHardBlocked_" + currentRouteKey) === "true") {
            document.getElementById('dash-debts').textContent = "—";
            document.getElementById('dash-balance').textContent = "—";
            if (document.getElementById('dash-debts-trend')) document.getElementById('dash-debts-trend').textContent = "Достъпът е спрян";
            if (document.getElementById('dash-balance-trend')) document.getElementById('dash-balance-trend').textContent = "Достъпът е спрян";
            return;
        }
        const result = await loadDashboardFromFirebase(currentRouteKey);
        throwIfStaleRouteRequestContext(requestContext);
        if (result && result.success && result.dashboard) {
            const d = result.dashboard;
            const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";

            document.getElementById('dash-debts').textContent = `${d.totalDebts} ${cur}`;
            
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
                    label: 'Асансьор',
                    data: data.map(i => i.elevator),
                    borderColor: '#3b6edc',
                    backgroundColor: 'rgba(59, 110, 220, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Абонамент',
                    data: data.map(i => i.subscription),
                    borderColor: '#ff9500',
                    backgroundColor: 'rgba(255, 149, 0, 0.1)',
                    tension: 0.3,
                    fill: false,
                    pointRadius: 4,
                    pointHoverRadius: 6
                },
                {
                    label: 'Осветление',
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
                    label: 'Поддръжка',
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
// APARTMENT DATA
// ==============================================

async function loadApartmentFromFirebase(routeKey, apartmentId) {
  const { collection, getDocs, query, where } = window.fb;
  const db = window.db;

  const qApt = query(
    collection(db, "apartments"),
    where("buildingId", "==", routeKey),
    where("apartmentId", "==", apartmentId)
  );
  const snapApt = await getDocs(qApt);

  let result = { saldo: 0, periods: [], aptNotice: "" };

  snapApt.forEach(doc => {
    const data = doc.data();
    result.saldo = Number(data.balance || 0);
    result.targetFund = Number(data.targetFund || 0);
  });

  const qPeriods = query(
    collection(db, "monthlyReports"),
    where("buildingId", "==", routeKey),
    where("apartmentId", "==", apartmentId)
  );
  const snapPeriods = await getDocs(qPeriods);

  const rawPeriods = [];
  snapPeriods.forEach(doc => {
    rawPeriods.push(doc.data());
  });

  rawPeriods.sort((a, b) => {
    const [mA, yA] = (a.periodId || a.period || "").split(".");
    const [mB, yB] = (b.periodId || b.period || "").split(".");
    const dA = new Date(yA, mA - 1);
    const dB = new Date(yB, mB - 1);
    return dA - dB;
  });

  result.periods = rawPeriods.map(p => {
    const d = p.details || {};
    return {
      period: p.periodId || p.period,
      elevator: Number(d["Асансьор"] || p.elevator || 0),
      subscription: Number(d["Абонамент"] || p.subscription || 0),
      light: Number(d["Ток"] || p.light || 0),
      security: Number(d["Вход"] || p.security || 0),
      cleaning: Number(d["Чистач"] || p.cleaning || 0),
      podrajka: Number(d["Поддръжка"] || p.podrajka || 0),
      remont: Number(d["Ремонт"] || p.remont || 0),
      due: Number(p.totalDue || p.due || 0),
      paid: Number(p.receivedPaid ?? p.totalPaid ?? p.paid ?? 0) // MAINTENANCE_RECEIPT_UI
    };
  });

  return result;
}

async function loadApartmentData(apartment) {
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
        if (tBody) tBody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:#e74c3c;">⚠️ Достъпът е напълно спрян поради неплатен абонамент.</td></tr>';
        showToast("Достъпът до входа е напълно спрян поради неплатен абонамент", "error");
        return;
    }

    const isSoftBlocked = sessionStorage.getItem("isSoftBlocked_" + currentRouteKey) === "true";
    if (isSoftBlocked) {
        document.getElementById("saldo").textContent = "Скрит";
        // Скриваме таблицата с периодите
        const tBody = document.getElementById("tableBody");
        if (tBody) tBody.innerHTML = '<tr><td colspan="10" style="text-align:center; color:#e74c3c;">⚠️ Информацията е скрита поради неплатен абонамент.</td></tr>';
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
        if (result.periods && Array.isArray(result.periods)) {
            (result.periods || []).forEach((r, idx) => {
                const tr = document.createElement("tr");
                tr.innerHTML = `
                <td>${r.period}</td>
                <td>${Number(r.elevator || 0).toFixed(2)}</td>
                <td>${Number(r.subscription || 0).toFixed(2)}</td>
                <td>${Number(r.light || 0).toFixed(2)}</td>
                <td>${Number(r.security || 0).toFixed(2)}</td>
                <td>${Number(r.cleaning || 0).toFixed(2)}</td>
                <td>${Number(r.podrajka || 0).toFixed(2)}</td>
                <td>${Number(r.remont || 0).toFixed(2)}</td>
                <td>${Number(r.due || 0).toFixed(2)}</td>
                <td>${Number(r.paid || 0).toFixed(2)}</td>
            `;
                tBody.appendChild(tr);
            });
        } else {
            tBody.innerHTML = '<tr><td colspan="10" style="text-align:center;">Няма налични данни за избрания апартамент.</td></tr>';
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
    } else {
        showToast("Грешка при зареждане на данните", "error");
    }
}

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
}

function autoFillCurrentPeriod() {
    const d = new Date();
    const currentPeriod = String(d.getMonth() + 1).padStart(2, '0') + "." + d.getFullYear();

    const periodFields = [
        "adminPeriod", "chargesPeriod", "v2IncomePeriod",
        "masterLogikaFrom", "masterUchFrom",
        "masterObFrom", "masterChFrom", "masterIdFrom"
    ];

    periodFields.forEach(id => {
        const el = document.getElementById(id);
        if (el && el.tagName === 'SELECT') {
            // Populate if empty
            if (el.options.length === 0) {
                const year = d.getFullYear();
                const monthNames = [
                    "Януари", "Февруари", "Март", "Април", "Май", "Юни",
                    "Юли", "Август", "Септември", "Октомври", "Ноември", "Декември"
                ];
                
                monthNames.forEach((name, index) => {
                    const m = String(index + 1).padStart(2, '0');
                    const val = `${m}.${year}`;
                    const opt = new Option(`${name} ${year}`, val);
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
// ЗУЕС Валидация в реално време за обитатели
    const obInput = document.getElementById("masterObVal");
    if (obInput) {
        obInput.addEventListener("change", (e) => {
            if (e.target.value !== "" && parseInt(e.target.value) < 1) {
                showToast("⚠️ Минималният брой е 1. „За самостоятелен обект, в който се пребивава не повече от 30 дни в годината, разходите за управление и поддръжка се заплащат в размера, определен за един обитател.“ (Чл. 51, ал. 1 от ЗУЕС)", "error");
                e.target.value = 1;
            }
        });
    }
    autoFillCurrentPeriod();
    
    const v2AptSel = document.getElementById("v2IncomeApt");
    if (v2AptSel && apartmentList.length > 0 && v2AptSel.options.length <= 2) {
        v2AptSel.innerHTML = '<option value="">Избери...</option>';
        v2AptSel.appendChild(new Option("Външен източник", "EXTERNAL"));
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
    { labelId: 'lbl-chargesElevator',     name: 'Асансьор',     key: 'elevator' },
    { labelId: 'lbl-chargesSubscription', name: 'Абонамент',    key: 'subscription' },
    { labelId: 'lbl-chargesLight',        name: 'Ток',         key: 'light' },
    { labelId: 'lbl-chargesSecurity',     name: 'Охрана',       key: 'security' },
    { labelId: 'lbl-chargesCleaning',     name: 'Почистване',   key: 'cleaning' },
    { labelId: 'lbl-chargesPodrajka',     name: 'Поддръжка',    key: 'maintenance', legacyKey: 'podrajka' },
    { labelId: 'lbl-chargesRemont',       name: 'Ремонтен фонд', key: 'repairFund', legacyKey: 'remont' },
    { labelId: 'lbl-chargesWater',        name: 'ВиК',         key: 'water' },
    { labelId: 'lbl-chargesPlatformSubscription', name: 'Абонамент Платформа', key: 'platformSubscription' }
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
        // Четем директно от Firebase колекция buildingCharges — мигновено
        const { routeDoc, getDoc } = window.fb;
        const db = window.db;

        // Опитваме да вземем конкретния документ по ID
        const docId = currentRouteKey + "_" + period;
        const docRef = routeDoc(db, "buildingCharges", docId, currentRouteKey);
        const snap = await getDoc(docRef);
        throwIfStaleRouteRequestContext(requestContext);

        if (snap.exists()) {
            const data = snap.data();
            chargeLabelsMap.forEach(c => updateChargeLabel(c.labelId, c.name,
                Object.prototype.hasOwnProperty.call(data, c.key) ? data[c.key] : data[c.legacyKey]));
        } else {
            // Няма записани глобални начисления за този период
            chargeLabelsMap.forEach(c => updateChargeLabel(c.labelId, c.name, null));
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        console.error('loadCurrentCharges error:', e);
        clearChargeLabels();
    }
}

// BEGIN SLICE4 MANUAL EXPENSE UX
// Presentation mapping only: keys/order mirror EXPENSE_SCHEMA; no allocation rules here.
const manualExpenseStates_ = new Map();
function manualExpenseState_() {
    if (!manualExpenseStates_.has(currentRouteKey)) {
        const draft = Object.create(null);
        chargeLabelsMap.forEach(c => { draft[c.key] = {amount: '', note: ''}; });
        manualExpenseStates_.set(currentRouteKey, {draft, pending: null, inFlight: false, message: ''});
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
    const amount = state.draft[key].amount.trim();
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
    button.textContent = state.inFlight ? 'Записване…' : state.pending ? 'Повтори същия запис' : 'Запиши начисление (+/-)';
    const feedback = document.getElementById('chargesFeedback');
    feedback.textContent = state.message;
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
        } catch (error) {
            // Only our bounded validation messages enter the ordinary UI.
            state.message = error instanceof Error && /^(Изберете|Проверете|Въведете|Добавете)/.test(error.message) ?
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
        state.message = 'Всички въведени начисления са записани успешно.';
    } else if (classification === 'NOT_ADMITTED' && !history.uncertainHistory && !history.confirmedCategories.length) {
        state.pending = null;
        state.message = 'Заявката не е допусната за обработка. Проверете данните и достъпа; след корекция изпратете нов запис.';
    } else {
        state.pending = history;
        state.message = manualExpenseFailureMessage_(response, history, classification);
    }
    if (!isFinancialOperationContextCurrent(attemptContext)) return;
    resetManualExpenseView_();
    if (classification === 'APPLIED') {
        // The V2 reconciler has already published the aggregate; refresh by reading only.
        Promise.resolve(loadCurrentCharges()).catch(() => {});
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

    const result = await apiCall('getEmail', { apartment: apt, pin: getStoredPin() });
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

window.switchMasterTab = function (tab, btn) {
    document.querySelectorAll(".master-panel").forEach(p => p.style.display = "none");
    document.querySelectorAll(".master-tab").forEach(b => {
        b.classList.remove("active");
        // Reset special styles for ZUES toggle
        b.style.background = "";
        b.style.color = "";
        b.style.borderColor = "";
    });

    const pane = document.getElementById("master-tab-" + tab);
    if (pane) pane.style.display = "block";
    btn.classList.add("active");

    if (tab === 'zues') {
        // Синьо когато е активно
        btn.style.background = "var(--primary)";
        btn.style.color = "white";
        btn.style.borderColor = "var(--primary)";
        switchZuesSubTab('z-book');
    }
}

window.submitMaster = async function (sheetName) {
    const requestContext = captureRouteRequestContext();
    // В зависимост от подаденото име (Логика, и т.н.) събираме стойностите
    let val, fromP, toP, apt;

    if (sheetName === 'Логика') {
        val = document.getElementById('masterLogikaVal').value;
        fromP = document.getElementById('masterLogikaFrom').value.trim();
        toP = "12.2050"; 
        apt = "";
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
        if (val !== "" && parseInt(val) < 1) {
            showToast("⚠️ Минималният брой е 1.", "error");
            return;
        }
    } else if (sheetName === 'ЧИПОВЕ') {
        apt = document.getElementById('masterChApt').value;
        val = document.getElementById('masterChVal').value;
        fromP = document.getElementById('masterChFrom').value.trim();
        toP = "12.2050";
    } else if (sheetName === 'ИДЕАЛНИ_ЧАСТИ') {
        apt = document.getElementById('masterIdApt').value;
        val = document.getElementById('masterIdVal').value;
        fromP = document.getElementById('masterIdFrom').value.trim();
        toP = "12.2050";
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
            showToast(`Успешно обновен регистър: ${sheetName}. Данните се синхронизират...`, "success");
            if (sheetName === 'ИДЕАЛНИ_ЧАСТИ') {
                _creditIdealPartsOk = null; // инвалидираме кеша, за да прецени наново дали "Кредит" е достъпен
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
        }
    } catch (e) {
        if (isStaleRouteRequestError(e)) return;
        showToast("Сървърна грешка при запис", "error");
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
            container.innerHTML = `
                <div style="background:rgba(0,122,255,0.05); padding:15px; border-radius:8px; border-left:4px solid var(--primary);">
                    <h4 style="margin-bottom:10px;">📊 Статус за Апт. ${apt}</h4>
                    <ul style="list-style:none; padding:0;">
                        <li><b>👥 Обитатели:</b> ${d.occupants || 0} бр.</li>
                        <li><b>🔑 Чипове:</b> ${d.chips || 0} бр.</li>
                        <li><b>🔘 Уч. асансьор:</b> ${d.participation === 'Да' ? '✅ Да' : '❌ Не'}</li>
                        <li><b>📐 Идеални части:</b> ${d.idealParts || 0}%</li>
                    </ul>
                    <p style="font-size:11px; color:#666; margin-top:10px;">* Посочените данни са от текущия MASTER регистър и се използват за следващите начисления.</p>
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
            const tr = document.createElement("tr");
            tr.innerHTML = `
                <td style="padding: 8px;"><b>${ent.name}</b></td>
                <td style="padding: 8px; font-family: monospace;">${ent.id}</td>
                <td style="padding: 8px; color: ${ent.validUntil === '2000-01-01' ? 'red' : 'inherit'};">
                    ${ent.validUntil === '2000-01-01' ? 'Блокиран' : (ent.validUntil || '---')}
                </td>
                <td style="padding: 8px;">
                    <span class="status-badge" style="background:${ent.validUntil === '2000-01-01' ? '#fa5252' : '#4ade80'}; color:white; padding: 2px 6px; border-radius: 4px; font-size: 11px;">
                        ${ent.validUntil === '2000-01-01' ? 'Спрян' : 'Активен'}
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

window.openMonthlyReport = function () {
    switchPage('monthly-report');
    const d = new Date();
    // По подразбиране предходния месец (защото отчетите се правят за завършен период)
    const lastMonth = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    const periodStr = String(lastMonth.getMonth() + 1).padStart(2, '0') + "." + lastMonth.getFullYear();
    document.getElementById("reportPeriodInput").value = periodStr;
    document.getElementById("report-content").style.display = "none";
}

async function loadMonthlyReportFromFirebase(routeKey, period) {
  const { collection, getDocs, query, where } = window.fb;
  const db = window.db;

  const q = query(
    collection(db, "monthlyReports"),
    where("buildingId", "==", routeKey),
    where("periodId", "==", period)
  );

  const snapshot = await getDocs(q);

  let totalInvoiced = 0;
  let totalCollected = 0;

  const rows = [];
  
  let invoicedCounts = {
      elevator: 0, subscription: 0, light: 0,
      security: 0, cleaning: 0, podrajka: 0, remont: 0
  };

  snapshot.forEach(doc => {
    const d = doc.data();

    const due = Number(d.totalDue || d.due || 0);
    const paid = Number(d.receivedPaid ?? d.totalPaid ?? d.paid ?? 0); // MAINTENANCE_RECEIPT_UI

    totalInvoiced += due;
    totalCollected += paid;

    const det = d.details || {};
    invoicedCounts.elevator += Number(det["Асансьор"] || d.elevator || 0);
    invoicedCounts.subscription += Number(det["Абонамент"] || d.subscription || 0);
    invoicedCounts.light += Number(det["Ток"] || d.light || 0);
    invoicedCounts.security += Number(det["Вход"] || d.security || 0);
    invoicedCounts.cleaning += Number(det["Чистач"] || d.cleaning || 0);
    invoicedCounts.podrajka += Number(det["Поддръжка"] || d.podrajka || 0);
    invoicedCounts.remont += Number(det["Ремонт"] || d.remont || 0);

    rows.push(d);
  });
  
  invoicedCounts.total = totalInvoiced;

  // Външни приходи (V2) за същия период
  let incomesV2 = [];
  try {
    const qInc = query(
      collection(db, "incomesV2"),
      where("routeKey", "==", routeKey),
      where("period", "==", period)
    );
    const snapInc = await getDocs(qInc);
    snapInc.forEach(doc => {
      const income = { id: doc.id, ...doc.data() }; if (income.paymentId && income.settlementStatus !== 'APPLIED') return; // FIN01_UI
      incomesV2.push({ id: doc.id, ...doc.data() });
    });
  } catch (err) {
    if (isStaleRouteRequestError(err)) throw err;
    console.warn("Error fetching V2 incomes for report, trying local storage:", err);
    const local = JSON.parse(localStorage.getItem('incomesV2_' + routeKey) || '[]');
    incomesV2 = local.filter(r => r.period === period);
  }

  // Разпределения (V2) за същия период
  let distributionsV2 = [];
  try {
    const qDist = query(
      collection(db, "distributionsV2"),
      where("routeKey", "==", routeKey),
      where("period", "==", period)
    );
    const snapDist = await getDocs(qDist);
    snapDist.forEach(doc => {
      distributionsV2.push({ id: doc.id, ...doc.data() });
    });
  } catch (err) {
    if (isStaleRouteRequestError(err)) throw err;
    console.warn("Error fetching V2 distributions for report, trying local storage:", err);
    const local = JSON.parse(localStorage.getItem('distributionsV2_' + routeKey) || '[]');
    distributionsV2 = local.filter(r => r.period === period);
  }

  return {
    success: true,
    data: {
      invoiced: invoicedCounts,
      collected: totalCollected,
      logic: rows[0] ? (rows[0].logic || 'Равно') : 'Равно', // Взимаме логиката от първия запис
      incomesV2: incomesV2,
      distributionsV2: distributionsV2,
      apartments: rows.map(r => {
        const d = r.details || {};
        return {
          apt: r.apartmentId || r.apt || '?',
          occupants: d["Обитатели"] !== undefined ? d["Обитатели"] : (r.occupants || 0),
          chips: d["Чипове"] !== undefined ? d["Чипове"] : (r.chips || 0),
          participation: d["Участие"] !== undefined ? d["Участие"] : (r.participation || 'Да'),
          idealParts: d["Ид. части"] !== undefined ? d["Ид. части"] : (r.idealParts || 0),
          due: Number(r.totalDue || r.due || 0)
        };
      }).sort((a, b) => {
        const numA = parseInt(a.apt.replace(/[^0-9]/g, '')) || 0;
        const numB = parseInt(b.apt.replace(/[^0-9]/g, '')) || 0;
        return numA - numB;
      })
    }
  };
}

window.generateReport = async function () {
    const requestContext = captureRouteRequestContext();
    const period = document.getElementById("reportPeriodInput").value.trim();
    if (!period) {
        showToast("Моля, въведете период!", "error");
        return;
    }

    const btn = document.querySelector("#view-monthly-report .btn-primary");
    showSaving(btn, "Зареждане...");

    try {
        const result = await loadMonthlyReportFromFirebase(currentRouteKey, period);
        if (result && result.success && result.data) {
            const d = result.data;
            document.getElementById("report-title-period").textContent = `за месец ${period} г.`;
            document.getElementById("report-gen-date").textContent = new Date().toLocaleDateString('bg-BG');

            const tableBody = document.getElementById("report-invoiced-rows");
            tableBody.innerHTML = "";

            const labels = {
                elevator: "Разходи за Асансьор ел.",

                subscription: "Асансьор абон. и др.",
                light: "Електрическа енергия - общи части",
                security: "Охрана / Консиерж",
                cleaning: "Хигиена и почистване",
                podrajka: "Поддръжка на общи части",
                remont: 'Фонд \u201eРемонт и обновяване\u201c'
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
                    if (inc.paymentId && inc.allocationSummary) inc = {...inc, category:inc.allocationSummary}; // FIN01_UI
                    const tr = document.createElement("tr");
                    const payer = inc.apt === "EXTERNAL" ? "Външен източник" : `Ап. ${inc.apt}`;
                    const noteStr = inc.note ? ` (${inc.note})` : "";
                    tr.innerHTML = `
                        <td style="padding: 10px 0; border-bottom: 1px dashed #eee;">Приход от ${payer} - кат. "${inc.category}"${noteStr}</td>
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
                    const noteStr = dist.note ? ` (${dist.note})` : "";
                    tr.innerHTML = `
                        <td style="padding: 10px 0; border-bottom: 1px dashed #eee;">Разпределено от "${dist.category}" към ${destType}${noteStr}</td>
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
                    aptRowsHTML += `
                        <tr style="text-align: center; border-bottom: 1px dashed #eee;">
                            <td style="padding: 6px 0;"><strong>${a.apt}</strong></td>
                            <td style="padding: 6px 0;">${a.occupants}</td>
                            <td style="padding: 6px 0;">${a.chips}</td>
                            <td style="padding: 6px 0;">${a.participation}</td>
                            <td style="padding: 6px 0;">${a.idealParts}%</td>
                            <td style="padding: 6px 0; font-weight: bold;">${a.due.toFixed(2)} EUR</td>
                        </tr>
                    `;
                });
            } else {
                aptRowsHTML = `<tr><td colspan="6" style="padding: 10px; text-align: center;">Няма налични детайлни данни</td></tr>`;
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
                                <th style="padding: 8px 4px; border-bottom: 2px solid #ddd;">Начислено</th>
                            </tr>
                        </thead>
                        <tbody>
                            ${aptRowsHTML}
                        </tbody>
                    </table>
                </div>
            `;

            document.getElementById("report-content").style.display = "block";
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
        if (res && res.success && res.parts && typeof apartmentList !== 'undefined' && apartmentList.length > 0) {
            missing = apartmentList.filter(apt => res.parts[apt] === undefined || res.parts[apt] === "" || parseFloat(res.parts[apt]) <= 0);
            allHaveParts = missing.length === 0;
        }

        if (input) {
            const pending = !!manualExpenseState_().pending;
            input.dataset.expenseUnavailable = String(!allHaveParts);
            input.disabled = !allHaveParts || pending;
            input.placeholder = allHaveParts ? "Обща сума за входа" : "Деактивирано (липсват Ид. части за всички)";
            if (!allHaveParts && !pending) {
                input.value = "";
                updateManualExpenseDraft('repairFund');
            }
        }
        
        if (warn) {
            warn.style.display = allHaveParts ? "none" : "block";
            if (!allHaveParts) {
                if (missing.length > 0 && missing.length <= 15) {
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
        catSel.value = "Управление и поддръжка";
        showToast("⚠️ Не са въведени идеални части за всички апартаменти — попълнете ги в MASTER – Настройки, за да въвеждате нов кредит.", "error");
    }
};

window.v2HandleAptChange = function() {
    const apt = document.getElementById("v2IncomeApt").value;
    const catSel = document.getElementById("v2IncomeCategory");
    const isApartment = apt && apt !== "EXTERNAL";

    // Когато платецът е конкретен апартамент, показваме само "Управление и
    // поддръжка" и "Кредит" — останалите категории (наем на общи части,
    // бюджетни средства, ВЕИ, дарения и т.н.) са само за Външен източник.
    Array.from(catSel.options).forEach(opt => {
        if (opt.value === "Управление и поддръжка" || opt.value === "Кредит" || opt.value === "") {
            opt.style.display = "";
        } else {
            opt.style.display = isApartment ? "none" : "";
        }
    });

    if (isApartment && catSel.value !== "Кредит" && catSel.value !== "Управление и поддръжка") {
        catSel.value = "Управление и поддръжка";
    }

    catSel.disabled = false;
    v2LoadPaymentDue();
    if (typeof updateCreditCategoryAvailability === 'function') updateCreditCategoryAvailability();
    if (typeof fin01RefreshPaymentView_ === 'function') fin01RefreshPaymentView_(); // FIN01_UI
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
    
    // Външен източник няма салдо/задължения към входа
    if (!apt || apt === "EXTERNAL" || !window.fb || !window.db) {
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
    if (!window.fb || !window.db) return;
    const { routeDoc, mutationDoc, getDoc, setDoc } = window.fb;
    const db = window.db;
    assertFinancialOperationContextCurrent(operationContext);
    if (typeof operationContext.apartment !== "string" || !operationContext.apartment) {
        throw new TypeError("Credit liability operation requires an apartment-bound context");
    }
    const operationRouteKey = operationContext.routeKey;
    const operationApartment = operationContext.apartment;
    const docId = operationRouteKey + "_" + operationApartment;
    const readRef = routeDoc(db, "creditLiabilitiesV2", docId, operationRouteKey);
    const writeAuthority = mutationDoc("creditLiabilitiesV2", docId, operationRouteKey);

    let current = { routeKey: operationRouteKey, apt: operationApartment, original: 0, remaining: 0 };
    const snap = await getDoc(readRef);
    assertFinancialOperationContextCurrent(operationContext);
    if (snap.exists()) current = { ...current, ...snap.data() };

    const newOriginal = (parseFloat(current.original) || 0) + originalDelta;
    const newRemaining = Math.max(0, (parseFloat(current.remaining) || 0) + remainingDelta);

    await setDoc(writeAuthority, {
        routeKey: operationRouteKey,
        apt: operationApartment,
        original: newOriginal,
        remaining: newRemaining,
        lastUpdated: new Date().getTime()
    });
    assertFinancialOperationContextCurrent(operationContext);
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

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount === 0) {
        showToast("Невалидна сума.", "error");
        return;
    }

    if (!window.fb || !window.fb.addDoc) {
        showToast("Грешка при връзка с базата данни (Firebase AddDoc липсва).", "error");
        return;
    }

    const btn = document.getElementById("v2SubmitBtn");
    btn.disabled = true;
    btn.textContent = "Записване...";

    const recordData = {
        routeKey: operationContext.routeKey,
        period: period,
        apt: operationContext.apartment,
        category: category,
        amount: amount,
        docNum: docNum,
        note: note
    };
    if (!editId) recordData.timestamp = new Date().getTime();
    let primaryIncomePersisted = false;
    let incomeSuccessMessage = editId ? "Успешно редактиран приход!" : SAVED_SYNC_TOAST_MSG;

    try {
        const { mutationCollection, mutationDoc, addDoc, updateDoc } = window.fb;
        assertFinancialOperationContextCurrent(operationContext);

        if (editId) {
            await updateDoc(mutationDoc("incomesV2", operationContext.documentId, operationContext.routeKey), recordData);
            primaryIncomePersisted = true;
            assertFinancialOperationContextCurrent(operationContext);
            v2CancelEdit();
        } else {
            await addDoc(mutationCollection("incomesV2", operationContext.routeKey), recordData);
            primaryIncomePersisted = true;
            assertFinancialOperationContextCurrent(operationContext);
            
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
        const { deleteDoc, mutationDoc } = window.fb;
        assertFinancialOperationContextCurrent(operationContext);
        const storageKey = 'incomesV2_' + operationContext.routeKey;
        if (id.startsWith('loc_')) {
            let localIncomes = JSON.parse(localStorage.getItem(storageKey) || '[]');
            localIncomes = localIncomes.filter(r => r.id !== id);
            localStorage.setItem(storageKey, JSON.stringify(localIncomes));
        } else {
            await deleteDoc(mutationDoc("incomesV2", operationContext.documentId, operationContext.routeKey));
            assertFinancialOperationContextCurrent(operationContext);
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
       typeof data.afterValue!=='number' || !Number.isFinite(data.afterValue) || Object.is(data.afterValue,-0) ||
       data.afterValue!==(data.beforeValue===null ? 0 : data.beforeValue)+o.signedAmount) fail();
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

    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;">Зареждане...</td></tr>';

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
        records = records.filter(r => !r.paymentId || r.settlementStatus === 'APPLIED'); // FIN01_UI
        
        records.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));

        if (records.length === 0) {
            tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;">Няма въведени приходи.</td></tr>';
            return;
        }

        let html = "";
        records.forEach(r => {
            const payer = r.apt === "EXTERNAL" ? "Външен източник" : "Ап. " + r.apt;
            if (r.paymentId && r.allocationSummary) r = {...r, note:(r.note || '')+'\n'+r.allocationSummary}; // FIN01_UI
            const docText = r.docNum ? `<b>Док:</b> ${r.docNum}<br>` : "";
            const noteText = r.note ? `<span style="color:#666; font-size:11px;">${r.note}</span>` : "";
            
            const safeDoc = (r.docNum || "").replace(/'/g, "\\'");
            const safeNote = (r.note || "").replace(/'/g, "\\'");

            html += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${formatRegisterDate(r.timestamp)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${payer}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.category}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #16a34a;">${parseFloat(r.amount).toFixed(2)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${docText}${noteText}</td>
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
    const note = document.getElementById("v2PayerNote").value.trim();

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
        const { mutationCollection, addDoc } = window.fb;
        assertFinancialOperationContextCurrent(operationContext);
        await addDoc(mutationCollection("externalPayers", operationContext.routeKey), recordData);
        primaryPayerPersisted = true;
        assertFinancialOperationContextCurrent(operationContext);
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
        const { deleteDoc, mutationDoc } = window.fb;
        assertFinancialOperationContextCurrent(operationContext);
        const storageKey = 'externalPayers_' + operationContext.routeKey;
        if (id.startsWith('loc_')) {
            let localPayers = JSON.parse(localStorage.getItem(storageKey) || '[]');
            localPayers = localPayers.filter(r => r.id !== id);
            localStorage.setItem(storageKey, JSON.stringify(localPayers));
        } else {
            await deleteDoc(mutationDoc("externalPayers", operationContext.documentId, operationContext.routeKey));
            assertFinancialOperationContextCurrent(operationContext);
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

window.updateV2DistAvailableSum = async function() {
    if(typeof maintenanceUpdateAvailable_==='function'&&await maintenanceUpdateAvailable_())return; // MAINTENANCE_AVAILABLE
    const category = document.getElementById("v2DistCategory").value;
    const lbl = document.getElementById("lbl-v2DistAmount");
    if (!lbl) return;

    // Изискване 4: за категория "Кредит" разпределянето е само "На каса" —
    // сумата вече е начислена по апартаментите като кредитно задължение
    // (виж creditLiabilitiesV2), затова "На салдо" няма смисъл тук.
    const balanceLabel = document.getElementById("v2DistTypeBalanceLabel");
    const creditNote = document.getElementById("v2DistCreditNote");
    const cashRadio = document.querySelector('input[name="v2DistType"][value="cash"]');
    const balanceRadio = document.querySelector('input[name="v2DistType"][value="balance"]');
    if (balanceLabel && cashRadio && balanceRadio) {
        if (category === "Кредит") {
            balanceLabel.style.display = "none";
            if (creditNote) creditNote.style.display = "block";
            cashRadio.checked = true;
        } else {
            balanceLabel.style.display = "";
            if (creditNote) creditNote.style.display = "none";
        }
    }

    if (!category) {
        lbl.innerHTML = 'Сума за разпределяне';
        return;
    }

    try {
        const { collection, getDocs, query, where } = window.fb;
        const db = window.db;

        // Fetch distributions for this category
        const qDist = query(collection(db, "distributionsV2"), where("routeKey", "==", currentRouteKey), where("category", "==", category));
        const snapDist = await getDocs(qDist);
        let totalDist = 0;
        snapDist.forEach(d => totalDist += parseFloat(d.data().amount) || 0);

        let totalCollected = 0;
        if (category === "Фонд ремонт") {
            const qApts = query(collection(db, "apartments"), where("buildingId", "==", currentRouteKey));
            const snapApts = await getDocs(qApts);
            snapApts.forEach(d => {
                totalCollected += parseFloat(d.data().collectedTargetFund) || 0;
            });
        } else if (category === "Кредит") {
            // Само НОВ кредит (платец = Външен източник) е налична сума за
            // разпределяне. Погасявания от апартаменти НЕ участват тук —
            // те само намаляват личния им кредитен остатък (виж
            // creditLiabilitiesV2), не са "нови" пари за разпределяне.
            const qInc = query(collection(db, "incomesV2"), where("routeKey", "==", currentRouteKey), where("category", "==", category));
            const snapInc = await getDocs(qInc);
            snapInc.forEach(d => {
                const rec = d.data();
                if (rec.apt === "EXTERNAL") {
                    totalCollected += parseFloat(rec.amount) || 0;
                }
            });
        } else {
            const qInc = query(collection(db, "incomesV2"), where("routeKey", "==", currentRouteKey), where("category", "==", category));
            const snapInc = await getDocs(qInc);
            snapInc.forEach(d => totalCollected += parseFloat(d.data().amount) || 0);
        }

        const available = totalCollected - totalDist;
        const cur = sessionStorage.getItem("currency_" + currentRouteKey) || "EUR";
        lbl.innerHTML = `Сума за разпределяне <span style="color:#16a34a; font-size:12px;">(Налични: ${available.toFixed(2)} ${cur})</span>`;
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
    const pEl = document.getElementById("v2DistPeriod");
    if (!pEl) return;
    if (pEl.options.length <= 1) {
        const d = new Date();
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
        const currentPeriod = String(d.getMonth() + 1).padStart(2, '0') + "." + d.getFullYear();
        pEl.value = currentPeriod;
    }
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
            const safeNote = (r.note || "").replace(/'/g, "\\'");

            html += `
                <tr>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${dateStr}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.category}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee;">${r.type === 'balance' ? 'На салдо' : 'На каса'}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; text-align: right; font-weight: bold; color: #3b82f6;">${parseFloat(r.amount).toFixed(2)}</td>
                    <td style="padding: 8px; border-bottom: 1px solid #eee; font-size: 11px;">${r.note} <br><span style="color:#64748b">Апт: ${(r.apts || []).length}</span></td>
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
    if(typeof submitMaintenanceDistributionIfSelected_==='function'&&await submitMaintenanceDistributionIfSelected_())return; // MAINTENANCE_SUBMIT
    const operationContext = captureFinancialOperationContext();
    const operationPin = sessionStorage.getItem("adminAuth_" + operationContext.routeKey);
    const period = document.getElementById("v2DistPeriod").value;
    const category = document.getElementById("v2DistCategory").value;
    const amountStr = document.getElementById("v2DistAmount").value;
    const note = document.getElementById("v2DistNote").value.trim();
    const typeRadio = document.querySelector('input[name="v2DistType"]:checked');
    const type = typeRadio ? typeRadio.value : 'cash';

    if (!period || !category || !amountStr) {
        showToast("Моля, попълнете Период, Категория и Сума.", "error");
        return;
    }

    const amount = parseFloat(amountStr);
    if (!Number.isFinite(amount) || amount <= 0) {
        showToast("Невалидна сума.", "error");
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
                        { completedPayments: completedBalancePayments, distributionPersisted: false },
                        paymentError
                    );
                }
                throw paymentError;
            }
        }

        const recordData = {
            routeKey: operationContext.routeKey,
            period: period,
            category: category,
            amount: amount,
            type: type,
            note: note,
            apts: Object.freeze(allocationPlan.allocations.map(allocation => allocation.apartment)),
            details: distributedDetails,
            timestamp: new Date().getTime()
        };

        try {
            assertFinancialOperationContextCurrent(operationContext);
            await addDoc(mutationCollection("distributionsV2", operationContext.routeKey), recordData);
            assertFinancialOperationContextCurrent(operationContext);
        } catch (fbErr) {
            if (isStaleRouteRequestError(fbErr)) throw fbErr;
            assertFinancialOperationContextCurrent(operationContext, fbErr);
            if (!isFirestorePermissionFallbackError(fbErr)) {
                if (completedBalancePayments.length) {
                    const completedText = completedBalancePayments.map(item =>
                        item.apartment + " (" + item.amount.toFixed(2) + ")").join(", ");
                    throw createFinancialPartialCompletionError_(
                        "Плащанията са извършени за: " + completedText +
                            ", но записът за разпределението не е създаден. Не повтаряйте операцията без операторска проверка.",
                        "distribution-persistence",
                        { completedPayments: completedBalancePayments, distributionPersisted: false },
                        fbErr
                    );
                }
                throw fbErr;
            }
            try {
                console.warn("Fallback to localStorage for distributionsV2", fbErr);
                const storageKey = 'distributionsV2_' + operationContext.routeKey;
                const local = readLocalFinancialRecords_(storageKey);
                local.push({ ...recordData, id: 'loc_' + new Date().getTime() });
                assertFinancialOperationContextCurrent(operationContext);
                localStorage.setItem(storageKey, JSON.stringify(local));
                assertFinancialOperationContextCurrent(operationContext);
            } catch (fallbackError) {
                if (isStaleRouteRequestError(fallbackError)) throw fallbackError;
                assertFinancialOperationContextCurrent(operationContext, fallbackError);
                if (completedBalancePayments.length) {
                    const completedText = completedBalancePayments.map(item =>
                        item.apartment + " (" + item.amount.toFixed(2) + ")").join(", ");
                    throw createFinancialPartialCompletionError_(
                        "Плащанията са извършени за: " + completedText +
                            ", но локалният запис за разпределението не е създаден. Не повтаряйте операцията без операторска проверка.",
                        "distribution-local-persistence",
                        { completedPayments: completedBalancePayments, distributionPersisted: false },
                        fallbackError
                    );
                }
                throw fallbackError;
            }
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
        
        await loadDistributionsV2(operationContext);
        assertFinancialOperationContextCurrent(operationContext);
        
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
