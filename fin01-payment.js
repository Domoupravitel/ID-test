// Pending payment identity is retained per entrance until confirmed or rejected before commit.
const fin01PaymentViews_ = new Map();
const fin01PaymentLabels_ = Object.freeze({management:'Управление и поддръжка',repairFund:'Фонд ремонт',loan:'Кредит'});
function fin01PaymentView_() {
    if(!fin01PaymentViews_.has(currentRouteKey))fin01PaymentViews_.set(currentRouteKey,{pending:null,inFlight:false,rejected:false,message:''});
    return fin01PaymentViews_.get(currentRouteKey);
}
function fin01PaymentFields_() { return ['v2IncomeApt','v2IncomeCategory','v2IncomeAmount','v2IncomeDoc','v2IncomeNote','fin01Basis','fin01Management','fin01RepairFund','fin01Loan']; }
function fin01RenderPayment_() {
    const state=fin01PaymentView_(),feedback=document.getElementById('fin01PaymentFeedback');
    if(feedback)feedback.textContent=state.message;
    fin01PaymentFields_().forEach(id=>{const n=document.getElementById(id);if(n)n.disabled=!!state.pending||state.inFlight;});
    const button=document.getElementById('v2SubmitBtn');
    if(button){button.disabled=state.inFlight||state.rejected;button.textContent=state.inFlight?'Записване…':state.pending?.committed?'Обнови отчета':state.pending?'Повтори същото плащане':'Добави приход';}
}
async function fin01RefreshPaymentView_() {
    const apt=document.getElementById('v2IncomeApt').value,context=captureFinancialOperationContext();
    const controls=document.getElementById('fin01PaymentControls');if(!controls)return;
    controls.hidden=true;
    if(!apt||apt==='EXTERNAL')return;
    try{const result=await apiCall('fin01Status',{routeKey:context.routeKey,pin:getStoredPin()},context);
        if(!isFinancialOperationContextCurrent(context)||document.getElementById('v2IncomeApt').value!==apt)return;
        controls.hidden=!(result&&result.success===true&&result.active===true);fin01RenderPayment_();
    }catch(error){if(isFinancialOperationContextCurrent(context)){fin01PaymentView_().message='Режимът за плащане не може да бъде потвърден.';fin01RenderPayment_();}}
}
function fin01UiAmount_(text) {
    if(typeof text!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(text.trim()))throw Error('Въведете положителна сума с до две цифри след десетичната точка.');
    const value=Number(text.trim());if(!Number.isFinite(value)||value<=0)throw Error('Въведете положителна сума.');return value;
}
function cancelRejectedFin01Payment() {
    const state=fin01PaymentView_();if(!state.rejected||state.inFlight)return;
    state.pending=null;state.rejected=false;state.message='Записът е отменен преди финансово изпълнение.';
    const dialog=document.getElementById('fin01PaymentDialog');if(dialog.open)dialog.close();fin01RenderPayment_();
}
function fin01ShowRejected_(state,error,unallocatedCents) {
    state.rejected=true;
    state.message=error==='FIN01_OVERPAYMENT'?'Има неразпределен остатък. Сумата надвишава приложимите задължения. Прегледайте сумата и разпределението.':
        error==='FIN01_MANUAL_REVIEW'?'Основанието изисква ръчна проверка. Допуска се само ID на апартамента и по желание маркер КРЕДИТ.':
        'Няма извършен запис по тази заявка. Проверете задълженията и изричното разпределение.';
    if(error==='FIN01_OVERPAYMENT'&&Number.isSafeInteger(unallocatedCents)&&unallocatedCents>0)state.message+=' Неразпределено: '+(unallocatedCents/100).toFixed(2)+' EUR.';
    document.getElementById('fin01PaymentDialogText').textContent=state.message;
    document.getElementById('fin01PaymentDialog').showModal();
}
function fin01UiSuccess_(result,request) {
    if(!result||result.success!==true||result.contractVersion!==1||result.status!=='APPLIED'||result.paymentId!==request.paymentId||
        !Number.isSafeInteger(result.settledCents)||result.settledCents<=0||result.settledCents/100!==request.amount||!Array.isArray(result.allocations))return false;
    let sum=0;
    for(const l of result.allocations){if(!l||!Object.prototype.hasOwnProperty.call(fin01PaymentLabels_,l.bucket)||!Number.isSafeInteger(l.amountCents)||l.amountCents<=0)return false;sum+=l.amountCents;}
    return Number.isSafeInteger(sum)&&sum===result.settledCents;
}
async function submitApartmentFin01IfActive_() {
    const apt=document.getElementById('v2IncomeApt').value;if(!apt||apt==='EXTERNAL')return false;
    const context=captureFinancialOperationContext(),state=fin01PaymentView_();
    if(state.inFlight||state.rejected)return true;
    state.inFlight=true;fin01RenderPayment_();
    try{
        const status=await apiCall('fin01Status',{routeKey:context.routeKey,pin:getStoredPin()},context);
        if(!isFinancialOperationContextCurrent(context))return true;
        if(!status||status.success!==true||typeof status.active!=='boolean')throw Error('unconfirmed');
        if(!status.active){if(state.pending)throw Error('unconfirmed');return false;}
        if(document.getElementById('v2IncomeEditId').value){state.message='Прието плащане не се коригира чрез редакция. Необходима е отделна проследима корекция.';return true;}
        if(!state.pending){
            const explicit=[];
            for(const [bucket,id]of [['management','fin01Management'],['repairFund','fin01RepairFund'],['loan','fin01Loan']]){
                const text=document.getElementById(id).value.trim();if(text)explicit.push(Object.freeze({bucket,period:null,amount:fin01UiAmount_(text),sourceFund:null}));
            }
            const request=Object.freeze({contractVersion:1,paymentId:newManualExpenseRequestId_(),apartment:apt,
                period:document.getElementById('v2IncomePeriod').value,amount:fin01UiAmount_(document.getElementById('v2IncomeAmount').value),
                basis:document.getElementById('fin01Basis').value.trim()||(document.getElementById('v2IncomeCategory').value==='Кредит'?'КРЕДИТ':apt),
                note:document.getElementById('v2IncomeNote').value,documentNumber:document.getElementById('v2IncomeDoc').value,
                explicitAllocations:Object.freeze(explicit),expectedDebtFingerprint:null});
            state.pending={request,raw:JSON.stringify(request),phase:'preview'};
        }
        fin01RenderPayment_();const pending=state.pending;
        if(pending.phase==='preview'){
            const preview=await apiCall('fin01Preview',{routeKey:context.routeKey,pin:getStoredPin(),request:pending.raw},context);
            if(!isFinancialOperationContextCurrent(context))return true;
            if(!preview||preview.success!==true){
                if(preview&&['FIN01_OVERPAYMENT','FIN01_MANUAL_REVIEW','FIN01_ALLOCATION','FIN01_AMOUNT','FIN01_VALIDATION','FIN01_MONEY_PRECISION','FIN01_CUTOVER'].includes(preview.error))fin01ShowRejected_(state,preview.error,preview.unallocatedCents);
                else throw Error('unconfirmed');return true;
            }
            if(preview.paymentId!==pending.request.paymentId||typeof preview.expectedDebtFingerprint!=='string'||!/^[0-9a-f]{64}$/.test(preview.expectedDebtFingerprint))throw Error('unconfirmed');
            pending.request=Object.freeze({...pending.request,expectedDebtFingerprint:preview.expectedDebtFingerprint});pending.raw=JSON.stringify(pending.request);pending.phase='commit';
        }
        const result=await apiCall('fin01Settle',{routeKey:context.routeKey,pin:getStoredPin(),request:pending.raw},context);
        if(!isFinancialOperationContextCurrent(context))return true;
        if(result&&result.error==='FIN01_STALE_PREVIEW'&&result.rejectedBeforeCommit===true){fin01ShowRejected_(state,result.error);return true;}
        if(!fin01UiSuccess_(result,pending.request))throw Error('unconfirmed');
        if(result.projectionStatus!=='COMPLETE'){
            pending.committed=true;
            state.message='Плащането е потвърдено. Обновяването на отчета не е завършило. Използвайте „Обнови отчета“ за същия запис.';
            return true;
        }
        state.pending=null;state.message='Плащането е потвърдено. '+result.allocations.map(l=>fin01PaymentLabels_[l.bucket]+': '+(l.amountCents/100).toFixed(2)+' EUR').join('; ');
        for(const id of ['v2IncomeAmount','v2IncomeDoc','v2IncomeNote','fin01Basis','fin01Management','fin01RepairFund','fin01Loan'])document.getElementById(id).value='';
    }catch(error){
        if(isFinancialOperationContextCurrent(context))state.message=state.pending?.committed?
            'Плащането е потвърдено. Обновяването на отчета не е потвърдено. Използвайте „Обнови отчета“ за същия запис.':state.pending?
            'Резултатът не е потвърден. Възможно е част от плащането да е записана. Повторете само същата заявка; не презареждайте страницата.':
            'Плащането не може да бъде проверено. Проверете сумата и опитайте отново.';
    }finally{state.inFlight=false;if(isFinancialOperationContextCurrent(context))fin01RenderPayment_();}
    return true;
}
// Closing the known-rejection dialog cancels the whole uncommitted save.
document.getElementById('fin01PaymentDialog').addEventListener('cancel',cancelRejectedFin01Payment);
document.getElementById('fin01PaymentDialog').addEventListener('close',cancelRejectedFin01Payment);
