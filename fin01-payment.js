// Pending payment identity is retained per entrance until confirmed or proven rejected before commit.
// PHASE 0: Canonical FIN-01 Receipt Contract & Read-Only Transaction Status Verification.
const fin01PaymentViews_ = new Map();
const fin01PaymentLabels_ = Object.freeze({
    basic: 'Режийни',
    maintenance: 'Фонд поддръжка',
    management: 'Управление и поддръжка',
    repairFund: 'Фонд ремонт',
    loan: 'Кредит'
});

function fin01PendingKey_(route) { return 'fin01PendingV1_' + route; }

function fin01PersistPending_(route, pending) {
    try {
        if (!route) return;
        if (pending && (pending.phase === 'commit' || pending.committed)) {
            // Persist ONLY non-credential pending transaction metadata (never PIN/auth tokens)
            sessionStorage.setItem(fin01PendingKey_(route), JSON.stringify({
                request: pending.request,
                raw: pending.raw,
                phase: pending.phase,
                committed: !!pending.committed,
                uiState: pending.uiState || 'AMBIGUOUS_UNKNOWN'
            }));
        } else {
            sessionStorage.removeItem(fin01PendingKey_(route));
        }
    } catch (e) {
        // Graceful fallback: in-memory Map retains pending state when sessionStorage is unavailable
    }
}

function fin01PaymentView_() {
    if (!fin01PaymentViews_.has(currentRouteKey)) {
        let restored = null;
        try {
            const saved = sessionStorage.getItem(fin01PendingKey_(currentRouteKey));
            if (saved) {
                const parsed = JSON.parse(saved);
                if (parsed && parsed.request && typeof parsed.request.paymentId === 'string') restored = parsed;
            }
        } catch (e) {}
        const initState = restored
            ? (restored.committed ? 'CONFIRMED_SYNC_PENDING' : (restored.uiState || 'AMBIGUOUS_UNKNOWN'))
            : 'IDLE';
        const initMsg = restored
            ? (restored.committed
                ? 'Плащането е потвърдено финансово. Обновяването на отчета не е завършило. Използвайте „Обнови отчета“.'
                : 'Открита е непотвърдена заявка за плащане. Първо натиснете „Провери статуса“, за да установите действителното състояние.')
            : '';
        fin01PaymentViews_.set(currentRouteKey, {
            pending: restored,
            inFlight: false,
            rejected: false,
            uiState: initState,
            message: initMsg
        });
    }
    return fin01PaymentViews_.get(currentRouteKey);
}

function fin01PaymentFields_() {
    return ['v2IncomeApt', 'v2IncomeCategory', 'v2IncomeAmount', 'v2IncomeDoc', 'v2IncomeNote', 'fin01Basis', 'fin01Management', 'fin01RepairFund', 'fin01Loan'];
}

function fin01RenderPayment_() {
    const state = fin01PaymentView_();
    const feedback = document.getElementById('fin01PaymentFeedback');
    if (feedback) {
        feedback.textContent = state.message;
        feedback.setAttribute('data-fin01-state', state.uiState || 'IDLE');
    }
    fin01PaymentFields_().forEach(id => {
        const n = document.getElementById(id);
        if (n) n.disabled = !!state.pending || state.inFlight;
    });
    const button = document.getElementById('v2SubmitBtn');
    if (button) {
        button.disabled = state.inFlight || state.rejected || state.uiState === 'CONFLICT';
        if (state.inFlight) {
            button.textContent = state.uiState === 'CHECKING_STATUS' ? 'Проверка на статуса…' : 'Записване…';
        } else if (state.pending && state.pending.committed) {
            button.textContent = 'Обнови отчета';
        } else if (state.pending && state.uiState === 'AMBIGUOUS_UNKNOWN') {
            button.textContent = 'Провери статуса';
        } else if (state.pending && state.uiState === 'RECOVERY_REQUIRED') {
            button.textContent = 'Възстанови същото плащане';
        } else if (state.pending) {
            button.textContent = 'Повтори същото плащане';
        } else {
            button.textContent = 'Добави приход';
        }
    }
}

async function fin01RefreshPaymentView_() {
    const apt = document.getElementById('v2IncomeApt').value;
    const context = captureFinancialOperationContext();
    const controls = document.getElementById('fin01PaymentControls');
    if (!controls) return;
    controls.hidden = true;
    if (!apt || apt === 'EXTERNAL' || apt === 'EXTERNAL_UNIT') return;
    try {
        const result = await apiCall('fin01Status', { routeKey: context.routeKey, pin: getStoredPin() }, context);
        if (!isFinancialOperationContextCurrent(context) || document.getElementById('v2IncomeApt').value !== apt) return;
        controls.hidden = !(result && result.success === true && result.active === true);
        fin01RenderPayment_();
    } catch (error) {
        if (isFinancialOperationContextCurrent(context)) {
            fin01PaymentView_().message = 'Режимът за плащане не може да бъде потвърден.';
            fin01RenderPayment_();
        }
    }
}

function fin01UiAmount_(text) {
    if (typeof text === 'string' && text.includes(',')) throw Error('Използвайте точка (.) за десетични стойности.');
    if (typeof text !== 'string' || !/^\d+(?:\.\d{1,2})?$/.test(text.trim())) throw Error('Въведете положителна сума с до две цифри след десетичната точка.');
    const value = Number(text.trim());
    if (!Number.isFinite(value) || value <= 0) throw Error('Въведете положителна сума.');
    return value;
}

function cancelRejectedFin01Payment() {
    const state = fin01PaymentView_();
    if (!state.rejected || state.inFlight) return;
    state.pending = null;
    fin01PersistPending_(currentRouteKey, null);
    state.rejected = false;
    state.uiState = 'IDLE';
    state.message = 'Записът е отменен преди финансово изпълнение.';
    const dialog = document.getElementById('fin01PaymentDialog');
    if (dialog && dialog.open) dialog.close();
    fin01RenderPayment_();
}

function fin01ShowRejected_(state, error, unallocatedCents) {
    state.rejected = true;
    state.uiState = 'REJECTED';
    state.message = error === 'FIN01_OVERPAYMENT'
        ? 'Има неразпределен остатък. Сумата надвишава приложимите задължения. Прегледайте сумата и разпределението.'
        : error === 'FIN01_MANUAL_REVIEW'
            ? 'Основанието изисква ръчна проверка. Допуска се само ID на апартамента и по желание маркер КРЕДИТ.'
            : error === 'FIN01_CUTOVER'
                ? 'Избраният период не съответства на текущия активен финансов период.'
                : 'Няма извършен запис по тази заявка. Проверете задълженията и изричното разпределение.';
    if (error === 'FIN01_OVERPAYMENT' && Number.isSafeInteger(unallocatedCents) && unallocatedCents > 0) {
        state.message += ' Неразпределено: ' + (unallocatedCents / 100).toFixed(2) + ' EUR.';
    }
    const dialogText = document.getElementById('fin01PaymentDialogText');
    const dialog = document.getElementById('fin01PaymentDialog');
    if (dialogText) dialogText.textContent = state.message;
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
}

/**
 * PHASE 0 (Section 5): Formal Canonical FIN-01 Receipt Validator.
 * Validates exact eurocent conservation: receivedCents === allocatedCents + unallocatedAdvanceCents.
 * Accepts all canonical buckets (basic, maintenance, management, repairFund, loan) and valid partial/full advances.
 * Rejects any invalid, tampered, non-conserving, or unknown-bucket receipt.
 */
function fin01UiSuccess_(result, request) {
    if (!result || result.success !== true || result.contractVersion !== 1) return false;
    const finStatus = result.financialStatus || result.status;
    if (result.status !== 'APPLIED' || finStatus !== 'APPLIED') return false;
    if (!request || result.paymentId !== request.paymentId) return false;
    if (result.apartment !== undefined && result.apartment !== request.apartment) return false;
    if (result.period !== undefined && result.period !== request.period) return false;
    if (!Array.isArray(result.allocations)) return false;

    const expectedReceivedCents = Math.round(Number(request.amount) * 100);
    if (!Number.isSafeInteger(expectedReceivedCents) || expectedReceivedCents <= 0) return false;

    const allocatedCents = result.allocatedCents !== undefined ? result.allocatedCents : result.settledCents;
    const unallocatedCents = result.unallocatedAdvanceCents !== undefined
        ? result.unallocatedAdvanceCents
        : (result.unallocatedReceiptCents !== undefined ? result.unallocatedReceiptCents : 0);
    const receivedCents = result.receivedCents !== undefined ? result.receivedCents : (allocatedCents + unallocatedCents);

    if (!Number.isSafeInteger(receivedCents) || receivedCents !== expectedReceivedCents) return false;
    if (!Number.isSafeInteger(allocatedCents) || allocatedCents < 0) return false;
    if (!Number.isSafeInteger(unallocatedCents) || unallocatedCents < 0) return false;
    if (allocatedCents + unallocatedCents !== receivedCents) return false;

    let sum = 0;
    for (const l of result.allocations) {
        if (!l || typeof l !== 'object') return false;
        if (!Object.prototype.hasOwnProperty.call(fin01PaymentLabels_, l.bucket)) return false;
        if (!Number.isSafeInteger(l.amountCents) || l.amountCents <= 0) return false;
        sum += l.amountCents;
    }
    return Number.isSafeInteger(sum) && sum === allocatedCents;
}

function fin01FormatReceiptSummary_(result) {
    const parts = (result.allocations || []).map(l => {
        const label = l.bucketLabel || fin01PaymentLabels_[l.bucket] || l.bucket;
        return label + ': ' + (l.amountCents / 100).toFixed(2) + ' EUR';
    });
    const advCents = result.unallocatedAdvanceCents !== undefined
        ? result.unallocatedAdvanceCents
        : (result.unallocatedReceiptCents || 0);
    if (advCents > 0) {
        parts.push('Аванс: ' + (advCents / 100).toFixed(2) + ' EUR');
    }
    return parts.join('; ');
}

function fin01CompleteUiConfirmation_(state, result, context) {
    const syncStatus = result.projectionSyncStatus || (result.projectionStatus === 'COMPLETE' ? 'COMPLETE' : 'FAILED');
    const summaryText = fin01FormatReceiptSummary_(result);
    if (syncStatus !== 'COMPLETE') {
        if (state.pending) {
            state.pending.committed = true;
            state.pending.uiState = 'CONFIRMED_SYNC_PENDING';
            fin01PersistPending_(context.routeKey, state.pending);
        }
        state.uiState = 'CONFIRMED_SYNC_PENDING';
        state.message = 'Плащането е потвърдено финансово (' + summaryText + '). Обновяването на отчета не е завършило — използвайте „Обнови отчета“ за същия запис.';
        return;
    }
    state.pending = null;
    fin01PersistPending_(context.routeKey, null);
    state.uiState = 'CONFIRMED';
    state.message = 'Плащането е потвърдено. ' + summaryText;
    for (const id of ['v2IncomeAmount', 'v2IncomeDoc', 'v2IncomeNote', 'fin01Basis', 'fin01Management', 'fin01RepairFund', 'fin01Loan']) {
        const el = document.getElementById(id);
        if (el) el.value = '';
    }
    if (typeof loadIncomesV2 === 'function') Promise.resolve(loadIncomesV2(context)).catch(() => {});
    if (typeof loadDashboardData === 'function') Promise.resolve(loadDashboardData()).catch(() => {});
}

async function submitApartmentFin01IfActive_() {
    const apt = document.getElementById('v2IncomeApt').value;
    if (!apt || apt === 'EXTERNAL' || apt === 'EXTERNAL_UNIT') return false;
    const context = captureFinancialOperationContext();
    const state = fin01PaymentView_();
    if (state.inFlight || state.rejected || state.uiState === 'CONFLICT') return true;
    state.inFlight = true;
    const isStatusCheckStep = Boolean(state.pending && !state.pending.committed && state.uiState === 'AMBIGUOUS_UNKNOWN');
    state.uiState = isStatusCheckStep ? 'CHECKING_STATUS' : 'SENDING';
    fin01RenderPayment_();
    try {
        // PHASE 0 (Section 10): On ambiguous/lost-response state, ALWAYS perform read-only status check FIRST!
        if (isStatusCheckStep) {
            const txRes = await apiCall('fin01TransactionStatus', {
                routeKey: context.routeKey,
                pin: getStoredPin(),
                request: JSON.stringify({ paymentId: state.pending.request.paymentId })
            }, context);
            if (!isFinancialOperationContextCurrent(context)) return true;
            if (!txRes || txRes.success !== true) {
                state.uiState = 'AMBIGUOUS_UNKNOWN';
                state.message = 'Статусът не може да бъде проверен в момента. Не въвеждайте ново плащане; опитайте „Провери статуса“ отново.';
                return true;
            }
            if (txRes.status === 'APPLIED' && txRes.receipt && fin01UiSuccess_(txRes.receipt, state.pending.request)) {
                fin01CompleteUiConfirmation_(state, txRes.receipt, context);
                return true;
            }
            if (txRes.status === 'PREPARED' || txRes.status === 'PARTIALLY_APPLIED') {
                state.uiState = 'RECOVERY_REQUIRED';
                state.pending.uiState = 'RECOVERY_REQUIRED';
                fin01PersistPending_(context.routeKey, state.pending);
                state.message = txRes.message || 'Плащането е незавършено. Натиснете „Възстанови същото плащане“, за да го приключите безопасно със същия идентификатор.';
                return true;
            }
            if (txRes.status === 'CONFLICT') {
                state.uiState = 'CONFLICT';
                state.pending.uiState = 'CONFLICT';
                fin01PersistPending_(context.routeKey, state.pending);
                state.message = 'Конфликт на идентификатор: тази заявка не може да бъде повторена автоматично. Изисква се административна проверка.';
                return true;
            }
            // NOT_FOUND or UNKNOWN: never falsely claim the payment failed
            state.uiState = 'RECOVERY_REQUIRED';
            state.pending.uiState = 'RECOVERY_REQUIRED';
            fin01PersistPending_(context.routeKey, state.pending);
            state.message = txRes.message || 'Платежният документ не е намерен (не е доказано, че липсва ефект). Можете да използвате „Възстанови същото плащане“ със същия идентификатор.';
            return true;
        }

        const status = await apiCall('fin01Status', { routeKey: context.routeKey, pin: getStoredPin() }, context);
        if (!isFinancialOperationContextCurrent(context)) return true;
        if (!status || status.success !== true || typeof status.active !== 'boolean') throw Error('unconfirmed');
        if (!status.active) {
            if (state.pending) throw Error('unconfirmed');
            return false;
        }
        if (document.getElementById('v2IncomeEditId').value) {
            state.uiState = 'IDLE';
            state.message = 'Прието плащане не се коригира чрез редакция. Необходима е отделна проследима корекция.';
            return true;
        }
        if (!state.pending) {
            const explicit = [];
            for (const [bucket, id] of [['management', 'fin01Management'], ['repairFund', 'fin01RepairFund'], ['loan', 'fin01Loan']]) {
                const text = document.getElementById(id).value.trim();
                if (text) explicit.push(Object.freeze({ bucket, period: null, amount: fin01UiAmount_(text), sourceFund: null }));
            }
            const request = Object.freeze({
                contractVersion: 1,
                paymentId: newManualExpenseRequestId_(),
                apartment: apt,
                period: document.getElementById('v2IncomePeriod').value,
                amount: fin01UiAmount_(document.getElementById('v2IncomeAmount').value),
                basis: document.getElementById('fin01Basis').value.trim() || (document.getElementById('v2IncomeCategory').value === 'Кредит' ? 'КРЕДИТ' : apt),
                note: document.getElementById('v2IncomeNote').value,
                documentNumber: document.getElementById('v2IncomeDoc').value,
                explicitAllocations: Object.freeze(explicit),
                expectedDebtFingerprint: null
            });
            state.pending = { request, raw: JSON.stringify(request), phase: 'preview', uiState: 'SENDING' };
        }
        fin01RenderPayment_();
        const pending = state.pending;
        if (pending.phase === 'preview') {
            const preview = await apiCall('fin01Preview', { routeKey: context.routeKey, pin: getStoredPin(), request: pending.raw }, context);
            if (!isFinancialOperationContextCurrent(context)) return true;
            if (!preview || preview.success !== true) {
                if (preview && ['FIN01_OVERPAYMENT', 'FIN01_MANUAL_REVIEW', 'FIN01_ALLOCATION', 'FIN01_AMOUNT', 'FIN01_VALIDATION', 'FIN01_MONEY_PRECISION', 'FIN01_CUTOVER'].includes(preview.error)) {
                    fin01ShowRejected_(state, preview.error, preview.unallocatedCents);
                } else {
                    throw Error('unconfirmed');
                }
                return true;
            }
            if (preview.paymentId !== pending.request.paymentId || typeof preview.expectedDebtFingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(preview.expectedDebtFingerprint)) {
                throw Error('unconfirmed');
            }
            pending.request = Object.freeze({ ...pending.request, expectedDebtFingerprint: preview.expectedDebtFingerprint });
            pending.raw = JSON.stringify(pending.request);
            pending.phase = 'commit';
            pending.uiState = 'AMBIGUOUS_UNKNOWN';
            fin01PersistPending_(context.routeKey, pending);
        }
        const result = await apiCall('fin01Settle', { routeKey: context.routeKey, pin: getStoredPin(), request: pending.raw }, context);
        if (!isFinancialOperationContextCurrent(context)) return true;
        if (result && result.error === 'FIN01_STALE_PREVIEW' && result.rejectedBeforeCommit === true) {
            fin01PersistPending_(context.routeKey, null);
            fin01ShowRejected_(state, result.error);
            return true;
        }
        if (result && result.error === 'FIN01_CONFLICT') {
            state.uiState = 'CONFLICT';
            pending.uiState = 'CONFLICT';
            fin01PersistPending_(context.routeKey, pending);
            state.message = 'Конфликт на идентификатор: заявката се различава от вече записана операция.';
            return true;
        }
        if (!fin01UiSuccess_(result, pending.request)) throw Error('unconfirmed');
        fin01CompleteUiConfirmation_(state, result, context);
    } catch (error) {
        if (isFinancialOperationContextCurrent(context)) {
            if (state.pending && state.pending.committed) {
                state.uiState = 'CONFIRMED_SYNC_PENDING';
                state.message = 'Плащането е потвърдено финансово. Обновяването на отчета не е потвърдено — използвайте „Обнови отчета“ за същия запис.';
            } else if (state.pending && state.pending.phase === 'preview') {
                state.uiState = 'IDLE';
                state.message = 'Връзката прекъсна при проверка преди запис. Не е извършено плащане. Натиснете „Повтори същото плащане“.';
            } else if (state.pending) {
                state.uiState = 'AMBIGUOUS_UNKNOWN';
                state.pending.uiState = 'AMBIGUOUS_UNKNOWN';
                fin01PersistPending_(context.routeKey, state.pending);
                state.message = 'Отговорът от сървъра не е получен. Възможно е плащането вече да е приложено — натиснете „Провери статуса“ преди всяка друга стъпка.';
            } else {
                state.uiState = 'IDLE';
                state.message = (error && error.message && error.message !== 'unconfirmed')
                    ? error.message
                    : 'Плащането не може да бъде проверено. Проверете сумата и опитайте отново.';
            }
        }
    } finally {
        state.inFlight = false;
        if (isFinancialOperationContextCurrent(context)) fin01RenderPayment_();
    }
    return true;
}

// Closing the known-rejection dialog cancels the whole uncommitted save.
if (typeof document !== 'undefined' && document.getElementById && document.getElementById('fin01PaymentDialog')) {
    document.getElementById('fin01PaymentDialog').addEventListener('cancel', cancelRejectedFin01Payment);
    document.getElementById('fin01PaymentDialog').addEventListener('close', cancelRejectedFin01Payment);
}
